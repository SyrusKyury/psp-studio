import { createStoredZip, readZip } from '../../shared/archive/zip-store.js?v=0.14.5';
import { isBlobLike, toRealmBlob } from './blob-utils.js?v=0.14.5';

const PROJECT_FORMAT = 'psp-modding-studio-project';
const PROJECT_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROJECT_ENTRIES = 50000;
const MAX_PROJECT_DEPTH = 128;
const MAX_NODE_NAME_CHARS = 1024;
const MAX_SAVED_TABS = 256;
const MAX_PINNED_TOOLS = 256;
const MAX_SUGGESTED_TOOLS = 32;
const MAX_FILE_ASSOCIATIONS = 1024;
const MAX_PROJECT_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_INFLATED_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_PROJECT_INFLATED_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PROJECT_PAYLOAD_BYTES = MAX_PROJECT_INFLATED_TOTAL_BYTES - MAX_MANIFEST_BYTES;
const MAX_ZIP_ENTRY_NAME_BYTES = 0xFFFF;
const pathEncoder = new TextEncoder();
const TOOL_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const projectIndexes = new WeakMap();
function indexes(project) { return projectIndexes.get(project); }

function id() { return globalThis.crypto?.randomUUID?.() || `node-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function cleanName(name) {
  const value = String(name ?? '').replace(/[\\/\x00-\x1F\x7F]/g, '').trim();
  return value === '.' || value === '..' ? '' : value;
}
function safeProjectFileStem(name) { return String(name || 'project').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'project'; }
function normalizeProjectName(name, fallback = 'Untitled Project') {
  const clean = (value) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 256);
  return clean(name) || clean(fallback) || 'Untitled Project';
}
function normalizeNodeName(name) {
  const value = cleanName(name);
  if (value.length > MAX_NODE_NAME_CHARS) throw new Error(`Name exceeds the ${MAX_NODE_NAME_CHARS}-character safety limit.`);
  return value;
}
function nodeDepth(node) { let depth = 0; for (let cursor = node; cursor?.parent; cursor = cursor.parent) depth += 1; return depth; }
function* walkSubtree(node) {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop(); yield current;
    for (let index = (current.children?.length || 0) - 1; index >= 0; index -= 1) stack.push(current.children[index]);
  }
}
function subtreeDepth(node) {
  let max = 0; const stack = [[node, 0]];
  while (stack.length) { const [current, depth] = stack.pop(); if (depth > max) max = depth; for (const child of current.children || []) stack.push([child, depth + 1]); }
  return max;
}
function assertBlobLike(value) {
  if (!isBlobLike(value)) throw new Error('Project file content must be a Blob or File.');
  if (value.size > MAX_PROJECT_INFLATED_ENTRY_BYTES) throw new Error(`Project files cannot exceed ${MAX_PROJECT_INFLATED_ENTRY_BYTES} bytes.`);
}
function detachProjectBlob(value) {
  const blob = toRealmBlob(value, globalThis);
  if (!blob) throw new Error('Project file content must be a real Blob or File.');
  return blob;
}
function subtreeBytes(node) { let total = 0; for (const current of walkSubtree(node)) if (!current.isDirectory) total += current.blob.size; return total; }
function validPathParts(parts) { return parts.length > 0 && parts.length <= MAX_PROJECT_DEPTH && parts.every((part) => part && part.length <= MAX_NODE_NAME_CHARS && cleanName(part) === part); }
function safeWorkspacePath(name) {
  const raw = String(name || '');
  if (!raw.startsWith('workspace/') || raw.includes('\\') || raw.includes('\0') || /^workspace\/\//.test(raw)) throw new Error(`Unsafe project path: ${raw || '(empty)'}`);
  const directory = raw.endsWith('/');
  const relative = raw.slice('workspace/'.length).replace(/\/$/, '');
  if (!relative) return { relative: '', directory, parts: [] };
  const parts = relative.split('/');
  if (!validPathParts(parts)) throw new Error(`Unsafe project path: ${raw}`);
  return { relative, directory, parts };
}
function normalizeTabPath(value) { const path = canonicalProjectPath(value); return path && path !== '/' ? path : null; }
export function savedTabKey({ editorId = '', filePath = '', title = '' } = {}) { return filePath ? `${editorId}\n${filePath}` : `${editorId}\n\n${title || ''}`; }
function canonicalProjectPath(value) {
  if (value === '/') return '/';
  if (typeof value !== 'string' || !value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\0')) return null;
  const parts = value.slice(1).split('/');
  if (!validPathParts(parts) || pathEncoder.encode(`workspace${value}/`).byteLength > MAX_ZIP_ENTRY_NAME_BYTES) return null;
  return value;
}
function normalizeTabs(value) {
  if (!Array.isArray(value)) return [];
  const out = []; const seen = new Set();
  for (const tab of value) {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab) || typeof tab.editorId !== 'string') continue;
    const editorId = normalizeToolId(tab.editorId);
    if (!editorId) continue;
    const declaresFilePath = tab.filePath !== undefined && tab.filePath !== null && tab.filePath !== '';
    const filePath = normalizeTabPath(tab.filePath);
    if (declaresFilePath && !filePath) continue;
    const title = typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim().slice(0, 512) : null;
    const key = savedTabKey({ editorId, filePath, title });
    if (seen.has(key)) continue;
    seen.add(key); out.push({ editorId, filePath, title });
    if (out.length >= MAX_SAVED_TABS) break;
  }
  return out;
}
function validAssociationKey(key) {
  return typeof key === 'string' && (/^ext:\.[^/\\\x00-\x1F\x7F]+$/i.test(key) || /^name:[^/\\\x00-\x1F\x7F]+$/i.test(key));
}
function normalizeToolId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 && TOOL_ID_RE.test(id) ? id : '';
}
function normalizeToolList(value, limit) {
  const out = []; const seen = new Set();
  if (Array.isArray(value)) for (const raw of value) {
    const id = normalizeToolId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id);
    if (out.length >= limit) break;
  }
  return Object.freeze(out);
}
function freezeWorkspace(value = {}) {
  const pinnedTools = normalizeToolList(value?.pinnedTools, MAX_PINNED_TOOLS);
  const suggestedTools = normalizeToolList(value?.suggestedTools, MAX_SUGGESTED_TOOLS);
  const fileAssociations = {};
  if (value?.fileAssociations && typeof value.fileAssociations === 'object' && !Array.isArray(value.fileAssociations)) {
    let count = 0;
    for (const [key, toolId] of Object.entries(value.fileAssociations)) {
      if (count >= MAX_FILE_ASSOCIATIONS) break;
      if (!validAssociationKey(key) || key.length > 512) continue;
      const id = normalizeToolId(toolId); if (!id) continue;
      fileAssociations[key.toLowerCase()] = id; count += 1;
    }
  }
  return Object.freeze({ pinnedTools, suggestedTools, fileAssociations: Object.freeze(fileAssociations) });
}

function childPath(parent, name) { return `${parent.path === '/' ? '' : parent.path}/${name}`; }

function ensureCapacity(project, additional = 1) {
  const count = Number(additional);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid project entry count.');
  if ((indexes(project).byId.size - 1) + count > MAX_PROJECT_ENTRIES) throw new Error(`Project exceeds the ${MAX_PROJECT_ENTRIES}-entry safety limit.`);
}
function registerNode(project, node) {
  if (!node || indexes(project).byId.has(node.id)) throw new Error('Project node identity collision.');
  const path = canonicalProjectPath(node.path);
  if (!path) throw new Error(`Project path exceeds format limits: ${node?.path || '(invalid)'}`);
  if (indexes(project).byPath.has(path)) throw new Error(`Project node path collision: ${path}`);
  indexes(project).byId.set(node.id, node); indexes(project).byPath.set(path, node);
}
function unregisterSubtree(project, node) {
  for (const current of walkSubtree(node)) if (indexes(project).byId.get(current.id) === current) {
    indexes(project).byId.delete(current.id);
    if (indexes(project).byPath.get(current.path) === current) indexes(project).byPath.delete(current.path);
  }
}
function unindexSubtree(project, node) {
  for (const current of walkSubtree(node)) if (indexes(project).byPath.get(current.path) === current) indexes(project).byPath.delete(current.path);
}
function reindexSubtree(project, node) {
  const pending = []; const seen = new Set();
  for (const current of walkSubtree(node)) {
    const path = canonicalProjectPath(current.path);
    if (!path) throw new Error(`Project path exceeds format limits: ${current.path || '(invalid)'}`);
    if (seen.has(path) || (indexes(project).byPath.has(path) && indexes(project).byPath.get(path) !== current)) throw new Error(`Project node path collision: ${path}`);
    seen.add(path); pending.push([path, current]);
  }
  for (const [path, current] of pending) indexes(project).byPath.set(path, current);
}
function resolveNode(project, nodeOrPath) {
  if (typeof nodeOrPath === 'string') return project.get(nodeOrPath);
  return project.owns(nodeOrPath) ? nodeOrPath : null;
}
function uniqueName(project, parent, requested, reserved = null) {
  const base = normalizeNodeName(requested) || 'Untitled';
  const available = (name) => {
    const path = childPath(parent, name);
    if (!canonicalProjectPath(path)) throw new Error(`Project path exceeds format limits: ${path}`);
    return !indexes(project).byPath.has(path) && !reserved?.has(path);
  };
  if (available(base)) return base;
  const dot = base.lastIndexOf('.'); const stem = dot > 0 ? base.slice(0, dot) : base; const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`; const room = MAX_NODE_NAME_CHARS - suffix.length - ext.length;
    const candidate = room > 0 ? `${stem.slice(0, room)}${suffix}${ext}` : `${base.slice(0, MAX_NODE_NAME_CHARS - suffix.length)}${suffix}`;
    if (available(candidate)) return candidate;
  }
}

function insertFolder(project, parentPath, name, { silent = false } = {}) {
  const parent = project.get(parentPath);
  if (!parent?.isDirectory) throw new Error('Target is not a folder.');
  if (nodeDepth(parent) >= MAX_PROJECT_DEPTH) throw new Error(`Project nesting exceeds the ${MAX_PROJECT_DEPTH}-level safety limit.`);
  ensureCapacity(project, 1);
  const node = new ProjectNode({ name: uniqueName(project, parent, name), parent });
  registerNode(project, node); parent.children.push(node);
  if (!silent) project.touch('folder-created');
  return node;
}


class ProjectNode {
  constructor({ name, blob = null, parent = null, nodeId = id() }) {
    this.id = nodeId; this.name = name; this.blob = blob; this.parent = parent; this.children = blob === null ? [] : null;
  }
  get isDirectory() { return this.children !== null; }
  get path() {
    if (!this.parent) return '/';
    const parts = []; let node = this;
    while (node.parent) { parts.unshift(node.name); node = node.parent; }
    return `/${parts.join('/')}`;
  }
}

export class ProjectStore extends EventTarget {
  static createNew(name = 'Untitled Project') {
    const project = new ProjectStore(name);
    project.#workspace = freezeWorkspace({ pinnedTools: ['umd-forge'] });
    return project;
  }

  #name;
  #workspace = freezeWorkspace();
  #revision = 0;
  #savedRevision = 0;
  #payloadBytes = 0;
  #fileName;
  #fileHandle = null;

  constructor(name = 'Untitled Project') {
    super();
    this.#name = normalizeProjectName(name);
    this.root = new ProjectNode({ name: '', parent: null, nodeId: 'root' });
    projectIndexes.set(this, { byId: new Map([[this.root.id, this.root]]), byPath: new Map([['/', this.root]]) });
    this.#fileName = `${safeProjectFileStem(this.#name)}.pspstudio`;
  }

  get name() { return this.#name; }
  get workspace() { return this.#workspace; }
  get revision() { return this.#revision; }
  get dirty() { return this.#revision !== this.#savedRevision; }

  #ensurePayload(additional = 0) {
    const bytes = Number(additional);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid project payload size.');
    if (this.#payloadBytes + bytes > MAX_PROJECT_PAYLOAD_BYTES) throw new Error(`Project file payloads exceed the ${MAX_PROJECT_PAYLOAD_BYTES}-byte safety limit.`);
  }
  #markSaved(expectedRevision = this.#revision) {
    const clean = expectedRevision === this.#revision;
    if (clean) this.#savedRevision = this.#revision;
    this.dispatchEvent(new CustomEvent('saved', { detail: { clean, revision: this.#revision, expectedRevision } }));
    return clean;
  }
  touch(reason = 'changed') { this.#revision += 1; this.dispatchEvent(new CustomEvent('change', { detail: { reason, revision: this.#revision } })); }

  pinTool(toolId) {
    const id = normalizeToolId(toolId);
    if (!id || this.#workspace.pinnedTools.includes(id) || this.#workspace.pinnedTools.length >= MAX_PINNED_TOOLS) return false;
    this.#workspace = freezeWorkspace({ ...this.#workspace, pinnedTools: [...this.#workspace.pinnedTools, id] });
    this.touch('tool-pinned'); return true;
  }
  unpinTool(toolId) {
    if (!this.#workspace.pinnedTools.includes(toolId)) return false;
    this.#workspace = freezeWorkspace({ ...this.#workspace, pinnedTools: this.#workspace.pinnedTools.filter((id) => id !== toolId) });
    this.touch('tool-unpinned'); return true;
  }
  suggestTool(toolId) {
    const id = normalizeToolId(toolId);
    if (!id || this.#workspace.suggestedTools[0] === id) return false;
    this.#workspace = freezeWorkspace({ ...this.#workspace, suggestedTools: [id, ...this.#workspace.suggestedTools.filter((item) => item !== id)] });
    this.touch('tool-suggested'); return true;
  }
  setFileAssociation(key, toolId) {
    const normalizedKey = String(key || '').trim().toLowerCase(); const id = normalizeToolId(toolId);
    if (!validAssociationKey(normalizedKey) || normalizedKey.length > 512 || !id) return false;
    const current = this.#workspace.fileAssociations;
    if (!(normalizedKey in current) && Object.keys(current).length >= MAX_FILE_ASSOCIATIONS) return false;
    if (current[normalizedKey] === id) return false;
    this.#workspace = freezeWorkspace({ ...this.#workspace, fileAssociations: { ...current, [normalizedKey]: id } });
    this.touch('file-association-changed'); return true;
  }
  get(path) { return indexes(this).byPath.get(canonicalProjectPath(path)) || null; }
  byId(nodeId) { return indexes(this).byId.get(nodeId) || null; }
  owns(node) { return Boolean(node && indexes(this).byId.get(node.id) === node && indexes(this).byPath.get(node.path) === node); }
  createFolder(parentPath = '/', name = 'New Folder', options = {}) { return insertFolder(this, parentPath, name, options); }
  addBlob(parentPath, name, blob, options = {}) { return this.addBlobs(parentPath, [{ name, blob }], options)[0]; }
  addBlobs(parentPath, entries, { silent = false } = {}) {
    const parent = this.get(parentPath);
    if (!parent?.isDirectory) throw new Error('Target is not a folder.');
    if (nodeDepth(parent) >= MAX_PROJECT_DEPTH) throw new Error(`Project nesting exceeds the ${MAX_PROJECT_DEPTH}-level safety limit.`);
    const items = Array.from(entries || []); if (!items.length) return [];
    ensureCapacity(this, items.length);
    let bytes = 0;
    for (const item of items) { assertBlobLike(item?.blob); bytes += item.blob.size; }
    this.#ensurePayload(bytes);
    const reserved = new Set();
    const plan = items.map((item) => {
      const name = uniqueName(this, parent, item?.name, reserved);
      reserved.add(childPath(parent, name)); return { name, blob: detachProjectBlob(item.blob) };
    });
    const created = [];
    try {
      for (const item of plan) {
        const node = new ProjectNode({ ...item, parent });
        registerNode(this, node); parent.children.push(node); created.push(node);
      }
    } catch (error) {
      for (const node of created) { indexes(this).byId.delete(node.id); indexes(this).byPath.delete(node.path); node.parent = null; }
      parent.children = parent.children.filter((node) => !created.includes(node));
      throw error;
    }
    this.#payloadBytes += bytes;
    if (!silent) this.touch(items.length === 1 ? 'file-added' : 'files-added');
    return created;
  }
  remove(nodeOrPath) {
    const node = resolveNode(this, nodeOrPath); if (!node?.parent) return false;
    const parent = node.parent;
    this.#payloadBytes -= subtreeBytes(node);
    parent.children = parent.children.filter((child) => child !== node);
    unregisterSubtree(this, node);
    node.parent = null;
    this.touch('removed'); return true;
  }
  rename(nodeOrPath, newName) {
    const node = resolveNode(this, nodeOrPath); if (!node?.parent) return false;
    const clean = normalizeNodeName(newName); if (!clean) throw new Error('Name cannot be empty.');
    if (clean === node.name) return false;
    const targetPath = childPath(node.parent, clean);
    const collision = indexes(this).byPath.get(targetPath);
    if (collision && collision !== node) throw new Error('A file or folder with that name already exists.');
    unindexSubtree(this, node);
    const previousName = node.name; node.name = clean;
    try { reindexSubtree(this, node); }
    catch (error) { node.name = previousName; reindexSubtree(this, node); throw error; }
    this.touch('renamed'); return true;
  }
  move(nodeOrPath, targetFolderOrPath) {
    const node = resolveNode(this, nodeOrPath); const target = resolveNode(this, targetFolderOrPath);
    if (!node?.parent || !target?.isDirectory || node === target || node.parent === target) return false;
    for (let cursor = target; cursor; cursor = cursor.parent) if (cursor === node) throw new Error('Cannot move a folder into itself.');
    if (nodeDepth(target) + 1 + subtreeDepth(node) > MAX_PROJECT_DEPTH) throw new Error(`Move would exceed the ${MAX_PROJECT_DEPTH}-level project nesting limit.`);
    const oldParent = node.parent; const oldName = node.name; const nextName = uniqueName(this, target, node.name);
    unindexSubtree(this, node);
    oldParent.children = oldParent.children.filter((child) => child !== node); node.parent = target; node.name = nextName; target.children.push(node);
    try { reindexSubtree(this, node); }
    catch (error) {
      target.children = target.children.filter((child) => child !== node); node.parent = oldParent; node.name = oldName; oldParent.children.push(node); reindexSubtree(this, node); throw error;
    }
    this.touch('moved'); return true;
  }

  insertSnapshot(targetFolderOrPath, snapshot, { silent = false } = {}) {
    const target = resolveNode(this, targetFolderOrPath);
    if (!target?.isDirectory) throw new Error('Target is not a folder.');
    let snapshotCount = 0; let snapshotBytes = 0;
    const validate = (item, depth = 1) => {
      snapshotCount += 1;
      if (depth + nodeDepth(target) > MAX_PROJECT_DEPTH) throw new Error(`Project nesting exceeds the ${MAX_PROJECT_DEPTH}-level safety limit.`);
      if (!item || !['file', 'folder'].includes(item.kind) || !normalizeNodeName(item.name)) throw new Error('Invalid project clipboard item.');
      if (item.kind === 'file') { assertBlobLike(item.blob); snapshotBytes += item.blob.size; return; }
      if (item.children != null && !Array.isArray(item.children)) throw new Error('Invalid project clipboard folder.');
      for (const child of item.children || []) validate(child, depth + 1);
    };
    validate(snapshot);
    ensureCapacity(this, snapshotCount); this.#ensurePayload(snapshotBytes);
    let firstInserted = null;
    const insert = (parent, item) => {
      const node = new ProjectNode({ name: uniqueName(this, parent, item.name), blob: item.kind === 'file' ? detachProjectBlob(item.blob) : null, parent });
      registerNode(this, node); parent.children.push(node);
      firstInserted ||= node;
      for (const child of item.children || []) insert(node, child);
      return node;
    };
    let created;
    try { created = insert(target, snapshot); }
    catch (error) {
      if (firstInserted && this.owns(firstInserted)) {
        target.children = target.children.filter((node) => node !== firstInserted);
        unregisterSubtree(this, firstInserted); firstInserted.parent = null;
      }
      throw error;
    }
    this.#payloadBytes += snapshotBytes;
    if (!silent) this.touch('pasted');
    return created;
  }
  async toZipBlob({ tabs = [], onProgress } = {}) {
    const manifest = {
      format: PROJECT_FORMAT, version: PROJECT_VERSION, name: this.name, savedAt: new Date().toISOString(),
      workspace: this.workspace,
      tabs: normalizeTabs(tabs),
    };
    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    if (manifestBlob.size > MAX_MANIFEST_BYTES) throw new Error(`Project manifest exceeds the ${MAX_MANIFEST_BYTES}-byte safety limit.`);
    const entries = [{ name: 'project.json', blob: manifestBlob }];
    for (const node of walkSubtree(this.root)) {
      if (node === this.root) continue;
      const relative = node.path.replace(/^\//, '');
      if (node.isDirectory) entries.push({ name: `workspace/${relative}/`, blob: new Blob([]) });
      else entries.push({ name: `workspace/${relative}`, blob: node.blob });
    }
    return createStoredZip(entries, { onProgress, maxCentralDirectoryBytes: MAX_PROJECT_CENTRAL_DIRECTORY_BYTES });
  }

  async save({ tabs = [], onProgress } = {}) {
    const suggestedName = this.#fileName || `${safeProjectFileStem(this.name)}.pspstudio`;
    const canUseNativePicker = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

    // Acquire a new file handle before expensive ZIP generation while the user
    // activation from the Save command is still fresh. Existing handles do not
    // need another picker interaction.
    if (canUseNativePicker && !this.#fileHandle) {
      try {
        this.#fileHandle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'PSP Modding Studio Project', accept: { 'application/zip': ['.pspstudio'] } }] });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        this.#fileHandle = null;
        console.warn('Native project save picker failed; falling back to a browser download.', error);
      }
    }

    const revisionAtSnapshot = this.#revision;
    const zip = await this.toZipBlob({ tabs, onProgress });
    if (this.#fileHandle) {
      let writable = null;
      try {
        writable = await this.#fileHandle.createWritable(); await writable.write(zip); await writable.close();
        writable = null;
        this.#fileName = this.#fileHandle.name || suggestedName; const clean = this.#markSaved(revisionAtSnapshot); return { mode: 'filesystem', name: this.#fileName, clean };
      } catch (error) {
        try { await writable?.abort?.(); } catch { /* best-effort rollback of a failed native write */ }
        if (error?.name === 'AbortError') throw error;
        this.#fileHandle = null;
        console.warn('Native project save failed; falling back to a browser download.', error);
      }
    }
    const url = URL.createObjectURL(zip); const a = document.createElement('a'); a.href = url; a.download = suggestedName; a.hidden = true;
    try { document.body.appendChild(a); a.click(); }
    finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
    this.#fileName = suggestedName; const clean = this.#markSaved(revisionAtSnapshot); return { mode: 'download', name: suggestedName, clean };
  }

  static async open(file) {
    if (!isBlobLike(file)) throw new Error('Project input must be a file.');
    const source = detachProjectBlob(file);
    const entries = await readZip(source, { maxEntries: MAX_PROJECT_ENTRIES + 1, maxCentralDirectoryBytes: MAX_PROJECT_CENTRAL_DIRECTORY_BYTES, maxInflatedEntryBytes: MAX_PROJECT_INFLATED_ENTRY_BYTES, maxInflatedTotalBytes: MAX_PROJECT_INFLATED_TOTAL_BYTES });
    let manifestEntry = null; const workspaceEntries = [];
    for (const entry of entries) {
      if (entry.name === 'project.json') {
        if (manifestEntry) throw new Error('Project contains duplicate project.json entries.');
        manifestEntry = entry;
      } else if (entry.name === 'workspace/') continue;
      else if (entry.name.startsWith('workspace/')) workspaceEntries.push(entry);
      else throw new Error(`Unexpected project archive entry: ${entry.name}`);
    }
    if (!manifestEntry) throw new Error('This ZIP is not a PSP Modding Studio project.');
    if (manifestEntry.blob.size > MAX_MANIFEST_BYTES) throw new Error('Project manifest is unexpectedly large.');
    let rawManifest;
    try { rawManifest = JSON.parse(await manifestEntry.blob.text()); }
    catch { throw new Error('Project manifest is not valid JSON.'); }
    if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) throw new Error('Invalid project manifest.');
    if (rawManifest.format !== PROJECT_FORMAT || rawManifest.version !== PROJECT_VERSION) throw new Error(`Unsupported project format/version: ${rawManifest.format || 'unknown'} v${rawManifest.version ?? '?'}.`);
    if (rawManifest.name != null && typeof rawManifest.name !== 'string') throw new Error('Invalid project manifest: name must be a string.');

    const fallbackName = typeof file.name === 'string' ? file.name.replace(/\.pspstudio$/i, '') : 'Project';
    const manifest = Object.freeze({
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: normalizeProjectName(rawManifest.name, fallbackName),
      savedAt: typeof rawManifest.savedAt === 'string' ? rawManifest.savedAt.slice(0, 128) : null,
      workspace: freezeWorkspace(rawManifest.workspace || {}),
      tabs: Object.freeze(normalizeTabs(rawManifest.tabs).map((tab) => Object.freeze(tab))),
    });
    const project = new ProjectStore(manifest.name);
    project.#fileName = typeof file.name === 'string' && file.name ? file.name : `${safeProjectFileStem(project.name)}.pspstudio`;
    project.#workspace = manifest.workspace;

    const logicalNodes = new Map();
    for (const entry of workspaceEntries) {
      const { directory, parts } = safeWorkspacePath(entry.name);
      for (let index = 0; index < parts.length; index += 1) {
        const path = parts.slice(0, index + 1).join('/');
        const kind = index === parts.length - 1 && !directory ? 'file' : 'folder';
        const existing = logicalNodes.get(path);
        if (existing && existing.kind !== kind) throw new Error(`Project path has conflicting file/folder roles: /${path}`);
        if (!existing) logicalNodes.set(path, { kind, blob: kind === 'file' ? entry.blob : null });
        if (logicalNodes.size > MAX_PROJECT_ENTRIES) throw new Error(`Project exceeds the ${MAX_PROJECT_ENTRIES}-entry safety limit after implicit directories are resolved.`);
      }
    }
    for (const [relative, item] of logicalNodes) {
      const slash = relative.lastIndexOf('/');
      const parent = slash < 0 ? '/' : `/${relative.slice(0, slash)}`;
      const name = relative.slice(slash + 1);
      if (item.kind === 'folder') project.createFolder(parent, name, { silent: true });
      else project.addBlob(parent, name, item.blob, { silent: true });
    }
    return { project, manifest };
  }
}
