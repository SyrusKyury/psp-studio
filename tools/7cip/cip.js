/*
 * 7-CIP archive codec for Yu-Gi-Oh! Tag Force.
 *
 * The format logic is a clean JavaScript port/reimplementation based on:
 *   CIPTool by Lovro Plese (Xan), MIT License
 *   https://github.com/xan1242/CIPTool
 *
 * See NOTICE.md for attribution.
 */

const HEADER_SIZE = 0x30;
const ALIGNMENT = 0x800;
const CPJ_DATA_OFFSET = 0xA0;
const CPJ_SEED_OFFSET = 0x9E;
const ALT_FLAG = 0x80000000;
const ALT_POINTER_MASK = 0x00FFFFFF;
const VALUE_MASK = 0x7FFFFFFF;

function hex(value) {
  return Uint8Array.from(
    value.trim().split(/\s+/).filter(Boolean).map((part) => Number.parseInt(part, 16))
  );
}

// Fixed GIM header reconstructed by CIPTool when extracting CPM archives.
export const CPM_GIM_HEADER = hex(`
  4D 49 47 2E 30 30 2E 31 50 53 50 00 00 00 00 00
  02 00 00 00 70 10 00 00 10 00 00 00 10 00 00 00
  03 00 00 00 60 10 00 00 10 00 00 00 10 00 00 00
  04 00 00 00 50 10 00 00 50 10 00 00 10 00 00 00
  30 00 00 00 08 00 00 00 40 00 40 00 04 00 04 00
  04 00 02 00 00 00 00 00 30 00 00 00 40 00 00 00
  40 10 00 00 00 00 00 00 01 00 01 00 03 00 01 00
  40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`);

// CPM stores only the actual 64x64 DXT1 texture payload. CIPTool reconstructs
// the fixed 0x80-byte GIM header above when extracting. The header declares a
// larger 0x1000-byte pixel region, but only the first 0x800 bytes are image
// data for 64x64 DXT1; the rest is GIM/container padding.
export const CPM_GIM_DATA_OFFSET = CPM_GIM_HEADER.length;
export const CPM_IMAGE_PAYLOAD_SIZE = 0x800;
export const CPM_STANDALONE_GIM_SIZE = 0x1080;

const GIM_FORMAT_LABELS = new Map([
  [0x00, 'RGBA5650'], [0x01, 'RGBA5551'], [0x02, 'RGBA4444'], [0x03, 'RGBA8888'],
  [0x04, 'INDEX4'], [0x05, 'INDEX8'], [0x06, 'INDEX16'], [0x07, 'INDEX32'],
  [0x08, 'DXT1'], [0x09, 'DXT3'], [0x0A, 'DXT5'],
]);

const CPM_DXT_PAYLOAD_SIZES = new Map([
  [0x08, 0x800],  // DXT1: 64x64 at 4 bpp
  [0x09, 0x1000], // DXT3: 64x64 at 8 bpp
  [0x0A, 0x1000], // DXT5: 64x64 at 8 bpp
]);

// CIPTool's fixed JPEG prefix for Tag Force 3 through Tag Force 6.
export const CPJ_JFIF_HEADER_STANDARD = hex(`
  FF D8 FF E0 00 10 4A 46 49 46 00 01 01 00 00 01
  00 01 00 00 FF DB 00 43 00 03 02 02 03 02 02 03
  03 03 03 04 03 03 04 05 08 05 05 04 04 05 0A 07
  07 06 08 0C 0A 0C 0C 0B 0A 0B 0B 0D 0E 12 10 0D
  0E 11 0E 0B 0B 10 16 10 11 13 14 15 15 15 0C 0F
  17 18 16 14 18 12 14 15 14 FF DB 00 43 01 03 04
  04 05 04 05 09 05 05 09 14 0D 0B 0D 14 14 14 14
  14 14 14 14 14 14 14 14 14 14 14 14 14 14 14 14
  14 14 14 14 14 14 14 14 14 14 14 14 14 14 14 14
  14 14 14 14 14 14 14 14 14 14 14 14 14 14 FF C0
`);

// CIPTool's fixed JPEG prefix for ARC-V Tag Force Special.
export const CPJ_JFIF_HEADER_TFSP = hex(`
  FF D8 FF E0 00 10 4A 46 49 46 00 01 02 01 00 80
  00 80 00 00 FF DB 00 84 00 09 07 07 08 07 06 09
  08 08 08 0A 0A 09 0B 0D 15 0E 0D 0C 0C 0D 1A 13
  14 10 15 1E 1B 20 1F 1E 1B 1D 1D 21 25 2F 28 21
  23 2D 24 1D 1D 29 38 2A 2D 31 32 35 35 35 20 28
  3A 3E 39 33 3D 2F 34 35 33 01 0A 0A 0A 0D 0C 0D
  19 0E 0E 19 33 22 1D 22 33 33 33 33 33 33 33 33
  33 33 33 33 33 33 33 33 33 33 33 33 33 33 33 33
  33 33 33 33 33 33 33 33 33 33 33 33 33 33 33 33
  33 33 33 33 33 33 33 33 33 FF C4 01 A2 00 00
`);

if (CPJ_JFIF_HEADER_STANDARD.length > CPJ_DATA_OFFSET || CPJ_JFIF_HEADER_TFSP.length > CPJ_DATA_OFFSET) {
  throw new Error('Internal error: CPJ fixed headers cannot exceed the 0xA0 packed-data offset.');
}

export const CPJ_PROFILES = Object.freeze({
  standard: {
    id: 'standard',
    label: 'Tag Force 3-6 (512x512 CPJ)',
    header: CPJ_JFIF_HEADER_STANDARD,
  },
  tfsp: {
    id: 'tfsp',
    label: 'Tag Force Special (256x256 CPJ)',
    header: CPJ_JFIF_HEADER_TFSP,
  },
});

export const CIP_TYPES = Object.freeze({
  CIP: { id: 'CIP', magic: 0x1A504943, extension: '.gim', label: 'CIP - Card Image Pack' },
  CPM: { id: 'CPM', magic: 0x1A4D5043, extension: '.gim', label: 'CPM - Card Picture Middle' },
  CPJ: { id: 'CPJ', magic: 0x1A4A5043, extension: '.jpg', label: 'CPJ - Card Picture JPEG' },
  CPL: { id: 'CPL', magic: 0x1A4C5043, extension: '.gim', label: 'CPL - Card Palette' },
});

const TYPE_BY_MAGIC = new Map(Object.values(CIP_TYPES).map((type) => [type.magic >>> 0, type]));

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Uint8Array, ArrayBuffer, or ArrayBuffer view.');
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function concatBytes(...parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function equalPrefix(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

const GIM_HEADER_SIZE = 0x10;
const GIM_ROOT_HEADER_END = 0x18;
const MAX_GIM_EXPORT_SIZE = 512 * 1024 * 1024;
const MAX_GIM_SYNTHETIC_TAIL = 16 * 1024 * 1024;

function hasLittleEndianGimSignature(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x4D // M
    && bytes[1] === 0x49 // I
    && bytes[2] === 0x47 // G
    && bytes[3] === 0x2E; // .
}

/**
 * Inspect the fixed GIM file header + root block header without requiring the
 * complete image in memory. Tag Force CIP archives can store compact GIM slots
 * whose physical slot is shorter than the root block size declared by the GIM.
 */
export function inspectGimHeader(input, { physicalSize = null } = {}) {
  const bytes = asUint8Array(input);
  if (bytes.length < GIM_ROOT_HEADER_END || !hasLittleEndianGimSignature(bytes)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rootBlockId = view.getUint16(0x10, true);
  if (rootBlockId !== 0x02) return null;

  const rootBlockSize = view.getUint32(0x14, true);
  const declaredSize = GIM_HEADER_SIZE + rootBlockSize;
  if (rootBlockSize < 0x10 || declaredSize < GIM_ROOT_HEADER_END) {
    throw new Error('GIM root block size is invalid.');
  }
  if (declaredSize > MAX_GIM_EXPORT_SIZE) {
    throw new Error(`GIM declares an unsafe standalone size of ${declaredSize} bytes.`);
  }

  const actualSize = physicalSize == null ? bytes.byteLength : Number(physicalSize);
  if (!Number.isSafeInteger(actualSize) || actualSize < 0) throw new Error('GIM physical size is invalid.');
  const missingBytes = Math.max(0, declaredSize - actualSize);
  if (missingBytes > MAX_GIM_SYNTHETIC_TAIL) {
    throw new Error(`GIM is missing ${missingBytes} bytes, which is too large to reconstruct safely.`);
  }

  return {
    declaredSize,
    physicalSize: actualSize,
    rootBlockSize,
    missingBytes,
    trailingBytes: Math.max(0, actualSize - declaredSize),
    compact: declaredSize > actualSize,
  };
}

/**
 * Produce a standalone GIM Blob while keeping the archive representation raw.
 *
 * - If a slot contains archive padding beyond the GIM root block, it is trimmed.
 * - If Tag Force stored a compact/truncated GIM slot, the unavailable tail is
 *   zero-filled up to the size declared by the GIM header. This does not invent
 *   image data; it merely makes the exported standalone file structurally match
 *   its own header. Archive rebuilds continue to use the untouched raw slot.
 */
export async function makeStandaloneGimBlob(source) {
  if (!(source instanceof Blob)) throw new TypeError('makeStandaloneGimBlob expects a Blob or File.');
  const prefix = new Uint8Array(await source.slice(0, GIM_ROOT_HEADER_END).arrayBuffer());
  const info = inspectGimHeader(prefix, { physicalSize: source.size });
  if (!info) return { blob: source, info: null };

  if (info.declaredSize === source.size) return { blob: source, info };
  if (info.declaredSize < source.size) {
    return { blob: source.slice(0, info.declaredSize), info };
  }

  const tail = new Uint8Array(info.missingBytes);
  return { blob: new Blob([source, tail], { type: source.type || 'application/octet-stream' }), info };
}

function writeAscii(target, offset, text, maxLength) {
  const encoded = new TextEncoder().encode(text);
  const count = Math.min(encoded.length, Math.max(0, maxLength - 1));
  target.set(encoded.subarray(0, count), offset);
  if (count < maxLength) target[offset + count] = 0;
}

function readU32(view, offset, label) {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new Error(`${label} is outside the archive.`);
  }
  return view.getUint32(offset, true);
}

function setU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function jpegCodecInPlace(bytes) {
  if (bytes.length < CPJ_DATA_OFFSET) {
    throw new Error('CPJ slot is smaller than 0xA0 bytes.');
  }

  let factor = ((bytes[CPJ_SEED_OFFSET] << 8) | bytes[CPJ_SEED_OFFSET + 1]) >>> 0;
  for (let cursor = CPJ_DATA_OFFSET; cursor < bytes.length; cursor += 1) {
    factor = (Math.floor((50849 * factor + 3343) / 2) & 0xFFFF) >>> 0;
    bytes[cursor] ^= (factor >>> 2) & 0xFF;
  }
}

function findJpegEnd(bytes, start = CPJ_DATA_OFFSET) {
  for (let i = start; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xD9) return i + 2;
  }
  return -1;
}

function cpjHeader(profileId) {
  const profile = CPJ_PROFILES[profileId];
  if (!profile) throw new Error(`Unknown CPJ profile: ${profileId}`);
  return profile.header;
}

function decodeEntryPayload(typeId, slot, profileId) {
  switch (typeId) {
    case 'CPM': {
      const imagePayload = slot.subarray(0, Math.min(slot.length, CPM_IMAGE_PAYLOAD_SIZE));
      const missing = Math.max(0, CPM_STANDALONE_GIM_SIZE - CPM_GIM_HEADER.length - imagePayload.length);
      return concatBytes(CPM_GIM_HEADER, imagePayload, new Uint8Array(missing));
    }
    case 'CPJ': { 
      const decoded = slot.slice();
      jpegCodecInPlace(decoded);
      const end = findJpegEnd(decoded);
      if (end < 0) throw new Error('Decoded CPJ slot does not contain a JPEG EOI marker.');
      return concatBytes(cpjHeader(profileId), decoded.subarray(CPJ_DATA_OFFSET, end));
    }
    case 'CIP':
    case 'CPL':
      return slot.slice();
    default:
      throw new Error(`Unsupported archive type: ${typeId}`);
  }
}

function prepareEntryPayload(typeId, bytes, profileId) {
  const input = asUint8Array(bytes);

  if (input.length === 0) throw new Error('Empty entries are not supported.');

  switch (typeId) {
    case 'CPM': {
      if (input.length < CPM_GIM_DATA_OFFSET) {
        throw new Error('CPM entries must be a 64x64 DXT1 PSP GIM; the file is shorter than the 0x80-byte GIM header.');
      }
      if (!hasLittleEndianGimSignature(input)) {
        throw new Error('CPM entries must be PSP GIM files beginning with MIG.00.1PSP.');
      }

      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      const rootId = view.getUint16(0x10, true);
      const pictureId = view.getUint16(0x20, true);
      const imageId = view.getUint16(0x30, true);
      const imageFormat = view.getUint16(0x44, true);
      const pixelOrder = view.getUint16(0x46, true);
      const width = view.getUint16(0x48, true);
      const height = view.getUint16(0x4A, true);
      const pixelsStart = view.getUint32(0x5C, true);
      const levelCount = view.getUint16(0x6A, true);
      const frameCount = view.getUint16(0x6E, true);
      const frameOffset = view.getUint32(0x70, true);
      const formatLabel = GIM_FORMAT_LABELS.get(imageFormat) || `format 0x${imageFormat.toString(16).toUpperCase()}`;

      if (rootId !== 0x02 || pictureId !== 0x03 || imageId !== 0x04) {
        throw new Error('CPM requires the simple Root/Picture/Image GIM layout used by Tag Force card thumbnails.');
      }
      if (pixelOrder !== 0 || width !== 64 || height !== 64) {
        throw new Error(`CPM requires a 64x64 / normal GIM. This file is ${width}x${height}, ${formatLabel}, pixel order ${pixelOrder}.`);
      }
      const payloadSize = CPM_DXT_PAYLOAD_SIZES.get(imageFormat);
      if (!payloadSize) {
        throw new Error(`CPM raw replacement currently supports DXT1, DXT3 and DXT5 GIM payloads. This file uses ${formatLabel}.`);
      }
      if (pixelsStart !== 0x40 || frameOffset !== 0x40 || levelCount !== 1 || frameCount !== 1) {
        throw new Error('CPM requires one frame/level with pixel data beginning at GIM offset 0x80.');
      }

      const payloadStart = CPM_GIM_DATA_OFFSET;
      const payloadEnd = payloadStart + payloadSize;
      if (input.length < payloadEnd) {
        throw new Error(`CPM ${formatLabel} pixel payload is truncated: expected ${payloadSize} bytes at offset 0x80, found ${Math.max(0, input.length - payloadStart)}.`);
      }

      // 7-CIP exports stock CPM/DXT1 as a structurally complete 0x1080-byte
      // standalone GIM. Its synthetic tail is zero padding and must not be
      // re-imported as archive payload. DXT3/DXT5 legitimately use the entire
      // 0x1000-byte pixel region instead.
      for (let i = payloadEnd; i < input.length; i += 1) {
        if (input[i] !== 0) {
          throw new Error(`CPM contains non-zero data after the expected ${formatLabel} payload.`);
        }
      }

      return {
        payload: input.subarray(payloadStart, payloadEnd),
        requiredSize: payloadSize,
        compatibilityWarning: imageFormat === 0x08
          ? null
          : `You're replacing the stock DXT1 CPM profile with ${formatLabel}. 7-CIP can pack it. ${formatLabel} needs a 0x${payloadSize.toString(16).toUpperCase()}-byte payload instead of DXT1's 0x800, so the archive's global slot size may grow. CPM also strips the GIM header, so the texture-format metadata is not retained in the packed file.`,
        formatLabel,
        imageFormat,
      };
    }

    case 'CPJ': {
      const header = cpjHeader(profileId);
      if (!equalPrefix(input, header)) {
        throw new Error(`CPJ JPEG does not match the selected ${CPJ_PROFILES[profileId].label} header/profile.`);
      }
      const eoi = findJpegEnd(input, header.length);
      if (eoi < 0) throw new Error('CPJ JPEG does not contain an EOI marker.');
      return {
        payload: input.subarray(header.length, eoi),
        requiredSize: CPJ_DATA_OFFSET + (eoi - header.length),
      };
    }

    case 'CIP':
    case 'CPL':
      return { payload: input, requiredSize: input.length };

    default:
      throw new Error(`Unsupported archive type: ${typeId}`);
  }
}

function entryName(typeId, cardId, altIndex) {
  const ext = CIP_TYPES[typeId].extension;
  return altIndex == null ? `${cardId}${ext}` : `${cardId}_${altIndex}${ext}`;
}

export function parseEntryFilename(typeId, filename) {
  const ext = CIP_TYPES[typeId]?.extension;
  if (!ext) throw new Error(`Unsupported archive type: ${typeId}`);

  const escaped = ext.replace('.', '\\.');
  const match = new RegExp(`^(\\d+)(?:_(\\d+))?${escaped}$`, 'i').exec(filename.trim());
  if (!match) return null;

  const cardId = Number.parseInt(match[1], 10);
  const altIndex = match[2] == null ? null : Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(cardId) || cardId < 0 || cardId > 0xFFFFFFFF) return null;
  if (altIndex != null && (!Number.isSafeInteger(altIndex) || altIndex < 0)) return null;

  return { cardId, altIndex };
}

export function detectType(input) {
  const bytes = asUint8Array(input);
  if (bytes.length < 4) throw new Error('File is too small to be a CIP archive.');
  const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const type = TYPE_BY_MAGIC.get(magic >>> 0);
  if (!type) {
    const shown = `0x${(magic >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
    throw new Error(`Unknown CIP-family magic ${shown}.`);
  }
  return type.id;
}

export function parseArchive(input, { cpjProfile = 'standard' } = {}) {
  const bytes = asUint8Array(input);
  if (bytes.length < HEADER_SIZE) throw new Error('Archive is smaller than the 0x30-byte header.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = detectType(bytes);
  if (type === 'CPJ') cpjHeader(cpjProfile);

  const fullFileSize = readU32(view, 0x04, 'FullFileSize');
  const headerSize = readU32(view, 0x10, 'HeaderSize');
  const minCardNumber = readU32(view, 0x14, 'MinCardNumber');
  const maxCardNumber = readU32(view, 0x18, 'MaxCardNumber');
  const offsetTableTop = readU32(view, 0x1C, 'OffsetTableTop');
  const bitshiftSize = readU32(view, 0x20, 'BitshiftSize');

  const warnings = [];
  if (fullFileSize !== 0 && fullFileSize !== bytes.length) {
    warnings.push(`Header FullFileSize is 0x${fullFileSize.toString(16)}, actual file size is 0x${bytes.length.toString(16)}.`);
  }
  if (headerSize < HEADER_SIZE || headerSize > bytes.length) throw new Error('HeaderSize is invalid.');
  if (offsetTableTop < HEADER_SIZE || offsetTableTop >= headerSize) throw new Error('OffsetTableTop is invalid.');
  if (maxCardNumber < minCardNumber) throw new Error('Card ID range is invalid.');
  if (bitshiftSize === 0) throw new Error('BitshiftSize is zero.');

  const primaryCount = maxCardNumber - minCardNumber + 1;
  if (primaryCount > 1_000_000) throw new Error('Card ID range is unreasonably large.');

  const primaryEnd = offsetTableTop + primaryCount * 8;
  if (primaryEnd > headerSize || primaryEnd > bytes.length) {
    throw new Error('Primary offset table exceeds HeaderSize.');
  }

  const slotSize = bitshiftSize * ALIGNMENT;
  const firstOffset = alignUp(headerSize, ALIGNMENT);
  if (firstOffset > bytes.length) throw new Error('Aligned data start is outside the archive.');
  const firstSlotId = firstOffset >>> 11;

  function resolveSlot(slotId, label) {
    const cleanId = slotId & VALUE_MASK;
    if (cleanId < firstSlotId) throw new Error(`${label}: slot ID points before the data area.`);
    const delta = cleanId - firstSlotId;
    if (delta % bitshiftSize !== 0) throw new Error(`${label}: slot ID is not aligned to BitshiftSize.`);
    const index = delta / bitshiftSize;
    const dataOffset = firstOffset + index * slotSize;
    if (dataOffset < firstOffset || dataOffset + slotSize > bytes.length) {
      throw new Error(`${label}: data slot at 0x${dataOffset.toString(16)} exceeds the archive.`);
    }
    return bytes.subarray(dataOffset, dataOffset + slotSize);
  }

  const entries = [];
  const seenAltPointers = new Set();

  for (let index = 0; index < primaryCount; index += 1) {
    const cardId = minCardNumber + index;
    const pairOffset = offsetTableTop + index * 8;
    const idField = readU32(view, pairOffset, `Card ${cardId} offset pair`);

    if (idField === 0) continue;

    if ((idField & ALT_FLAG) !== 0) {
      const altPointer = idField & ALT_POINTER_MASK;
      if (altPointer < primaryEnd || altPointer + 8 > headerSize) {
        throw new Error(`Card ${cardId}: alternate-art table pointer 0x${altPointer.toString(16)} is invalid.`);
      }
      if (seenAltPointers.has(altPointer)) {
        warnings.push(`Card ${cardId}: alternate-art table pointer is reused.`);
      }
      seenAltPointers.add(altPointer);

      let cursor = altPointer;
      let altIndex = 0;
      let foundLast = false;
      while (cursor + 8 <= headerSize) {
        const altIdField = readU32(view, cursor, `Card ${cardId} alternate ${altIndex}`);
        if (altIdField === 0 || altIdField === 0xFFFFFFFF) {
          throw new Error(`Card ${cardId}: invalid alternate-art slot ID.`);
        }
        const isLast = (altIdField & ALT_FLAG) !== 0;
        const slot = resolveSlot(altIdField, `Card ${cardId} alternate ${altIndex}`);
        const payload = decodeEntryPayload(type, slot, cpjProfile);
        const cleanSlotId = altIdField & VALUE_MASK;
        entries.push({
          cardId,
          altIndex,
          name: entryName(type, cardId, altIndex),
          bytes: payload,
          rawSlot: slot.slice(),
          sourceSlotId: cleanSlotId >>> 0,
          sourceSlotIndex: (cleanSlotId - firstSlotId) / bitshiftSize,
        });
        altIndex += 1;
        cursor += 8;
        if (isLast) {
          foundLast = true;
          break;
        }
        if (altIndex > 10000) throw new Error(`Card ${cardId}: alternate-art chain is unreasonably long.`);
      }
      if (!foundLast) throw new Error(`Card ${cardId}: alternate-art chain has no terminating flag.`);
      continue;
    }

    const slot = resolveSlot(idField, `Card ${cardId}`);
    const payload = decodeEntryPayload(type, slot, cpjProfile);
    const cleanSlotId = idField & VALUE_MASK;
    entries.push({
      cardId,
      altIndex: null,
      name: entryName(type, cardId, null),
      bytes: payload,
      rawSlot: slot.slice(),
      sourceSlotId: cleanSlotId >>> 0,
      sourceSlotIndex: (cleanSlotId - firstSlotId) / bitshiftSize,
    });
  }

  return {
    type,
    cpjProfile,
    entries,
    warnings,
    header: {
      fullFileSize,
      headerSize,
      minCardNumber,
      maxCardNumber,
      offsetTableTop,
      bitshiftSize,
      slotSize,
      firstOffset,
    },
  };
}

function normalizeEntries(typeId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Add at least one entry before building an archive.');
  }

  const groups = new Map();
  for (const source of entries) {
    const cardId = Number(source.cardId);
    const altIndex = source.altIndex == null ? null : Number(source.altIndex);
    if (!Number.isInteger(cardId) || cardId < 0 || cardId > 0xFFFFFFFF) {
      throw new Error(`Invalid card ID: ${source.cardId}`);
    }
    if (altIndex != null && (!Number.isInteger(altIndex) || altIndex < 0)) {
      throw new Error(`Invalid alternate-art index for card ${cardId}.`);
    }

    const bytes = asUint8Array(source.bytes);
    let group = groups.get(cardId);
    if (!group) {
      group = { cardId, base: null, alts: new Map() };
      groups.set(cardId, group);
    }

    if (altIndex == null) {
      if (group.base) throw new Error(`Card ${cardId} has more than one base entry.`);
      if (group.alts.size) throw new Error(`Card ${cardId} mixes a base image with alternate-art entries.`);
      group.base = {
        cardId,
        altIndex: null,
        bytes,
        name: source.name || entryName(typeId, cardId, null),
        sourceSlotId: Number.isInteger(source.sourceSlotId) ? source.sourceSlotId : null,
        sourceSlotIndex: Number.isInteger(source.sourceSlotIndex) && source.sourceSlotIndex >= 0 ? source.sourceSlotIndex : null,
      };
    } else {
      if (group.base) throw new Error(`Card ${cardId} mixes a base image with alternate-art entries.`);
      if (group.alts.has(altIndex)) throw new Error(`Card ${cardId} has duplicate alternate-art index ${altIndex}.`);
      group.alts.set(altIndex, {
        cardId,
        altIndex,
        bytes,
        name: source.name || entryName(typeId, cardId, altIndex),
        sourceSlotId: Number.isInteger(source.sourceSlotId) ? source.sourceSlotId : null,
        sourceSlotIndex: Number.isInteger(source.sourceSlotIndex) && source.sourceSlotIndex >= 0 ? source.sourceSlotIndex : null,
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) => a.cardId - b.cardId);
  for (const group of ordered) {
    if (group.base) continue;
    if (!group.alts.size) throw new Error(`Card ${group.cardId} has no data.`);
    const indices = [...group.alts.keys()].sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i += 1) {
      if (indices[i] !== i) {
        throw new Error(`Card ${group.cardId} alternate arts must be contiguous from _0 (missing _${i}).`);
      }
    }
  }
  return ordered;
}

export function buildArchive({ type, cpjProfile = 'standard', entries }) {
  const typeInfo = CIP_TYPES[type];
  if (!typeInfo) throw new Error(`Unsupported archive type: ${type}`);
  if (type === 'CPJ') cpjHeader(cpjProfile);

  const groups = normalizeEntries(type, entries);
  const minCardNumber = groups[0].cardId;
  const maxCardNumber = groups[groups.length - 1].cardId;
  const primaryCount = maxCardNumber - minCardNumber + 1;
  if (primaryCount > 1_000_000) throw new Error('Card ID range is too large to build safely.');

  let altPairCount = 0;
  const orderedData = [];
  let maxRequiredSize = 0;

  for (const group of groups) {
    const groupEntries = group.base
      ? [group.base]
      : [...group.alts.values()].sort((a, b) => a.altIndex - b.altIndex);

    if (!group.base) altPairCount += groupEntries.length;

    for (const entry of groupEntries) {
      const prepared = prepareEntryPayload(type, entry.bytes, cpjProfile);
      maxRequiredSize = Math.max(maxRequiredSize, prepared.requiredSize);
      orderedData.push({ ...entry, prepared, logicalOrder: orderedData.length });
    }
  }

  // Existing archives may store payload slots in an order unrelated to numeric card ID.
  // Preserve that physical order when source slot metadata is available so opening and
  // rebuilding an untouched archive can be byte-identical. New entries have no source
  // slot and are appended after the preserved source layout.
  if (orderedData.some((entry) => Number.isInteger(entry.sourceSlotIndex))) {
    const seenSourceSlots = new Set();
    for (const entry of orderedData) {
      if (!Number.isInteger(entry.sourceSlotIndex)) continue;
      if (seenSourceSlots.has(entry.sourceSlotIndex)) {
        throw new Error(`Duplicate source slot index ${entry.sourceSlotIndex} while preserving archive layout.`);
      }
      seenSourceSlots.add(entry.sourceSlotIndex);
    }
    orderedData.sort((a, b) => {
      const aHasSource = Number.isInteger(a.sourceSlotIndex);
      const bHasSource = Number.isInteger(b.sourceSlotIndex);
      if (aHasSource && bHasSource) return a.sourceSlotIndex - b.sourceSlotIndex;
      if (aHasSource) return -1;
      if (bHasSource) return 1;
      return a.logicalOrder - b.logicalOrder;
    });
  }

  const bitshiftSize = Math.max(1, Math.ceil(maxRequiredSize / ALIGNMENT));
  const slotSize = bitshiftSize * ALIGNMENT;
  const offsetTableTop = HEADER_SIZE;
  const primaryTableSize = primaryCount * 8;
  const altTableSize = altPairCount * 8;
  const headerSize = HEADER_SIZE + primaryTableSize + altTableSize + 8;
  const firstOffset = alignUp(headerSize, ALIGNMENT);
  const firstSlotId = firstOffset >>> 11;
  const fullFileSize = firstOffset + orderedData.length * slotSize;

  if (fullFileSize > 0x7FFFFFFF) throw new Error('Resulting archive is too large for the browser implementation.');

  const out = new Uint8Array(fullFileSize);
  const view = new DataView(out.buffer);

  setU32(view, 0x00, typeInfo.magic);
  setU32(view, 0x04, fullFileSize);
  setU32(view, 0x10, headerSize);
  setU32(view, 0x14, minCardNumber);
  setU32(view, 0x18, maxCardNumber);
  setU32(view, 0x1C, offsetTableTop);
  setU32(view, 0x20, bitshiftSize);

  const groupById = new Map(groups.map((group) => [group.cardId, group]));
  const slotByEntryKey = new Map();
  for (let i = 0; i < orderedData.length; i += 1) {
    const entry = orderedData[i];
    const key = `${entry.cardId}:${entry.altIndex == null ? 'base' : entry.altIndex}`;
    const slotId = firstSlotId + bitshiftSize * i;
    if (slotId > VALUE_MASK) throw new Error('Archive slot ID exceeds supported 31-bit range.');
    slotByEntryKey.set(key, slotId >>> 0);
  }

  let altCursor = offsetTableTop + primaryTableSize;
  for (let cardId = minCardNumber; cardId <= maxCardNumber; cardId += 1) {
    const group = groupById.get(cardId);
    if (!group) continue;
    const pairOffset = offsetTableTop + (cardId - minCardNumber) * 8;

    if (group.base) {
      const slotId = slotByEntryKey.get(`${cardId}:base`);
      setU32(view, pairOffset, slotId);
      continue;
    }

    if (altCursor > ALT_POINTER_MASK) {
      throw new Error('Alternate-art table exceeds the 24-bit pointer range used by CIPTool.');
    }
    setU32(view, pairOffset, ALT_FLAG | altCursor);

    const alts = [...group.alts.values()].sort((a, b) => a.altIndex - b.altIndex);
    for (let i = 0; i < alts.length; i += 1) {
      const alt = alts[i];
      let slotId = slotByEntryKey.get(`${cardId}:${alt.altIndex}`);
      if (i === alts.length - 1) slotId = (slotId | ALT_FLAG) >>> 0;
      setU32(view, altCursor, slotId);
      altCursor += 8;
    }
  }

  setU32(view, altCursor, 0xFFFFFFFF);
  setU32(view, altCursor + 4, 0xFFFFFFFF);

  for (let i = 0; i < orderedData.length; i += 1) {
    const entry = orderedData[i];
    const slotOffset = firstOffset + i * slotSize;
    const slot = out.subarray(slotOffset, slotOffset + slotSize);

    if (type === 'CPJ') {
      if (entry.prepared.payload.length > slotSize - CPJ_DATA_OFFSET) {
        throw new Error(`${entry.name} does not fit the selected CPJ slot size.`);
      }
      slot[CPJ_SEED_OFFSET] = (entry.cardId >>> 8) & 0xFF;
      slot[CPJ_SEED_OFFSET + 1] = entry.cardId & 0xFF;
      slot.set(entry.prepared.payload, CPJ_DATA_OFFSET);
      jpegCodecInPlace(slot);
      writeAscii(slot, 0, `file: ${entryName(type, entry.cardId, entry.altIndex)} encode_secret: 0x${entry.cardId.toString(16).toUpperCase()}`, CPJ_SEED_OFFSET);
    } else {
      if (entry.prepared.payload.length > slot.length) {
        throw new Error(`${entry.name} does not fit the selected slot size.`);
      }
      slot.set(entry.prepared.payload);
    }
  }

  return {
    bytes: out,
    info: {
      type,
      cpjProfile,
      fullFileSize,
      headerSize,
      minCardNumber,
      maxCardNumber,
      offsetTableTop,
      bitshiftSize,
      slotSize,
      firstOffset,
      entryCount: orderedData.length,
      altPairCount,
    },
  };
}

export function expectedExtension(typeId) {
  const type = CIP_TYPES[typeId];
  if (!type) throw new Error(`Unsupported archive type: ${typeId}`);
  return type.extension;
}

export function makeEntryName(typeId, cardId, altIndex = null) {
  return entryName(typeId, cardId, altIndex);
}

export function validateEntryBytes(typeId, bytes, { cpjProfile = 'standard' } = {}) {
  prepareEntryPayload(typeId, asUint8Array(bytes), cpjProfile);
  return true;
}

export function entryCompatibilityWarning(typeId, bytes, { cpjProfile = 'standard' } = {}) {
  const prepared = prepareEntryPayload(typeId, asUint8Array(bytes), cpjProfile);
  return prepared.compatibilityWarning || null;
}

/*
 * Lazy archive helpers.
 *
 * These APIs intentionally separate archive metadata from entry payloads so large
 * CPJ files can be opened without decoding/copying every slot up front. The source
 * Blob/File remains authoritative and callers read individual slots on demand.
 */

export function decodeSlotPayload(typeId, slotBytes, { cpjProfile = 'standard' } = {}) {
  const slot = asUint8Array(slotBytes);
  if (!CIP_TYPES[typeId]) throw new Error(`Unsupported archive type: ${typeId}`);
  if (typeId === 'CPJ') cpjHeader(cpjProfile);
  return decodeEntryPayload(typeId, slot, cpjProfile);
}

export function encodeEntrySlot(typeId, entry, slotSize, { cpjProfile = 'standard' } = {}) {
  if (!CIP_TYPES[typeId]) throw new Error(`Unsupported archive type: ${typeId}`);
  if (!Number.isInteger(slotSize) || slotSize <= 0 || slotSize % ALIGNMENT !== 0) {
    throw new Error('Slot size must be a positive multiple of 0x800.');
  }

  const prepared = prepareEntryPayload(typeId, entry.bytes, cpjProfile);
  const slot = new Uint8Array(slotSize);

  if (typeId === 'CPJ') {
    if (prepared.payload.length > slotSize - CPJ_DATA_OFFSET) {
      throw new Error(`${entry.name || entryName(typeId, entry.cardId, entry.altIndex)} does not fit the selected CPJ slot size.`);
    }
    slot[CPJ_SEED_OFFSET] = (entry.cardId >>> 8) & 0xFF;
    slot[CPJ_SEED_OFFSET + 1] = entry.cardId & 0xFF;
    slot.set(prepared.payload, CPJ_DATA_OFFSET);
    jpegCodecInPlace(slot);
    writeAscii(
      slot,
      0,
      `file: ${entryName(typeId, entry.cardId, entry.altIndex)} encode_secret: 0x${entry.cardId.toString(16).toUpperCase()}`,
      CPJ_SEED_OFFSET,
    );
    return slot;
  }

  if (prepared.payload.length > slot.length) {
    throw new Error(`${entry.name || entryName(typeId, entry.cardId, entry.altIndex)} does not fit the selected slot size.`);
  }
  slot.set(prepared.payload);
  return slot;
}

function indexSizeHint(typeId, slotSize) {
  switch (typeId) {
    case 'CPM': return CPM_STANDALONE_GIM_SIZE;
    case 'CIP':
    case 'CPL': return slotSize;
    case 'CPJ': return null;
    default: return null;
  }
}

export function parseArchiveIndex(input, { cpjProfile = 'standard', archiveSize = null } = {}) {
  const bytes = asUint8Array(input);
  if (bytes.length < HEADER_SIZE) throw new Error('Archive is smaller than the 0x30-byte header.');

  const totalSize = archiveSize == null ? bytes.length : Number(archiveSize);
  if (!Number.isSafeInteger(totalSize) || totalSize < HEADER_SIZE) throw new Error('Archive size is invalid.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = detectType(bytes);
  if (type === 'CPJ') cpjHeader(cpjProfile);

  const fullFileSize = readU32(view, 0x04, 'FullFileSize');
  const headerSize = readU32(view, 0x10, 'HeaderSize');
  const minCardNumber = readU32(view, 0x14, 'MinCardNumber');
  const maxCardNumber = readU32(view, 0x18, 'MaxCardNumber');
  const offsetTableTop = readU32(view, 0x1C, 'OffsetTableTop');
  const bitshiftSize = readU32(view, 0x20, 'BitshiftSize');

  const warnings = [];
  if (fullFileSize !== 0 && fullFileSize !== totalSize) {
    warnings.push(`Header FullFileSize is 0x${fullFileSize.toString(16)}, actual file size is 0x${totalSize.toString(16)}.`);
  }
  if (headerSize < HEADER_SIZE || headerSize > totalSize) throw new Error('HeaderSize is invalid.');
  if (bytes.length < headerSize) throw new Error('The provided header buffer does not contain the complete HeaderSize region.');
  if (offsetTableTop < HEADER_SIZE || offsetTableTop >= headerSize) throw new Error('OffsetTableTop is invalid.');
  if (maxCardNumber < minCardNumber) throw new Error('Card ID range is invalid.');
  if (bitshiftSize === 0) throw new Error('BitshiftSize is zero.');

  const primaryCount = maxCardNumber - minCardNumber + 1;
  if (primaryCount > 1_000_000) throw new Error('Card ID range is unreasonably large.');

  const primaryEnd = offsetTableTop + primaryCount * 8;
  if (primaryEnd > headerSize || primaryEnd > bytes.length) {
    throw new Error('Primary offset table exceeds HeaderSize.');
  }

  const slotSize = bitshiftSize * ALIGNMENT;
  const firstOffset = alignUp(headerSize, ALIGNMENT);
  if (firstOffset > totalSize) throw new Error('Aligned data start is outside the archive.');
  const firstSlotId = firstOffset >>> 11;

  function resolveSlotMeta(slotId, label) {
    const cleanId = slotId & VALUE_MASK;
    if (cleanId < firstSlotId) throw new Error(`${label}: slot ID points before the data area.`);
    const delta = cleanId - firstSlotId;
    if (delta % bitshiftSize !== 0) throw new Error(`${label}: slot ID is not aligned to BitshiftSize.`);
    const index = delta / bitshiftSize;
    const dataOffset = firstOffset + index * slotSize;
    if (dataOffset < firstOffset || dataOffset + slotSize > totalSize) {
      throw new Error(`${label}: data slot at 0x${dataOffset.toString(16)} exceeds the archive.`);
    }
    return {
      cleanSlotId: cleanId >>> 0,
      sourceSlotIndex: index,
      sourceSlotOffset: dataOffset,
      sourceSlotSize: slotSize,
    };
  }

  const entries = [];
  const seenAltPointers = new Set();

  function pushIndexedEntry(cardId, altIndex, idField, label) {
    const meta = resolveSlotMeta(idField, label);
    entries.push({
      cardId,
      altIndex,
      name: entryName(type, cardId, altIndex),
      bytes: null,
      rawSlot: null,
      modified: false,
      lazy: true,
      loadedSize: null,
      sizeHint: indexSizeHint(type, slotSize),
      sourceSlotId: meta.cleanSlotId,
      sourceSlotIndex: meta.sourceSlotIndex,
      sourceSlotOffset: meta.sourceSlotOffset,
      sourceSlotSize: meta.sourceSlotSize,
      sourceCardId: cardId,
      sourceAltIndex: altIndex,
    });
  }

  for (let index = 0; index < primaryCount; index += 1) {
    const cardId = minCardNumber + index;
    const pairOffset = offsetTableTop + index * 8;
    const idField = readU32(view, pairOffset, `Card ${cardId} offset pair`);

    if (idField === 0) continue;

    if ((idField & ALT_FLAG) !== 0) {
      const altPointer = idField & ALT_POINTER_MASK;
      if (altPointer < primaryEnd || altPointer + 8 > headerSize) {
        throw new Error(`Card ${cardId}: alternate-art table pointer 0x${altPointer.toString(16)} is invalid.`);
      }
      if (seenAltPointers.has(altPointer)) warnings.push(`Card ${cardId}: alternate-art table pointer is reused.`);
      seenAltPointers.add(altPointer);

      let cursor = altPointer;
      let altIndex = 0;
      let foundLast = false;
      while (cursor + 8 <= headerSize) {
        const altIdField = readU32(view, cursor, `Card ${cardId} alternate ${altIndex}`);
        if (altIdField === 0 || altIdField === 0xFFFFFFFF) {
          throw new Error(`Card ${cardId}: invalid alternate-art slot ID.`);
        }
        const isLast = (altIdField & ALT_FLAG) !== 0;
        pushIndexedEntry(cardId, altIndex, altIdField, `Card ${cardId} alternate ${altIndex}`);
        altIndex += 1;
        cursor += 8;
        if (isLast) {
          foundLast = true;
          break;
        }
        if (altIndex > 10000) throw new Error(`Card ${cardId}: alternate-art chain is unreasonably long.`);
      }
      if (!foundLast) throw new Error(`Card ${cardId}: alternate-art chain has no terminating flag.`);
      continue;
    }

    pushIndexedEntry(cardId, null, idField, `Card ${cardId}`);
  }

  return {
    type,
    cpjProfile,
    entries,
    warnings,
    header: {
      fullFileSize,
      headerSize,
      minCardNumber,
      maxCardNumber,
      offsetTableTop,
      bitshiftSize,
      slotSize,
      firstOffset,
    },
  };
}

export async function readArchiveIndex(blob, { cpjProfile = 'standard' } = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('readArchiveIndex expects a Blob or File.');
  if (blob.size < HEADER_SIZE) throw new Error('Archive is smaller than the 0x30-byte header.');

  const lead = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
  const leadView = new DataView(lead.buffer, lead.byteOffset, lead.byteLength);
  const headerSize = readU32(leadView, 0x10, 'HeaderSize');
  if (headerSize < HEADER_SIZE || headerSize > blob.size) throw new Error('HeaderSize is invalid.');

  const headerBytes = headerSize === HEADER_SIZE
    ? lead
    : new Uint8Array(await blob.slice(0, headerSize).arrayBuffer());
  return parseArchiveIndex(headerBytes, { cpjProfile, archiveSize: blob.size });
}

function normalizeEntriesForPlan(typeId, entries, cpjProfile) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Add at least one entry before building an archive.');
  }

  const groups = new Map();
  for (const source of entries) {
    const cardId = Number(source.cardId);
    const altIndex = source.altIndex == null ? null : Number(source.altIndex);
    if (!Number.isInteger(cardId) || cardId < 0 || cardId > 0xFFFFFFFF) throw new Error(`Invalid card ID: ${source.cardId}`);
    if (altIndex != null && (!Number.isInteger(altIndex) || altIndex < 0)) throw new Error(`Invalid alternate-art index for card ${cardId}.`);

    let prepared = null;
    let requiredSize = null;
    if (source.bytes != null) {
      prepared = prepareEntryPayload(typeId, source.bytes, cpjProfile);
      requiredSize = prepared.requiredSize;
    } else if (Number.isInteger(source.sourceSlotSize) && source.sourceSlotSize > 0) {
      // For an untouched lazy source entry, keeping at least the original raw slot
      // size is sufficient and avoids decoding it merely to calculate a rebuild.
      requiredSize = source.sourceSlotSize;
    } else {
      throw new Error(`${source.name || entryName(typeId, cardId, altIndex)} has no payload bytes or lazy source slot metadata.`);
    }

    const record = {
      ...source,
      cardId,
      altIndex,
      name: source.name || entryName(typeId, cardId, altIndex),
      prepared,
      requiredSize,
      sourceSlotId: Number.isInteger(source.sourceSlotId) ? source.sourceSlotId : null,
      sourceSlotIndex: Number.isInteger(source.sourceSlotIndex) && source.sourceSlotIndex >= 0 ? source.sourceSlotIndex : null,
    };

    let group = groups.get(cardId);
    if (!group) {
      group = { cardId, base: null, alts: new Map() };
      groups.set(cardId, group);
    }
    if (altIndex == null) {
      if (group.base) throw new Error(`Card ${cardId} has more than one base entry.`);
      if (group.alts.size) throw new Error(`Card ${cardId} mixes a base image with alternate-art entries.`);
      group.base = record;
    } else {
      if (group.base) throw new Error(`Card ${cardId} mixes a base image with alternate-art entries.`);
      if (group.alts.has(altIndex)) throw new Error(`Card ${cardId} has duplicate alternate-art index ${altIndex}.`);
      group.alts.set(altIndex, record);
    }
  }

  const orderedGroups = [...groups.values()].sort((a, b) => a.cardId - b.cardId);
  for (const group of orderedGroups) {
    if (group.base) continue;
    const indices = [...group.alts.keys()].sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i += 1) {
      if (indices[i] !== i) throw new Error(`Card ${group.cardId} alternate arts must be contiguous from _0 (missing _${i}).`);
    }
  }
  return orderedGroups;
}

export function buildArchivePlan({ type, cpjProfile = 'standard', entries }) {
  const typeInfo = CIP_TYPES[type];
  if (!typeInfo) throw new Error(`Unsupported archive type: ${type}`);
  if (type === 'CPJ') cpjHeader(cpjProfile);

  const groups = normalizeEntriesForPlan(type, entries, cpjProfile);
  const minCardNumber = groups[0].cardId;
  const maxCardNumber = groups[groups.length - 1].cardId;
  const primaryCount = maxCardNumber - minCardNumber + 1;
  if (primaryCount > 1_000_000) throw new Error('Card ID range is too large to build safely.');

  let altPairCount = 0;
  const orderedData = [];
  let maxRequiredSize = 0;

  for (const group of groups) {
    const groupEntries = group.base ? [group.base] : [...group.alts.values()].sort((a, b) => a.altIndex - b.altIndex);
    if (!group.base) altPairCount += groupEntries.length;
    for (const entry of groupEntries) {
      maxRequiredSize = Math.max(maxRequiredSize, entry.requiredSize);
      orderedData.push({ ...entry, logicalOrder: orderedData.length });
    }
  }

  if (orderedData.some((entry) => Number.isInteger(entry.sourceSlotIndex))) {
    const seenSourceSlots = new Set();
    for (const entry of orderedData) {
      if (!Number.isInteger(entry.sourceSlotIndex)) continue;
      if (seenSourceSlots.has(entry.sourceSlotIndex)) {
        throw new Error(`Duplicate source slot index ${entry.sourceSlotIndex} while preserving archive layout.`);
      }
      seenSourceSlots.add(entry.sourceSlotIndex);
    }
    orderedData.sort((a, b) => {
      const aHasSource = Number.isInteger(a.sourceSlotIndex);
      const bHasSource = Number.isInteger(b.sourceSlotIndex);
      if (aHasSource && bHasSource) return a.sourceSlotIndex - b.sourceSlotIndex;
      if (aHasSource) return -1;
      if (bHasSource) return 1;
      return a.logicalOrder - b.logicalOrder;
    });
  }

  const bitshiftSize = Math.max(1, Math.ceil(maxRequiredSize / ALIGNMENT));
  const slotSize = bitshiftSize * ALIGNMENT;
  const offsetTableTop = HEADER_SIZE;
  const primaryTableSize = primaryCount * 8;
  const altTableSize = altPairCount * 8;
  const headerSize = HEADER_SIZE + primaryTableSize + altTableSize + 8;
  const firstOffset = alignUp(headerSize, ALIGNMENT);
  const firstSlotId = firstOffset >>> 11;
  const fullFileSize = firstOffset + orderedData.length * slotSize;
  if (fullFileSize > 0x7FFFFFFF) throw new Error('Resulting archive is too large for the browser implementation.');

  const prefix = new Uint8Array(firstOffset);
  const view = new DataView(prefix.buffer);
  setU32(view, 0x00, typeInfo.magic);
  setU32(view, 0x04, fullFileSize);
  setU32(view, 0x10, headerSize);
  setU32(view, 0x14, minCardNumber);
  setU32(view, 0x18, maxCardNumber);
  setU32(view, 0x1C, offsetTableTop);
  setU32(view, 0x20, bitshiftSize);

  const groupById = new Map(groups.map((group) => [group.cardId, group]));
  const slotByEntryKey = new Map();
  for (let i = 0; i < orderedData.length; i += 1) {
    const entry = orderedData[i];
    const key = `${entry.cardId}:${entry.altIndex == null ? 'base' : entry.altIndex}`;
    const slotId = firstSlotId + bitshiftSize * i;
    if (slotId > VALUE_MASK) throw new Error('Archive slot ID exceeds supported 31-bit range.');
    slotByEntryKey.set(key, slotId >>> 0);
    entry.targetSlotIndex = i;
    entry.targetSlotOffset = firstOffset + i * slotSize;
  }

  let altCursor = offsetTableTop + primaryTableSize;
  for (let cardId = minCardNumber; cardId <= maxCardNumber; cardId += 1) {
    const group = groupById.get(cardId);
    if (!group) continue;
    const pairOffset = offsetTableTop + (cardId - minCardNumber) * 8;

    if (group.base) {
      setU32(view, pairOffset, slotByEntryKey.get(`${cardId}:base`));
      continue;
    }

    if (altCursor > ALT_POINTER_MASK) throw new Error('Alternate-art table exceeds the 24-bit pointer range used by CIPTool.');
    setU32(view, pairOffset, ALT_FLAG | altCursor);
    const alts = [...group.alts.values()].sort((a, b) => a.altIndex - b.altIndex);
    for (let i = 0; i < alts.length; i += 1) {
      const alt = alts[i];
      let slotId = slotByEntryKey.get(`${cardId}:${alt.altIndex}`);
      if (i === alts.length - 1) slotId = (slotId | ALT_FLAG) >>> 0;
      setU32(view, altCursor, slotId);
      altCursor += 8;
    }
  }
  setU32(view, altCursor, 0xFFFFFFFF);
  setU32(view, altCursor + 4, 0xFFFFFFFF);

  return {
    prefix,
    entries: orderedData,
    info: {
      type,
      cpjProfile,
      fullFileSize,
      headerSize,
      minCardNumber,
      maxCardNumber,
      offsetTableTop,
      bitshiftSize,
      slotSize,
      firstOffset,
      entryCount: orderedData.length,
      altPairCount,
    },
  };
}

export async function buildArchiveBlob({
  type,
  cpjProfile = 'standard',
  entries,
  sourceBlob = null,
  yieldEvery = 128,
  onProgress = null,
} = {}) {
  if (sourceBlob != null && !(sourceBlob instanceof Blob)) throw new TypeError('sourceBlob must be a Blob or File.');
  const plan = buildArchivePlan({ type, cpjProfile, entries });
  const parts = [plan.prefix];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index];
    if (entry.bytes instanceof Uint8Array || entry.bytes instanceof ArrayBuffer || ArrayBuffer.isView(entry.bytes)) {
      parts.push(encodeEntrySlot(type, entry, plan.info.slotSize, { cpjProfile }));
    } else {
      if (!sourceBlob || !Number.isInteger(entry.sourceSlotOffset) || !Number.isInteger(entry.sourceSlotSize)) {
        throw new Error(`${entry.name} has neither payload bytes nor a source slot.`);
      }
      if (entry.sourceSlotOffset < 0 || entry.sourceSlotSize <= 0 || entry.sourceSlotOffset + entry.sourceSlotSize > sourceBlob.size) {
        throw new Error(`${entry.name} has invalid lazy source slot bounds.`);
      }

      const sourceSlice = sourceBlob.slice(entry.sourceSlotOffset, entry.sourceSlotOffset + entry.sourceSlotSize);
      const sameSlotSize = entry.sourceSlotSize === plan.info.slotSize;
      const metadataChanged = entry.sourceCardId != null && (
        entry.cardId !== entry.sourceCardId
        || (entry.altIndex ?? null) !== (entry.sourceAltIndex ?? null)
      );
      const needsCpjReencode = type === 'CPJ' && (metadataChanged || !sameSlotSize);

      if (!needsCpjReencode && sameSlotSize) {
        parts.push(sourceSlice);
      } else if (type !== 'CPJ' && entry.sourceSlotSize < plan.info.slotSize) {
        parts.push(sourceSlice, new Uint8Array(plan.info.slotSize - entry.sourceSlotSize));
      } else {
        const raw = new Uint8Array(await sourceSlice.arrayBuffer());
        const bytes = decodeSlotPayload(type, raw, { cpjProfile });
        parts.push(encodeEntrySlot(type, { ...entry, bytes }, plan.info.slotSize, { cpjProfile }));
      }
    }

    if (typeof onProgress === 'function') onProgress(index + 1, plan.entries.length);
    if (yieldEvery > 0 && index > 0 && index % yieldEvery === 0) await pause();
  }

  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    info: plan.info,
  };
}
