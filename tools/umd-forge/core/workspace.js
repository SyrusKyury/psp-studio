let nextNodeId = 1;

const ZERO_MIB_BLOB = new Blob([new Uint8Array(1024 * 1024)]);
function zeroBlob(size) {
  const parts = [];
  for (let left = Math.max(0, size); left > 0; left -= ZERO_MIB_BLOB.size) parts.push(left >= ZERO_MIB_BLOB.size ? ZERO_MIB_BLOB : ZERO_MIB_BLOB.slice(0, left));
  return new Blob(parts, { type: 'application/octet-stream' });
}

function makeNodeFromIso(entry, parent = null) {
  const node = {
    id: `n${nextNodeId++}`,
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    parent,
    children: [],
    sourceEntry: entry,
    file: null,
    added: false,
    renamed: false,
    deleted: false,
    dummy: false,
    dummySize: null,
    trimmed: false,
    linkedTo: null,
    requestedLba: null,
    size: entry.size,
    lba: entry.lba,
    offset: entry.offset,
  };
  if (entry.isDirectory) {
    node.children = entry.children.map((child) => makeNodeFromIso(child, node));
  }
  return node;
}

function clonePathMap(root) {
  const map = new Map();
  const walk = (node) => {
    map.set(node.path, node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return map;
}

function recomputePath(node, parentPath = null) {
  if (!node.parent) node.path = '/';
  else node.path = parentPath === '/' ? `/${node.name}` : `${parentPath}/${node.name}`;
  for (const child of node.children || []) recomputePath(child, node.path);
}

function validateName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('Name cannot be empty.');
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new Error('Name contains invalid path characters.');
  if (new TextEncoder().encode(value).length > 220) throw new Error('Name is too long for this ISO builder.');
  return value;
}

function ensureUnique(parent, name, except = null) {
  const normalized = name.toUpperCase();
  if (parent.children.some((child) => child !== except && child.name.toUpperCase() === normalized)) {
    throw new Error(`An entry named ${name} already exists in this directory.`);
  }
}

function currentSize(node) {
  const source = node?.linkedTo || node;
  if (!source) return 0;
  if (source.dummy) return source.dummySize ?? source.sourceEntry?.size ?? source.size ?? 0;
  return source.file?.size ?? source.sourceEntry?.size ?? source.size ?? 0;
}

function subtreeContains(root, candidate) {
  if (root === candidate) return true;
  return Boolean(root?.isDirectory && root.children.some((child) => subtreeContains(child, candidate)));
}

export class UmdWorkspace {
  constructor(iso) {
    this.iso = iso;
    this.root = makeNodeFromIso(iso.root);
    this.entries = clonePathMap(this.root);
    this.layout = [...this.entries.values()].filter((node) => !node.isDirectory).sort((a, b) => (a.lba ?? Number.MAX_SAFE_INTEGER) - (b.lba ?? Number.MAX_SAFE_INTEGER));
    this.undoStack = [];
    this.redoStack = [];
    this.savedStack = [];
    this.volumeOverrides = Object.create(null);
  }

  #refreshIndex() {
    recomputePath(this.root);
    this.entries = clonePathMap(this.root);
  }

  #commit(op) {
    this.undoStack.push(op);
    this.redoStack.length = 0;
    this.#refreshIndex();
  }


  volumeValue(field) {
    if (Object.prototype.hasOwnProperty.call(this.volumeOverrides, field)) return this.volumeOverrides[field];
    return this.iso.volume?.[field] ?? '';
  }

  volumeMetadata() {
    const fields = ['systemId', 'volumeId', 'volumeSetId', 'publisherId', 'dataPreparerId', 'applicationId', 'copyrightFileId', 'creationDate'];
    return Object.fromEntries(fields.map((field) => [field, this.volumeValue(field)]));
  }

  setVolumeField(field, requestedValue) {
    const limits = { systemId: 32, volumeId: 32, volumeSetId: 128, publisherId: 128, dataPreparerId: 128, applicationId: 128, copyrightFileId: 37, creationDate: 64 };
    if (!Object.prototype.hasOwnProperty.call(limits, field)) throw new Error(`Unsupported ISO metadata field: ${field}`);
    let value = String(requestedValue ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (field === 'creationDate') {
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) throw new Error('Creation date must be a valid date/time, for example 2026-08-15T12:00:00Z.');
      value = date.toISOString();
    } else if (new TextEncoder().encode(value).length > limits[field]) throw new Error(`${field} exceeds the ISO 9660 ${limits[field]}-byte field limit.`);
    const hadPrevious = Object.prototype.hasOwnProperty.call(this.volumeOverrides, field);
    const previous = hadPrevious ? this.volumeOverrides[field] : undefined;
    const original = this.iso.volume?.[field] ?? '';
    if (value === this.volumeValue(field)) return false;
    const apply = (next, has) => { if (has) this.volumeOverrides[field] = next; else delete this.volumeOverrides[field]; };
    apply(value, value !== original);
    const nextHas = Object.prototype.hasOwnProperty.call(this.volumeOverrides, field);
    const next = nextHas ? this.volumeOverrides[field] : undefined;
    this.#commit({
      type: 'volume-metadata', patch: { type: 'volume-metadata', field, value },
      undo: () => apply(previous, hadPrevious), redo: () => apply(next, nextHas),
    });
    return true;
  }

  get(path) { return this.entries.get(path); }
  all() { return [...this.entries.values()]; }
  fileLayout() { return [...this.layout]; }
  layoutPosition(node) { const index = this.layout.indexOf(node); return index < 0 ? null : index; }
  getReplacement(path) {
    const node = this.get(path);
    return node?.file && !node.added ? { entry: node.sourceEntry, file: node.file, changedAt: node.changedAt } : null;
  }
  getNodeFile(node) { return node?.file || null; }

  async readNode(node) {
    if (!node || node.isDirectory) throw new Error('Cannot read a directory as a file.');
    if (node.linkedTo) return this.readNode(node.linkedTo);
    if (node.dummy) {
      const size = node.dummySize ?? node.sourceEntry?.size ?? node.size ?? 0;
      return zeroBlob(size);
    }
    if (node.file) return node.file;
    if (!node.sourceEntry) throw new Error('This file has no source data.');
    return this.iso.readEntry(node.sourceEntry);
  }

  replace(node, file) {
    if (!node || node.isDirectory) throw new Error('Select a file to replace.');
    const previous = { file: node.file, dummy: node.dummy, dummySize: node.dummySize, trimmed: node.trimmed, linkedTo: node.linkedTo };
    node.file = file; node.dummy = false; node.dummySize = null; node.trimmed = false; node.linkedTo = null;
    node.changedAt = Date.now();
    const next = { file, dummy: false, dummySize: null, trimmed: false, linkedTo: null };
    const patchPath = node.path;
    this.#commit({
      type: 'replace',
      patch: { type: 'replace', path: patchPath, file },
      undo: () => Object.assign(node, previous),
      redo: () => Object.assign(node, next),
    });
    return node;
  }


  dummy(node) {
    if (!node || node.isDirectory) throw new Error('Select a file to dummy.');
    const previous = { file: node.file, dummy: node.dummy, dummySize: node.dummySize, trimmed: node.trimmed, linkedTo: node.linkedTo };
    const size = node.linkedTo ? (node.linkedTo.file?.size ?? node.linkedTo.dummySize ?? node.linkedTo.sourceEntry?.size ?? node.linkedTo.size ?? 0) : (node.file?.size ?? node.dummySize ?? node.sourceEntry?.size ?? node.size ?? 0);
    node.file = null; node.dummy = true; node.dummySize = size; node.trimmed = false; node.linkedTo = null;
    const next = { file: null, dummy: true, dummySize: size, trimmed: false, linkedTo: null };
    this.#commit({
      type: 'dummy', patch: { type: 'dummy', path: node.path },
      undo: () => Object.assign(node, previous), redo: () => Object.assign(node, next),
    });
    return node;
  }

  truncate(node) {
    if (!node || node.isDirectory) throw new Error('Select a file to trim.');
    const previous = { file: node.file, dummy: node.dummy, dummySize: node.dummySize, trimmed: node.trimmed, linkedTo: node.linkedTo };
    const empty = new Blob([], { type: 'application/octet-stream' });
    node.file = empty; node.dummy = false; node.dummySize = null; node.trimmed = true; node.linkedTo = null;
    const next = { file: empty, dummy: false, dummySize: null, trimmed: true, linkedTo: null };
    this.#commit({
      type: 'truncate', patch: { type: 'truncate', path: node.path },
      undo: () => Object.assign(node, previous), redo: () => Object.assign(node, next),
    });
    return node;
  }

  relink(node, source) {
    if (!node || node.isDirectory || !source || source.isDirectory) throw new Error('Relink requires two files.');
    if (node === source) throw new Error('A file cannot be relinked to itself.');
    if (!this.layout.includes(source)) throw new Error('Relink source is no longer part of this image. Choose a new source.');
    let cursor = source;
    const seen = new Set();
    while (cursor?.linkedTo) {
      if (cursor === node || seen.has(cursor)) throw new Error('This relink would create a cycle.');
      seen.add(cursor);
      cursor = cursor.linkedTo;
    }
    if (cursor === node) throw new Error('This relink would create a cycle.');
    // UMDGen-style relinking aliases the target directory record to the source
    // extent.  The target's previous allocation is not a limit: on rebuild the
    // representative is placed once and every alias receives its resulting LBA
    // and logical size.  This is important for real BOOT.BIN/EBOOT.BIN relink
    // workflows and for fan patches where replacement data grows.
    const previous = { linkedTo: node.linkedTo, file: node.file, dummy: node.dummy, dummySize: node.dummySize, trimmed: node.trimmed };
    node.linkedTo = source; node.file = null; node.dummy = false; node.dummySize = null; node.trimmed = false;
    const next = { linkedTo: source, file: null, dummy: false, dummySize: null, trimmed: false };
    this.#commit({
      type: 'relink',
      patch: { type: 'relink', path: node.path, sourcePath: source.path },
      undo: () => Object.assign(node, previous),
      redo: () => Object.assign(node, next),
    });
    return node;
  }

  clearRelink(node) {
    if (!node?.linkedTo) return false;
    const previous = node.linkedTo; node.linkedTo = null;
    this.#commit({ type: 'unlink', patch: { type: 'unlink', path: node.path }, undo: () => { node.linkedTo = previous; }, redo: () => { node.linkedTo = null; } });
    return true;
  }

  addFile(parent, file) {
    if (!parent?.isDirectory) throw new Error('Select a directory first.');
    const name = validateName(file.name);
    ensureUnique(parent, name);
    const node = {
      id: `n${nextNodeId++}`, name, path: '', isDirectory: false, parent, children: [],
      sourceEntry: null, file, added: true, renamed: false, deleted: false, dummy: false, dummySize: null, trimmed: false, linkedTo: null, requestedLba: null,
      size: file.size, lba: null, offset: null,
    };
    const index = parent.children.length;
    const layoutIndex = this.layout.length;
    parent.children.push(node); this.layout.push(node);
    const patchParentPath = parent.path;
    this.#commit({
      type: 'add-file',
      patch: { type: 'add-file', parentPath: patchParentPath, name, file },
      undo: () => { parent.children.splice(parent.children.indexOf(node), 1); const li = this.layout.indexOf(node); if (li >= 0) this.layout.splice(li, 1); },
      redo: () => { parent.children.splice(Math.min(index, parent.children.length), 0, node); this.layout.splice(Math.min(layoutIndex, this.layout.length), 0, node); },
    });
    return node;
  }

  addDirectory(parent, requestedName) {
    if (!parent?.isDirectory) throw new Error('Select a directory first.');
    const name = validateName(requestedName);
    ensureUnique(parent, name);
    const node = {
      id: `n${nextNodeId++}`, name, path: '', isDirectory: true, parent, children: [],
      sourceEntry: null, file: null, added: true, renamed: false, deleted: false, dummy: false, dummySize: null, trimmed: false, linkedTo: null, requestedLba: null,
      size: 0, lba: null, offset: null,
    };
    const index = parent.children.length;
    parent.children.push(node);
    const patchParentPath = parent.path;
    this.#commit({
      type: 'add-directory',
      patch: { type: 'add-directory', parentPath: patchParentPath, name },
      undo: () => { parent.children.splice(parent.children.indexOf(node), 1); },
      redo: () => { parent.children.splice(Math.min(index, parent.children.length), 0, node); },
    });
    return node;
  }

  rename(node, requestedName) {
    if (!node || node === this.root) throw new Error('The ISO root cannot be renamed.');
    const name = validateName(requestedName);
    ensureUnique(node.parent, name, node);
    const previous = node.name;
    if (previous === name) return node;
    const patchPath = node.path;
    node.name = name;
    node.renamed = true;
    this.#commit({
      type: 'rename',
      patch: { type: 'rename', path: patchPath, newName: name },
      undo: () => { node.name = previous; node.renamed = node.sourceEntry ? node.name !== node.sourceEntry.name : true; },
      redo: () => { node.name = name; node.renamed = true; },
    });
    return node;
  }

  delete(node) {
    if (!node || node === this.root) throw new Error('The ISO root cannot be deleted.');
    const dependent = this.layout.find((candidate) => candidate.linkedTo && subtreeContains(node, candidate.linkedTo) && !subtreeContains(node, candidate));
    if (dependent) throw new Error(`Cannot delete ${node.name}: ${dependent.path} is relinked to data inside it. Remove that relink first.`);
    const parent = node.parent;
    const index = parent.children.indexOf(node);
    if (index < 0) return false;
    const subtreeFiles = [];
    const collect = (current) => { if (current.isDirectory) current.children.forEach(collect); else subtreeFiles.push(current); };
    collect(node);
    const layoutSnapshot = subtreeFiles.map((file) => ({ file, index: this.layout.indexOf(file) })).filter((item) => item.index >= 0).sort((a,b) => a.index - b.index);
    const patchPath = node.path;
    parent.children.splice(index, 1);
    for (const item of [...layoutSnapshot].sort((a,b) => b.index-a.index)) this.layout.splice(item.index, 1);
    this.#commit({
      type: 'delete',
      patch: { type: 'delete', path: patchPath },
      undo: () => { parent.children.splice(Math.min(index, parent.children.length), 0, node); for (const item of layoutSnapshot) this.layout.splice(Math.min(item.index, this.layout.length), 0, item.file); },
      redo: () => { const i = parent.children.indexOf(node); if (i >= 0) parent.children.splice(i, 1); for (const item of [...layoutSnapshot].sort((a,b) => b.index-a.index)) { const li=this.layout.indexOf(item.file); if(li>=0)this.layout.splice(li,1); } },
    });
    return true;
  }

  moveLayout(node, delta) {
    if (!node || node.isDirectory) throw new Error('Select a file to change its disc layout order.');
    const from = this.layout.indexOf(node); if (from < 0) throw new Error('File is not present in the layout.');
    const to = Math.max(0, Math.min(this.layout.length - 1, from + Math.sign(delta || 0)));
    if (to === from) return false;
    const swap = (a,b) => { const tmp=this.layout[a]; this.layout[a]=this.layout[b]; this.layout[b]=tmp; };
    swap(from,to);
    this.#commit({ type:'layout-order', undo:()=>swap(from,to), redo:()=>swap(from,to) });
    return true;
  }

  setRequestedLbas(items) {
    const previous = this.layout.map((node) => [node, node.requestedLba]);
    const requested = new Map((items || []).map((item) => [item.path, Number(item.lba)]));
    let changed = false;
    for (const node of this.layout) {
      const next = requested.has(node.path) && Number.isInteger(requested.get(node.path)) && requested.get(node.path) >= 0 ? requested.get(node.path) : null;
      if (node.requestedLba !== next) changed = true;
      node.requestedLba = next;
    }
    if (!changed) return false;
    const nextState = this.layout.map((node) => [node, node.requestedLba]);
    const apply = (pairs) => { for (const [node, value] of pairs) node.requestedLba = value; };
    this.#commit({
      type: 'lba-map',
      patch: { type: 'lba-map', items: this.layout.filter((n) => n.requestedLba != null).map((n) => ({ path: n.path, lba: n.requestedLba })) },
      undo: () => apply(previous), redo: () => apply(nextState),
    });
    return true;
  }

  clearRequestedLbas() {
    return this.setRequestedLbas([]);
  }

  setLayoutOrder(paths) {
    const previous = [...this.layout];
    const requested = [];
    const seen = new Set();
    for (const path of paths || []) {
      const node = this.get(path);
      if (node && !node.isDirectory && !seen.has(node)) { requested.push(node); seen.add(node); }
    }
    for (const node of this.layout) if (!seen.has(node)) requested.push(node);
    if (requested.length !== this.layout.length) throw new Error('Patch layout does not match the current ISO workspace.');
    const same = requested.every((node, index) => node === this.layout[index]);
    if (same) return false;
    this.layout = requested;
    const next = [...requested];
    this.#commit({ type: 'layout-order-set', undo: () => { this.layout = [...previous]; }, redo: () => { this.layout = [...next]; } });
    return true;
  }

  estimatedRebuiltSize() {
    const directoryOverhead = 512 * 1024;
    const seen = new Set();
    let bytes = directoryOverhead;
    for (const node of this.layout) {
      let source = node;
      const chain = new Set();
      while (source?.linkedTo) {
        if (chain.has(source)) break;
        chain.add(source); source = source.linkedTo;
      }
      if (!source || seen.has(source)) continue;
      seen.add(source);
      bytes += Math.ceil(currentSize(source) / 2048) * 2048;
    }
    return bytes;
  }

  exportPatchPlan() {
    return {
      operations: this.undoStack.filter((op) => op.patch).map((op) => ({ ...op.patch })),
      layout: this.layout.map((node) => node.path),
      layoutChanged: this.undoStack.some((op) => op.type === 'layout-order' || op.type === 'layout-order-set'),
    };
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return false;
    op.undo();
    this.redoStack.push(op);
    this.#refreshIndex();
    return true;
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return false;
    op.redo();
    this.undoStack.push(op);
    this.#refreshIndex();
    return true;
  }

  get changedCount() {
    let common = 0;
    const max = Math.min(this.undoStack.length, this.savedStack.length);
    while (common < max && this.undoStack[common] === this.savedStack[common]) common++;
    return (this.undoStack.length - common) + (this.savedStack.length - common);
  }
  get isDirty() { return this.changedCount > 0; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  markSaved() { this.savedStack = [...this.undoStack]; }

  needsFullRebuild() {
    if (this.iso.format !== 'iso') return true;
    if (this.undoStack.some((op) => op.type !== 'replace')) return true;
    return this.all().some((node) => node.file && node.sourceEntry && node.file.size > node.sourceEntry.size);
  }
}
