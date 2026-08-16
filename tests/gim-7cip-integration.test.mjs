import assert from 'node:assert/strict';
import { encodeGim, decodeGim, inspectGim, replaceGimImage, GimFormat } from '../tools/gim-studio/gim-codec.js';
import { buildArchive, parseArchive, validateEntryBytes } from '../tools/7cip/cip.js';

function fixture(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      rgba[p] = (x * 9 + y * 5) & 255;
      rgba[p + 1] = (x * 3 + y * 11) & 255;
      rgba[p + 2] = (x * 13 + y * 7) & 255;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

function mae(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

const width = 64, height = 64;
const originalRgba = fixture(width, height);
const originalGim = encodeGim({ rgba: originalRgba, width, height, format: GimFormat.DXT1, pixelOrder: 0 });
const firstBuild = buildArchive({ type: 'CPM', entries: [{ cardId: 5066, altIndex: null, name: '5066.gim', bytes: originalGim }] });
assert.equal(firstBuild.info.slotSize, 0x800, 'stock DXT1 CPM should use 0x800 slots');

const opened = parseArchive(firstBuild.bytes);
const extracted = opened.entries[0].bytes;
const extractedInfo = inspectGim(extracted).pictures[0];
assert.equal(extractedInfo.format, GimFormat.DXT1);
assert.equal(extractedInfo.width, 64);
assert.equal(extractedInfo.height, 64);

const modifiedRgba = decodeGim(extracted).rgba.slice();
for (let y = 12; y < 28; y += 1) {
  for (let x = 8; x < 40; x += 1) {
    const p = (y * width + x) * 4;
    modifiedRgba[p] = 255 - modifiedRgba[p];
    modifiedRgba[p + 1] = (modifiedRgba[p + 1] + 80) & 255;
  }
}
const replaced = replaceGimImage(extracted, modifiedRgba, width, height);
const replacedInfo = inspectGim(replaced).pictures[0];
assert.equal(replacedInfo.format, GimFormat.DXT1, 'Replace image must preserve DXT1');
assert.equal(replaced.length, extracted.length, 'Replace image must preserve GIM container length');
assert.deepEqual([...replaced.subarray(0, 0x80)], [...extracted.subarray(0, 0x80)], 'Replace image must preserve the CPM-reconstructed GIM header/layout');
assert.equal(validateEntryBytes('CPM', replaced), true);

const secondBuild = buildArchive({ type: 'CPM', entries: [{ ...opened.entries[0], bytes: replaced }] });
assert.equal(secondBuild.info.slotSize, 0x800, 'DXT1 replacement must not grow CPM slots');
assert.equal(secondBuild.bytes.length, firstBuild.bytes.length, 'DXT1 replacement must keep archive size');

const reopened = parseArchive(secondBuild.bytes).entries[0].bytes;
assert.equal(inspectGim(reopened).pictures[0].format, GimFormat.DXT1);
assert.ok(mae(modifiedRgba, decodeGim(reopened).rgba) < 35, 'reopened card should remain visually close after DXT1 recompression');

console.log('GIM Studio -> 7-CIP CPM workflow integration test passed.');
