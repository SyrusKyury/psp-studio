import assert from 'node:assert/strict';
import { encodeGim, decodeGim, inspectGim, replaceGimImage, GimFormat } from '../tools/gim-studio/gim-codec.js';

function fixture(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      rgba[p] = (x * 17 + y * 3) & 255;
      rgba[p + 1] = (y * 21 + x * 5) & 255;
      rgba[p + 2] = ((x ^ y) * 31) & 255;
      rgba[p + 3] = ((x + y) % 5 === 0) ? 72 : 255;
    }
  }
  return rgba;
}

function mae(a, b, channels = [0,1,2,3]) {
  let total = 0, count = 0;
  for (let p = 0; p < a.length; p += 4) for (const c of channels) { total += Math.abs(a[p + c] - b[p + c]); count += 1; }
  return total / count;
}

const width = 19, height = 13, source = fixture(width, height);
const cases = [
  [GimFormat.RGBA5650, 0, [0,1,2], 5],
  [GimFormat.RGBA5551, 0, [0,1,2,3], 30],
  [GimFormat.RGBA4444, 0, [0,1,2,3], 9],
  [GimFormat.RGBA8888, 0, [0,1,2,3], 0],
  [GimFormat.RGBA8888, 1, [0,1,2,3], 0],
  [GimFormat.INDEX4, 0, [0,1,2,3], 65],
  [GimFormat.INDEX4, 1, [0,1,2,3], 65],
  [GimFormat.INDEX8, 0, [0,1,2,3], 25],
  [GimFormat.INDEX8, 1, [0,1,2,3], 25],
  [GimFormat.DXT1, 0, [0,1,2], 55],
  [GimFormat.DXT3, 0, [0,1,2,3], 55],
  [GimFormat.DXT5, 0, [0,1,2,3], 55]
];

for (const [format, pixelOrder, channels, limit] of cases) {
  const gim = encodeGim({ rgba: source, width, height, format, pixelOrder });
  const info = inspectGim(gim);
  assert.equal(info.pictureCount, 1);
  assert.equal(info.pictures[0].width, width);
  assert.equal(info.pictures[0].height, height);
  assert.equal(info.pictures[0].format, format);
  assert.equal(info.pictures[0].pixelOrder, pixelOrder);
  const decoded = decodeGim(gim);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  const error = mae(source, decoded.rgba, channels);
  assert.ok(error <= limit, `format ${format} order ${pixelOrder}: MAE ${error.toFixed(2)} > ${limit}`);
}

const base = encodeGim({ rgba: source, width, height, format: GimFormat.INDEX8, pixelOrder: 1 });
const replacement = fixture(width, height);
for (let p = 0; p < replacement.length; p += 4) {
  replacement[p] = 255 - replacement[p];
  replacement[p + 1] = (replacement[p + 1] + 90) & 255;
}
const patched = replaceGimImage(base, replacement, width, height);
assert.equal(patched.length, base.length, 'replacement must preserve container length');
const patchedInfo = inspectGim(patched);
assert.equal(patchedInfo.pictures[0].format, GimFormat.INDEX8);
assert.equal(patchedInfo.pictures[0].pixelOrder, 1);
const patchedDecoded = decodeGim(patched);
assert.ok(mae(replacement, patchedDecoded.rgba) < 30, 'patched indexed texture should remain visually close');

assert.throws(() => replaceGimImage(base, replacement, width + 1, height), /Replacement must stay/);
assert.throws(() => encodeGim({ rgba: source, width, height, format: GimFormat.DXT1, pixelOrder: 1 }), /DXT/);
assert.throws(() => encodeGim({ rgba: source, width, height, format: GimFormat.INDEX16, pixelOrder: 0 }), /not writable/);
assert.throws(() => encodeGim({ rgba: source, width, height, format: GimFormat.INDEX32, pixelOrder: 0 }), /not writable/);
assert.throws(() => encodeGim({ rgba: source, width, height, format: 0x108, pixelOrder: 0 }), /not writable/);

console.log(`GIM codec tests passed (${cases.length} encode/decode cases + replacement).`);

// Golden PSP byte-layout tests. These intentionally mutate raw GIM frame bytes
// so decode correctness is not inferred from our own encoder.
function solid(width, height, r, g, b, a = 255) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < out.length; p += 4) {
    out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = a;
  }
  return out;
}

function assertPixel(rgba, width, x, y, expected, label) {
  const p = (y * width + x) * 4;
  assert.deepEqual([...rgba.subarray(p, p + 4)], expected, label);
}

// Generated single-picture GIMs place their first image frame at 0x80.
const GOLDEN_FRAME = 0x80;

for (const [format, word, expected, label] of [
  [GimFormat.RGBA5650, 0x001f, [255, 0, 0, 255], '5650 red is in the low 5 bits'],
  [GimFormat.RGBA5551, 0x801f, [255, 0, 0, 255], '5551 red is in the low 5 bits'],
  [GimFormat.RGBA4444, 0xf00f, [255, 0, 0, 255], '4444 red is in the low 4 bits'],
]) {
  const gim = encodeGim({ rgba: solid(1, 1, 0, 0, 0, 0), width: 1, height: 1, format, pixelOrder: 0 });
  gim[GOLDEN_FRAME] = word & 0xff;
  gim[GOLDEN_FRAME + 1] = word >>> 8;
  const decoded = decodeGim(gim);
  assertPixel(decoded.rgba, 1, 0, 0, expected, label);
}

// PSP DXT1 is reversed relative to PC DXT: four color-index bytes first,
// then two RGB565 endpoints. PPSSPP expands 565 endpoints by shifting.
{
  const gim = encodeGim({ rgba: solid(4, 4, 0, 0, 0), width: 4, height: 4, format: GimFormat.DXT1, pixelOrder: 0 });
  gim.set([
    0x00, 0x55, 0xaa, 0xff, // rows selecting color 0, 1, 2, 3
    0x00, 0xf8,             // color1 = red (RGB565)
    0x1f, 0x00,             // color2 = blue
  ], GOLDEN_FRAME);
  const decoded = decodeGim(gim);
  assertPixel(decoded.rgba, 4, 0, 0, [248, 0, 0, 255], 'DXT1 color0');
  assertPixel(decoded.rgba, 4, 0, 1, [0, 0, 248, 255], 'DXT1 color1');
  assertPixel(decoded.rgba, 4, 0, 2, [165, 0, 82, 255], 'DXT1 interpolant2');
  assertPixel(decoded.rgba, 4, 0, 3, [82, 0, 165, 255], 'DXT1 interpolant3');
}

// PSP DXT3 uses the same endpoint-order color palette as PPSSPP's DXT1
// decoder, then applies explicit 4-bit alpha. In particular, when c0 <= c1,
// color index 3 remains black rather than switching to PC-style DXT3 four-color
// interpolation. Alpha nibbles are read low nibble first within each row.
{
  const gim = encodeGim({ rgba: solid(4, 4, 0, 0, 0), width: 4, height: 4, format: GimFormat.DXT3, pixelOrder: 0 });
  gim.set([
    0x03, 0x00, 0x00, 0x00, // pixel0 -> color index 3, all others -> color0
    0x1f, 0x00, 0x00, 0xf8, // c0=blue <= c1=red, triggers PSP 3-color/black branch
    0x0f, 0x00,             // pixel0 alpha=15 (low nibble), pixel1 alpha=0
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ], GOLDEN_FRAME);
  const decoded = decodeGim(gim);
  assertPixel(decoded.rgba, 4, 0, 0, [0, 0, 0, 255], 'PSP DXT3 color index 3 stays black when c0 <= c1');
  assertPixel(decoded.rgba, 4, 1, 0, [0, 0, 248, 0], 'PSP DXT3 reads the next alpha nibble from the high half-byte');
}

// PSP DXT5 stores color first, then the 48 alpha-index bits, and finally
// alpha1/alpha2 at bytes 14/15. The first pixel uses alpha index 1 here.
{
  const gim = encodeGim({ rgba: solid(4, 4, 0, 0, 0), width: 4, height: 4, format: GimFormat.DXT5, pixelOrder: 0 });
  gim.set([
    0x00, 0x00, 0x00, 0x00, // all pixels use color0
    0x00, 0xf8, 0x1f, 0x00, // red / blue endpoints
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, // alpha indices: pixel0 -> index1, rest -> index0
    200, 20, // alpha1 / alpha2
  ], GOLDEN_FRAME);
  const decoded = decodeGim(gim);
  assertPixel(decoded.rgba, 4, 0, 0, [248, 0, 0, 20], 'DXT5 alpha index 1');
  assertPixel(decoded.rgba, 4, 1, 0, [248, 0, 0, 200], 'DXT5 alpha index 0');
}

// Encoder-side DXT5 golden placement: endpoints must be the final two bytes,
// not the first two bytes of the alpha section as in PC DXT5.
{
  const rgba = solid(4, 4, 200, 20, 40, 200);
  rgba[3] = 20;
  const gim = encodeGim({ rgba, width: 4, height: 4, format: GimFormat.DXT5, pixelOrder: 0 });
  assert.equal(gim[GOLDEN_FRAME + 14], 200, 'PSP DXT5 alpha1 endpoint must be byte 14');
  assert.equal(gim[GOLDEN_FRAME + 15], 20, 'PSP DXT5 alpha2 endpoint must be byte 15');
  assert.equal(gim[GOLDEN_FRAME + 8] & 7, 1, 'first alpha index should reference alpha2');
}


// Generated indexed GIM palette metadata uses the verified normal RGBA palette
// profile seen in GimConv output: PitchAlign 16 / HeightAlign 1.
{
  const gim = encodeGim({ rgba: solid(8, 8, 50, 100, 150), width: 8, height: 8, format: GimFormat.INDEX8, pixelOrder: 0 });
  const view = new DataView(gim.buffer, gim.byteOffset, gim.byteLength);
  let offset = 0x10;
  let paletteOffset = -1;
  for (let guard = 0; guard < 16 && offset + 0x10 <= gim.length; guard += 1) {
    const type = view.getUint16(offset, true);
    if (type === 0x05) { paletteOffset = offset; break; }
    const next = view.getUint32(offset + 8, true);
    if (!next) break;
    offset += next;
  }
  assert.notEqual(paletteOffset, -1, 'generated INDEX8 GIM must contain a palette block');
  const dataStart = paletteOffset + view.getUint32(paletteOffset + 12, true);
  assert.equal(view.getUint16(dataStart, true), 0x30, 'palette structure_size');
  assert.equal(view.getUint16(dataStart + 14, true), 0x10, 'palette pitch_align');
  assert.equal(view.getUint16(dataStart + 16, true), 0x01, 'palette height_align');
  assert.equal(view.getUint32(dataStart + 24, true), 0x30, 'palette frame index offset');
  assert.equal(view.getUint32(dataStart + 28, true), 0x40, 'palette frame data start');
  assert.equal(view.getUint16(dataStart + 8, true), 256, 'palette colormap width is always 256');
  assert.equal(view.getUint16(dataStart + 10, true), 1, 'palette colormap height is always 1');
  assert.equal(view.getUint16(dataStart + 40, true), 2, 'palette level_type is MIPMAP2');

  // GimConv hierarchy for indexed pictures is Picture -> Palette -> Image.
  // The generic block chain therefore sees 0x05 before 0x04.
  const pictureOffset = 0x20;
  const paletteAt = pictureOffset + view.getUint32(pictureOffset + 8, true);
  assert.equal(view.getUint16(paletteAt, true), 0x05, 'indexed GIM places Palette before Image');
  const imageAt = paletteAt + view.getUint32(paletteAt + 8, true);
  assert.equal(view.getUint16(imageAt, true), 0x04, 'Image follows Palette in indexed GIM hierarchy');

  // Decoder must still pair the palette and image independent of their order.
  const roundTrip = decodeGim(gim);
  assert.equal(roundTrip.width, 8);
  assert.equal(roundTrip.height, 8);
}

// Verified creation profiles: normal direct-color uses a byte pitch alignment,
// DXT uses 4/4, and PSP faster storage uses 16/8.
{
  const rgba = solid(5, 3, 10, 20, 30, 255);
  const normal = encodeGim({ rgba, width: 5, height: 3, format: GimFormat.RGBA8888, pixelOrder: 0, pitchAlign: 16, heightAlign: 1 });
  const normalInfo = inspectGim(normal).pictures[0];
  assert.equal(normalInfo.pitchAlign, 16);
  assert.equal(normalInfo.heightAlign, 1);
  // 5*4 = 20 bytes per row -> 32-byte stride at PitchAlign 16; 3 rows.
  assert.equal(normal.length - 0x80, 96, 'normal frame uses byte-aligned row stride');

  const dxt = encodeGim({ rgba: solid(8, 8, 10, 20, 30), width: 8, height: 8, format: GimFormat.DXT1, pixelOrder: 0 });
  const dxtInfo = inspectGim(dxt).pictures[0];
  assert.equal(dxtInfo.pitchAlign, 4);
  assert.equal(dxtInfo.heightAlign, 4);

  const faster = encodeGim({ rgba: solid(16, 8, 10, 20, 30), width: 16, height: 8, format: GimFormat.RGBA8888, pixelOrder: 1 });
  const fasterInfo = inspectGim(faster).pictures[0];
  assert.equal(fasterInfo.pitchAlign, 16);
  assert.equal(fasterInfo.heightAlign, 8);

  const dxtAligned = encodeGim({ rgba: solid(64, 64, 10, 20, 30), width: 64, height: 64, format: GimFormat.DXT1, pixelOrder: 0, pitchAlign: 4, heightAlign: 4 });
  const dxtAlignedInfo = inspectGim(dxtAligned).pictures[0];
  assert.equal(dxtAlignedInfo.format, GimFormat.DXT1);
  assert.equal(dxtAlignedInfo.pixelOrder, 0);
  assert.equal(dxtAlignedInfo.pitchAlign, 4);
  assert.equal(dxtAlignedInfo.heightAlign, 4);

  assert.throws(() => encodeGim({ rgba, width: 5, height: 3, format: GimFormat.RGBA8888, pixelOrder: 0, pitchAlign: 16, heightAlign: 8 }), /heightAlign=1/);
  assert.throws(() => encodeGim({ rgba: solid(8, 8, 0, 0, 0), width: 8, height: 8, format: GimFormat.DXT1, pixelOrder: 0, pitchAlign: 16, heightAlign: 8 }), /DXT creation is verified/);
}



// Structural golden headers cross-checked against Sony GimConv examples documented
// on PSDevWiki. The public examples are big-endian; these constants are the same
// field values serialized in PSP little-endian form. Pixel bytes are intentionally
// excluded because our DXT compressor need not be byte-identical to GimConv.
function hexBytes(text) {
  return Uint8Array.from(text.trim().split(/\s+/).map((x) => Number.parseInt(x, 16)));
}

{
  const rgba = solid(4, 2, 0xca, 0x5e, 0x11, 0x00);
  const gim = encodeGim({ rgba, width: 4, height: 2, format: GimFormat.RGBA8888, pixelOrder: 0 });
  const expectedHeader = hexBytes(`
    4d 49 47 2e 30 30 2e 31 50 53 50 00 00 00 00 00
    02 00 00 00 90 00 00 00 10 00 00 00 10 00 00 00
    03 00 00 00 80 00 00 00 10 00 00 00 10 00 00 00
    04 00 00 00 70 00 00 00 70 00 00 00 10 00 00 00
    30 00 00 00 03 00 00 00 04 00 02 00 20 00 10 00
    01 00 02 00 00 00 00 00 30 00 00 00 40 00 00 00
    60 00 00 00 00 00 00 00 01 00 01 00 03 00 01 00
    40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  `);
  assert.deepEqual([...gim.subarray(0, 0x80)], [...expectedHeader], 'RGBA8888 GIM structure must match GimConv 4x2 profile');
  assert.equal(gim.length, 0xa0, 'RGBA8888 4x2 GimConv-profile file length');
}

{
  const rgba = solid(4, 2, 0xca, 0x5e, 0x11, 0xff);
  const gim = encodeGim({ rgba, width: 4, height: 2, format: GimFormat.DXT5, pixelOrder: 0 });
  const expectedHeader = hexBytes(`
    4d 49 47 2e 30 30 2e 31 50 53 50 00 00 00 00 00
    02 00 00 00 80 00 00 00 10 00 00 00 10 00 00 00
    03 00 00 00 70 00 00 00 10 00 00 00 10 00 00 00
    04 00 00 00 60 00 00 00 60 00 00 00 10 00 00 00
    30 00 00 00 0a 00 00 00 04 00 02 00 08 00 04 00
    04 00 02 00 00 00 00 00 30 00 00 00 40 00 00 00
    50 00 00 00 00 00 00 00 01 00 01 00 03 00 01 00
    40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  `);
  assert.deepEqual([...gim.subarray(0, 0x80)], [...expectedHeader], 'DXT5 GIM structure must match GimConv 4x2 profile');
  assert.equal(gim.length, 0x90, 'DXT5 4x2 GimConv-profile file length');
}

console.log('GIM structural GimConv golden tests passed.');

console.log('GIM golden PSP byte-layout tests passed.');
