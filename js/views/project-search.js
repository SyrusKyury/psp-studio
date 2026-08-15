import { escapeHtml as esc, formatBytes } from '../../shared/utils/format.js?v=0.14.3';

const AUTO_SCAN_LIMIT = 32 * 1024 * 1024;
const AUTO_SCAN_BUDGET = 256 * 1024 * 1024;
const MAX_PATTERN_BYTES = 64 * 1024;
const MAX_NAME_RESULTS = 1000;
const MAX_CONTENT_RESULTS = 2000;
const SEARCH_BATCH_FILES = 256;
const WORKER_URL = new URL('../workers/search-worker.js?v=0.14.3', import.meta.url);
const NON_CONTENT_CHANGES = new Set(['tool-pinned', 'tool-unpinned', 'tool-suggested', 'file-association-changed']);

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.isDirectory) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
    } else out.push(node);
  }
  return out;
}

function parsePattern(mode, value) {
  const raw = String(value || '');
  if (mode === 'hex') {
    const compact = raw.replace(/\s+/g, '');
    if (!compact || compact.length % 2 || !/^[0-9a-f]+$/i.test(compact)) throw new Error('Hex search expects complete bytes, for example: DE AD BE EF.');
    const bytes = new Uint8Array(compact.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    if (bytes.length > MAX_PATTERN_BYTES) throw new Error(`Search pattern exceeds ${MAX_PATTERN_BYTES} bytes.`);
    return bytes;
  }
  const bytes = new TextEncoder().encode(raw);
  if (!bytes.length) throw new Error('Enter text to search for.');
  if (bytes.length > MAX_PATTERN_BYTES) throw new Error(`Search pattern exceeds ${MAX_PATTERN_BYTES} bytes.`);
  return bytes;
}

function offsetLabel(value) { return `0x${Number(value).toString(16).toUpperCase().padStart(8, '0')}`; }

export class ProjectSearch {
  constructor(container, { getProject, onOpenFile }) {
    this.container = container;
    this.getProject = getProject;
    this.onOpenFile = onOpenFile;
    this.project = null;
    this.worker = null;
    this.projectController = null;
    this.cancelRun = null;
    this.requestId = 0;
    this.mode = 'text';
    this.query = '';
    this.state = null;
    container.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-search-form]');
      if (!form) return;
      event.preventDefault();
      this.search().catch((error) => this.fail(error));
    });
    container.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-search-mode]')?.dataset.searchMode;
      if (mode) { this.setMode(mode); return; }
      if (event.target.closest('[data-search-cancel]')) { this.cancel(); this.render(); return; }
      const scan = event.target.closest('[data-search-scan]')?.dataset.searchScan;
      if (scan) { this.scanDeferred(scan === 'all' ? null : scan).catch((error) => this.fail(error)); return; }
      const nodeId = event.target.closest('[data-search-node]')?.dataset.searchNode;
      if (nodeId) {
        const node = this.getProject()?.byId(nodeId);
        if (node && !node.isDirectory) this.onOpenFile?.(node);
      }
    });
  }

  bind(project) {
    this.cancel();
    this.projectController?.abort();
    this.projectController = new AbortController();
    this.project = project || null;
    this.mode = 'text';
    this.query = '';
    this.state = null;
    if (project) project.addEventListener('change', (event) => {
      if (!this.state || NON_CONTENT_CHANGES.has(event.detail?.reason)) return;
      this.cancel();
      this.state.nameMatches = [];
      this.state.deferred = [];
      this.state.content.clear();
      this.state.error = 'Project files changed. Run the search again.';
      this.render();
    }, { signal: this.projectController.signal });
    this.render();
  }

  setMode(mode) {
    if (!['text', 'hex'].includes(mode)) return;
    const input = this.container.querySelector('[data-search-query]');
    this.query = input?.value ?? this.query;
    this.mode = mode;
    this.cancel();
    this.state = null;
    this.render();
    queueMicrotask(() => {
      const next = this.container.querySelector('[data-search-query]');
      next?.focus();
      next?.setSelectionRange(this.query.length, this.query.length);
    });
  }

  cancel() {
    this.requestId += 1;
    const cancelRun = this.cancelRun;
    this.cancelRun = null;
    cancelRun?.();
    this.worker?.terminate();
    this.worker = null;
    if (this.state) { this.state.searching = false; this.state.progress = null; }
  }

  fail(error) {
    this.cancel();
    const project = this.getProject();
    const input = this.container.querySelector('[data-search-query]');
    this.query = input?.value ?? this.query;
    this.state ||= { query: this.query, mode: this.mode, revision: project?.revision ?? 0, nameMatches: [], deferred: [], nameCapped: false, content: new Map(), searching: false, progress: null, capped: false, error: null };
    this.state.error = error instanceof Error ? error.message : String(error);
    this.render();
  }

  async search() {
    const project = this.getProject();
    if (!project) return;
    this.cancel();
    const query = this.container.querySelector('[data-search-query]')?.value ?? this.query;
    const mode = this.mode;
    const pattern = parsePattern(mode, query);
    this.query = query;
    const files = walkFiles(project.root);
    const needle = query.trim().toLowerCase();
    const allNameMatches = needle ? files.filter((node) => node.path.toLowerCase().includes(needle)) : [];
    const nameMatches = allNameMatches.slice(0, MAX_NAME_RESULTS).map((node) => node.id);
    const automatic = [];
    const deferred = [];
    let automaticBytes = 0;
    for (const node of files) {
      if (node.blob.size <= AUTO_SCAN_LIMIT && automaticBytes + node.blob.size <= AUTO_SCAN_BUDGET) {
        automatic.push(node);
        automaticBytes += node.blob.size;
      } else deferred.push(node.id);
    }
    this.state = {
      query, mode, revision: project.revision, nameMatches, deferred, nameCapped: allNameMatches.length > MAX_NAME_RESULTS,
      content: new Map(), searching: false, progress: null, capped: false, error: null,
    };
    this.render();
    if (automatic.length) await this.scanNodes(automatic);
  }

  async scanDeferred(nodeId = null) {
    const project = this.getProject();
    if (!project || !this.state) return;
    if (project !== this.project || project.revision !== this.state.revision) throw new Error('Project changed since this search started. Run the search again.');
    const ids = nodeId ? [nodeId] : [...this.state.deferred];
    const nodes = ids.map((id) => project.byId(id)).filter((node) => node && !node.isDirectory);
    if (!nodes.length) return;
    const scanned = await this.scanNodes(nodes);
    this.state.deferred = this.state.deferred.filter((id) => !scanned?.has(id));
    this.render();
  }

  async scanNodes(nodes) {
    const project = this.getProject();
    if (!project || !this.state || !nodes.length) return;
    const pattern = parsePattern(this.state.mode, this.state.query);
    const requestId = ++this.requestId;
    this.worker?.terminate();
    const worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker = worker;
    this.state.searching = true;
    this.state.progress = { done: 0, total: nodes.length };
    this.state.error = null;
    this.render();

    let cancelled = false;
    let processed = 0;
    const scannedIds = new Set();
    let totalMatches = [...this.state.content.values()].reduce((sum, result) => sum + (result.offsets?.length || 0), 0);
    try {
      for (let start = 0, batchId = 0; start < nodes.length; start += SEARCH_BATCH_FILES, batchId += 1) {
        if (this.worker !== worker || this.requestId !== requestId) { cancelled = true; break; }
        if (totalMatches >= MAX_CONTENT_RESULTS) { this.state.capped = true; break; }
        const batch = nodes.slice(start, start + SEARCH_BATCH_FILES);
        const result = await new Promise((resolve, reject) => {
          this.cancelRun = () => resolve({ cancelled: true });
          worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.requestId !== requestId || message.batchId !== batchId || this.worker !== worker) return;
            if (message.type === 'file') {
              this.state.content.set(message.id, { offsets: message.offsets || [], truncated: Boolean(message.truncated) });
              this.renderResultsOnly();
              return;
            }
            if (message.type === 'progress') {
              this.state.progress = { done: processed + message.done, total: nodes.length };
              this.renderStatusOnly();
              return;
            }
            if (message.type === 'done') { resolve({ processed: message.processed || 0, totalMatches: message.totalMatches || 0, capped: Boolean(message.capped) }); return; }
            if (message.type === 'error') reject(new Error(message.message || 'Search worker failed.'));
          };
          worker.onerror = (event) => reject(new Error(event.message || 'Search worker failed.'));
          worker.postMessage({
            requestId, batchId, pattern, totalLimit: MAX_CONTENT_RESULTS - totalMatches,
            jobs: batch.map((node) => ({ id: node.id, blob: node.blob })),
          });
        });
        this.cancelRun = null;
        if (this.worker !== worker || this.requestId !== requestId || result.cancelled) { cancelled = true; break; }
        totalMatches += result.totalMatches;
        for (const node of batch.slice(0, result.processed)) scannedIds.add(node.id);
        processed += result.processed;
        this.state.progress = { done: processed, total: nodes.length };
        if (result.capped && totalMatches >= MAX_CONTENT_RESULTS) { this.state.capped = true; break; }
      }
    } finally {
      this.cancelRun = null;
      if (this.worker === worker) this.worker = null;
      worker.terminate();
      if (this.state) { this.state.searching = false; this.state.progress = null; }
    }

    if (cancelled) { this.render(); return scannedIds; }
    if (project !== this.getProject() || project.revision !== this.state.revision) {
      this.state.content.clear();
      this.state.error = 'Project changed while searching. Run the search again.';
    }
    this.render();
    return scannedIds;
  }

  resultMarkup() {
    const project = this.getProject();
    const state = this.state;
    if (!project || !state) return '<div class="search-empty">Search file names or file contents in this project.</div>';
    const groups = [];

    if (state.nameMatches.length) {
      groups.push(`<section class="search-group"><div class="search-group-title">FILE NAMES <span>${state.nameMatches.length}</span></div>${state.nameMatches.map((id) => {
        const node = project.byId(id); if (!node) return '';
        return `<button class="search-file-result" type="button" data-search-node="${esc(node.id)}"><span class="search-result-path">${esc(node.path)}</span><span>${formatBytes(node.blob.size)}</span></button>`;
      }).join('')}</section>`);
    }

    const contentRows = [];
    for (const [id, result] of state.content) {
      if (!result.offsets?.length) continue;
      const node = project.byId(id); if (!node) continue;
      contentRows.push(`<section class="search-content-file"><button class="search-file-result" type="button" data-search-node="${esc(node.id)}"><span class="search-result-path">${esc(node.path)}</span><span>${result.offsets.length}${result.truncated ? '+' : ''}</span></button><div class="search-offsets">${result.offsets.map((offset) => `<button type="button" data-search-node="${esc(node.id)}"><span>${offsetLabel(offset)}</span></button>`).join('')}</div></section>`);
    }
    if (contentRows.length) groups.push(`<section class="search-group"><div class="search-group-title">CONTENTS</div>${contentRows.join('')}</section>`);

    if (state.deferred.length) {
      groups.push(`<section class="search-group"><div class="search-group-title">DEFERRED <button type="button" data-search-scan="all">Scan all</button></div>${state.deferred.map((id) => {
        const node = project.byId(id); if (!node) return '';
        return `<div class="search-deferred"><button type="button" data-search-node="${esc(node.id)}"><span class="search-result-path">${esc(node.path)}</span><span>${formatBytes(node.blob.size)}</span></button><button type="button" data-search-scan="${esc(node.id)}">Scan</button></div>`;
      }).join('')}</section>`);
    }

    if (!groups.length && !state.searching) groups.push('<div class="search-empty">No matches.</div>');
    if (state.nameCapped) groups.push(`<div class="search-note">File-name results are limited to ${MAX_NAME_RESULTS}. Refine the query to see fewer paths.</div>`);
    if (state.capped) groups.push(`<div class="search-note">Content results are limited to ${MAX_CONTENT_RESULTS}. Refine the query for a smaller result set.</div>`);
    if (state.error) groups.push(`<div class="search-error">${esc(state.error)}</div>`);
    return groups.join('');
  }

  renderStatusOnly() {
    const status = this.container.querySelector('[data-search-status]');
    if (!status || !this.state) return;
    status.textContent = this.state.searching && this.state.progress ? `Scanning ${this.state.progress.done}/${this.state.progress.total}` : '';
  }

  renderResultsOnly() {
    const results = this.container.querySelector('[data-search-results]');
    if (results) results.innerHTML = this.resultMarkup();
  }

  render() {
    const state = this.state || { query: this.query, mode: this.mode, searching: false };
    this.container.innerHTML = `<div class="search-surface"><div class="search-head">SEARCH</div><form class="search-form" data-search-form><input class="studio-input search-input" data-search-query type="search" placeholder="Search text or hex..." autocomplete="off" spellcheck="false" value="${esc(state.query || '')}"><div class="search-controls"><div class="search-mode" role="group" aria-label="Search mode"><button class="${state.mode !== 'hex' ? 'active' : ''}" type="button" data-search-mode="text">Text</button><button class="${state.mode === 'hex' ? 'active' : ''}" type="button" data-search-mode="hex">Hex</button></div><button class="button search-run" type="submit">Search</button>${state.searching ? '<button class="button" type="button" data-search-cancel>Cancel</button>' : ''}</div><div class="search-status" data-search-status>${state.searching && state.progress ? `Scanning ${state.progress.done}/${state.progress.total}` : ''}</div></form><div class="search-results" data-search-results>${this.resultMarkup()}</div></div>`;
  }
}
