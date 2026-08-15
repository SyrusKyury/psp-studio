import { buildRebuiltIsoBlob } from './iso-writer.js';
import { encodeImage } from './image-codec.js';
import { deriveDaxNcRanges } from './dax-ranges.js';
import { saveBlob } from '../lib/download.js';


function sizeRecordBytes(size) {
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setUint32(0, size, true); view.setUint32(4, size, false); return new Uint8Array(buffer);
}
function sourceStem(workspace) { return String(workspace.iso.file.name || 'umd').replace(/\.(iso|cso|dax)$/i, ''); }
function suggestedName(workspace, format, mode = 'copy') { const suffix = mode.startsWith('rebuild') ? '-rebuilt' : workspace.changedCount ? '-mod' : ''; return `${sourceStem(workspace)}${suffix}.${format}`; }
function mime(format) { return format === 'cso' ? 'application/x-cso' : format === 'dax' ? 'application/x-dax' : 'application/x-iso9660-image'; }
function description(format) { return format === 'cso' ? 'PSP Compressed ISO (CSO)' : format === 'dax' ? 'PSP DAX image' : 'PSP UMD ISO'; }

function buildBlobPatchedIso(workspace) {
  if (workspace.iso.format !== 'iso') throw new Error('Physical in-place patching is only available for raw ISO sources.');
  const source = workspace.iso.physicalFile, patches = [];
  for (const node of workspace.all()) {
    if (!node.file || !node.sourceEntry) continue;
    const { sourceEntry: entry, file } = node;
    patches.push({ offset: entry.recordOffset + 10, length: 8, data: sizeRecordBytes(file.size) });
    if (file.size) patches.push({ offset: entry.offset, length: file.size, data: file });
  }
  patches.sort((a, b) => a.offset - b.offset);
  const parts = []; let cursor = 0;
  for (const patch of patches) {
    if (patch.offset < cursor) throw new Error('Overlapping ISO patches are not supported.');
    if (patch.offset > cursor) parts.push(source.slice(cursor, patch.offset));
    parts.push(patch.data); cursor = patch.offset + patch.length;
  }
  if (cursor < source.size) parts.push(source.slice(cursor));
  return new Blob(parts, { type: 'application/x-iso9660-image' });
}

export async function buildWorkspaceIsoBlob(workspace, { onProgress, padding } = {}) {
  if (!workspace.changedCount) {
    if (workspace.iso.format === 'iso') { onProgress?.(1); return { blob: workspace.iso.physicalFile, mode: 'copy' }; }
    const blob = await workspace.iso.source.materialize({ onProgress });
    return { blob, mode: 'materialize' };
  }
  const rebuild = workspace.needsFullRebuild();
  if (!rebuild && workspace.iso.format === 'iso') { onProgress?.(.8); return { blob: buildBlobPatchedIso(workspace), mode: 'patch' }; }
  const blob = await buildRebuiltIsoBlob(workspace, { padding, onProgress: (value) => onProgress?.(value * .8) });
  return { blob, mode: 'rebuild' };
}

export async function buildWorkspaceImage(workspace, format = 'iso', { onProgress, level = 9, padding, dax = {} } = {}) {
  const target = String(format).toLowerCase();
  if (!workspace.changedCount && target === workspace.iso.format) { onProgress?.(1); return { blob: workspace.iso.physicalFile, mode: 'copy', format: target }; }
  const { blob: isoBlob, mode } = await buildWorkspaceIsoBlob(workspace, { padding, onProgress: (v) => onProgress?.(v * (target === 'iso' ? 1 : .58)) });
  if (target === 'iso') { onProgress?.(1); return { blob: isoBlob, mode, format: target }; }
  let encodeOptions = { level, onProgress: (v) => onProgress?.(.58 + v * .42) };
  if (target === 'dax') {
    const ncRanges = await deriveDaxNcRanges(isoBlob, dax);
    encodeOptions = { ...encodeOptions, ...dax, ncRanges };
  }
  const blob = await encodeImage(isoBlob, target, encodeOptions);
  onProgress?.(1); return { blob, mode: `${mode}+${target}`, format: target };
}

export async function saveImage(workspace, format = 'iso', { onProgress, level = 9, padding, dax = {} } = {}) {
  const result = await buildWorkspaceImage(workspace, format, { level, padding, dax, onProgress: (v) => onProgress?.(v * .94) });
  const target = result.format;
  const extension = `.${target}`;
  await saveBlob(result.blob, suggestedName(workspace, target, result.mode), { description: description(target), mime: mime(target), extension });
  onProgress?.(1);
  return { mode: result.mode, size: result.blob.size, format: target };
}

export async function saveIso(workspace, options = {}) { return saveImage(workspace, 'iso', options); }
