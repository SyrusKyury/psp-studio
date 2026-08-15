import { inflateRawFallback } from './inflate-fallback.js';

function currentFflate() {
  const lib = globalThis.fflate;
  return lib && typeof lib.deflateSync === 'function' && typeof lib.inflateSync === 'function' ? lib : null;
}

function deflateStoredRaw(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = [];
  for (let offset = 0; offset < input.length || (offset === 0 && !input.length);) {
    const size = Math.min(0xffff, input.length - offset);
    const final = offset + size >= input.length;
    const block = new Uint8Array(5 + size);
    block[0] = final ? 1 : 0; // BFINAL + BTYPE=00, followed by byte alignment.
    block[1] = size & 0xff; block[2] = (size >>> 8) & 0xff;
    const nlen = (~size) & 0xffff; block[3] = nlen & 0xff; block[4] = nlen >>> 8;
    if (size) block.set(input.subarray(offset, offset + size), 5);
    parts.push(block); offset += size;
    if (!input.length) break;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0), out = new Uint8Array(total);
  let cursor = 0; for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
}

async function nativeTransform(bytes, mode) {
  if (typeof document === 'undefined' && globalThis.process?.versions?.node) {
    const zlib = await import('node:zlib');
    const fn = mode === 'compress' ? zlib.deflateRawSync : zlib.inflateRawSync;
    return new Uint8Array(fn(bytes));
  }
  if (mode === 'compress') {
    if (typeof globalThis.CompressionStream !== 'function') return deflateStoredRaw(bytes);
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Compression Streams universally exposes zlib-wrapped `deflate` on modern
      // browsers. Removing its 2-byte header and 4-byte Adler32 trailer yields the
      // raw RFC 1951 stream required by CSO/DAX.
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      const wrapped = new Uint8Array(await new Response(stream).arrayBuffer());
      if (wrapped.length < 6) throw new Error('Browser DEFLATE output is truncated.');
      return wrapped.slice(2, -4);
    }
  }
  if (typeof globalThis.DecompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {}
  }
  // Self-contained fallback keeps CSO/DAX readable offline even on engines that
  // do not expose raw DEFLATE through DecompressionStream.
  return inflateRawFallback(bytes);
}
export async function deflateRaw(bytes, { level = 9, preferFast = true } = {}) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const lib = currentFflate();
  if (lib) return lib.deflateSync(input, { level: Math.max(0, Math.min(9, Math.trunc(Number(level) || 0))) });
  return nativeTransform(input, 'compress');
}

export async function inflateRaw(bytes, { expectedSize = 0 } = {}) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // For tiny CSO/DAX blocks fflate avoids the per-stream setup cost. Do one lazy
  // attempt, then cache the native fallback for offline/self-hosted use.
  const lib = currentFflate();
  if (lib) {
    const out = lib.inflateSync(input);
    if (expectedSize && out.length < expectedSize) throw new Error(`DEFLATE block expanded to ${out.length} bytes; expected at least ${expectedSize}.`);
    return out;
  }
  return nativeTransform(input, 'decompress');
}

export function compressionBackend() {
  return currentFflate() ? 'fflate' : (typeof CompressionStream === 'function' ? 'browser' : 'self-contained');
}
