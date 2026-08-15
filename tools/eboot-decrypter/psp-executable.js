const PSP_HEADER_SIZE = 0x150;
const EMBEDDED_ELF_OFFSET = 0x150;
const textDecoder = new TextDecoder('ascii');

function bytesEqual(bytes, offset, values) {
  if (offset < 0 || offset + values.length > bytes.length) return false;
  return values.every((value, index) => bytes[offset + index] === value);
}

function magicAt(bytes, offset) {
  if (bytesEqual(bytes, offset, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF';
  if (bytesEqual(bytes, offset, [0x7e, 0x50, 0x53, 0x50])) return '~PSP';
  if (bytesEqual(bytes, offset, [0x7e, 0x53, 0x43, 0x45])) return '~SCE';
  return '';
}

function readCString(bytes, offset, length) {
  const end = Math.min(bytes.length, offset + length);
  let stop = offset;
  while (stop < end && bytes[stop] !== 0) stop += 1;
  return textDecoder.decode(bytes.subarray(offset, stop)).trim();
}

function formatTag(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)} MiB`;
}

export function outputElfName(name) {
  const original = String(name || 'EBOOT.BIN');
  const base = original.replace(/\.[^.]+$/, '') || 'EBOOT';
  return `${base}.elf`;
}

export function inspectExecutable(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4) throw new Error('The selected file is too small to be a PSP executable.');

  const initialMagic = magicAt(bytes, 0);
  if (initialMagic === 'ELF') {
    return {
      kind: 'elf', container: 'ELF', payloadOffset: 0, payloadSize: bytes.length,
      moduleName: '-', pspSize: bytes.length, elfSize: bytes.length,
      compressionAttributes: 0, isGzip: false, tag: null,
    };
  }

  let payloadOffset = 0;
  let container = '~PSP';
  if (initialMagic === '~SCE') {
    if (bytes.length < 8) throw new Error('The ~SCE container header is truncated.');
    const sceHeaderSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (sceHeaderSize < 8 || sceHeaderSize > bytes.length - PSP_HEADER_SIZE) throw new Error('The ~SCE container has an invalid embedded executable offset.');
    payloadOffset = sceHeaderSize;
    container = '~SCE -> ~PSP';
  }

  if (magicAt(bytes, payloadOffset) !== '~PSP') throw new Error('Unsupported executable format. Expected ~PSP, ~SCE or ELF data.');
  if (bytes.length - payloadOffset < PSP_HEADER_SIZE) throw new Error('The PSP executable header is truncated.');

  const view = new DataView(bytes.buffer, bytes.byteOffset + payloadOffset, bytes.byteLength - payloadOffset);
  const compressionAttributes = view.getUint16(0x06, true);
  const elfSize = view.getUint32(0x28, true);
  const pspSize = view.getUint32(0x2c, true);
  const tag = view.getUint32(0xd0, true);
  const available = bytes.length - payloadOffset;
  const payloadSize = pspSize > 0 && pspSize <= available ? pspSize : available;

  if (payloadSize < PSP_HEADER_SIZE) throw new Error('The PSP executable declares an invalid size.');

  return {
    kind: 'psp',
    container,
    payloadOffset,
    payloadSize,
    moduleName: readCString(bytes, payloadOffset + 0x0a, 28) || '-',
    pspSize,
    elfSize,
    compressionAttributes,
    isGzip: (compressionAttributes & 0x01) !== 0,
    tag,
    tagText: formatTag(tag),
  };
}

function isElf(bytes) { return magicAt(bytes, 0) === 'ELF'; }
function isGzip(bytes) { return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression required by this EBOOT.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decryptExecutable(input, decryptPrx) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const info = inspectExecutable(bytes);

  if (info.kind === 'elf') return { bytes: bytes.slice(), info, alreadyElf: true, usedEmbeddedElf: false };
  if (typeof decryptPrx !== 'function') throw new Error('No PSP crypto engine is available.');

  const payload = bytes.subarray(info.payloadOffset, info.payloadOffset + info.payloadSize);
  const outputCapacity = Math.max(info.elfSize || 0, info.payloadSize);
  const decrypted = await decryptPrx(payload, outputCapacity);
  let result = decrypted?.bytes || null;
  let usedEmbeddedElf = false;

  if (!result || decrypted.code <= 0) {
    if (payload.length > EMBEDDED_ELF_OFFSET && isElf(payload.subarray(EMBEDDED_ELF_OFFSET))) {
      result = payload.slice(EMBEDDED_ELF_OFFSET, info.payloadSize);
      usedEmbeddedElf = true;
    } else {
      const code = Number(decrypted?.code);
      throw new Error(`PSP decryption failed${Number.isFinite(code) ? ` (code ${code})` : ''}. The executable may use an unsupported PRX tag or may be damaged.`);
    }
  }

  if (info.isGzip || isGzip(result)) {
    if (!isGzip(result)) throw new Error('The PSP header marks the executable as gzip-compressed, but the decrypted payload is not a gzip stream.');
    result = await gunzip(result);
  }

  if (!isElf(result)) throw new Error('Decryption completed, but the result is not a valid ELF executable.');
  return { bytes: result, info, alreadyElf: false, usedEmbeddedElf };
}
