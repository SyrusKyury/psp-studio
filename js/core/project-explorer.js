import { isFileLike, toRealmBlob } from './blob-utils.js?v=0.14.5';
import { abortError, isStudioAbort, waitBounded } from './async-utils.js?v=0.14.5';
import { bindShortcuts, shortcutLabel } from './shortcut-manager.js?v=0.14.5';
import { projectNodeIcon } from './file-icon-service.js?v=0.14.5';
import { TOOL_TRANSFER_MIME, PROJECT_NODE_MIME } from './transfer-registry.js?v=0.14.5';
import { escapeHtml as esc, formatBytes, errorText } from '../../shared/utils/format.js?v=0.14.5';

const MAX_TRANSFER_FILES = 20000;
const MAX_TRANSFER_NODES = 50000;
const MAX_TRANSFER_DEPTH = 128;
const MAX_TRANSFER_PATH_CHARS = 4096;
const TRANSFER_TOTAL_TIMEOUT_MS = 60000;
const TRANSFER_STEP_TIMEOUT_MS = 15000;
const MAX_PROJECT_NAME_CHARS = 1024;
const TRANSFER_ABORT_MESSAGE = 'Project transfer cancelled because the workspace changed.';
const NON_TREE_PROJECT_CHANGES = new Set(['tool-pinned', 'tool-unpinned', 'tool-suggested', 'file-association-changed']);

function transferStepTimeout(deadlineAt) { return Math.min(TRANSFER_STEP_TIMEOUT_MS, Math.max(0, deadlineAt - Date.now())); }

async function* folderEntries(resource, { signal = null, deadlineAt = Infinity } = {}) {
  if (!resource) return;
  const source = await waitBounded(() => {
    const files = resource.files;
    return typeof files === 'function' ? files.call(resource) : files;
  }, { timeoutMs: transferStepTimeout(deadlineAt), timeoutMessage: 'Tool folder transfer timed out while preparing its file list.', signal, abortMessage: TRANSFER_ABORT_MESSAGE });
  if (source == null) throw new Error('Tool folder resource did not provide a file list.');
  if (typeof source[Symbol.asyncIterator] === 'function') {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const step = await waitBounded(() => iterator.next(), { timeoutMs: transferStepTimeout(deadlineAt), timeoutMessage: 'Tool folder transfer stopped responding.', signal, abortMessage: TRANSFER_ABORT_MESSAGE });
        if (step.done) return;
        yield step.value;
      }
    } finally {
      try {
        const closing = iterator.return?.();
        if (closing) void Promise.resolve(closing).catch(() => {});
      } catch { /* iterator cleanup is best-effort */ }
    }
  }
  if (typeof source[Symbol.iterator] === 'function') { for (const item of source) yield item; return; }
  throw new Error('Tool folder resource file list must be iterable.');
}

function safeTransferPart(value) {
  const part = String(value ?? '');
  if (!part || part === '.' || part === '..' || part.length > MAX_PROJECT_NAME_CHARS || /[\\/\x00-\x1F\x7F]/.test(part)) throw new Error(`Invalid transferred path segment: ${part || '(empty)'}`);
  return part;
}

function projectPathDepth(node) { return String(node?.path || '/').split('/').filter(Boolean).length; }

function eventNode(project, event) {
  const row = event.target.closest('.project-node');
  return row ? project.byId(row.dataset.nodeId) : null;
}

function hasTransferType(event) {
  return [...(event.dataTransfer?.types || [])].some((type) => [PROJECT_NODE_MIME, TOOL_TRANSFER_MIME, 'Files'].includes(type));
}

async function folderResourceSnapshot(resource, fallbackName = 'Folder', { isActive = () => true, signal = null } = {}) {
  if (!resource || typeof resource !== 'object' || !('files' in resource)) throw new Error('The tool did not return a valid folder resource.');
  const requestedName = String(resource?.name || fallbackName || 'Folder').trim();
  const name = safeTransferPart(requestedName || 'Folder');
  const root = { kind: 'folder', name, children: [] };
  const nodes = new Map([['', root]]);
  const deadlineAt = Date.now() + TRANSFER_TOTAL_TIMEOUT_MS; let count = 0; let nodeCount = 1;

  for await (const entry of folderEntries(resource, { signal, deadlineAt })) {
    if (!isActive()) throw abortError(TRANSFER_ABORT_MESSAGE);
    if (++count > MAX_TRANSFER_FILES) throw new Error(`Tool folder transfer exceeds the ${MAX_TRANSFER_FILES}-file safety limit.`);
    if (Date.now() > deadlineAt) throw new Error('Tool folder transfer exceeded the 60-second safety limit.');
    if (!entry || typeof entry.path !== 'string' || !entry.path || !entry.file) throw new Error('Tool folder resource contains an invalid file entry.');
    const normalized = entry.path;
    if (normalized.length > MAX_TRANSFER_PATH_CHARS) throw new Error('Transferred path is too long.');
    if (normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0')) throw new Error(`Transferred paths must be relative POSIX paths: ${normalized}`);
    const parts = normalized.split('/');
    if (!parts.length || parts.length > MAX_TRANSFER_DEPTH || parts.some((part) => !part)) throw new Error(`Invalid transferred path: ${normalized}`);
    parts.forEach(safeTransferPart);
    const fileName = parts.pop(); let parentPath = '';
    for (const part of parts) {
      const path = parentPath ? `${parentPath}/${part}` : part;
      const existing = nodes.get(path);
      if (nodes.has(path) && !existing) throw new Error(`Transferred path collides with a file: ${normalized}`);
      if (!existing) {
        if (++nodeCount > MAX_TRANSFER_NODES) throw new Error(`Tool folder transfer exceeds the ${MAX_TRANSFER_NODES}-node safety limit.`);
        const folder = { kind: 'folder', name: part, children: [] }; nodes.get(parentPath).children.push(folder); nodes.set(path, folder);
      }
      parentPath = path;
    }
    const filePath = parentPath ? `${parentPath}/${fileName}` : fileName;
    if (nodes.has(filePath)) throw new Error(`Duplicate transferred path: ${normalized}`);
    if (++nodeCount > MAX_TRANSFER_NODES) throw new Error(`Tool folder transfer exceeds the ${MAX_TRANSFER_NODES}-node safety limit.`);
    const blob = toRealmBlob(entry.file, globalThis);
    if (!blob) throw new Error(`Could not detach transferred file from its tool context: ${normalized}`);
    nodes.get(parentPath).children.push({ kind: 'file', name: fileName, blob }); nodes.set(filePath, null);
  }
  return root;
}

export class ProjectExplorer {
  constructor(container, { getProject, transfers, onOpenFile, onOpenWith, ui }) {
    this.container = container;
    this.getProject = getProject;
    this.transfers = transfers;
    this.onOpenFile = onOpenFile;
    this.onOpenWith = onOpenWith;
    this.ui = ui;
    this.selectedId = null;
    this.expanded = new Set(['/']);
    this.clipboard = null;
    this.contextMenu = null;
    this.contextMenuController = null;
    this.lifecycleController = new AbortController();
  }

  bind(project) {
    this.lifecycleController?.abort();
    this.lifecycleController = new AbortController();
    this.closeContextMenu();
    const { signal } = this.lifecycleController;
    project?.addEventListener('change', (event) => {
      if (NON_TREE_PROJECT_CHANGES.has(event.detail?.reason)) return;
      this.render();
    }, { signal });
    this.selectedId = null;
    this.expanded = new Set(['/']);
    this.render();
    this.bindShortcuts();
  }

  destroy() {
    this.lifecycleController?.abort();
    this.closeContextMenu();
  }

  selectedNode() { const project = this.getProject(); return project?.byId(this.selectedId) || project?.root || null; }
  isCurrentProject(project) { return Boolean(project && !this.lifecycleController.signal.aborted && this.getProject() === project); }
  targetFolder(node = this.selectedNode()) { return node?.isDirectory ? node : node?.parent || this.getProject()?.root; }
  reportError(error, fallback = 'Project operation failed.') { if (!isStudioAbort(error)) { console.error(error); this.ui.toast(errorText(error, fallback), 'error'); } }

  selectNode(node, { focus = true, scroll = false } = {}) {
    if (!node) return false;
    this.selectedId = node.id;
    this.container.querySelector('.project-node.selected')?.classList.remove('selected');
    const row = this.container.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
    row?.classList.add('selected');
    if (focus) this.focusTree();
    if (scroll) queueMicrotask(() => row?.scrollIntoView({ block: 'nearest' }));
    return true;
  }

  focusTree() {
    queueMicrotask(() => this.container.querySelector('.project-tree')?.focus({ preventScroll: true }));
  }

  renderNode(node, depth = 0) {
    const isOpen = node.isDirectory && (this.expanded.has(node.path) || depth === 0);
    const children = node.isDirectory && isOpen ? node.children.map((child) => this.renderNode(child, depth + 1)).join('') : '';
    const caret = node.isDirectory ? (isOpen ? '▾' : '▸') : '';
    const iconUrl = projectNodeIcon(node, { open: isOpen });
    return `<div class="project-node-wrap"><div class="project-node ${this.selectedId === node.id ? 'selected' : ''}" draggable="${node.id !== 'root'}" data-node-id="${node.id}" style="--depth:${depth}">
      <span class="project-node-caret" data-toggle>${caret}</span><span class="project-node-icon"><img src="${esc(iconUrl)}" alt="" draggable="false"></span><span class="project-node-name">${node.id === 'root' ? esc(this.getProject()?.name || 'Project') : esc(node.name)}</span>${!node.isDirectory ? `<span class="project-node-size">${formatBytes(node.blob?.size || 0)}</span>` : ''}
    </div>${children}</div>`;
  }

  render() {
    this.closeContextMenu();
    const project = this.getProject();
    if (!project) { this.container.innerHTML = '<div class="project-empty">No project open</div>'; return; }
    this.container.innerHTML = `<div class="explorer-surface"><div class="explorer-head"><span>PROJECT</span><div class="explorer-actions"><button class="mini-button" data-action="new-file" title="New file" aria-label="New file"><span class="ui-icon icon-file-plus"></span></button><button class="mini-button" data-action="new-folder" title="New folder (${shortcutLabel('Mod+Shift+N')})" aria-label="New folder"><span class="ui-icon icon-folder-plus"></span></button><button class="mini-button" data-action="import-files" title="Import files" aria-label="Import files"><span class="ui-icon icon-import"></span></button></div></div><div class="project-tree" tabindex="0" aria-label="Project Explorer">${this.renderNode(project.root, 0)}</div><input class="hidden" type="file" data-file-picker multiple></div>`;
    this.bindDom();
  }

  async importToolTransfer(target, token) {
    const project = this.getProject(); const signal = this.lifecycleController?.signal || null;
    if (!this.isCurrentProject(project) || !project.owns?.(target)) throw abortError(TRANSFER_ABORT_MESSAGE);
    return this.transfers.consume(token, async (item, transferSignal) => {
      const active = () => !transferSignal.aborted && this.isCurrentProject(project) && project.owns?.(target);
      if (!active()) throw abortError(TRANSFER_ABORT_MESSAGE);
      if (item.kind === 'file') {
        const blob = toRealmBlob(item.resource, globalThis);
        const name = safeTransferPart(isFileLike(item.resource) ? item.resource.name : item.name);
        if (!blob) throw new Error('Could not detach the transferred file from its tool context.');
        project.addBlob(target.path, name, blob, { silent: true });
        this.expanded.add(target.path);
        project.touch('file-imported');
        this.ui.toast(`${name} added to project.`, 'success'); return;
      }
      if (item.kind === 'folder') {
        const snapshot = await folderResourceSnapshot(item.resource, item.name, { isActive: active, signal: transferSignal });
        if (!active()) throw abortError(TRANSFER_ABORT_MESSAGE);
        const rootFolder = project.insertSnapshot(target, snapshot, { silent: true });
        this.expanded.add(target.path); this.expanded.add(rootFolder.path);
        project.touch('folder-imported');
        this.ui.toast(`${rootFolder.name} copied to the project.`, 'success'); return;
      }
      throw new Error(`Unsupported transferred resource: ${item.kind}`);
    }, { signal });
  }

  importNativeFiles(target, files) {
    const project = this.getProject();
    if (!this.isCurrentProject(project) || !project.owns?.(target) || !files.length) return;
    const entries = files.map((file) => {
      if (!isFileLike(file)) throw new Error('Imported item is not a valid File.');
      return { name: safeTransferPart(file.name), blob: file };
    });
    project.addBlobs(target.path, entries, { silent: true });
    this.expanded.add(target.path);
    project.touch(files.length === 1 ? 'file-added' : 'files-added');
  }

  async handleDrop(target, event) {
    const project = this.getProject(); if (!project || !target?.isDirectory || !event.dataTransfer) return;
    const nodeId = event.dataTransfer.getData(PROJECT_NODE_MIME);
    if (nodeId) {
      try { if (project.move(project.byId(nodeId), target)) this.expanded.add(target.path); }
      catch (error) { this.reportError(error); }
      return;
    }
    const token = event.dataTransfer.getData(TOOL_TRANSFER_MIME);
    if (token) { try { await this.importToolTransfer(target, token); } catch (error) { this.reportError(error, 'Tool transfer failed.'); } return; }
    try { this.importNativeFiles(target, [...(event.dataTransfer.files || [])]); }
    catch (error) { this.reportError(error); }
  }

  newFile(target = this.targetFolder()) {
    if (!target?.isDirectory) return;
    const name = prompt('File name', 'new-file.bin');
    if (!name) return;
    const project = this.getProject();
    try {
      const node = project.addBlob(target.path, name, new Blob([], { type: 'application/octet-stream' }), { silent: true });
      this.selectedId = node.id; this.expanded.add(target.path); project.touch('file-created');
    } catch (error) { this.reportError(error); }
    this.focusTree();
  }

  newFolder(target = this.targetFolder()) {
    if (!target?.isDirectory) return;
    const name = prompt('Folder name', 'New Folder');
    if (!name) return;
    const project = this.getProject();
    try {
      const node = project.createFolder(target.path, name, { silent: true });
      this.selectedId = node.id; this.expanded.add(target.path); project.touch('folder-created');
    } catch (error) { this.reportError(error); }
    this.focusTree();
  }

  renameSelected() {
    const node = this.selectedNode(); if (!node || node.id === 'root') return;
    const name = prompt('Rename', node.name);
    if (name && name !== node.name) {
      try { this.getProject().rename(node, name); }
      catch (error) { this.reportError(error); }
    }
    this.focusTree();
  }

  async deleteSelected() {
    const node = this.selectedNode(); if (!node || node.id === 'root') return;
    if (await this.ui.confirm(`Delete ${node.name} from the project?`)) {
      const parentId = node.parent?.id || 'root'; this.selectedId = parentId; this.getProject().remove(node);
    }
    this.focusTree();
  }

  copySelected() {
    const node = this.selectedNode();
    if (!node || node.id === 'root') return;

    // Keep the Explorer clipboard self-contained. Copy/paste is a Studio UI
    // concern and must not require optional clipboard methods on ProjectStore.
    // Blobs are intentionally referenced, not duplicated in memory.
    const snapshot = (item) => item.isDirectory
      ? { kind: 'folder', name: item.name, children: item.children.map(snapshot) }
      : { kind: 'file', name: item.name, blob: item.blob };

    this.clipboard = snapshot(node);
    this.ui.toast(`${node.name} copied.`, 'success', 1800);
    this.focusTree();
  }

  pasteClipboard(target = this.targetFolder()) {
    if (!this.clipboard || !target?.isDirectory) return;
    const project = this.getProject();
    if (!project) return;

    try {
      const created = project.insertSnapshot(target, this.clipboard, { silent: true });
      this.selectedId = created.id;
      this.expanded.add(target.path);
      if (created.isDirectory) this.expanded.add(created.path);
      project.touch('pasted');
      this.ui.toast(`${created.name} pasted.`, 'success', 1800);
    } catch (error) {
      this.reportError(error);
    }
    this.focusTree();
  }

  openSelected() {
    const node = this.selectedNode(); if (!node) return;
    if (node.isDirectory) { if (this.expanded.has(node.path)) this.expanded.delete(node.path); else this.expanded.add(node.path); this.render(); this.focusTree(); }
    else this.onOpenFile(node);
  }

  moveSelection(delta) {
    const rows = [...this.container.querySelectorAll('.project-node')]; if (!rows.length) return;
    let index = rows.findIndex((row) => row.dataset.nodeId === this.selectedId); if (index < 0) index = 0;
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    this.selectNode(this.getProject()?.byId(next.dataset.nodeId), { scroll: true });
  }

  navigateHorizontal(direction) {
    const node = this.selectedNode(); if (!node) return;
    if (direction > 0 && node.isDirectory && !this.expanded.has(node.path)) { this.expanded.add(node.path); this.render(); this.focusTree(); return; }
    if (direction < 0 && node.isDirectory && this.expanded.has(node.path) && node.id !== 'root') { this.expanded.delete(node.path); this.render(); this.focusTree(); return; }
    if (direction < 0 && node.parent) this.selectNode(node.parent, { scroll: true });
  }

  contextItems(node) {
    const folder = this.targetFolder(node);
    return [
      ...(!node.isDirectory ? [{ command: 'open', label: 'Open', shortcut: 'Enter' }, { command: 'open-with', label: 'Open With...', shortcut: 'Shift+Enter' }] : []),
      ...(node.isDirectory ? [{ command: 'new-file', label: 'New File' }, { command: 'new-folder', label: 'New Folder', shortcut: shortcutLabel('Mod+Shift+N') }, { command: 'import-files', label: 'Import Files...' }] : []),
      { separator: true },
      ...(node.id !== 'root' ? [{ command: 'rename', label: 'Rename', shortcut: 'F2' }, { command: 'copy', label: 'Copy', shortcut: shortcutLabel('Mod+C') }] : []),
      { command: 'paste', label: node.isDirectory ? 'Paste' : 'Paste into Parent', shortcut: shortcutLabel('Mod+V'), disabled: !this.clipboard || !folder },
      ...(node.id !== 'root' ? [{ separator: true }, { command: 'delete', label: 'Delete', shortcut: 'Del', danger: true }] : []),
    ];
  }

  openContextMenu(x, y, node) {
    this.closeContextMenu();
    const menu = document.createElement('div'); menu.className = 'studio-context-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = this.contextItems(node).map((item) => item.separator ? '<div class="context-menu-separator"></div>' : `<button class="context-menu-item ${item.danger ? 'danger' : ''}" data-command="${item.command}" type="button" ${item.disabled ? 'disabled' : ''}><span>${esc(item.label)}</span>${item.shortcut ? `<kbd>${esc(item.shortcut)}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(menu); this.contextMenu = menu;
    const rect = menu.getBoundingClientRect(); menu.style.left = `${Math.max(6, Math.min(x, innerWidth - rect.width - 6))}px`; menu.style.top = `${Math.max(6, Math.min(y, innerHeight - rect.height - 6))}px`;
    const controller = new AbortController(); this.contextMenuController = controller;
    menu.addEventListener('click', async (event) => { const command = event.target.closest('[data-command]')?.dataset.command; if (!command) return; this.closeContextMenu(); try { await this.runCommand(command, node); } catch (error) { this.reportError(error, 'Project command failed.'); } }, { signal: controller.signal });
    queueMicrotask(() => document.addEventListener('pointerdown', (event) => { if (!menu.contains(event.target)) this.closeContextMenu(); }, { capture: true, signal: controller.signal }));
  }

  closeContextMenu() {
    this.contextMenuController?.abort(); this.contextMenuController = null;
    this.contextMenu?.remove(); this.contextMenu = null;
  }

  async runCommand(command, node = this.selectedNode()) {
    if (node) this.selectedId = node.id;
    switch (command) {
      case 'open': return this.openSelected();
      case 'open-with': { const selected = node || this.selectedNode(); if (selected && !selected.isDirectory) return this.onOpenWith?.(selected); return; }
      case 'new-file': return this.newFile(node?.isDirectory ? node : this.targetFolder(node));
      case 'new-folder': return this.newFolder(node?.isDirectory ? node : this.targetFolder(node));
      case 'import-files': { const picker = this.container.querySelector('[data-file-picker]'); if (node) this.selectedId = node.id; return picker?.click(); }
      case 'rename': return this.renameSelected();
      case 'copy': return this.copySelected();
      case 'paste': return this.pasteClipboard(this.targetFolder(node));
      case 'delete': return this.deleteSelected();
    }
  }

  bindShortcuts() {
    bindShortcuts(this.container, [
      { id: 'project.rename', combo: 'F2', handler: () => this.renameSelected() },
      { id: 'project.delete', combo: 'Delete', handler: () => this.deleteSelected() },
      { id: 'project.copy', combo: 'Mod+C', handler: () => this.copySelected() },
      { id: 'project.paste', combo: 'Mod+V', handler: () => this.pasteClipboard() },
      { id: 'project.new-folder', combo: 'Mod+Shift+N', handler: () => this.newFolder() },
      { id: 'project.open', combo: 'Enter', handler: () => this.openSelected() },
      { id: 'project.open-with', combo: 'Shift+Enter', handler: () => { const node = this.selectedNode(); if (node && !node.isDirectory) return this.onOpenWith?.(node); } },
      { id: 'project.up', combo: 'ArrowUp', handler: () => this.moveSelection(-1) },
      { id: 'project.down', combo: 'ArrowDown', handler: () => this.moveSelection(1) },
      { id: 'project.left', combo: 'ArrowLeft', handler: () => this.navigateHorizontal(-1) },
      { id: 'project.right', combo: 'ArrowRight', handler: () => this.navigateHorizontal(1) },
      { id: 'project.context', combo: 'Shift+F10', handler: () => { const row = this.container.querySelector(`[data-node-id="${CSS.escape(this.selectedNode()?.id || 'root')}"]`); const rect = row?.getBoundingClientRect(); if (rect) this.openContextMenu(rect.left + 24, rect.top + 18, this.selectedNode()); } },
    ], { scope: 'project-explorer', signal: this.lifecycleController.signal });
  }

  bindDom() {
    const project = this.getProject(); if (!project) return;
    const { signal } = this.lifecycleController;
    const picker = this.container.querySelector('[data-file-picker]'); const tree = this.container.querySelector('.project-tree'); const surface = this.container.querySelector('.explorer-surface');
    this.container.querySelector('[data-action="new-file"]').onclick = () => this.newFile();
    this.container.querySelector('[data-action="import-files"]').onclick = () => picker.click();
    picker.onchange = () => {
      if (!this.isCurrentProject(project)) { picker.value = ''; return; }
      try { this.importNativeFiles(this.targetFolder(), [...(picker.files || [])]); }
      catch (error) { this.reportError(error); }
      picker.value = ''; this.focusTree();
    };
    this.container.querySelector('[data-action="new-folder"]').onclick = () => this.newFolder();

    tree.addEventListener('contextmenu', (event) => {
      event.preventDefault(); const node = eventNode(project, event) || project.root; if (!node) return;
      this.selectNode(node); this.openContextMenu(event.clientX, event.clientY, node);
    }, { signal });

    // One delegated drop surface covers the whole Explorer. Directory rows
    // target themselves; files target their parent; empty space targets root.
    let dropRow = null;
    const clearDropIndicator = () => {
      dropRow?.classList.remove('drop-target'); dropRow = null;
      surface.classList.remove('drop-target-root');
    };
    const finishDragUi = () => clearDropIndicator();
    const cancelStaleProjectDrag = () => {
      clearDropIndicator();
      this.transfers?.endProjectDrag?.();
    };
    // Drag events do not reliably cross iframe/document boundaries in every
    // browser. Treat drag UI as ephemeral and clear it from every lifecycle
    // signal we can observe instead of trusting dragleave.relatedTarget.
    window.addEventListener('psp-drag-session-end', finishDragUi, { signal });
    window.addEventListener('dragend', finishDragUi, { capture: true, signal });
    window.addEventListener('drop', finishDragUi, { capture: true, signal });
    window.addEventListener('blur', finishDragUi, { signal });
    document.addEventListener('pointerdown', cancelStaleProjectDrag, { capture: true, signal });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      cancelStaleProjectDrag();
    }, { capture: true, signal });
    const dropTarget = (event) => {
      const node = eventNode(project, event);
      return node?.isDirectory ? node : node?.parent?.isDirectory ? node.parent : project.root;
    };
    surface.addEventListener('dragover', (event) => {
      if (!hasTransferType(event)) return;
      event.preventDefault();
      const node = eventNode(project, event);
      const nextRow = node?.isDirectory ? event.target.closest('.project-node') : null;
      if (dropRow !== nextRow) { dropRow?.classList.remove('drop-target'); dropRow = nextRow; dropRow?.classList.add('drop-target'); }
      surface.classList.toggle('drop-target-root', !dropRow);
    }, { signal });
    surface.addEventListener('dragleave', (event) => { if (!surface.contains(event.relatedTarget)) clearDropIndicator(); }, { signal });
    surface.addEventListener('drop', async (event) => {
      if (!hasTransferType(event)) return;
      event.preventDefault(); event.stopPropagation();
      const target = dropTarget(event); clearDropIndicator();
      await this.handleDrop(target, event);
    }, { signal });

    tree.addEventListener('click', (event) => {
      const node = eventNode(project, event);
      if (!node) return;
      this.selectedId = node.id;
      if (event.target.closest('[data-toggle]') && node.isDirectory) {
        if (this.expanded.has(node.path)) this.expanded.delete(node.path); else this.expanded.add(node.path);
        this.render(); this.focusTree(); return;
      }
      this.selectNode(node);
    }, { signal });
    tree.addEventListener('dblclick', (event) => {
      const node = eventNode(project, event);
      if (!node) return;
      this.selectNode(node, { focus: false }); this.openSelected();
    }, { signal });
    tree.addEventListener('dragstart', (event) => {
      const node = eventNode(project, event);
      if (!node || node.id === 'root' || !event.dataTransfer) return;
      // Project-to-project drops are moves; project-to-tool drops are copies.
      // copyMove is required so Firefox does not reject a tool's copy drop before
      // the iframe receives its drop event.
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(PROJECT_NODE_MIME, node.id);
      event.dataTransfer.setData('text/plain', node.name);
      this.transfers?.beginProjectDrag?.(node.id);
      console.debug('[PSP Studio DnD] project dragstart', { id: node.id, path: node.path, name: node.name, effectAllowed: event.dataTransfer.effectAllowed });
    }, { signal });
    tree.addEventListener('dragend', (event) => {
      const node = eventNode(project, event);
      const activeId = this.transfers?.activeProjectNodeId?.();
      clearDropIndicator();
      this.transfers?.endProjectDrag?.(node?.id || activeId || null);
      window.dispatchEvent(new Event('psp-drag-session-end'));
      console.debug('[PSP Studio DnD] project dragend', { id: node?.id || activeId || '', dropEffect: event.dataTransfer?.dropEffect || 'none' });
    }, { signal });
  }
}
