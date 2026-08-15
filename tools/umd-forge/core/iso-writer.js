import { SECTOR_SIZE } from './iso-reader.js';

const encoder = new TextEncoder();
const ZERO_SECTOR = new Uint8Array(SECTOR_SIZE);
const ZERO_MIB_BLOB = new Blob([new Uint8Array(1024 * 1024)]);
function zeroBlob(size) { const parts = []; for (let left = Math.max(0, size); left > 0; left -= ZERO_MIB_BLOB.size) parts.push(left >= ZERO_MIB_BLOB.size ? ZERO_MIB_BLOB : ZERO_MIB_BLOB.slice(0, left)); return new Blob(parts); }

function align(value, alignment) { return Math.ceil(value / alignment) * alignment; }
function sectors(bytes) { return Math.max(1, Math.ceil(bytes / SECTOR_SIZE)); }

function writeBothU16(view, offset, value) {
  view.setUint16(offset, value, true);
  view.setUint16(offset + 2, value, false);
}
function writeBothU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, value >>> 0, false);
}


function isoDate17(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n, width=2) => String(n).padStart(width, '0');
  const text = `${pad(date.getUTCFullYear(),4)}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(Math.floor(date.getUTCMilliseconds()/10))}`;
  const out = new Uint8Array(17); out.set(encoder.encode(text), 0); out[16] = 0; return out;
}

function isoDate7(date = new Date()) {
  date = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(date.getTime())) date = new Date();
  return new Uint8Array([
    Math.max(0, Math.min(255, date.getUTCFullYear() - 1900)),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]);
}

function nodeDate(node) {
  if (node?.sourceEntry?.recordedAt) return new Date(node.sourceEntry.recordedAt);
  if (node?.file?.lastModified) return new Date(node.file.lastModified);
  return new Date();
}

function identifierBytes(node, special = null) {
  if (special === '.') return new Uint8Array([0]);
  if (special === '..') return new Uint8Array([1]);
  const raw = node.isDirectory ? node.name : `${node.name};1`;
  return encoder.encode(raw);
}

function recordLengthFor(idBytes) { return 33 + idBytes.length + (idBytes.length % 2 === 0 ? 1 : 0); }

function makeDirectoryRecord(node, { special = null, parent = null } = {}) {
  const target = special === '..' ? parent : node;
  const id = identifierBytes(node, special);
  const length = recordLengthFor(id);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = length;
  bytes[1] = 0;
  writeBothU32(view, 2, target.outputLba);
  writeBothU32(view, 10, target.outputSize);
  bytes.set(isoDate7(nodeDate(target)), 18);
  bytes[25] = target.isDirectory ? 0x02 : 0x00;
  bytes[26] = 0;
  bytes[27] = 0;
  writeBothU16(view, 28, 1);
  bytes[32] = id.length;
  bytes.set(id, 33);
  return bytes;
}

function measureDirectory(node) {
  const records = [identifierBytes(node, '.'), identifierBytes(node, '..'), ...node.children.map((child) => identifierBytes(child))];
  let cursor = 0;
  for (const id of records) {
    const len = recordLengthFor(id);
    const within = cursor % SECTOR_SIZE;
    if (within + len > SECTOR_SIZE) cursor = align(cursor, SECTOR_SIZE);
    cursor += len;
  }
  return align(cursor, SECTOR_SIZE);
}

function serializeDirectory(node) {
  const bytes = new Uint8Array(node.outputSize);
  let cursor = 0;
  const records = [
    makeDirectoryRecord(node, { special: '.' }),
    makeDirectoryRecord(node, { special: '..', parent: node.parent || node }),
    ...node.children.map((child) => makeDirectoryRecord(child)),
  ];
  for (const record of records) {
    const within = cursor % SECTOR_SIZE;
    if (within + record.length > SECTOR_SIZE) cursor = align(cursor, SECTOR_SIZE);
    bytes.set(record, cursor);
    cursor += record.length;
  }
  return bytes;
}

function directoryList(root) {
  const result = [];
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    result.push(node);
    for (const child of node.children) if (child.isDirectory) queue.push(child);
  }
  return result;
}

function pathId(dir) { return dir.parent ? encoder.encode(dir.name) : new Uint8Array([0]); }
function pathTableSize(dirs) {
  return dirs.reduce((sum, dir) => {
    const id = pathId(dir);
    return sum + 8 + id.length + (id.length % 2 ? 1 : 0);
  }, 0);
}

function serializePathTable(dirs, bigEndian = false) {
  const total = pathTableSize(dirs);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const numbers = new Map(dirs.map((dir, i) => [dir, i + 1]));
  let cursor = 0;
  for (const dir of dirs) {
    const id = pathId(dir);
    out[cursor] = id.length;
    out[cursor + 1] = 0;
    view.setUint32(cursor + 2, dir.outputLba >>> 0, !bigEndian);
    view.setUint16(cursor + 6, dir.parent ? numbers.get(dir.parent) : 1, !bigEndian);
    out.set(id, cursor + 8);
    cursor += 8 + id.length;
    if (id.length % 2) cursor++;
  }
  return out;
}

function copyAscii(target, offset, length, text) {
  target.fill(0x20, offset, offset + length);
  target.set(encoder.encode(String(text || '').slice(0, length)), offset);
}

async function makePvd(workspace, plan) {
  const pvdSector = workspace.iso.volume?.pvdSector ?? 16;
  let pvd;
  try {
    const source = await workspace.iso.readBytes(pvdSector * SECTOR_SIZE, SECTOR_SIZE);
    pvd = source.length === SECTOR_SIZE ? source.slice() : new Uint8Array(SECTOR_SIZE);
  } catch {
    pvd = new Uint8Array(SECTOR_SIZE);
  }
  const view = new DataView(pvd.buffer);
  pvd[0] = 1;
  pvd.set(encoder.encode('CD001'), 1);
  pvd[6] = 1;
  const volume = workspace.volumeMetadata ? workspace.volumeMetadata() : (workspace.iso.volume || {});
  copyAscii(pvd, 8, 32, volume.systemId || '');
  copyAscii(pvd, 40, 32, volume.volumeId || 'PSP_MODDING_STUDIO');
  copyAscii(pvd, 190, 128, volume.volumeSetId || '');
  copyAscii(pvd, 318, 128, volume.publisherId || '');
  copyAscii(pvd, 446, 128, volume.dataPreparerId || '');
  copyAscii(pvd, 574, 128, volume.applicationId || '');
  copyAscii(pvd, 702, 37, volume.copyrightFileId || '');
  if (volume.creationDate) { const creation = isoDate17(volume.creationDate); if (creation) pvd.set(creation, 813); }
  writeBothU32(view, 80, plan.totalSectors);
  writeBothU16(view, 120, 1);
  writeBothU16(view, 124, 1);
  writeBothU16(view, 128, SECTOR_SIZE);
  writeBothU32(view, 132, plan.pathTableBytes);
  view.setUint32(140, plan.lPathLba, true);
  view.setUint32(144, 0, true);
  view.setUint32(148, plan.mPathLba, false);
  view.setUint32(152, 0, false);
  pvd.set(makeDirectoryRecord(workspace.root, { special: '.' }).subarray(0, 34), 156);
  return pvd;
}

function terminator() {
  const bytes = new Uint8Array(SECTOR_SIZE);
  bytes[0] = 255;
  bytes.set(encoder.encode('CD001'), 1);
  bytes[6] = 1;
  return bytes;
}

async function fileBlob(workspace, node) {
  const blob = await workspace.readNode(node);
  node.outputSize = blob.size;
  return blob;
}

export async function buildIsoPlan(workspace, { padding = { mode: 'none', sectors: 0 } } = {}) {
  const dirs = directoryList(workspace.root);
  for (const dir of dirs) dir.outputSize = measureDirectory(dir);

  const pathBytes = pathTableSize(dirs);
  let cursorLba = 18;
  const lPathLba = cursorLba;
  cursorLba += sectors(pathBytes);
  const mPathLba = cursorLba;
  cursorLba += sectors(pathBytes);

  for (const dir of dirs) {
    dir.outputLba = cursorLba;
    cursorLba += sectors(dir.outputSize);
  }

  const layoutFiles = workspace.fileLayout();
  const representative = new Map();
  const resolveRepresentative = (node) => {
    if (representative.has(node)) return representative.get(node);
    const seen = new Set(); let current = node;
    while (current.linkedTo) {
      if (seen.has(current)) throw new Error(`Relink cycle detected at ${current.path}.`);
      seen.add(current); current = current.linkedTo;
    }
    representative.set(node, current);
    return current;
  };
  const files = []; const seenRepresentatives = new Set();
  for (const file of layoutFiles) {
    const rep = resolveRepresentative(file);
    if (!seenRepresentatives.has(rep)) { seenRepresentatives.add(rep); files.push(rep); }
  }

  const paddingMode = ['none','standard','custom'].includes(padding?.mode) ? padding.mode : 'none';
  const customPadding = Math.max(0, Math.min(1_000_000, Math.trunc(Number(padding?.sectors) || 0)));
  const blobs = new Map();
  let placedFiles = 0;
  for (const file of files) {
    const blob = await fileBlob(workspace, file);
    blobs.set(file, blob);
    const requested = Number.isInteger(file.requestedLba) ? file.requestedLba : null;
    if (requested != null) {
      if (requested < cursorLba) throw new Error(`Cannot preserve LBA ${requested} for ${file.path}: previous data already reaches LBA ${cursorLba}.`);
      file.outputLba = requested;
    } else if (paddingMode === 'standard' && Number.isInteger(file.sourceEntry?.lba) && file.sourceEntry.lba >= cursorLba) {
      // Retail UMD masters commonly contain inter-file gaps. For an existing image,
      // "standard" padding means retaining those original source gaps wherever possible.
      file.outputLba = file.sourceEntry.lba;
    } else if (paddingMode === 'custom' && placedFiles > 0 && customPadding > 0) file.outputLba = cursorLba + customPadding;
    else file.outputLba = cursorLba;
    placedFiles++;
    file.outputSize = blob.size;
    cursorLba = file.outputLba + Math.ceil(blob.size / SECTOR_SIZE);
  }
  for (const file of layoutFiles) {
    const rep = resolveRepresentative(file);
    file.outputLba = rep.outputLba;
    file.outputSize = rep.outputSize;
  }

  const totalSectors = cursorLba;
  return { dirs, files, layoutFiles, blobs, pathTableBytes: pathBytes, lPathLba, mPathLba, totalSectors, paddingMode, customPadding };
}

export async function buildRebuiltIsoBlob(workspace, { onProgress, padding } = {}) {
  onProgress?.(0.04);
  const plan = await buildIsoPlan(workspace, { padding });
  onProgress?.(0.12);
  const pvd = await makePvd(workspace, plan);
  const lPath = serializePathTable(plan.dirs, false);
  const mPath = serializePathTable(plan.dirs, true);

  const parts = [];
  parts.push(new Blob([await workspace.iso.readBytes(0, Math.min(workspace.iso.file.size, 16 * SECTOR_SIZE))]));
  if (workspace.iso.file.size < 16 * SECTOR_SIZE) parts.push(zeroBlob(16 * SECTOR_SIZE - workspace.iso.file.size));
  parts.push(pvd, terminator());

  parts.push(lPath);
  if (lPath.length % SECTOR_SIZE) parts.push(new Uint8Array(align(lPath.length, SECTOR_SIZE) - lPath.length));
  parts.push(mPath);
  if (mPath.length % SECTOR_SIZE) parts.push(new Uint8Array(align(mPath.length, SECTOR_SIZE) - mPath.length));

  for (let i = 0; i < plan.dirs.length; i++) {
    parts.push(serializeDirectory(plan.dirs[i]));
    onProgress?.(0.14 + ((i + 1) / Math.max(1, plan.dirs.length)) * 0.16);
  }

  let currentLba = plan.dirs.length ? plan.dirs[plan.dirs.length - 1].outputLba + sectors(plan.dirs[plan.dirs.length - 1].outputSize) : plan.mPathLba + sectors(plan.pathTableBytes);
  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i];
    const blob = plan.blobs.get(file);
    if (file.outputLba > currentLba) {
      const start = currentLba * SECTOR_SIZE; const end = file.outputLba * SECTOR_SIZE;
      const preserveGap = plan.paddingMode === 'standard' || Number.isInteger(file.requestedLba);
      if (preserveGap && start < workspace.iso.file.size) {
        const preservedEnd = Math.min(end, workspace.iso.file.size);
        const chunk = 4 * 1024 * 1024;
        for (let pos = start; pos < preservedEnd; pos += chunk) parts.push(await workspace.iso.readBytes(pos, Math.min(chunk, preservedEnd - pos)));
        if (end > workspace.iso.file.size) parts.push(zeroBlob(end - Math.max(start, workspace.iso.file.size)));
      } else parts.push(zeroBlob(end - start));
    }
    parts.push(blob);
    const pad = align(blob.size, SECTOR_SIZE) - blob.size;
    if (pad) parts.push(pad <= SECTOR_SIZE ? ZERO_SECTOR.subarray(0, pad) : new Uint8Array(pad));
    currentLba = file.outputLba + Math.ceil(blob.size / SECTOR_SIZE);
    onProgress?.(0.30 + ((i + 1) / Math.max(1, plan.files.length)) * 0.68);
  }
  onProgress?.(1);
  return new Blob(parts, { type: 'application/x-iso9660-image' });
}
