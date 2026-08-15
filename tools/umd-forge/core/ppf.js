const ASCII = new TextDecoder('windows-1252');
const FILE_ID_BEGIN = new TextEncoder().encode('@BEGIN_FILE_ID.DIZ');
const CHUNK = 8 * 1024 * 1024;

function findBytes(haystack, needle, from = 0) {
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer; return i; } return -1;
}
function description(bytes) { return ASCII.decode(bytes.subarray(6, 56)).replace(/\0.*$/s, '').trim(); }
function requireBytes(bytes, offset, length, label) { if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error(`Truncated PPF ${label}.`); }
function patchEnd(bytes, minimum) { const id = findBytes(bytes, FILE_ID_BEGIN, minimum); return id >= 0 ? id : bytes.length; }

export async function parsePpf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 56) throw new Error('PPF file is too small.');
  const magic = ASCII.decode(bytes.subarray(0, 5));
  const version = magic.startsWith('PPF1') ? 1 : magic.startsWith('PPF2') ? 2 : magic === 'PPF30' ? 3 : 0;
  if (!version) throw new Error('Not a PPF 1.0, 2.0 or 3.0 patch.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), records = [];
  let cursor, end = bytes.length, expectedSize = null, validation = null, undoAvailable = false, imageType = 0;
  if (version === 1) cursor = 56;
  else if (version === 2) {
    requireBytes(bytes, 56, 1028, '2.0 header'); expectedSize = view.getUint32(56, true);
    validation = bytes.slice(60, 1084); cursor = 1084; end = patchEnd(bytes, cursor);
  } else {
    requireBytes(bytes, 56, 4, '3.0 header'); imageType = bytes[56]; const blockcheck = bytes[57] === 1; undoAvailable = bytes[58] === 1;
    cursor = blockcheck ? 1084 : 60; if (blockcheck) { requireBytes(bytes, 60, 1024, '3.0 validation block'); validation = bytes.slice(60, 1084); }
    end = patchEnd(bytes, cursor);
  }
  let recordIndex = 0;
  while (cursor < end) {
    if (version <= 2) {
      requireBytes(bytes, cursor, 5, `${version}.0 record ${recordIndex}`); const offset = view.getUint32(cursor, true), length = bytes[cursor + 4]; cursor += 5;
      requireBytes(bytes, cursor, length, `${version}.0 record data`); records.push({ offset, data: bytes.slice(cursor, cursor + length), undo: null }); cursor += length;
    } else {
      requireBytes(bytes, cursor, 9, `3.0 record ${recordIndex}`); const rawOffset = view.getBigUint64(cursor, true); if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PPF3 record offset exceeds browser safe integer range.');
      const offset = Number(rawOffset), length = bytes[cursor + 8]; cursor += 9; requireBytes(bytes, cursor, length, '3.0 patch data'); const data = bytes.slice(cursor, cursor + length); cursor += length;
      let undo = null; if (undoAvailable) { requireBytes(bytes, cursor, length, '3.0 undo data'); undo = bytes.slice(cursor, cursor + length); cursor += length; }
      records.push({ offset, data, undo });
    }
    recordIndex++;
  }
  if (cursor !== end) throw new Error('PPF patch data has an invalid trailing record.');
  return { version, description: description(bytes), records, expectedSize, validation, validationOffset: imageType ? 0x80a0 : 0x9320, undoAvailable, imageType, fileId: end < bytes.length };
}

export async function validatePpf(imageBlob, patch) {
  const problems = [];
  if (patch.expectedSize != null && patch.expectedSize !== imageBlob.size) problems.push(`PPF2 expects ${patch.expectedSize} bytes; image has ${imageBlob.size}.`);
  if (patch.validation) {
    const actual = new Uint8Array(await imageBlob.slice(patch.validationOffset, patch.validationOffset + 1024).arrayBuffer());
    if (actual.length !== 1024 || actual.some((value, index) => value !== patch.validation[index])) problems.push(`PPF block check failed at 0x${patch.validationOffset.toString(16).toUpperCase()}.`);
  }
  for (const record of patch.records) if (record.offset + record.data.length > imageBlob.size) { problems.push(`Patch record at 0x${record.offset.toString(16)} extends beyond the image.`); break; }
  return { valid: problems.length === 0, problems };
}

export async function applyPpf(imageBlob, patchOrFile, { undo = false, force = false, onProgress } = {}) {
  const patch = patchOrFile?.records ? patchOrFile : await parsePpf(patchOrFile);
  if (undo && !patch.undoAvailable) throw new Error('This PPF does not contain undo data.');
  const validation = await validatePpf(imageBlob, patch); if (!validation.valid && !force) throw new Error(validation.problems.join(' '));
  const records = patch.records.map((r) => ({ offset: r.offset, bytes: undo ? r.undo : r.data }));
  const parts = [];
  for (let start = 0; start < imageBlob.size; start += CHUNK) {
    const end = Math.min(imageBlob.size, start + CHUNK); const intersecting = records.filter((r) => r.offset < end && r.offset + r.bytes.length > start);
    if (!intersecting.length) parts.push(imageBlob.slice(start, end));
    else {
      const chunk = new Uint8Array(await imageBlob.slice(start, end).arrayBuffer());
      for (const record of intersecting) {
        const from = Math.max(start, record.offset), to = Math.min(end, record.offset + record.bytes.length);
        chunk.set(record.bytes.subarray(from - record.offset, to - record.offset), from - start);
      }
      parts.push(chunk);
    }
    onProgress?.(end / Math.max(1, imageBlob.size));
  }
  return { blob: new Blob(parts, { type: 'application/x-iso9660-image' }), patch, validation };
}
