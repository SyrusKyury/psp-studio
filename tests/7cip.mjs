import assert from 'node:assert/strict';
import {
  CIP_TYPES,
  CPM_GIM_HEADER,
  CPM_IMAGE_PAYLOAD_SIZE,
  CPM_STANDALONE_GIM_SIZE,
  CPJ_JFIF_HEADER_STANDARD,
  CPJ_JFIF_HEADER_TFSP,
  buildArchive,
  buildArchiveBlob,
  buildArchivePlan,
  decodeSlotPayload,
  detectType,
  entryCompatibilityWarning,
  parseArchive,
  readArchiveIndex,
  parseEntryFilename,
  inspectGimHeader,
  makeStandaloneGimBlob,
} from '../tools/7cip/cip.js';

function bytes(...values) {
  return Uint8Array.from(values);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function startsWith(actual, expected) {
  assert.ok(actual.length >= expected.length);
  assert.deepEqual(actual.subarray(0, expected.length), expected);
}

function assertZeroPadding(actual, from) {
  for (let i = from; i < actual.length; i += 1) assert.equal(actual[i], 0);
}

function roundTripFixedSlot(type) {
  const originalEntries = [
    { cardId: 100, altIndex: null, bytes: bytes(1, 2, 3, 4, 5) },
    { cardId: 102, altIndex: null, bytes: bytes(6, 7, 8) },
    { cardId: 105, altIndex: 0, bytes: bytes(9, 10, 11, 12) },
    { cardId: 105, altIndex: 1, bytes: bytes(13, 14, 15) },
  ];

  const built = buildArchive({ type, entries: originalEntries });
  assert.equal(detectType(built.bytes), type);
  assert.equal(built.info.minCardNumber, 100);
  assert.equal(built.info.maxCardNumber, 105);
  assert.equal(built.info.entryCount, 4);
  assert.equal(built.info.altPairCount, 2);
  assert.equal(built.info.bitshiftSize, 1);

  const parsed = parseArchive(built.bytes);
  assert.equal(parsed.type, type);
  assert.equal(parsed.entries.length, 4);
  assert.deepEqual(parsed.entries.map((e) => [e.cardId, e.altIndex]), [
    [100, null], [102, null], [105, 0], [105, 1],
  ]);

  for (let i = 0; i < originalEntries.length; i += 1) {
    const expected = originalEntries[i].bytes;
    const actual = parsed.entries[i].bytes;
    startsWith(actual, expected);
    assertZeroPadding(actual, expected.length);
  }

  const rebuilt = buildArchive({ type, entries: parsed.entries });
  assert.deepEqual(rebuilt.bytes, built.bytes);
}

roundTripFixedSlot('CIP');
roundTripFixedSlot('CPL');

{
  function cpmGim(seed) {
    const payload = new Uint8Array(CPM_IMAGE_PAYLOAD_SIZE);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (seed + i * 17) & 0xFF;
    const tail = new Uint8Array(CPM_STANDALONE_GIM_SIZE - CPM_GIM_HEADER.length - payload.length);
    return { payload, gim: concat(CPM_GIM_HEADER, payload, tail) };
  }

  const a = cpmGim(0x10);
  const b = cpmGim(0x50);
  const entries = [
    { cardId: 200, altIndex: null, bytes: a.gim },
    { cardId: 201, altIndex: null, bytes: b.gim },
  ];
  const built = buildArchive({ type: 'CPM', entries });
  assert.equal(built.info.slotSize, 0x800, 'standalone zero padding must not grow CPM slots');
  const parsed = parseArchive(built.bytes);
  assert.equal(parsed.type, 'CPM');
  assert.equal(parsed.entries[0].bytes.length, CPM_STANDALONE_GIM_SIZE);
  startsWith(parsed.entries[0].bytes, concat(CPM_GIM_HEADER, a.payload));
  startsWith(parsed.entries[1].bytes, concat(CPM_GIM_HEADER, b.payload));
  const rebuilt = buildArchive({ type: 'CPM', entries: parsed.entries });
  assert.deepEqual(rebuilt.bytes, built.bytes);

  const dxt3 = a.gim.slice();
  const dxt3View = new DataView(dxt3.buffer, dxt3.byteOffset, dxt3.byteLength);
  dxt3View.setUint16(0x44, 0x09, true);
  // DXT3 legitimately uses the full 0x1000-byte pixel region.
  dxt3.fill(0x5A, 0x80 + CPM_IMAGE_PAYLOAD_SIZE);
  const warning = entryCompatibilityWarning('CPM', dxt3);
  assert.match(warning, /stock DXT1 CPM profile with DXT3/);
  const dxt3Built = buildArchive({ type: 'CPM', entries: [{ cardId: 200, altIndex: null, bytes: dxt3 }] });
  assert.equal(dxt3Built.info.slotSize, 0x1000, 'DXT3 replacement must grow the CPM slot to 0x1000');
}

function cpjRoundTrip(profile, header) {
  const jpegA = concat(header, bytes(0x00, 0x11, 0x22, 0x33, 0xFF, 0xD9));
  const jpegB = concat(header, bytes(0x44, 0x55, 0x66, 0x77, 0x88, 0xFF, 0xD9));
  const jpegC = concat(header, bytes(0xAB, 0xCD, 0xEF, 0xFF, 0xD9));
  const entries = [
    { cardId: 300, altIndex: null, bytes: jpegA },
    { cardId: 305, altIndex: 0, bytes: jpegB },
    { cardId: 305, altIndex: 1, bytes: jpegC },
  ];

  const built = buildArchive({ type: 'CPJ', cpjProfile: profile, entries });
  const parsed = parseArchive(built.bytes, { cpjProfile: profile });
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries[0].bytes, jpegA);
  assert.deepEqual(parsed.entries[1].bytes, jpegB);
  assert.deepEqual(parsed.entries[2].bytes, jpegC);
  const rebuilt = buildArchive({ type: 'CPJ', cpjProfile: profile, entries: parsed.entries });
  assert.deepEqual(rebuilt.bytes, built.bytes);
}

cpjRoundTrip('standard', CPJ_JFIF_HEADER_STANDARD);
cpjRoundTrip('tfsp', CPJ_JFIF_HEADER_TFSP);

{
  assert.deepEqual(parseEntryFilename('CIP', '123.gim'), { cardId: 123, altIndex: null });
  assert.deepEqual(parseEntryFilename('CIP', '123_4.gim'), { cardId: 123, altIndex: 4 });
  assert.deepEqual(parseEntryFilename('CPJ', '88_0.JPG'), { cardId: 88, altIndex: 0 });
  assert.equal(parseEntryFilename('CPJ', 'card.jpg'), null);
}

{
  const invalid = new Uint8Array(48);
  assert.throws(() => detectType(invalid), /Unknown CIP-family magic/);
}

{
  const built = buildArchive({ type: 'CIP', entries: [{ cardId: 1, altIndex: null, bytes: bytes(1) }] });
  const broken = built.bytes.slice();
  new DataView(broken.buffer).setUint32(0x10, 0xFFFFFFFF, true);
  assert.throws(() => parseArchive(broken), /HeaderSize is invalid/);
}

for (const type of Object.keys(CIP_TYPES)) {
  assert.ok(['CIP', 'CPM', 'CPJ', 'CPL'].includes(type));
}


{
  const large = new Uint8Array(0x1001);
  large[0] = 0x5A;
  const built = buildArchive({
    type: 'CIP',
    entries: [
      { cardId: 10, altIndex: null, bytes: bytes(1, 2, 3) },
      { cardId: 11, altIndex: null, bytes: large },
    ],
  });
  assert.equal(built.info.bitshiftSize, 3, 'slot size must be based on the largest entry');
  const view = new DataView(built.bytes.buffer, built.bytes.byteOffset, built.bytes.byteLength);
  assert.equal(view.getUint32(0x30 + 4, true), 0, 'CIPTool-compatible on-disk Offset field stays zero');
  assert.equal(view.getUint32(0x38 + 4, true), 0, 'CIPTool-compatible on-disk Offset field stays zero');
}

console.log('7-CIP codec tests: OK');

// Preserve physical slot order from parsed archives, even when it differs from card-ID order.
{
  const built = buildArchive({
    type: 'CIP',
    entries: [
      { cardId: 10, altIndex: null, bytes: bytes(0xAA), sourceSlotIndex: 1 },
      { cardId: 11, altIndex: null, bytes: bytes(0xBB), sourceSlotIndex: 0 },
    ],
  });
  const parsed = parseArchive(built.bytes);
  const byCard = new Map(parsed.entries.map((entry) => [entry.cardId, entry]));
  assert.equal(byCard.get(10).sourceSlotIndex, 1);
  assert.equal(byCard.get(11).sourceSlotIndex, 0);
  const rebuilt = buildArchive({ type: 'CIP', entries: parsed.entries });
  assert.deepEqual(rebuilt.bytes, built.bytes);
}


// Lazy index: opening a Blob must not materialize entry payloads.
{
  const jpegA = concat(CPJ_JFIF_HEADER_TFSP, bytes(0x01, 0x02, 0x03, 0xFF, 0xD9));
  const jpegB = concat(CPJ_JFIF_HEADER_TFSP, bytes(0x10, 0x20, 0x30, 0x40, 0xFF, 0xD9));
  const built = buildArchive({
    type: 'CPJ',
    cpjProfile: 'tfsp',
    entries: [
      { cardId: 4000, altIndex: null, bytes: jpegA },
      { cardId: 4001, altIndex: null, bytes: jpegB },
    ],
  });
  const blob = new Blob([built.bytes]);
  const indexed = await readArchiveIndex(blob, { cpjProfile: 'tfsp' });
  assert.equal(indexed.entries.length, 2);
  assert.equal(indexed.entries[0].bytes, null);
  assert.equal(indexed.entries[0].lazy, true);
  assert.ok(indexed.entries[0].sourceSlotOffset >= indexed.header.firstOffset);
  assert.equal(indexed.entries[0].sourceSlotSize, indexed.header.slotSize);

  const first = indexed.entries[0];
  const raw = new Uint8Array(await blob.slice(first.sourceSlotOffset, first.sourceSlotOffset + first.sourceSlotSize).arrayBuffer());
  assert.deepEqual(decodeSlotPayload('CPJ', raw, { cpjProfile: 'tfsp' }), jpegA);

  // A lazy rebuild plan must be able to reuse the source slots without requiring
  // decoded payload bytes and still reproduce the original archive exactly.
  const plan = buildArchivePlan({ type: 'CPJ', cpjProfile: 'tfsp', entries: indexed.entries });
  assert.equal(plan.info.fullFileSize, built.bytes.length);
  const parts = [plan.prefix];
  for (const entry of plan.entries) {
    parts.push(blob.slice(entry.sourceSlotOffset, entry.sourceSlotOffset + entry.sourceSlotSize));
  }
  const lazyRebuilt = new Uint8Array(await new Blob(parts).arrayBuffer());
  assert.deepEqual(lazyRebuilt, built.bytes);
}

console.log('7-CIP lazy-loading tests: OK');


// Lazy Blob builder: unchanged source reuse, delete, re-ID and CPJ slot growth.
{
  const smallA = concat(CPJ_JFIF_HEADER_TFSP, bytes(0x21, 0x22, 0x23, 0xFF, 0xD9));
  const smallB = concat(CPJ_JFIF_HEADER_TFSP, bytes(0x31, 0x32, 0x33, 0xFF, 0xD9));
  const initial = buildArchive({
    type: 'CPJ', cpjProfile: 'tfsp',
    entries: [
      { cardId: 5000, altIndex: null, bytes: smallA },
      { cardId: 5001, altIndex: null, bytes: smallB },
    ],
  });
  const source = new Blob([initial.bytes]);
  const indexed = await readArchiveIndex(source, { cpjProfile: 'tfsp' });

  const unchanged = await buildArchiveBlob({ type: 'CPJ', cpjProfile: 'tfsp', entries: indexed.entries, sourceBlob: source, yieldEvery: 0 });
  assert.deepEqual(new Uint8Array(await unchanged.blob.arrayBuffer()), initial.bytes);

  const deleted = await buildArchiveBlob({ type: 'CPJ', cpjProfile: 'tfsp', entries: [indexed.entries[1]], sourceBlob: source, yieldEvery: 0 });
  const deletedIndex = await readArchiveIndex(deleted.blob, { cpjProfile: 'tfsp' });
  assert.deepEqual(deletedIndex.entries.map((entry) => entry.cardId), [5001]);

  const renamedEntry = { ...indexed.entries[0], cardId: 6000, name: '6000.jpg', modified: true };
  const renamed = await buildArchiveBlob({ type: 'CPJ', cpjProfile: 'tfsp', entries: [renamedEntry, indexed.entries[1]], sourceBlob: source, yieldEvery: 0 });
  const renamedIndex = await readArchiveIndex(renamed.blob, { cpjProfile: 'tfsp' });
  const renamedMeta = renamedIndex.entries.find((entry) => entry.cardId === 6000);
  assert.ok(renamedMeta);
  const renamedRaw = new Uint8Array(await renamed.blob.slice(renamedMeta.sourceSlotOffset, renamedMeta.sourceSlotOffset + renamedMeta.sourceSlotSize).arrayBuffer());
  assert.deepEqual(decodeSlotPayload('CPJ', renamedRaw, { cpjProfile: 'tfsp' }), smallA);

  const largeBody = new Uint8Array(3500);
  largeBody.fill(0x5A);
  const largeJpeg = concat(CPJ_JFIF_HEADER_TFSP, largeBody, bytes(0xFF, 0xD9));
  const grownEntries = [indexed.entries[0], indexed.entries[1], { cardId: 5002, altIndex: null, bytes: largeJpeg, name: '5002.jpg', modified: true }];
  const grown = await buildArchiveBlob({ type: 'CPJ', cpjProfile: 'tfsp', entries: grownEntries, sourceBlob: source, yieldEvery: 0 });
  assert.ok(grown.info.slotSize > indexed.header.slotSize);
  const grownIndex = await readArchiveIndex(grown.blob, { cpjProfile: 'tfsp' });
  for (const [cardId, expected] of [[5000, smallA], [5001, smallB], [5002, largeJpeg]]) {
    const meta = grownIndex.entries.find((entry) => entry.cardId === cardId);
    const raw = new Uint8Array(await grown.blob.slice(meta.sourceSlotOffset, meta.sourceSlotOffset + meta.sourceSlotSize).arrayBuffer());
    assert.deepEqual(decodeSlotPayload('CPJ', raw, { cpjProfile: 'tfsp' }), expected);
  }
}

console.log('7-CIP lazy Blob builder tests: OK');

// Tag Force compact GIM export: keep raw CIP slots untouched internally, but
// reconstruct a standalone file whose byte length matches the GIM root header.
{
  const compact = new Uint8Array(0x1000);
  compact.set(new TextEncoder().encode('MIG.00.1PSP'), 0);
  const view = new DataView(compact.buffer);
  view.setUint16(0x10, 0x02, true);
  view.setUint32(0x14, 0x1070, true); // standalone file ends at 0x1080
  view.setUint16(0x30, 0x04, true);
  view.setUint32(0x34, 0x1050, true);
  view.setUint16(0x44, 0x08, true); // DXT1
  view.setUint16(0x48, 128, true);
  view.setUint16(0x4A, 64, true);
  view.setUint32(0x60, 0x1040, true);
  compact[0x80] = 0xA5;
  compact[0xFFF] = 0x5A;

  const header = inspectGimHeader(compact.subarray(0, 0x18), { physicalSize: compact.length });
  assert.equal(header.declaredSize, 0x1080);
  assert.equal(header.missingBytes, 0x80);
  assert.equal(header.compact, true);

  const standalone = await makeStandaloneGimBlob(new Blob([compact]));
  assert.equal(standalone.blob.size, 0x1080);
  const exported = new Uint8Array(await standalone.blob.arrayBuffer());
  assert.deepEqual(exported.subarray(0, compact.length), compact);
  assertZeroPadding(exported, compact.length);

  // Rebuilding an archive from the raw compact slot must not be affected by the
  // standalone-export repair.
  const archive = buildArchive({ type: 'CIP', entries: [{ cardId: 7000, altIndex: null, bytes: compact }] });
  const parsed = parseArchive(archive.bytes);
  const rebuilt = buildArchive({ type: 'CIP', entries: parsed.entries });
  assert.deepEqual(rebuilt.bytes, archive.bytes);
}

// A GIM with archive-level trailing padding should export only its declared size.
{
  const padded = new Uint8Array(0x1800);
  padded.set(new TextEncoder().encode('MIG.00.1PSP'), 0);
  const view = new DataView(padded.buffer);
  view.setUint16(0x10, 0x02, true);
  view.setUint32(0x14, 0x1070, true);
  padded[0x107F] = 0xCC;
  padded[0x1080] = 0xDD;
  const standalone = await makeStandaloneGimBlob(new Blob([padded]));
  assert.equal(standalone.blob.size, 0x1080);
  const exported = new Uint8Array(await standalone.blob.arrayBuffer());
  assert.equal(exported[0x107F], 0xCC);
}

console.log('7-CIP standalone GIM export tests: OK');

