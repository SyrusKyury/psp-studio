const FORMAT_NAMES = Object.freeze({
  0x00: 'RGBA5650',
  0x01: 'RGBA5551',
  0x02: 'RGBA4444',
  0x03: 'RGBA8888',
  0x04: 'INDEX4',
  0x05: 'INDEX8',
  0x06: 'INDEX16',
  0x07: 'INDEX32',
  0x08: 'DXT1',
  0x09: 'DXT3',
  0x0a: 'DXT5',
  0x108: 'DXT1EXT',
  0x109: 'DXT3EXT',
  0x10a: 'DXT5EXT'
});

const BPP_BY_FORMAT = Object.freeze({
  0x00: 16, 0x01: 16, 0x02: 16, 0x03: 32,
  0x04: 4, 0x05: 8, 0x06: 16, 0x07: 32,
  0x08: 4, 0x09: 8, 0x0a: 8,
  0x108: 4, 0x109: 8, 0x10a: 8
});

const BLOCK = Object.freeze({ ROOT: 0x02, PICTURE: 0x03, IMAGE: 0x04, PALETTE: 0x05, FILEINFO: 0xff });
const GIM_HEADER_SIZE = 0x10;
const BLOCK_HEADER_SIZE = 0x10;
const IMAGE_HEADER_SIZE = 0x30;
const FRAME_DATA_START = 0x40;
const DEFAULT_PITCH_ALIGN = 0x10;
const DEFAULT_HEIGHT_ALIGN = 0x01;
const DXT_PITCH_ALIGN = 0x04;
const DXT_HEIGHT_ALIGN = 0x04;
const PSP_SWIZZLE_PITCH_ALIGN = 0x10;
const PSP_SWIZZLE_HEIGHT_ALIGN = 0x08;

function fail(message) { throw new Error(message); }
function align(value, boundary) { return boundary > 1 ? Math.ceil(value / boundary) * boundary : value; }
function validateAlignment(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff) fail(`${name} must be an integer between 1 and 65535.`);
  return value;
}
function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function asU8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  fail('Expected an ArrayBuffer or Uint8Array.');
}
function readAscii(bytes, offset, length) { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function writeAscii(bytes, offset, text) { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i) & 0xff; }
function u16(view, offset, little) { return view.getUint16(offset, little); }
function u32(view, offset, little) { return view.getUint32(offset, little); }
function set16(view, offset, value, little) { view.setUint16(offset, value, little); }
function set32(view, offset, value, little) { view.setUint32(offset, value >>> 0, little); }

function detectEndian(bytes) {
  if (bytes.length < GIM_HEADER_SIZE) fail('File is too small to be a GIM.');
  const sig = readAscii(bytes, 0, 8);
  const style = readAscii(bytes, 8, 4);
  if (sig === 'MIG.00.1' && style === 'PSP\0') return true;
  if (sig === '.GIM1.00' && style === '\0PSP') return false;
  fail('Invalid or unsupported GIM header. Expected a PSP GIM 1.00 file.');
}

function parseBlockHeader(bytes, offset, little) {
  if (offset < GIM_HEADER_SIZE || offset + BLOCK_HEADER_SIZE > bytes.length) fail(`Invalid GIM block at 0x${offset.toString(16)}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = u16(view, offset, little);
  const unknown = u16(view, offset + 2, little);
  const blockSize = u32(view, offset + 4, little);
  const nextBlock = u32(view, offset + 8, little);
  const dataOffset = u32(view, offset + 12, little);
  if (blockSize < BLOCK_HEADER_SIZE || offset + blockSize > bytes.length) fail(`Invalid GIM block size at 0x${offset.toString(16)}.`);
  if (nextBlock === 0) fail(`Invalid zero next-block offset at 0x${offset.toString(16)}.`);
  if (dataOffset < BLOCK_HEADER_SIZE || offset + dataOffset > offset + blockSize) fail(`Invalid GIM data offset at 0x${offset.toString(16)}.`);
  return { type, unknown, offset, blockSize, end: offset + blockSize, nextBlock, nextOffset: offset + nextBlock, dataOffset, dataStart: offset + dataOffset };
}

function parseImageHeader(bytes, block, little) {
  const start = block.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (start + IMAGE_HEADER_SIZE > block.end) fail('Truncated GIM image block.');
  const info = {
    ...block,
    structureSize: u16(view, start, little),
    format: u16(view, start + 4, little),
    pixelOrder: u16(view, start + 6, little),
    width: u16(view, start + 8, little),
    height: u16(view, start + 10, little),
    bpp: u16(view, start + 12, little),
    pitchAlign: u16(view, start + 14, little),
    heightAlign: u16(view, start + 16, little),
    unknown12: u16(view, start + 18, little),
    nextIndexBlock: u32(view, start + 24, little),
    frameDataStart: u32(view, start + 28, little),
    frameDataEnd: u32(view, start + 32, little),
    planeMask: u32(view, start + 36, little),
    levelType: u16(view, start + 40, little),
    levelCount: u16(view, start + 42, little),
    frameType: u16(view, start + 44, little),
    frameCount: u16(view, start + 46, little)
  };
  if (!FORMAT_NAMES[info.format]) fail(`Unsupported GIM pixel format 0x${info.format.toString(16)}.`);
  if (!info.width || !info.height || !info.bpp) fail('Invalid zero-sized GIM image.');
  if (info.frameCount !== 1 || info.levelCount !== 1) fail(`This GIM uses ${info.frameCount} frame(s) and ${info.levelCount} level(s). GIM Studio currently supports one frame and one mip level per picture.`);
  const indexPos = start + info.nextIndexBlock;
  if (indexPos + 4 > block.end) fail('Invalid GIM frame index.');
  const firstFrameOffset = u32(view, indexPos, little);
  info.frameOffset = firstFrameOffset;
  info.frameStart = start + firstFrameOffset;
  info.frameEnd = start + info.frameDataEnd;
  if (info.frameStart < start || info.frameEnd > block.end || info.frameStart > info.frameEnd) fail('Invalid GIM frame data range.');
  return info;
}

function collectBlocks(bytes, little) {
  const blocks = [];
  let offset = GIM_HEADER_SIZE;
  const seen = new Set();
  for (let guard = 0; guard < 4096 && offset < bytes.length; guard += 1) {
    if (seen.has(offset)) fail('GIM block chain contains a loop.');
    seen.add(offset);
    const block = parseBlockHeader(bytes, offset, little);
    blocks.push(block);
    const next = block.nextOffset;
    if (next <= offset) fail('Invalid backwards GIM block link.');
    if (next >= bytes.length) break;
    offset = next;
  }
  if (!blocks.length || blocks[0].type !== BLOCK.ROOT) fail('GIM root block not found.');
  return blocks;
}

function expand5(v) { return (v << 3) | (v >> 2); }
function expand6(v) { return (v << 2) | (v >> 4); }
function expand4(v) { return (v << 4) | v; }

// PSP direct-color formats use ABGR-style channel placement: red occupies the
// least-significant bits. This differs from the RGB565 color endpoints used by
// PSP DXT blocks, which follow the usual S3TC RGB565 bit placement.
function pack5650(r, g, b) { return ((b >> 3) << 11) | ((g >> 2) << 5) | (r >> 3); }
function unpack5650(word) { return [expand5(word & 31), expand6((word >> 5) & 63), expand5((word >> 11) & 31), 255]; }
function pack5551(r, g, b, a) { return ((a >= 128 ? 1 : 0) << 15) | ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3); }
function unpack5551(word) { return [expand5(word & 31), expand5((word >> 5) & 31), expand5((word >> 10) & 31), (word & 0x8000) ? 255 : 0]; }
function pack4444(r, g, b, a) { return ((a >> 4) << 12) | ((b >> 4) << 8) | ((g >> 4) << 4) | (r >> 4); }
function unpack4444(word) { return [expand4(word & 15), expand4((word >> 4) & 15), expand4((word >> 8) & 15), expand4((word >> 12) & 15)]; }

function packDxt565(r, g, b) { return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); }
function unpackDxt565(word) {
  // Match PPSSPP's PSP DXT decoder: endpoints are expanded by shifting, not by
  // bit replication. This also makes our preview match what the game sees.
  return [((word >> 11) & 31) << 3, ((word >> 5) & 63) << 2, (word & 31) << 3, 255];
}

function readPackedValue(bytes, byteOffset, bpp) {
  if (bpp === 4) return null;
  if (bpp === 8) return bytes[byteOffset];
  if (bpp === 16) return bytes[byteOffset] | (bytes[byteOffset + 1] << 8);
  if (bpp === 32) return (bytes[byteOffset] | (bytes[byteOffset + 1] << 8) | (bytes[byteOffset + 2] << 16) | (bytes[byteOffset + 3] << 24)) >>> 0;
  fail(`Unsupported ${bpp}-bpp packed value.`);
}

function writePackedValue(bytes, byteOffset, bpp, value) {
  if (bpp === 8) bytes[byteOffset] = value & 0xff;
  else if (bpp === 16) { bytes[byteOffset] = value & 0xff; bytes[byteOffset + 1] = (value >>> 8) & 0xff; }
  else if (bpp === 32) { bytes[byteOffset] = value & 0xff; bytes[byteOffset + 1] = (value >>> 8) & 0xff; bytes[byteOffset + 2] = (value >>> 16) & 0xff; bytes[byteOffset + 3] = (value >>> 24) & 0xff; }
  else fail(`Unsupported ${bpp}-bpp packed value.`);
}

function swizzledDimensions(width, height, bpp) {
  const tileWidth = Math.max(1, Math.floor(128 / bpp));
  const tileHeight = 8;
  return { tileWidth, tileHeight, width: align(width, tileWidth), height: align(height, tileHeight) };
}

function unpackValues(frameBytes, info) {
  const { width, height, bpp, pixelOrder } = info;
  const pitchAlign = info.pitchAlign || 1;
  if (![4, 8, 16, 32].includes(bpp)) fail(`Unsupported GIM bpp alignment ${bpp}.`);
  if (pixelOrder === 1) {
    const dims = swizzledDimensions(width, height, bpp);
    const count = dims.width * dims.height;
    const raw = new Uint32Array(count);
    if (bpp === 4) {
      for (let i = 0; i < count; i += 1) raw[i] = (frameBytes[i >> 1] >> ((i & 1) * 4)) & 0xf;
    } else {
      const bytesPer = bpp >> 3;
      for (let i = 0; i < count; i += 1) raw[i] = readPackedValue(frameBytes, i * bytesPer, bpp);
    }
    const out = new Uint32Array(width * height);
    let source = 0;
    for (let tileY = 0; tileY < dims.height; tileY += dims.tileHeight) {
      for (let tileX = 0; tileX < dims.width; tileX += dims.tileWidth) {
        for (let y = 0; y < dims.tileHeight; y += 1) {
          for (let x = 0; x < dims.tileWidth; x += 1) {
            const dx = tileX + x;
            const dy = tileY + y;
            if (dx < width && dy < height) out[dy * width + dx] = raw[source];
            source += 1;
          }
        }
      }
    }
    return out;
  }
  if (pixelOrder !== 0) fail(`Unsupported GIM pixel order ${pixelOrder}.`);
  const out = new Uint32Array(width * height);
  const rowBytes = Math.ceil(width * bpp / 8);
  const stride = align(rowBytes, pitchAlign);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    if (bpp === 4) {
      for (let x = 0; x < width; x += 1) out[y * width + x] = (frameBytes[row + (x >> 1)] >> ((x & 1) * 4)) & 0xf;
    } else {
      const bytesPer = bpp >> 3;
      for (let x = 0; x < width; x += 1) out[y * width + x] = readPackedValue(frameBytes, row + x * bytesPer, bpp);
    }
  }
  return out;
}

function packValues(values, info) {
  const { width, height, bpp, pixelOrder } = info;
  const pitchAlign = info.pitchAlign || 1;
  if (values.length !== width * height) fail('Pixel index/value count does not match image dimensions.');
  if (pixelOrder === 1) {
    const dims = swizzledDimensions(width, height, bpp);
    const count = dims.width * dims.height;
    const raw = new Uint32Array(count);
    let dest = 0;
    for (let tileY = 0; tileY < dims.height; tileY += dims.tileHeight) {
      for (let tileX = 0; tileX < dims.width; tileX += dims.tileWidth) {
        for (let y = 0; y < dims.tileHeight; y += 1) {
          for (let x = 0; x < dims.tileWidth; x += 1) {
            const sx = tileX + x;
            const sy = tileY + y;
            raw[dest++] = sx < width && sy < height ? values[sy * width + sx] : 0;
          }
        }
      }
    }
    const out = new Uint8Array(Math.ceil(count * bpp / 8));
    if (bpp === 4) {
      for (let i = 0; i < count; i += 1) out[i >> 1] |= (raw[i] & 0xf) << ((i & 1) * 4);
    } else {
      const bytesPer = bpp >> 3;
      for (let i = 0; i < count; i += 1) writePackedValue(out, i * bytesPer, bpp, raw[i]);
    }
    return out;
  }
  if (pixelOrder !== 0) fail(`Unsupported GIM pixel order ${pixelOrder}.`);
  const rowBytes = Math.ceil(width * bpp / 8);
  const stride = align(rowBytes, pitchAlign);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    if (bpp === 4) {
      for (let x = 0; x < width; x += 1) out[row + (x >> 1)] |= (values[y * width + x] & 0xf) << ((x & 1) * 4);
    } else {
      const bytesPer = bpp >> 3;
      for (let x = 0; x < width; x += 1) writePackedValue(out, row + x * bytesPer, bpp, values[y * width + x]);
    }
  }
  return out;
}

function rgbaToDirectValues(rgba, format) {
  const count = rgba.length >> 2;
  const out = new Uint32Array(count);
  for (let i = 0, p = 0; i < count; i += 1, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
    if (format === 0) out[i] = pack5650(r, g, b);
    else if (format === 1) out[i] = pack5551(r, g, b, a);
    else if (format === 2) out[i] = pack4444(r, g, b, a);
    else if (format === 3) out[i] = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    else fail(`Format ${format} is not a direct RGBA format.`);
  }
  return out;
}

function directValuesToRgba(values, format) {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0, p = 0; i < values.length; i += 1, p += 4) {
    let color;
    if (format === 0) color = unpack5650(values[i]);
    else if (format === 1) color = unpack5551(values[i]);
    else if (format === 2) color = unpack4444(values[i]);
    else if (format === 3) color = [values[i] & 0xff, (values[i] >>> 8) & 0xff, (values[i] >>> 16) & 0xff, (values[i] >>> 24) & 0xff];
    else fail(`Format ${format} is not a direct RGBA format.`);
    out[p] = color[0]; out[p + 1] = color[1]; out[p + 2] = color[2]; out[p + 3] = color[3];
  }
  return out;
}

function colorDistanceSq(r, g, b, a, c) {
  const dr = r - c[0], dg = g - c[1], db = b - c[2], da = (a - c[3]) * 1.25;
  return dr * dr + dg * dg + db * db + da * da;
}

function quantizeRgba(rgba, maxColors) {
  const counts = new Map();
  for (let p = 0; p < rgba.length; p += 4) {
    const key = ((rgba[p] << 24) | (rgba[p + 1] << 16) | (rgba[p + 2] << 8) | rgba[p + 3]) >>> 0;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let palette;
  if (counts.size <= maxColors) {
    palette = [...counts.keys()].map(key => [(key >>> 24) & 0xff, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff]);
  } else {
    const points = [...counts.entries()].map(([key, count]) => ({
      color: [(key >>> 24) & 0xff, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff], count
    }));
    let boxes = [points];
    while (boxes.length < maxColors) {
      let best = -1, bestScore = -1, bestChannel = 0;
      for (let i = 0; i < boxes.length; i += 1) {
        const box = boxes[i];
        if (box.length < 2) continue;
        const min = [255, 255, 255, 255], max = [0, 0, 0, 0];
        let weight = 0;
        for (const point of box) {
          weight += point.count;
          for (let c = 0; c < 4; c += 1) { min[c] = Math.min(min[c], point.color[c]); max[c] = Math.max(max[c], point.color[c]); }
        }
        const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2], (max[3] - min[3]) * 1.25];
        const channel = ranges.indexOf(Math.max(...ranges));
        const score = ranges[channel] * Math.log2(weight + 1);
        if (score > bestScore) { bestScore = score; best = i; bestChannel = channel; }
      }
      if (best < 0) break;
      const box = boxes[best].slice().sort((a, b) => a.color[bestChannel] - b.color[bestChannel]);
      const total = box.reduce((sum, p) => sum + p.count, 0);
      let accum = 0, split = 1;
      for (; split < box.length; split += 1) { accum += box[split - 1].count; if (accum >= total / 2) break; }
      boxes.splice(best, 1, box.slice(0, split), box.slice(split));
    }
    palette = boxes.map(box => {
      let total = 0, r = 0, g = 0, b = 0, a = 0;
      for (const point of box) { total += point.count; r += point.color[0] * point.count; g += point.color[1] * point.count; b += point.color[2] * point.count; a += point.color[3] * point.count; }
      return [clampByte(r / total), clampByte(g / total), clampByte(b / total), clampByte(a / total)];
    });
  }
  while (palette.length < maxColors) palette.push([0, 0, 0, 0]);
  const indices = new Uint32Array(rgba.length >> 2);
  const exact = new Map();
  for (let i = 0; i < maxColors; i += 1) exact.set(`${palette[i][0]},${palette[i][1]},${palette[i][2]},${palette[i][3]}`, i);
  for (let i = 0, p = 0; i < indices.length; i += 1, p += 4) {
    const key = `${rgba[p]},${rgba[p + 1]},${rgba[p + 2]},${rgba[p + 3]}`;
    const hit = exact.get(key);
    if (hit !== undefined) { indices[i] = hit; continue; }
    let best = 0, bestDist = Infinity;
    for (let j = 0; j < maxColors; j += 1) {
      const dist = colorDistanceSq(rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3], palette[j]);
      if (dist < bestDist) { bestDist = dist; best = j; }
    }
    indices[i] = best;
  }
  return { palette, indices };
}

function paletteToRgba(paletteValues, paletteFormat) { return directValuesToRgba(paletteValues, paletteFormat); }
function rgbaArrayToPalette(rgba) {
  const out = [];
  for (let p = 0; p < rgba.length; p += 4) out.push([rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]);
  return out;
}

function dxtColorPalette(c0, c1, dxt1Alpha) {
  const a = unpackDxt565(c0), b = unpackDxt565(c1);
  const palette = [a, b];
  // PPSSPP follows the endpoint ordering for all PSP DXT variants. For DXT3/5
  // the alpha plane later replaces alpha, but color index 3 is still black when
  // color1 <= color2.
  if (c0 <= c1) {
    palette.push([
      Math.floor((a[0] + b[0]) / 2), Math.floor((a[1] + b[1]) / 2), Math.floor((a[2] + b[2]) / 2), 255
    ], [0, 0, 0, dxt1Alpha ? 0 : 255]);
  } else {
    palette.push([
      Math.floor((2 * a[0] + b[0]) / 3), Math.floor((2 * a[1] + b[1]) / 3), Math.floor((2 * a[2] + b[2]) / 3), 255
    ], [
      Math.floor((a[0] + 2 * b[0]) / 3), Math.floor((a[1] + 2 * b[1]) / 3), Math.floor((a[2] + 2 * b[2]) / 3), 255
    ]);
  }
  return palette;
}

function dxt5Lerp(alpha1, alpha2, n, denominator) {
  const part1 = Math.floor((alpha1 * ((denominator - n) << 8)) / denominator);
  const part2 = Math.floor((alpha2 * (n << 8)) / denominator);
  return (part1 + part2 + 31) >> 8;
}

function dxt5AlphaPalette(alpha1, alpha2) {
  const palette = [alpha1, alpha2];
  if (alpha1 > alpha2) {
    for (let n = 1; n <= 6; n += 1) palette.push(dxt5Lerp(alpha1, alpha2, n, 7));
  } else {
    for (let n = 1; n <= 4; n += 1) palette.push(dxt5Lerp(alpha1, alpha2, n, 5));
    palette.push(0, 255);
  }
  return palette;
}

function decodeDxt(bytes, width, height, format) {
  const baseFormat = format & 0xff;
  const blockBytes = baseFormat === 8 ? 8 : 16;
  const blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4);
  const needed = blocksX * blocksY * blockBytes;
  if (bytes.length < needed) fail('Truncated DXT frame data.');
  const out = new Uint8ClampedArray(width * height * 4);
  let pos = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const colorBits = (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
      const c0 = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const c1 = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const colors = dxtColorPalette(c0, c1, baseFormat === 8);
      let alphaValues = null;
      if (baseFormat === 9) {
        alphaValues = new Uint8Array(16);
        for (let i = 0; i < 8; i += 1) {
          const value = bytes[pos + 8 + i];
          alphaValues[i * 2] = (value & 0xf) * 17;
          alphaValues[i * 2 + 1] = (value >>> 4) * 17;
        }
      } else if (baseFormat === 10) {
        // PSP DXT5 reverses the PC layout: color block first, then 48 bits of
        // alpha indices, then the two alpha endpoints.
        const alpha1 = bytes[pos + 14], alpha2 = bytes[pos + 15];
        const ap = dxt5AlphaPalette(alpha1, alpha2);
        let alphaBits = 0n;
        for (let i = 0; i < 6; i += 1) alphaBits |= BigInt(bytes[pos + 8 + i]) << BigInt(i * 8);
        alphaValues = new Uint8Array(16);
        for (let i = 0; i < 16; i += 1) alphaValues[i] = ap[Number((alphaBits >> BigInt(i * 3)) & 7n)];
      }
      for (let py = 0; py < 4; py += 1) {
        for (let px = 0; px < 4; px += 1) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const i = py * 4 + px;
          const ci = (colorBits >>> (i * 2)) & 3;
          const c = colors[ci];
          const dst = (y * width + x) * 4;
          out[dst] = c[0]; out[dst + 1] = c[1]; out[dst + 2] = c[2];
          out[dst + 3] = alphaValues ? alphaValues[i] : c[3];
        }
      }
      pos += blockBytes;
    }
  }
  return out;
}

function chooseDxtEndpoints(block, hasTransparent, forceFourColor) {
  const candidates = block.filter(c => !hasTransparent || c[3] >= 128);
  if (!candidates.length) return { c0: 0, c1: 0 };
  let min = candidates[0], max = candidates[0], minLum = Infinity, maxLum = -Infinity;
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (const c of candidates) { minR = Math.min(minR, c[0]); minG = Math.min(minG, c[1]); minB = Math.min(minB, c[2]); maxR = Math.max(maxR, c[0]); maxG = Math.max(maxG, c[1]); maxB = Math.max(maxB, c[2]); }
  const axis = [maxR - minR, maxG - minG, maxB - minB];
  for (const c of candidates) {
    const lum = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2];
    if (lum < minLum) { minLum = lum; min = c; }
    if (lum > maxLum) { maxLum = lum; max = c; }
  }
  let c0 = packDxt565(max[0], max[1], max[2]);
  let c1 = packDxt565(min[0], min[1], min[2]);
  if (hasTransparent && !forceFourColor) {
    if (c0 > c1) [c0, c1] = [c1, c0];
  } else if (c0 <= c1) {
    [c0, c1] = [c1, c0];
    if (c0 === c1) {
      if (c0 < 0xffff) c0 += 1;
      else if (c1 > 0) c1 -= 1;
    }
  }
  return { c0, c1 };
}

function encodeColorBlock(block, allowTransparency, forceFourColor) {
  const hasTransparent = allowTransparency && block.some(c => c[3] < 128);
  const { c0, c1 } = chooseDxtEndpoints(block, hasTransparent, forceFourColor);
  const palette = dxtColorPalette(c0, c1, allowTransparency);
  let bits = 0;
  for (let i = 0; i < 16; i += 1) {
    const c = block[i];
    let best = 0, bestDist = Infinity;
    if (hasTransparent && c[3] < 128 && c0 <= c1) best = 3;
    else {
      const maxIndex = (allowTransparency && c0 <= c1) ? 2 : 3;
      for (let j = 0; j <= maxIndex; j += 1) {
        const p = palette[j];
        const dr = c[0] - p[0], dg = c[1] - p[1], db = c[2] - p[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
    }
    bits |= best << (i * 2);
  }
  return { bits: bits >>> 0, c0, c1 };
}

function blockPixels(rgba, width, height, bx, by) {
  const block = [];
  for (let py = 0; py < 4; py += 1) {
    for (let px = 0; px < 4; px += 1) {
      const x = Math.min(width - 1, bx * 4 + px), y = Math.min(height - 1, by * 4 + py);
      const p = (y * width + x) * 4;
      block.push([rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]);
    }
  }
  return block;
}

function encodeDxt(rgba, width, height, format) {
  const baseFormat = format & 0xff;
  if (![8, 9, 10].includes(baseFormat)) fail('Not a DXT format.');
  const blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4);
  const blockBytes = baseFormat === 8 ? 8 : 16;
  const out = new Uint8Array(blocksX * blocksY * blockBytes);
  let pos = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const block = blockPixels(rgba, width, height, bx, by);
      const color = encodeColorBlock(block, baseFormat === 8, baseFormat !== 8);
      out[pos] = color.bits & 0xff; out[pos + 1] = (color.bits >>> 8) & 0xff; out[pos + 2] = (color.bits >>> 16) & 0xff; out[pos + 3] = (color.bits >>> 24) & 0xff;
      out[pos + 4] = color.c0 & 0xff; out[pos + 5] = color.c0 >>> 8; out[pos + 6] = color.c1 & 0xff; out[pos + 7] = color.c1 >>> 8;
      if (baseFormat === 9) {
        for (let i = 0; i < 16; i += 2) out[pos + 8 + (i >> 1)] = ((block[i + 1][3] >> 4) << 4) | (block[i][3] >> 4);
      } else if (baseFormat === 10) {
        let alpha1 = 0, alpha2 = 255;
        for (const c of block) { alpha1 = Math.max(alpha1, c[3]); alpha2 = Math.min(alpha2, c[3]); }
        const ap = dxt5AlphaPalette(alpha1, alpha2);
        let bits = 0n;
        for (let i = 0; i < 16; i += 1) {
          let best = 0, bestDist = Infinity;
          for (let j = 0; j < 8; j += 1) {
            const dist = Math.abs(block[i][3] - ap[j]);
            if (dist < bestDist) { bestDist = dist; best = j; }
          }
          bits |= BigInt(best) << BigInt(i * 3);
        }
        for (let i = 0; i < 6; i += 1) out[pos + 8 + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
        out[pos + 14] = alpha1;
        out[pos + 15] = alpha2;
      }
      pos += blockBytes;
    }
  }
  return out;
}

function decodeImage(bytes, imageInfo, paletteInfo) {
  const frame = bytes.subarray(imageInfo.frameStart, imageInfo.frameEnd);
  const baseFormat = imageInfo.format & 0xff;
  if ([8, 9, 10].includes(baseFormat)) {
    if (imageInfo.pixelOrder !== 0) fail('DXT GIM with pixel_order=faster is not supported safely. PSP DXT textures are normally stored unswizzled.');
    return decodeDxt(frame, imageInfo.width, imageInfo.height, imageInfo.format);
  }
  const values = unpackValues(frame, imageInfo);
  if (imageInfo.format <= 3) return directValuesToRgba(values, imageInfo.format);
  if ([6, 7].includes(imageInfo.format)) fail(`${FORMAT_NAMES[imageInfo.format]} is recognized, but its alpha/index packing is not documented well enough for a safe conversion yet.`);
  if (!paletteInfo) fail('Indexed GIM image has no palette block.');
  const paletteFrame = bytes.subarray(paletteInfo.frameStart, paletteInfo.frameEnd);
  const paletteValues = unpackValues(paletteFrame, paletteInfo);
  const paletteRgba = paletteToRgba(paletteValues, paletteInfo.format);
  const out = new Uint8ClampedArray(values.length * 4);
  const paletteCount = paletteValues.length;
  for (let i = 0, p = 0; i < values.length; i += 1, p += 4) {
    const idx = values[i];
    if (idx >= paletteCount) fail(`Palette index ${idx} exceeds palette size ${paletteCount}.`);
    const q = idx * 4;
    out[p] = paletteRgba[q]; out[p + 1] = paletteRgba[q + 1]; out[p + 2] = paletteRgba[q + 2]; out[p + 3] = paletteRgba[q + 3];
  }
  return out;
}

function inspectInternal(input) {
  const bytes = asU8(input);
  const littleEndian = detectEndian(bytes);
  const blocks = collectBlocks(bytes, littleEndian);
  const pictures = [];
  let currentPicture = null;
  for (const block of blocks) {
    if (block.type === BLOCK.PICTURE) {
      currentPicture = { block, image: null, palette: null };
      pictures.push(currentPicture);
    } else if (block.type === BLOCK.IMAGE) {
      const info = parseImageHeader(bytes, block, littleEndian);
      if (!currentPicture) { currentPicture = { block: null, image: null, palette: null }; pictures.push(currentPicture); }
      currentPicture.image = info;
    } else if (block.type === BLOCK.PALETTE) {
      const info = parseImageHeader(bytes, block, littleEndian);
      if (!currentPicture) { currentPicture = { block: null, image: null, palette: null }; pictures.push(currentPicture); }
      currentPicture.palette = info;
    }
  }
  const usable = pictures.filter(p => p.image);
  if (!usable.length) fail('No image block was found in this GIM.');
  return { bytes, littleEndian, blocks, pictures: usable };
}

export function inspectGim(input) {
  const parsed = inspectInternal(input);
  return {
    littleEndian: parsed.littleEndian,
    pictureCount: parsed.pictures.length,
    pictures: parsed.pictures.map((p, index) => ({
      index,
      width: p.image.width,
      height: p.image.height,
      format: p.image.format,
      formatName: FORMAT_NAMES[p.image.format] || `0x${p.image.format.toString(16)}`,
      pixelOrder: p.image.pixelOrder,
      pixelOrderName: p.image.pixelOrder === 1 ? 'faster (swizzled)' : 'normal',
      bpp: p.image.bpp,
      pitchAlign: p.image.pitchAlign,
      heightAlign: p.image.heightAlign,
      paletteFormat: p.palette?.format ?? null,
      paletteFormatName: p.palette ? FORMAT_NAMES[p.palette.format] : null
    }))
  };
}

export function decodeGim(input, pictureIndex = 0) {
  const parsed = inspectInternal(input);
  const picture = parsed.pictures[pictureIndex];
  if (!picture) fail(`GIM picture ${pictureIndex} does not exist.`);
  const rgba = decodeImage(parsed.bytes, picture.image, picture.palette);
  return {
    width: picture.image.width,
    height: picture.image.height,
    rgba,
    pictureIndex,
    metadata: inspectGim(parsed.bytes).pictures[pictureIndex]
  };
}

function encodeForInfo(rgba, info, paletteInfo = null) {
  if (rgba.length !== info.width * info.height * 4) fail('Replacement image dimensions do not match the GIM image.');
  const baseFormat = info.format & 0xff;
  if ([8, 9, 10].includes(baseFormat)) {
    if (info.pixelOrder !== 0) fail('Cannot safely rebuild a swizzled DXT GIM.');
    return { imageBytes: encodeDxt(rgba, info.width, info.height, info.format), paletteBytes: null };
  }
  if (info.format <= 3) {
    return { imageBytes: packValues(rgbaToDirectValues(rgba, info.format), info), paletteBytes: null };
  }
  if ([6, 7].includes(info.format)) fail(`${FORMAT_NAMES[info.format]} replacement is disabled until its alpha/index packing is verified.`);
  if (!paletteInfo) fail('Cannot rebuild indexed GIM without its palette block.');
  const maxColors = info.format === 4 ? 16 : 256;
  const quantized = quantizeRgba(rgba, maxColors);
  const imageBytes = packValues(quantized.indices, info);
  const paletteCount = paletteInfo.width * paletteInfo.height;
  const paletteRgba = new Uint8ClampedArray(paletteCount * 4);
  for (let i = 0; i < Math.min(maxColors, paletteCount); i += 1) paletteRgba.set(quantized.palette[i], i * 4);
  const paletteBytes = packValues(rgbaToDirectValues(paletteRgba, paletteInfo.format), paletteInfo);
  return { imageBytes, paletteBytes };
}

export function replaceGimImage(input, rgbaInput, width, height, pictureIndex = 0) {
  const parsed = inspectInternal(input);
  const picture = parsed.pictures[pictureIndex];
  if (!picture) fail(`GIM picture ${pictureIndex} does not exist.`);
  if (picture.image.width !== width || picture.image.height !== height) fail(`Replacement must stay ${picture.image.width}x${picture.image.height} to preserve the original GIM structure.`);
  const rgba = rgbaInput instanceof Uint8ClampedArray ? rgbaInput : new Uint8ClampedArray(asU8(rgbaInput));
  const encoded = encodeForInfo(rgba, picture.image, picture.palette);
  const imageCapacity = picture.image.frameEnd - picture.image.frameStart;
  if (encoded.imageBytes.length > imageCapacity) fail(`Encoded image needs ${encoded.imageBytes.length} bytes, but the original frame reserves ${imageCapacity}.`);
  if (picture.palette && encoded.paletteBytes) {
    const paletteCapacity = picture.palette.frameEnd - picture.palette.frameStart;
    if (encoded.paletteBytes.length > paletteCapacity) fail(`Encoded palette needs ${encoded.paletteBytes.length} bytes, but the original reserves ${paletteCapacity}.`);
  }
  const out = new Uint8Array(parsed.bytes);
  out.fill(0, picture.image.frameStart, picture.image.frameEnd);
  out.set(encoded.imageBytes, picture.image.frameStart);
  if (picture.palette && encoded.paletteBytes) {
    out.fill(0, picture.palette.frameStart, picture.palette.frameEnd);
    out.set(encoded.paletteBytes, picture.palette.frameStart);
  }
  return out;
}

function makeImagePayload({ format, pixelOrder, width, height, bpp, pitchAlign, heightAlign, levelType, bytes }) {
  const frameEnd = FRAME_DATA_START + bytes.length;
  const payload = new Uint8Array(frameEnd);
  const view = new DataView(payload.buffer);
  set16(view, 0, IMAGE_HEADER_SIZE, true);
  set16(view, 2, 0, true);
  set16(view, 4, format, true);
  set16(view, 6, pixelOrder, true);
  set16(view, 8, width, true);
  set16(view, 10, height, true);
  set16(view, 12, bpp, true);
  set16(view, 14, pitchAlign, true);
  set16(view, 16, heightAlign, true);
  set16(view, 18, 2, true);
  set32(view, 20, 0, true);
  set32(view, 24, IMAGE_HEADER_SIZE, true);
  set32(view, 28, FRAME_DATA_START, true);
  set32(view, 32, frameEnd, true);
  set32(view, 36, 0, true);
  set16(view, 40, levelType, true);
  set16(view, 42, 1, true);
  set16(view, 44, 3, true);
  set16(view, 46, 1, true);
  set32(view, IMAGE_HEADER_SIZE, FRAME_DATA_START, true);
  payload.set(bytes, FRAME_DATA_START);
  return payload;
}

function makeBlock(type, payload = new Uint8Array()) {
  const out = new Uint8Array(BLOCK_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  set16(view, 0, type, true);
  set16(view, 2, 0, true);
  set32(view, 4, out.length, true);
  set32(view, 8, out.length, true);
  set32(view, 12, BLOCK_HEADER_SIZE, true);
  out.set(payload, BLOCK_HEADER_SIZE);
  return out;
}

function patchBlockHeader(bytes, offset, { blockSize, nextBlock }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  set32(view, offset + 4, blockSize, true);
  set32(view, offset + 8, nextBlock, true);
}

export function encodeGim({ rgba: rgbaInput, width, height, format = 3, pixelOrder = 0, paletteFormat = 3, pitchAlign = null, heightAlign = null, palettePitchAlign = DEFAULT_PITCH_ALIGN, paletteHeightAlign = DEFAULT_HEIGHT_ALIGN }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) fail('Invalid image dimensions.');
  if (!FORMAT_NAMES[format]) fail(`Unsupported GIM format 0x${format.toString(16)}.`);
  // EXT DXT variants are recognized for inspection/decoding, but their writer
  // semantics are not sufficiently verified against GimConv/real PSP assets.
  // Do not silently serialize them using the base DXT layout.
  if (![0, 1, 2, 3, 4, 5, 8, 9, 10].includes(format)) {
    fail(`GIM format ${FORMAT_NAMES[format]} is recognized but not writable.`);
  }
  if (![0, 1].includes(pixelOrder)) fail('pixelOrder must be 0 (normal) or 1 (faster).');
  const baseFormat = format & 0xff;
  if (pitchAlign == null) pitchAlign = pixelOrder === 1 ? PSP_SWIZZLE_PITCH_ALIGN : [8, 9, 10].includes(baseFormat) ? DXT_PITCH_ALIGN : DEFAULT_PITCH_ALIGN;
  if (heightAlign == null) heightAlign = pixelOrder === 1 ? PSP_SWIZZLE_HEIGHT_ALIGN : [8, 9, 10].includes(baseFormat) ? DXT_HEIGHT_ALIGN : DEFAULT_HEIGHT_ALIGN;
  pitchAlign = validateAlignment(pitchAlign, 'pitchAlign');
  heightAlign = validateAlignment(heightAlign, 'heightAlign');
  palettePitchAlign = validateAlignment(palettePitchAlign, 'palettePitchAlign');
  paletteHeightAlign = validateAlignment(paletteHeightAlign, 'paletteHeightAlign');
  if (pixelOrder === 1 && (pitchAlign !== PSP_SWIZZLE_PITCH_ALIGN || heightAlign !== PSP_SWIZZLE_HEIGHT_ALIGN)) {
    fail(`pixel_order=faster uses the PSP 16-byte x 8-row swizzle layout; use pitchAlign=${PSP_SWIZZLE_PITCH_ALIGN} and heightAlign=${PSP_SWIZZLE_HEIGHT_ALIGN}.`);
  }
  if (pixelOrder === 0 && [8, 9, 10].includes(baseFormat) && (pitchAlign !== DXT_PITCH_ALIGN || heightAlign !== DXT_HEIGHT_ALIGN)) {
    fail(`DXT creation is verified with GimConv-style pitchAlign=${DXT_PITCH_ALIGN} and heightAlign=${DXT_HEIGHT_ALIGN}. Use Replace image to preserve other existing profiles.`);
  }
  if (pixelOrder === 0 && ![8, 9, 10].includes(baseFormat) && heightAlign !== DEFAULT_HEIGHT_ALIGN) {
    fail(`Normal non-DXT creation is currently verified with heightAlign=${DEFAULT_HEIGHT_ALIGN}. Use Replace image to preserve other existing profiles.`);
  }
  const rgba = rgbaInput instanceof Uint8ClampedArray ? rgbaInput : new Uint8ClampedArray(asU8(rgbaInput));
  if (rgba.length !== width * height * 4) fail('RGBA byte count does not match dimensions.');
  if ([8, 9, 10].includes(baseFormat) && pixelOrder !== 0) fail('PSP DXT GIM creation uses pixel_order=normal; swizzled DXT is intentionally not emitted.');
  const bpp = BPP_BY_FORMAT[format];
  let imageBytes, paletteBytes = null, paletteInfo = null;
  const imageInfo = { format, pixelOrder, width, height, bpp, pitchAlign, heightAlign };
  if ([8, 9, 10].includes(baseFormat)) imageBytes = encodeDxt(rgba, width, height, format);
  else if (format <= 3) imageBytes = packValues(rgbaToDirectValues(rgba, format), imageInfo);
  else if (format === 4 || format === 5) {
    if (paletteFormat < 0 || paletteFormat > 3) fail('Palette format must be RGBA5650/5551/4444/8888.');
    const maxColors = format === 4 ? 16 : 256;
    const quantized = quantizeRgba(rgba, maxColors);
    imageBytes = packValues(quantized.indices, imageInfo);
    const paletteRgba = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < maxColors; i += 1) paletteRgba.set(quantized.palette[i], i * 4);
    paletteInfo = { format: paletteFormat, pixelOrder: 0, width: 256, height: 1, bpp: BPP_BY_FORMAT[paletteFormat], pitchAlign: palettePitchAlign, heightAlign: paletteHeightAlign };
    paletteBytes = packValues(rgbaToDirectValues(paletteRgba, paletteFormat), paletteInfo);
  } else fail(`GIM format ${FORMAT_NAMES[format]} is recognized but not writable.`);

  const imagePayload = makeImagePayload({ ...imageInfo, levelType: 1, bytes: imageBytes });
  const imageBlock = makeBlock(BLOCK.IMAGE, imagePayload);
  const paletteBlock = paletteBytes ? makeBlock(BLOCK.PALETTE, makeImagePayload({ ...paletteInfo, levelType: 2, bytes: paletteBytes })) : null;
  const rootBlock = makeBlock(BLOCK.ROOT);
  const pictureBlock = makeBlock(BLOCK.PICTURE);
  // GimConv places the Palette (0x05) before the Image (0x04) inside an
  // indexed Picture. There is no explicit link between the two; order is part
  // of the observed GIM hierarchy, so preserve it when creating indexed GIMs.
  const blocks = [rootBlock, pictureBlock];
  if (paletteBlock) blocks.push(paletteBlock);
  blocks.push(imageBlock);
  const total = GIM_HEADER_SIZE + blocks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  writeAscii(out, 0, 'MIG.00.1');
  writeAscii(out, 8, 'PSP\0');
  let cursor = GIM_HEADER_SIZE;
  const offsets = [];
  for (const block of blocks) { offsets.push(cursor); out.set(block, cursor); cursor += block.length; }
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const next = i + 1 < offsets.length ? offsets[i + 1] - start : total - start;
    let blockSize = next;
    if (i === 0) blockSize = total - start;
    else if (i === 1) blockSize = total - start;
    patchBlockHeader(out, start, { blockSize, nextBlock: next });
  }
  return out;
}

export const GimFormat = Object.freeze({
  RGBA5650: 0, RGBA5551: 1, RGBA4444: 2, RGBA8888: 3,
  INDEX4: 4, INDEX8: 5, INDEX16: 6, INDEX32: 7,
  DXT1: 8, DXT3: 9, DXT5: 10
});

export function formatName(format) { return FORMAT_NAMES[format] || `0x${Number(format).toString(16)}`; }
