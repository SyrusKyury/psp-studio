const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const ZIP16_MAX = 0xFFFF;
const ZIP32_MAX = 0xFFFFFFFF;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, bytes) {
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function crc32Blob(blob) {
  if (!blob || !Number.isFinite(blob.size) || blob.size < 0 || typeof blob.slice !== 'function') throw new Error('CRC32 input must be Blob-like.');
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + 1024 * 1024)).arrayBuffer());
    crc = crc32Update(crc, bytes);
  }
  return crc >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function dosDateTime(date = new Date()) {
  const source = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, source.getFullYear()));
  const time = ((source.getHours() & 0x1F) << 11) | ((source.getMinutes() & 0x3F) << 5) | ((Math.floor(source.getSeconds() / 2)) & 0x1F);
  const day = ((year - 1980) << 9) | ((source.getMonth() + 1) << 5) | source.getDate();
  return { time, day };
}

function localHeader(nameBytes, crc, size, date) {
  const bytes = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  u32(view, 0, 0x04034B50); u16(view, 4, 20); u16(view, 6, 0x0800); u16(view, 8, 0);
  u16(view, 10, date.time); u16(view, 12, date.day); u32(view, 14, crc); u32(view, 18, size); u32(view, 22, size);
  u16(view, 26, nameBytes.length); u16(view, 28, 0); bytes.set(nameBytes, 30);
  return bytes;
}

function centralHeader(nameBytes, crc, size, offset, date, isDirectory) {
  const bytes = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  u32(view, 0, 0x02014B50); u16(view, 4, 20); u16(view, 6, 20); u16(view, 8, 0x0800); u16(view, 10, 0);
  u16(view, 12, date.time); u16(view, 14, date.day); u32(view, 16, crc); u32(view, 20, size); u32(view, 24, size);
  u16(view, 28, nameBytes.length); u16(view, 30, 0); u16(view, 32, 0); u16(view, 34, 0); u16(view, 36, 0);
  u32(view, 38, isDirectory ? 0x10 : 0); u32(view, 42, offset); bytes.set(nameBytes, 46);
  return bytes;
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  u32(view, 0, 0x06054B50); u16(view, 4, 0); u16(view, 6, 0); u16(view, 8, count); u16(view, 10, count);
  u32(view, 12, centralSize); u32(view, 16, centralOffset); u16(view, 20, 0);
  return bytes;
}

function assertZipEntryName(name) {
  if (typeof name !== 'string' || !name) throw new Error('ZIP entry name cannot be empty.');
  const bytes = textEncoder.encode(name);
  if (bytes.length > ZIP16_MAX) throw new Error(`ZIP entry name is too long: ${name.slice(0, 80)}`);
  return bytes;
}

function assertZip32Value(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= ZIP32_MAX) throw new Error(`${label} exceeds the usable ZIP32 limit/sentinel. ZIP64 is not supported.`);
}

export async function createStoredZip(entries, { onProgress, maxCentralDirectoryBytes = ZIP32_MAX - 1 } = {}) {
  if (!Array.isArray(entries)) throw new Error('ZIP entries must be an array.');
  if (entries.length >= ZIP16_MAX) throw new Error('ZIP contains too many entries. ZIP64 is not supported.');
  if (!Number.isSafeInteger(maxCentralDirectoryBytes) || maxCentralDirectoryBytes < 0 || maxCentralDirectoryBytes >= ZIP32_MAX) throw new Error('Invalid ZIP central-directory safety limit.');

  const names = new Set();
  const prepared = [];
  let predictedLocalSize = 0;
  let predictedCentralSize = 0;
  let total = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid ZIP entry.');
    const name = String(entry.name || '');
    if (names.has(name)) throw new Error(`ZIP contains a duplicate output entry: ${name}`);
    names.add(name);
    const isDirectory = name.endsWith('/');
    const blob = isDirectory ? new Blob([]) : entry.blob;
    if (!isDirectory && (!blob || !Number.isFinite(blob.size) || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function')) throw new Error(`Invalid ZIP payload for ${name || '(unnamed entry)'}.`);
    assertZip32Value(blob.size, `ZIP entry ${name || '(unnamed entry)'}`);
    const nameBytes = assertZipEntryName(name);
    predictedLocalSize += 30 + nameBytes.length + blob.size;
    predictedCentralSize += 46 + nameBytes.length;
    total += blob.size;
    assertZip32Value(predictedLocalSize, 'ZIP local-data area');
    assertZip32Value(predictedCentralSize, 'ZIP central-directory size');
    if (predictedCentralSize > maxCentralDirectoryBytes) throw new Error('ZIP central directory exceeds the configured safety limit.');
    assertZip32Value(predictedLocalSize + predictedCentralSize + 22, 'ZIP archive size');
    prepared.push({ entry, nameBytes, isDirectory, blob });
  }

  const parts = [];
  const central = [];
  let offset = 0;
  let processed = 0;
  const progressTotal = total || 1;

  for (const item of prepared) {
    const { entry, nameBytes, isDirectory, blob } = item;
    const crc = isDirectory ? 0 : await crc32Blob(blob);
    const date = dosDateTime(entry.lastModified ? new Date(entry.lastModified) : new Date());
    const header = localHeader(nameBytes, crc, blob.size, date);
    parts.push(header, blob);
    assertZip32Value(offset, 'ZIP local-header offset');
    central.push(centralHeader(nameBytes, crc, blob.size, offset, date, isDirectory));
    offset += header.byteLength + blob.size;
    processed += blob.size;
    onProgress?.(Math.min(0.9, processed / progressTotal * 0.9));
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const header of central) { parts.push(header); centralSize += header.byteLength; }
  assertZip32Value(centralOffset, 'ZIP central-directory offset');
  assertZip32Value(centralSize, 'ZIP central-directory size');
  assertZip32Value(centralOffset + centralSize + 22, 'ZIP archive size');
  parts.push(endOfCentralDirectory(central.length, centralSize, centralOffset));
  onProgress?.(1);
  return new Blob(parts, { type: 'application/zip' });
}


function findEocd(file) {
  const max = Math.min(file.size, 65557);
  return file.slice(file.size - max).arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4B || bytes[i + 2] !== 0x05 || bytes[i + 3] !== 0x06) continue;
      const commentLength = view.getUint16(i + 20, true);
      if (i + 22 + commentLength === bytes.length) return { offset: file.size - max + i, buffer, localOffset: i };
    }
    throw new Error('Invalid ZIP: end-of-central-directory not found.');
  });
}

async function inflateRawBounded(blob, expectedSize, name) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Deflate-compressed ZIP entries are not supported in this browser.');
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > expectedSize) {
        try { await reader.cancel(); } catch {}
        throw new Error(`ZIP entry expands beyond its declared uncompressed size: ${name}.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (/expands beyond its declared/.test(String(error?.message || error))) throw error;
    throw new Error(`Could not decompress ZIP entry ${name}: ${error?.message || error}`);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (total !== expectedSize) throw new Error(`Invalid decompressed size for ${name}.`);
  return new Blob(chunks);
}

export async function readZip(file, { maxEntries = ZIP16_MAX - 1, maxCentralDirectoryBytes = ZIP32_MAX, maxInflatedEntryBytes = ZIP32_MAX, maxInflatedTotalBytes = Number.MAX_SAFE_INTEGER } = {}) {
  if (!file || !Number.isFinite(file.size) || typeof file.slice !== 'function' || file.size < 22) throw new Error('Invalid ZIP file.');
  if (file.size >= ZIP32_MAX) throw new Error('ZIP archive reaches the ZIP32 size sentinel. ZIP64 is not supported.');
  const eocd = await findEocd(file);
  if (eocd.localOffset + 22 > eocd.buffer.byteLength) throw new Error('Invalid ZIP end-of-central-directory record.');
  const view = new DataView(eocd.buffer, eocd.localOffset);
  const disk = view.getUint16(4, true);
  const centralDisk = view.getUint16(6, true);
  const diskCount = view.getUint16(8, true);
  const count = view.getUint16(10, true);
  const centralSize = view.getUint32(12, true);
  const centralOffset = view.getUint32(16, true);
  const commentLength = view.getUint16(20, true);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw new Error('Multi-disk ZIP archives are not supported.');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || count > maxEntries) throw new Error(`ZIP contains too many entries (${count}; limit ${maxEntries}).`);
  if (!Number.isSafeInteger(maxCentralDirectoryBytes) || maxCentralDirectoryBytes < 0 || centralSize > maxCentralDirectoryBytes) throw new Error('ZIP central directory exceeds the configured safety limit.');
  if (count === ZIP16_MAX || centralSize === ZIP32_MAX || centralOffset === ZIP32_MAX) throw new Error('ZIP64 archives are not supported.');
  if (eocd.localOffset + 22 + commentLength > eocd.buffer.byteLength) throw new Error('Invalid ZIP comment length.');
  if (centralOffset + centralSize > eocd.offset || centralOffset + centralSize > file.size) throw new Error('Invalid ZIP central-directory bounds.');

  const buffer = await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const centralView = new DataView(buffer);
  const entries = [];
  const names = new Set();
  let cursor = 0;
  let uncompressedTotal = 0;
  const localRanges = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralView.byteLength) throw new Error('Truncated ZIP central directory.');
    if (centralView.getUint32(cursor, true) !== 0x02014B50) throw new Error('Invalid ZIP central directory.');
    const flags = centralView.getUint16(cursor + 8, true);
    const expectedCrc32 = centralView.getUint32(cursor + 16, true);
    const method = centralView.getUint16(cursor + 10, true);
    const compressedSize = centralView.getUint32(cursor + 20, true);
    const uncompressedSize = centralView.getUint32(cursor + 24, true);
    const nameLength = centralView.getUint16(cursor + 28, true);
    const extraLength = centralView.getUint16(cursor + 30, true);
    const commentLengthEntry = centralView.getUint16(cursor + 32, true);
    const diskNumberStart = centralView.getUint16(cursor + 34, true);
    const localOffset = centralView.getUint32(cursor + 42, true);
    const recordSize = 46 + nameLength + extraLength + commentLengthEntry;
    if (cursor + recordSize > centralView.byteLength) throw new Error('Truncated ZIP central-directory entry.');
    if (diskNumberStart !== 0) throw new Error('Multi-disk ZIP entries are not supported.');
    if (compressedSize === ZIP32_MAX || uncompressedSize === ZIP32_MAX || localOffset === ZIP32_MAX) throw new Error('ZIP64 entry fields are not supported.');
    if (flags & 0x0001) throw new Error('Encrypted ZIP entries are not supported.');
    if (flags & (0x0020 | 0x0040 | 0x2000)) throw new Error('Patched, strong-encryption or masked ZIP entry headers are not supported.');
    if (![0, 8].includes(method)) throw new Error(`ZIP compression method ${method} is not supported in this browser.`);
    let name;
    try { name = textDecoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw new Error('ZIP contains a filename that is not valid UTF-8.'); }
    if (!name) throw new Error('ZIP contains an entry with an empty name.');
    if (names.has(name)) throw new Error(`ZIP contains a duplicate entry: ${name}`);
    names.add(name);
    if (name.endsWith('/') && (compressedSize !== 0 || uncompressedSize !== 0 || expectedCrc32 !== 0)) throw new Error(`ZIP directory entry contains unexpected data: ${name}`);
    if (uncompressedSize > maxInflatedEntryBytes) throw new Error(`ZIP entry exceeds the configured uncompressed-size limit: ${name}`);
    uncompressedTotal += uncompressedSize;
    if (!Number.isSafeInteger(uncompressedTotal) || uncompressedTotal > maxInflatedTotalBytes) throw new Error('ZIP payloads exceed the configured total uncompressed-size limit.');
    const localPrefixEnd = localOffset + 30 + nameLength;
    if (localPrefixEnd > centralOffset || localPrefixEnd > file.size) throw new Error(`Invalid local ZIP header/name bounds for ${name}.`);
    const localBuffer = await file.slice(localOffset, localPrefixEnd).arrayBuffer();
    if (localBuffer.byteLength !== 30 + nameLength) throw new Error(`Truncated local ZIP header/name for ${name}.`);
    const local = new DataView(localBuffer);
    if (local.getUint32(0, true) !== 0x04034B50) throw new Error(`Invalid local ZIP header for ${name}.`);
    const localFlags = local.getUint16(6, true);
    const localMethod = local.getUint16(8, true);
    const localCrc32 = local.getUint32(14, true);
    const localCompressedSize = local.getUint32(18, true);
    const localUncompressedSize = local.getUint32(22, true);
    const localNameLength = local.getUint16(26, true);
    const localExtraLength = local.getUint16(28, true);
    if (localNameLength !== nameLength) throw new Error(`ZIP local filename length disagrees with central directory for ${name}.`);
    if (localMethod !== method || localFlags !== flags) throw new Error(`ZIP local header disagrees with central directory for ${name}.`);
    const usesDataDescriptor = Boolean(flags & 0x0008);
    if (!usesDataDescriptor && (localCrc32 !== expectedCrc32 || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) throw new Error(`ZIP local sizes/CRC disagree with central directory for ${name}.`);
    if (usesDataDescriptor && !((localCrc32 === 0 || localCrc32 === expectedCrc32) && (localCompressedSize === 0 || localCompressedSize === compressedSize) && (localUncompressedSize === 0 || localUncompressedSize === uncompressedSize))) throw new Error(`ZIP local data-descriptor fields disagree with central directory for ${name}.`);
    if (localPrefixEnd + localExtraLength > centralOffset) throw new Error(`ZIP local header variable data is out of bounds: ${name}`);
    let localName;
    try { localName = textDecoder.decode(new Uint8Array(localBuffer, 30, nameLength)); }
    catch { throw new Error(`ZIP local filename is not valid UTF-8 for ${name}.`); }
    if (localName !== name) throw new Error(`ZIP local filename disagrees with central directory for ${name}.`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedEnd = dataOffset + compressedSize;
    if (compressedEnd > centralOffset || compressedEnd > file.size) throw new Error(`ZIP entry data is out of bounds: ${name}`);
    let dataDescriptorSize = 0;
    if (usesDataDescriptor) {
      if (compressedEnd + 12 > centralOffset || compressedEnd + 12 > file.size) throw new Error(`ZIP data descriptor is missing or truncated: ${name}`);
      const descriptorBuffer = await file.slice(compressedEnd, Math.min(compressedEnd + 16, centralOffset)).arrayBuffer();
      const descriptor = new DataView(descriptorBuffer);
      const hasSignature = descriptor.byteLength >= 16 && descriptor.getUint32(0, true) === 0x08074B50;
      const descriptorSize = hasSignature ? 16 : 12;
      dataDescriptorSize = descriptorSize;
      if (descriptor.byteLength < descriptorSize) throw new Error(`ZIP data descriptor is truncated: ${name}`);
      const base = hasSignature ? 4 : 0;
      const descriptorCrc32 = descriptor.getUint32(base, true);
      const descriptorCompressedSize = descriptor.getUint32(base + 4, true);
      const descriptorUncompressedSize = descriptor.getUint32(base + 8, true);
      if (descriptorCrc32 !== expectedCrc32 || descriptorCompressedSize !== compressedSize || descriptorUncompressedSize !== uncompressedSize) throw new Error(`ZIP data descriptor disagrees with central directory for ${name}.`);
    }
    let blob;
    if (name.endsWith('/')) blob = new Blob([]);
    else if (method === 0) {
      if (compressedSize !== uncompressedSize) throw new Error(`Invalid stored ZIP sizes for ${name}.`);
      blob = file.slice(dataOffset, dataOffset + compressedSize);
    } else blob = await inflateRawBounded(file.slice(dataOffset, dataOffset + compressedSize), uncompressedSize, name);
    if (!name.endsWith('/') && (await crc32Blob(blob)) !== expectedCrc32) throw new Error(`ZIP entry failed its CRC32 integrity check: ${name}`);
    localRanges.push({ name, start: localOffset, end: compressedEnd + dataDescriptorSize });
    entries.push({ name, blob });
    cursor += recordSize;
  }
  if (cursor !== centralView.byteLength) throw new Error('ZIP central directory contains unexpected trailing data.');
  localRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < localRanges.length; i += 1) {
    const previous = localRanges[i - 1]; const current = localRanges[i];
    if (current.start < previous.end) throw new Error(`ZIP local records overlap: ${previous.name} / ${current.name}`);
  }
  return entries;
}
