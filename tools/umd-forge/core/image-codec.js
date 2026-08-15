import { deflateRaw } from './deflate.js';

const CISO_HEADER_SIZE = 24;
const DAX_HEADER_SIZE = 32;
const DAX_FRAME_SIZE = 0x2000;
const PAYLOAD_BATCH = 8 * 1024 * 1024;

function u32Table(values) {
  const out = new Uint8Array(values.length * 4), v = new DataView(out.buffer);
  values.forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
  return out;
}
function u16Table(values) {
  const out = new Uint8Array(values.length * 2), v = new DataView(out.buffer);
  values.forEach((n, i) => v.setUint16(i * 2, n, true));
  return out;
}
async function readBlob(blob, offset, size) {
  return new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
}

class PayloadBuilder {
  constructor(batchSize = PAYLOAD_BATCH) {
    this.batchSize = batchSize;
    this.pending = [];
    this.pendingBytes = 0;
    this.chunks = [];
    this.size = 0;
  }
  push(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    this.size += bytes.byteLength;
    if (this.pendingBytes >= this.batchSize) this.flush();
  }
  flush() {
    if (!this.pending.length) return;
    this.chunks.push(new Blob(this.pending, { type: 'application/octet-stream' }));
    this.pending = [];
    this.pendingBytes = 0;
  }
  finish() {
    this.flush();
    return this.chunks;
  }
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

export function chooseCsoIndexShift(uncompressedSize, blockSize = 2048) {
  const size = Number(uncompressedSize);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid CSO source size.');
  const blocks = Math.ceil(size / blockSize);
  const indexBytes = (blocks + 1) * 4;
  const tableEnd = CISO_HEADER_SIZE + indexBytes;

  // CISO v1 stores the physical block offset in 31 bits and left-shifts it by
  // index_shift.  Choose the smallest alignment that is guaranteed to fit even
  // when every source block has to be stored raw.  This keeps ordinary PSP UMDs
  // at the classic shift=0 layout while allowing merged >2 GiB romhacking ISOs.
  for (let shift = 0; shift <= 31; shift++) {
    const alignment = 2 ** shift;
    const dataStart = alignUp(tableEnd, alignment);
    const worstCaseEnd = dataStart + size + blocks * (alignment - 1);
    if (Math.ceil(worstCaseEnd / alignment) < 0x80000000) return shift;
  }
  throw new Error('CSO v1 cannot address this image with a 31-bit shifted index.');
}

export async function encodeCso(isoBlob, { onProgress, level = 9 } = {}) {
  const blockSize = 2048;
  const blocks = Math.ceil(isoBlob.size / blockSize);
  const indexBytes = (blocks + 1) * 4;
  const indexShift = chooseCsoIndexShift(isoBlob.size, blockSize);
  const alignment = 2 ** indexShift;
  const tableEnd = CISO_HEADER_SIZE + indexBytes;
  let cursor = alignUp(tableEnd, alignment);

  const offsets = new Uint32Array(blocks + 1);
  const payload = new PayloadBuilder();
  const prefixPadding = cursor - tableEnd;
  if (prefixPadding) payload.push(new Uint8Array(prefixPadding));

  for (let i = 0; i < blocks; i++) {
    const shiftedOffset = cursor / alignment;
    if (!Number.isInteger(shiftedOffset) || shiftedOffset >= 0x80000000) throw new Error('CSO v1 output exceeds its shifted 31-bit address range.');

    const raw = await readBlob(isoBlob, i * blockSize, Math.min(blockSize, isoBlob.size - i * blockSize));
    const compressed = await deflateRaw(raw, { level });
    const storeRaw = compressed.length >= raw.length;
    const bytes = storeRaw ? raw : compressed;
    offsets[i] = (shiftedOffset >>> 0) | (storeRaw ? 0x80000000 : 0);

    const nextCursor = alignUp(cursor + bytes.length, alignment);
    const padding = nextCursor - (cursor + bytes.length);
    if (padding) {
      // Padding is part of the indexed block span by design.  CISO readers must
      // ignore bytes after the end of the raw DEFLATE stream, and raw blocks are
      // clipped to block_size.  Consolidating it here avoids millions of tiny
      // Blob parts for large merged images.
      const aligned = new Uint8Array(bytes.length + padding);
      aligned.set(bytes);
      payload.push(aligned);
    } else payload.push(bytes);
    cursor = nextCursor;
    onProgress?.((i + 1) / Math.max(1, blocks) * .88);
  }

  const finalShifted = cursor / alignment;
  if (!Number.isInteger(finalShifted) || finalShifted >= 0x80000000) throw new Error('CSO v1 final index exceeds its shifted 31-bit address range.');
  offsets[blocks] = finalShifted >>> 0;

  const header = new Uint8Array(CISO_HEADER_SIZE), hv = new DataView(header.buffer);
  header.set([0x43, 0x49, 0x53, 0x4f], 0);
  hv.setUint32(4, CISO_HEADER_SIZE, true);
  hv.setBigUint64(8, BigInt(isoBlob.size), true);
  hv.setUint32(16, blockSize, true);
  header[20] = 1;
  header[21] = indexShift;

  onProgress?.(.96);
  const blob = new Blob([header, u32Table(offsets), ...payload.finish()], { type: 'application/x-cso' });
  onProgress?.(1);
  return blob;
}

function groupAreas(flags) {
  const areas = [];
  for (let i = 0; i < flags.length;) {
    if (!flags[i]) { i++; continue; }
    const start = i;
    while (i < flags.length && flags[i]) i++;
    areas.push({ start, count: i - start });
  }
  return areas;
}

export async function encodeDax(isoBlob, { onProgress, level = 9, useNcAreas = true, ncRanges = [], frameCandidateSize = DAX_FRAME_SIZE } = {}) {
  if (isoBlob.size > 0xffffffff) throw new Error('DAX stores uncompressed size in 32 bits and cannot represent images above 4 GiB.');
  const frames = Math.ceil(isoBlob.size / DAX_FRAME_SIZE);
  const threshold = Math.max(1, Math.min(DAX_FRAME_SIZE, Math.trunc(Number(frameCandidateSize) || DAX_FRAME_SIZE)));
  const ranges = Array.isArray(ncRanges) ? ncRanges.filter((r) => Number.isFinite(r?.start) && Number.isFinite(r?.end) && r.end > r.start) : [];
  const frameForcedNc = (frame) => { const start = frame * DAX_FRAME_SIZE, end = Math.min(isoBlob.size, start + DAX_FRAME_SIZE); return ranges.some((r) => r.start < end && r.end > start); };
  const nc = new Uint8Array(frames);
  const sizes = new Uint16Array(frames);

  // Compress into batched Blob chunks while retaining only compact size/NC tables.
  // Once the NC-area table size is known, offsets can be derived from frame sizes.
  const payload = new PayloadBuilder();
  for (let i = 0; i < frames; i++) {
    const raw = await readBlob(isoBlob, i * DAX_FRAME_SIZE, Math.min(DAX_FRAME_SIZE, isoBlob.size - i * DAX_FRAME_SIZE));
    const compressed = await deflateRaw(raw, { level });
    const candidateLimit = Math.min(raw.length, threshold);
    const storeRaw = Boolean(useNcAreas) && (frameForcedNc(i) || compressed.length >= candidateLimit);
    const bytes = storeRaw ? raw : compressed;
    if (storeRaw) nc[i] = 1;
    sizes[i] = bytes.length;
    payload.push(bytes);
    onProgress?.((i + 1) / Math.max(1, frames) * .86);
  }

  const areas = groupAreas(nc), version = areas.length ? 1 : 0;
  const dataStart = DAX_HEADER_SIZE + frames * 4 + frames * 2 + (version ? areas.length * 8 : 0);
  const offsets = new Uint32Array(frames);
  let cursor = dataStart;
  for (let i = 0; i < frames; i++) { offsets[i] = cursor; cursor += sizes[i]; }

  const header = new Uint8Array(DAX_HEADER_SIZE), hv = new DataView(header.buffer);
  header.set([0x44, 0x41, 0x58, 0], 0);
  hv.setUint32(4, isoBlob.size, true);
  hv.setUint32(8, version, true);
  hv.setUint32(12, areas.length, true);
  const areaBytes = new Uint8Array(areas.length * 8), av = new DataView(areaBytes.buffer);
  areas.forEach((area, i) => { av.setUint32(i * 8, area.start, true); av.setUint32(i * 8 + 4, area.count, true); });

  onProgress?.(.96);
  const blob = new Blob([header, u32Table(offsets), u16Table(sizes), areaBytes, ...payload.finish()], { type: 'application/x-dax' });
  onProgress?.(1);
  return blob;
}

export async function encodeImage(isoBlob, format, options = {}) {
  const target = String(format || 'iso').toLowerCase();
  if (target === 'iso') { options.onProgress?.(1); return isoBlob; }
  if (target === 'cso') return encodeCso(isoBlob, options);
  if (target === 'dax') return encodeDax(isoBlob, options);
  throw new Error(`Unknown image format: ${format}`);
}
