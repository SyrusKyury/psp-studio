import { inflateRaw } from './deflate.js';
const ASCII = new TextDecoder('ascii');
const CISO_MAGIC = 'CISO';
const DAX_MAGIC = 'DAX\0';
const DAX_FRAME_SIZE = 0x2000;

function ascii(bytes, start, length) { return ASCII.decode(bytes.subarray(start, start + length)); }
function ensureRange(offset, length, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error('Invalid image read range.');
  return { start: Math.min(offset, size), end: Math.min(size, offset + length) };
}

class LruCache {
  constructor(limit = 24) { this.limit = limit; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return null; const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); return value; }
  set(key, value) { if (this.map.has(key)) this.map.delete(key); this.map.set(key, value); while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value); return value; }
}

export class RawImageSource {
  constructor(file) {
    this.file = file; this.name = file.name || 'image.iso'; this.format = 'iso'; this.size = file.size; this.storageSize = file.size;
  }
  async read(offset, length) { const { start, end } = ensureRange(offset, length, this.size); return new Uint8Array(await this.file.slice(start, end).arrayBuffer()); }
  slice(offset, end) { return this.file.slice(offset, end); }
  async materialize() { return this.file; }
}

export class CsoImageSource {
  constructor(file, header, index) {
    this.file = file; this.name = file.name || 'image.cso'; this.format = 'cso'; this.size = header.uncompressedSize;
    this.storageSize = file.size; this.blockSize = header.blockSize; this.version = header.version; this.indexShift = header.indexShift;
    this.index = index; this.cache = new LruCache(32);
  }
  static async open(file) {
    const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    if (head.length < 24 || ascii(head, 0, 4) !== CISO_MAGIC) throw new Error('Invalid CSO header.');
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const headerSize = view.getUint32(4, true), uncompressedSize = Number(view.getBigUint64(8, true)), blockSize = view.getUint32(16, true);
    const version = head[20], indexShift = head[21];
    if (!Number.isSafeInteger(uncompressedSize) || !uncompressedSize || !blockSize) throw new Error('Invalid CSO dimensions.');
    if (version > 1) throw new Error(`Unsupported CSO version ${version}. UMD Forge supports classic CISO/CSO v1 images.`);
    const blocks = Math.ceil(uncompressedSize / blockSize), count = blocks + 1, indexBytes = count * 4;
    const rawIndex = new Uint8Array(await file.slice(headerSize, headerSize + indexBytes).arrayBuffer());
    if (rawIndex.length !== indexBytes) throw new Error('Truncated CSO index.');
    const iv = new DataView(rawIndex.buffer, rawIndex.byteOffset, rawIndex.byteLength), index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = iv.getUint32(i * 4, true);
    return new CsoImageSource(file, { uncompressedSize, blockSize, version, indexShift }, index);
  }
  async #block(block) {
    const cached = this.cache.get(block); if (cached) return cached;
    if (block < 0 || block >= this.index.length - 1) return new Uint8Array();
    const a = this.index[block] >>> 0, b = this.index[block + 1] >>> 0;
    const raw = Boolean(a & 0x80000000); const start = (a & 0x7fffffff) * (2 ** this.indexShift); const end = (b & 0x7fffffff) * (2 ** this.indexShift);
    if (end < start || end > this.file.size) throw new Error(`Invalid CSO block ${block}.`);
    let bytes = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
    if (!raw) bytes = await inflateRaw(bytes, { expectedSize: Math.min(this.blockSize, this.size - block * this.blockSize) });
    const expected = Math.min(this.blockSize, this.size - block * this.blockSize);
    if (bytes.length < expected) throw new Error(`CSO block ${block} decompressed to ${bytes.length} bytes; expected ${expected}.`);
    return this.cache.set(block, bytes.subarray(0, expected));
  }
  async read(offset, length) {
    const { start, end } = ensureRange(offset, length, this.size); if (end <= start) return new Uint8Array();
    const out = new Uint8Array(end - start); let cursor = start, outPos = 0;
    while (cursor < end) {
      const block = Math.floor(cursor / this.blockSize), bytes = await this.#block(block), within = cursor % this.blockSize;
      const take = Math.min(bytes.length - within, end - cursor); if (take <= 0) throw new Error('Invalid CSO block boundary.');
      out.set(bytes.subarray(within, within + take), outPos); cursor += take; outPos += take;
    }
    return out;
  }
  async materialize({ onProgress } = {}) {
    const parts = []; const chunk = 4 * 1024 * 1024;
    for (let offset = 0; offset < this.size; offset += chunk) { parts.push(new Blob([await this.read(offset, Math.min(chunk, this.size - offset))])); onProgress?.(Math.min(1, (offset + chunk) / this.size)); }
    return new Blob(parts, { type: 'application/x-iso9660-image' });
  }
}

export class DaxImageSource {
  constructor(file, header, offsets, sizes, nonCompressed) {
    this.file = file; this.name = file.name || 'image.dax'; this.format = 'dax'; this.size = header.uncompressedSize; this.storageSize = file.size;
    this.version = header.version; this.offsets = offsets; this.sizes = sizes; this.nonCompressed = nonCompressed; this.cache = new LruCache(24);
  }
  static async open(file) {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (head.length < 32 || ascii(head, 0, 4) !== DAX_MAGIC) throw new Error('Invalid DAX header.');
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength), uncompressedSize = view.getUint32(4, true), version = view.getUint32(8, true), ncAreas = view.getUint32(12, true);
    if (version > 1) throw new Error(`Unsupported DAX version ${version}.`);
    const frames = Math.ceil(uncompressedSize / DAX_FRAME_SIZE), offsetsBytes = frames * 4, sizesBytes = frames * 2;
    const tables = new Uint8Array(await file.slice(32, 32 + offsetsBytes + sizesBytes + (version >= 1 ? ncAreas * 8 : 0)).arrayBuffer());
    if (tables.length < offsetsBytes + sizesBytes) throw new Error('Truncated DAX tables.');
    const tv = new DataView(tables.buffer, tables.byteOffset, tables.byteLength), offsets = new Uint32Array(frames), sizes = new Uint16Array(frames);
    for (let i = 0; i < frames; i++) offsets[i] = tv.getUint32(i * 4, true);
    for (let i = 0; i < frames; i++) sizes[i] = tv.getUint16(offsetsBytes + i * 2, true);
    const nonCompressed = new Uint8Array(frames);
    if (version >= 1) {
      let p = offsetsBytes + sizesBytes;
      for (let i = 0; i < ncAreas; i++, p += 8) {
        if (p + 8 > tables.length) throw new Error('Truncated DAX non-compressed area table.');
        const start = tv.getUint32(p, true), count = tv.getUint32(p + 4, true);
        for (let f = start; f < Math.min(frames, start + count); f++) nonCompressed[f] = 1;
      }
    }
    return new DaxImageSource(file, { uncompressedSize, version }, offsets, sizes, nonCompressed);
  }
  async #frame(frame) {
    const cached = this.cache.get(frame); if (cached) return cached;
    if (frame < 0 || frame >= this.offsets.length) return new Uint8Array();
    const start = this.offsets[frame], length = this.sizes[frame];
    if (start + length > this.file.size) throw new Error(`Invalid DAX frame ${frame}.`);
    let bytes = new Uint8Array(await this.file.slice(start, start + length).arrayBuffer());
    if (!this.nonCompressed[frame]) bytes = await inflateRaw(bytes, { expectedSize: Math.min(DAX_FRAME_SIZE, this.size - frame * DAX_FRAME_SIZE) });
    const expected = Math.min(DAX_FRAME_SIZE, this.size - frame * DAX_FRAME_SIZE);
    if (bytes.length < expected) throw new Error(`DAX frame ${frame} decompressed to ${bytes.length} bytes; expected ${expected}.`);
    return this.cache.set(frame, bytes.subarray(0, expected));
  }
  async read(offset, length) {
    const { start, end } = ensureRange(offset, length, this.size); if (end <= start) return new Uint8Array();
    const out = new Uint8Array(end - start); let cursor = start, outPos = 0;
    while (cursor < end) {
      const frame = Math.floor(cursor / DAX_FRAME_SIZE), bytes = await this.#frame(frame), within = cursor % DAX_FRAME_SIZE;
      const take = Math.min(bytes.length - within, end - cursor); if (take <= 0) throw new Error('Invalid DAX frame boundary.');
      out.set(bytes.subarray(within, within + take), outPos); cursor += take; outPos += take;
    }
    return out;
  }
  async materialize({ onProgress } = {}) {
    const parts = []; const chunk = 4 * 1024 * 1024;
    for (let offset = 0; offset < this.size; offset += chunk) { parts.push(new Blob([await this.read(offset, Math.min(chunk, this.size - offset))])); onProgress?.(Math.min(1, (offset + chunk) / this.size)); }
    return new Blob(parts, { type: 'application/x-iso9660-image' });
  }
}

export async function openImageSource(file) {
  if (!(file instanceof Blob)) throw new Error('Expected an ISO, CSO or DAX file.');
  const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer()); const magic = ascii(sig, 0, 4);
  if (magic === CISO_MAGIC) return CsoImageSource.open(file);
  if (magic === DAX_MAGIC) return DaxImageSource.open(file);
  return new RawImageSource(file);
}
