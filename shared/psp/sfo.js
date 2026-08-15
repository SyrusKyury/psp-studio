const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export const SFO_FORMAT = Object.freeze({
  BINARY: 0x0004,
  UTF8: 0x0204,
  UINT32: 0x0404,
});

export const SFO_FORMAT_NAMES = Object.freeze({
  [SFO_FORMAT.BINARY]: 'Binary',
  [SFO_FORMAT.UTF8]: 'UTF-8 string',
  [SFO_FORMAT.UINT32]: 'Unsigned integer',
});

function align4(value) { return (value + 3) & ~3; }
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}
function copyBytes(value) {
  const bytes = asBytes(value);
  return bytes ? bytes.slice() : new Uint8Array();
}
function cString(bytes) {
  const zero = bytes.indexOf(0);
  return decoder.decode(zero >= 0 ? bytes.subarray(0, zero) : bytes);
}

function checkedRange(start, length, total, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > total) {
    throw new Error(`Invalid PARAM.SFO ${label} range.`);
  }
}

export function parseSfoDetailed(input) {
  const bytes = copyBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46535000) throw new Error('Invalid PARAM.SFO');

  const version = view.getUint32(4, true);
  const keyTable = view.getUint32(8, true);
  const dataTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  if (keyTable < 20 || keyTable > view.byteLength || dataTable < keyTable || dataTable > view.byteLength) throw new Error('Invalid PARAM.SFO tables.');
  if (20 + count * 16 > keyTable) throw new Error('Invalid PARAM.SFO index table.');

  const entries = [];
  for (let i = 0; i < count; i++) {
    const offset = 20 + i * 16;
    const keyOffset = view.getUint16(offset, true);
    const format = view.getUint16(offset + 2, true);
    const length = view.getUint32(offset + 4, true);
    const maxLength = view.getUint32(offset + 8, true);
    const dataOffset = view.getUint32(offset + 12, true);

    const keyStart = keyTable + keyOffset;
    if (keyStart < keyTable || keyStart >= dataTable) throw new Error('Invalid PARAM.SFO key offset.');
    let keyEnd = keyStart;
    while (keyEnd < dataTable && bytes[keyEnd] !== 0) keyEnd++;
    if (keyEnd >= dataTable) throw new Error('Invalid PARAM.SFO key table.');
    const key = decoder.decode(bytes.subarray(keyStart, keyEnd));
    if (!key) throw new Error('PARAM.SFO contains an empty key.');

    const start = dataTable + dataOffset;
    const reserved = Math.max(length, maxLength);
    checkedRange(start, reserved, bytes.byteLength, `data for ${key}`);
    const raw = bytes.subarray(start, start + length).slice();

    let value;
    if (format === SFO_FORMAT.UINT32) {
      if (length < 4) throw new Error(`Invalid integer entry ${key}.`);
      value = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
    } else if (format === SFO_FORMAT.UTF8) {
      value = cString(raw);
    } else {
      value = raw;
    }

    entries.push({ key, format, length, maxLength, value, raw });
  }

  return { version, entries };
}

export function parseSfo(input) {
  return Object.fromEntries(parseSfoDetailed(input).entries.map((entry) => [entry.key, entry.value]));
}

function encodeEntry(entry) {
  const format = Number(entry.format) & 0xffff;
  if (format === SFO_FORMAT.UINT32) {
    const encoded = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, Number(entry.value) >>> 0, true);
    return { encoded, length: 4, maxLength: 4 };
  }
  if (format === SFO_FORMAT.UTF8) {
    const encoded = encoder.encode(String(entry.value ?? '') + '\0');
    const previous = Number(entry.maxLength) || 0;
    return { encoded, length: encoded.length, maxLength: align4(Math.max(previous, encoded.length)) };
  }

  const encoded = copyBytes(entry.value ?? entry.raw);
  const previous = Number(entry.maxLength) || 0;
  return { encoded, length: encoded.length, maxLength: align4(Math.max(previous, encoded.length, 1)) };
}

export function buildSfo(detailed, updates = {}) {
  if (!detailed || !Array.isArray(detailed.entries)) throw new Error('Invalid SFO model.');
  const seen = new Set();
  const entries = detailed.entries.map((source) => {
    const key = String(source.key || '').trim();
    if (!key) throw new Error('SFO keys cannot be empty.');
    if (seen.has(key)) throw new Error(`Duplicate SFO key: ${key}`);
    seen.add(key);
    const value = Object.prototype.hasOwnProperty.call(updates, key) ? updates[key] : source.value;
    return { ...source, key, value };
  });

  const keyChunks = [];
  let keyLength = 0;
  for (const entry of entries) {
    const keyBytes = encoder.encode(entry.key + '\0');
    entry.keyOffset = keyLength;
    keyChunks.push(keyBytes);
    keyLength += keyBytes.length;
  }

  const keyTableSize = align4(keyLength);
  const indexSize = entries.length * 16;
  const keyTableStart = 20 + indexSize;
  const dataTableStart = keyTableStart + keyTableSize;

  let dataSize = 0;
  for (const entry of entries) {
    const encoded = encodeEntry(entry);
    entry.encoded = encoded.encoded;
    entry.length = encoded.length;
    entry.maxLength = encoded.maxLength;
    entry.dataOffset = dataSize;
    dataSize += entry.maxLength;
  }

  const out = new Uint8Array(dataTableStart + dataSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46535000, true);
  view.setUint32(4, Number(detailed.version) || 0x00000101, true);
  view.setUint32(8, keyTableStart, true);
  view.setUint32(12, dataTableStart, true);
  view.setUint32(16, entries.length, true);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const off = 20 + i * 16;
    view.setUint16(off, entry.keyOffset, true);
    view.setUint16(off + 2, Number(entry.format) & 0xffff, true);
    view.setUint32(off + 4, entry.length, true);
    view.setUint32(off + 8, entry.maxLength, true);
    view.setUint32(off + 12, entry.dataOffset, true);
  }

  let cursor = keyTableStart;
  for (const chunk of keyChunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (const entry of entries) out.set(entry.encoded, dataTableStart + entry.dataOffset);
  return out;
}

export function cloneSfoDetailed(detailed) {
  return {
    version: detailed.version,
    entries: detailed.entries.map((entry) => ({
      ...entry,
      value: entry.value instanceof Uint8Array ? entry.value.slice() : entry.value,
      raw: entry.raw instanceof Uint8Array ? entry.raw.slice() : entry.raw,
    })),
  };
}
