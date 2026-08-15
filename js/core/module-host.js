import { toRealmFile } from './blob-utils.js?v=0.14.5';
import { abortError, isStudioAbort, waitBounded } from './async-utils.js?v=0.14.5';
import { TOOL_TRANSFER_MIME, PROJECT_NODE_MIME } from './transfer-registry.js?v=0.14.5';
import { errorText, safeText } from '../../shared/utils/format.js?v=0.14.5';
const TOOL_LOAD_TIMEOUT_MS = 15000;
const TOOL_CALL_TIMEOUT_MS = 60000;
const TOOL_METHODS = ['open', 'get', 'replace', 'add'];


function normalizeToolApi(win, manifest) {
  let source;
  try { source = win.tool; }
  catch { throw new Error(`${manifest.name} exposes an unreadable window.tool.`); }
  if (source == null) return Object.freeze({});
  if (!['object', 'function'].includes(typeof source)) throw new Error(`${manifest.name} must expose window.tool as an object.`);

  const api = {};
  for (const name of TOOL_METHODS) {
    let method;
    try { method = source[name]; }
    catch { throw new Error(`${manifest.name} exposes an unreadable tool.${name}.`); }
    if (method == null) continue;
    if (typeof method !== 'function') throw new Error(`${manifest.name} tool.${name} must be a function.`);
    api[name] = (...args) => method.apply(source, args);
  }
  return Object.freeze(api);
}

function semanticElement(target) {
  return target?.closest?.('[data-file],[data-folder]') || null;
}

function resourceInfo(element) {
  if (!element) return null;
  const hasFile = element.hasAttribute('data-file'); const hasFolder = element.hasAttribute('data-folder');
  if (hasFile === hasFolder) return null;
  const kind = hasFile ? 'file' : 'folder';
  const id = element.getAttribute(kind === 'file' ? 'data-file' : 'data-folder');
  if (typeof id !== 'string' || !id || id.length > 4096) return null;
  return { kind, id };
}



function supportsDrop(tool, info) {
  return Boolean(info && ((info.kind === 'file' && typeof tool.replace === 'function') || (info.kind === 'folder' && typeof tool.add === 'function')));
}
function defaultResourceName(id, kind) {
  const value = String(id || '').replace(/[\\/]+$/, '');
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || (kind === 'folder' ? 'Folder' : 'File');
}

export class ModuleHost {
  constructor(container, api) {
    this.container = container;
    this.api = api;
    this.sessionController = null;
  }

  async unload() {
    this.sessionController?.abort();
    this.sessionController = null;
    this.api.transfers?.cancelOwner?.(this);
    this.container.replaceChildren();
  }

  async callTool(factory, label, { signal = this.sessionController?.signal, timeoutMs = TOOL_CALL_TIMEOUT_MS } = {}) {
    try {
      return await waitBounded(factory, { timeoutMs, timeoutMessage: `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`, signal, abortMessage: `${label} cancelled.` });
    } catch (error) {
      if (isStudioAbort(error)) throw error;
      const message = errorText(error);
      if (message.startsWith(`${label} `)) throw error;
      throw new Error(`${label} failed: ${message}`, { cause: error });
    }
  }

  async incomingFiles(event, targetWindow, { signal = this.sessionController?.signal } = {}) {
    if (signal?.aborted) throw abortError('Tool drop cancelled.');
    const data = event.dataTransfer;
    const files = [...(data?.files || [])];
    if (files.length) {
      const converted = files.map((file) => toRealmFile(file, file.name || 'file.bin', targetWindow));
      if (converted.some((file) => !file)) throw new Error('One or more dropped files could not be normalized for the target tool.');
      return converted;
    }

    const projectNodeId = data?.getData(PROJECT_NODE_MIME) || this.api.transfers?.activeProjectNodeId?.();
    if (projectNodeId && this.api.project) {
      const node = this.api.project.byId(projectNodeId);
      console.debug('[PSP Studio DnD] resolving project file for tool', { projectNodeId, name: node?.name, path: node?.path });
      if (!node || node.isDirectory) throw new Error('The dragged Project resource is not a file.');
      const file = toRealmFile(node.blob, node.name, targetWindow);
      if (!file) throw new Error('The Project file could not be normalized for the target tool.');
      return [file];
    }

    const token = data?.getData(TOOL_TRANSFER_MIME);
    if (token && this.api.transfers) return this.api.transfers.consume(token, (item) => {
      if (item.kind !== 'file') throw new Error('Tool API v1 only supports file drops between tools; copy folders through the Project Explorer.');
      const file = toRealmFile(item.resource, item.name, targetWindow);
      if (!file) throw new Error('The source tool did not return a valid file resource.');
      return [file];
    }, { signal });

    return [];
  }

  installSemanticBridge(doc, win, manifest, tool) {
    const signal = this.sessionController?.signal;
    const listenerOptions = { capture: true, signal };
    let lastLoggedDropTarget = '';
    const mark = (element) => { element.draggable = Boolean(resourceInfo(element) && typeof tool.get === 'function'); };
    const markResources = (root = doc) => root.querySelectorAll?.('[data-file],[data-folder]').forEach(mark);
    markResources();

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const element = record.target;
          if (element?.nodeType === 1) mark(element);
          continue;
        }
        for (const node of record.addedNodes) if (node.nodeType === 1) {
          if (node.matches?.('[data-file],[data-folder]')) mark(node);
          markResources(node);
        }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-file', 'data-folder'] });

    const style = doc.createElement('style');
    style.textContent = `[data-file][draggable="true"],[data-folder][draggable="true"]{cursor:grab}[data-file][draggable="true"]:active,[data-folder][draggable="true"]:active{cursor:grabbing}.studio-drop-target{outline:2px solid var(--accent,#6f8cff)!important;outline-offset:-2px}`;
    doc.head?.appendChild(style);

    doc.addEventListener('dragstart', (event) => {
      const element = semanticElement(event.target); const info = resourceInfo(element);
      if (!info || typeof tool.get !== 'function' || !event.dataTransfer) return;
      const name = defaultResourceName(info.id, info.kind);
      const token = this.api.transfers.register({
        kind: info.kind,
        name,
        owner: this,
        getResource: () => this.callTool(() => tool.get(info.id), `${manifest.name} get()`),
      });
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(TOOL_TRANSFER_MIME, token);
      event.dataTransfer.setData('text/plain', name);
    }, listenerOptions);

    doc.addEventListener('dragend', (event) => {
      const token = event.dataTransfer?.getData(TOOL_TRANSFER_MIME);
      if (token) this.api.transfers?.cancel?.(token);
      // The source event lives inside the iframe and does not bubble to the
      // Studio document. Explicitly notify the shell so stale drop highlights
      // cannot survive a cancelled or completed tool drag.
      window.dispatchEvent(new Event('psp-drag-session-end'));
    }, listenerOptions);

    doc.addEventListener('dragover', (event) => {
      const element = semanticElement(event.target); const info = resourceInfo(element);
      if (!supportsDrop(tool, info)) return;
      const types = [...(event.dataTransfer?.types || [])];
      const activeProjectNodeId = this.api.transfers?.activeProjectNodeId?.() || '';
      if (!activeProjectNodeId && !types.some((type) => type === 'Files' || type === PROJECT_NODE_MIME || type === TOOL_TRANSFER_MIME)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      element.classList.add('studio-drop-target');
      const targetKey = `${info.kind}:${info.id}`;
      if (targetKey !== lastLoggedDropTarget) {
        lastLoggedDropTarget = targetKey;
        console.debug('[PSP Studio DnD] tool drop target recognized', { tool: manifest.name, target: info, types, activeProjectNodeId });
      }
    }, listenerOptions);

    doc.addEventListener('dragleave', (event) => { semanticElement(event.target)?.classList.remove('studio-drop-target'); }, listenerOptions);

    doc.addEventListener('drop', async (event) => {
      const element = semanticElement(event.target); const info = resourceInfo(element);
      element?.classList.remove('studio-drop-target');
      if (!info) return;
      if (!supportsDrop(tool, info)) return;
      event.preventDefault();
      lastLoggedDropTarget = '';
      const signal = this.sessionController?.signal;
      try {
        console.debug('[PSP Studio DnD] drop received by tool bridge', { tool: manifest.name, target: info, types: [...(event.dataTransfer?.types || [])], activeProjectNodeId: this.api.transfers?.activeProjectNodeId?.() || '' });
        const files = await this.incomingFiles(event, win, { signal });
        if (!files.length) { console.warn('[PSP Studio DnD] drop contained no transferable files'); return; }
        if (info.kind === 'file') {
          if (files.length !== 1) throw new Error('A data-file target accepts exactly one file.');
          console.debug('[PSP Studio DnD] calling tool.replace()', { tool: manifest.name, id: info.id, file: files[0].name, size: files[0].size });
          await this.callTool(() => tool.replace(info.id, files[0]), `${manifest.name} replace()`, { signal });
        } else {
          console.debug('[PSP Studio DnD] calling tool.add()', { tool: manifest.name, id: info.id, files: files.map((file) => ({ name: file.name, size: file.size })) });
          await this.callTool(() => tool.add(info.id, files), `${manifest.name} add()`, { signal });
        }
        console.debug('[PSP Studio DnD] tool drop completed', { tool: manifest.name, target: info });
      } catch (error) {
        if (isStudioAbort(error)) return;
        console.error(error);
        this.api.ui.toast(errorText(error, 'Could not transfer the file.'), 'error', 6000);
      } finally {
        const activeProjectNodeId = this.api.transfers?.activeProjectNodeId?.();
        if (activeProjectNodeId) this.api.transfers?.endProjectDrag?.(activeProjectNodeId);
        window.dispatchEvent(new Event('psp-drag-session-end'));
      }
    }, listenerOptions);

    signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  async load(manifest) {
    await this.unload();
    const controller = new AbortController();
    const { signal } = controller;
    this.sessionController = controller;
    const throwIfAborted = () => { if (signal.aborted) throw abortError(`${manifest.name} load cancelled.`); };

    this.container.className = 'studio-tab-panel tool-host';
    const iframe = document.createElement('iframe');
    iframe.className = 'tool-frame';
    iframe.title = manifest.name;
    const loaded = new Promise((resolve, reject) => {
      iframe.addEventListener('load', resolve, { once: true, signal });
      iframe.addEventListener('error', () => reject(new Error(`Could not load ${manifest.name}.`)), { once: true, signal });
    });
    iframe.src = manifest.pageUrl;
    this.container.appendChild(iframe);
    await waitBounded(loaded, {
      timeoutMs: TOOL_LOAD_TIMEOUT_MS,
      timeoutMessage: `${manifest.name} did not finish loading within ${TOOL_LOAD_TIMEOUT_MS / 1000} seconds.`,
      signal,
      abortMessage: `${manifest.name} load cancelled.`,
    });

    throwIfAborted();
    const win = iframe.contentWindow; const doc = iframe.contentDocument;
    if (!win || !doc) throw new Error(`${manifest.name} could not be attached to the Studio.`);
    doc.documentElement.dataset.theme = 'dark';
    doc.documentElement.dataset.studioHosted = 'true';
    if (Object.prototype.hasOwnProperty.call(win, 'studio')) throw new Error(`${manifest.name} conflicts with the reserved window.studio bridge.`);
    const studioBridge = Object.freeze({
      toast: (message, type = 'info', duration = 3200) => this.api.ui.toast(message, type, duration),
      confirm: (message) => this.api.ui.confirm(message),
      dirty: (value = true) => this.api.tab?.update({ dirty: Boolean(value) }),
      title: (value) => { const title = safeText(value, 512).trim(); if (title) this.api.tab?.update({ title }); },
    });
    Object.defineProperty(win, 'studio', { value: studioBridge, writable: false, configurable: false });
    win.dispatchEvent(new win.CustomEvent('studio-ready'));

    const tool = normalizeToolApi(win, manifest);
    if (tool.get || tool.replace || tool.add) this.installSemanticBridge(doc, win, manifest, tool);

    const file = this.api.document;
    if (file && typeof tool.open !== 'function') throw new Error(`${manifest.name} does not implement tool.open(file), required to open a project file.`);
    if (file) {
      const realmFile = toRealmFile(file, file.name || 'file.bin', win);
      if (!realmFile) throw new Error(`${manifest.name} could not receive the document file.`);
      await this.callTool(() => tool.open(realmFile), `${manifest.name} open()`, { signal });
      throwIfAborted();
    }
  }
}
