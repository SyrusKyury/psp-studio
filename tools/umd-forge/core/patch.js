import { saveBlob } from '../lib/download.js';
import { createStoredZip, readZip } from '../lib/zip-store.js';

const PATCH_FORMAT = 'umd-forge-patch';
const PATCH_VERSION = 1;

function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

export async function fingerprintIso(iso) {
  const file = iso.file;
  const edge = 64 * 1024;
  const first = await iso.readBytes(0, Math.min(edge, file.size));
  const last = await iso.readBytes(Math.max(0, file.size - edge), Math.min(edge, file.size));
  const meta = new TextEncoder().encode(`${file.size}:${iso.volume?.volumeId || ''}:${iso.volume?.volumeSpaceSize || ''}`);
  const all = new Uint8Array(first.length + last.length + meta.length); all.set(first, 0); all.set(last, first.length); all.set(meta, first.length + last.length);
  const digest = await crypto.subtle.digest('SHA-256', all);
  return { size: file.size, volumeId: iso.volume?.volumeId || '', edgeSha256: hex(digest) };
}

export async function createUmdPatch(workspace, { name = null, onProgress } = {}) {
  const plan = workspace.exportPatchPlan();
  if (!plan.operations.length && !plan.layoutChanged) throw new Error('There are no changes to include in a patch.');
  const source = await fingerprintIso(workspace.iso);
  const entries = [];
  const operations = [];
  let fileIndex = 0;
  for (const op of plan.operations) {
    const clean = { ...op }; delete clean.file;
    if (op.file) {
      const ref = `files/${String(++fileIndex).padStart(4, '0')}-${sanitize(op.file.name || op.name || 'payload.bin')}`;
      entries.push({ name: ref, blob: op.file }); clean.file = ref; clean.fileName = op.file.name || op.name || 'payload.bin';
    }
    operations.push(clean);
  }
  const manifest = {
    format: PATCH_FORMAT, version: PATCH_VERSION,
    name: name || `${workspace.iso.file.name} patch`, createdAt: new Date().toISOString(),
    source, operations, layout: plan.layout,
  };
  entries.unshift({ name: 'patch.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) });
  const blob = await createStoredZip(entries, { onProgress });
  return { blob, manifest };
}

export async function openUmdPatch(file) {
  const entries = await readZip(file); const manifestEntry = entries.find((entry) => entry.name === 'patch.json');
  if (!manifestEntry) throw new Error('Invalid UMD Forge patch: patch.json is missing.');
  const manifest = JSON.parse(await manifestEntry.blob.text());
  if (manifest.format !== PATCH_FORMAT || manifest.version !== PATCH_VERSION) throw new Error(`Unsupported UMD Forge patch format/version.`);
  const files = new Map(entries.map((entry) => [entry.name, entry.blob]));
  return { manifest, files };
}

export async function checkPatchCompatibility(workspace, patch) {
  const actual = await fingerprintIso(workspace.iso); const expected = patch.manifest.source || {};
  return { compatible: actual.size === expected.size && actual.volumeId === expected.volumeId && actual.edgeSha256 === expected.edgeSha256, expected, actual };
}

export async function applyUmdPatch(workspace, patch) {
  for (const op of patch.manifest.operations || []) {
    if (op.type === 'replace') {
      const node = workspace.get(op.path); if (!node || node.isDirectory) throw new Error(`Patch target not found: ${op.path}`);
      const blob = patch.files.get(op.file); if (!blob) throw new Error(`Patch payload missing: ${op.file}`);
      workspace.replace(node, new File([blob], op.fileName || node.name, { type: 'application/octet-stream' }));
    } else if (op.type === 'dummy') {
      const node = workspace.get(op.path); if (!node || node.isDirectory) throw new Error(`Patch target not found: ${op.path}`); workspace.dummy(node);
    } else if (op.type === 'truncate') {
      const node = workspace.get(op.path); if (!node || node.isDirectory) throw new Error(`Patch target not found: ${op.path}`); workspace.truncate(node);
    } else if (op.type === 'relink') {
      const node = workspace.get(op.path); const source = workspace.get(op.sourcePath); if (!node || node.isDirectory || !source || source.isDirectory) throw new Error(`Patch relink target/source not found: ${op.path}`); workspace.relink(node, source);
    } else if (op.type === 'unlink') {
      const node = workspace.get(op.path); if (!node || node.isDirectory) throw new Error(`Patch target not found: ${op.path}`); workspace.clearRelink(node);
    } else if (op.type === 'lba-map') {
      workspace.setRequestedLbas(op.items || []);
    } else if (op.type === 'volume-metadata') {
      workspace.setVolumeField(op.field, op.value ?? '');
    } else if (op.type === 'add-file') {
      const parent = workspace.get(op.parentPath); if (!parent?.isDirectory) throw new Error(`Patch directory not found: ${op.parentPath}`);
      const blob = patch.files.get(op.file); if (!blob) throw new Error(`Patch payload missing: ${op.file}`);
      workspace.addFile(parent, new File([blob], op.name || op.fileName || 'file.bin', { type: 'application/octet-stream' }));
    } else if (op.type === 'add-directory') {
      const parent = workspace.get(op.parentPath); if (!parent?.isDirectory) throw new Error(`Patch directory not found: ${op.parentPath}`); workspace.addDirectory(parent, op.name);
    } else if (op.type === 'rename') {
      const node = workspace.get(op.path); if (!node) throw new Error(`Patch target not found: ${op.path}`); workspace.rename(node, op.newName);
    } else if (op.type === 'delete') {
      const node = workspace.get(op.path); if (!node) throw new Error(`Patch target not found: ${op.path}`); workspace.delete(node);
    } else throw new Error(`Unsupported patch operation: ${op.type}`);
  }
  if (Array.isArray(patch.manifest.layout) && patch.manifest.layout.length) workspace.setLayoutOrder(patch.manifest.layout);
}

export function downloadUmdPatch(blob, filename = 'umd-patch.umdpatch') {
  const name = filename.endsWith('.umdpatch') ? filename : `${filename}.umdpatch`;
  return saveBlob(blob, name, { description: 'UMD Forge patch', mime: 'application/zip', extension: '.umdpatch' });
}

function sanitize(name) { return String(name).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 100) || 'payload.bin'; }
