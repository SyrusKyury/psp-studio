function reverseBits(value, length) {
  let out = 0;
  for (let i = 0; i < length; i++) { out = (out << 1) | (value & 1); value >>>= 1; }
  return out;
}

function buildHuffman(lengths) {
  let max = 0;
  for (const len of lengths) if (len > max) max = len;
  if (!max) return { max: 0, maps: [] };
  const count = new Uint16Array(max + 1);
  for (const len of lengths) if (len) count[len]++;
  const next = new Uint32Array(max + 1);
  let code = 0;
  for (let bits = 1; bits <= max; bits++) { code = (code + count[bits - 1]) << 1; next[bits] = code; }
  const maps = Array.from({ length: max + 1 }, () => new Map());
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol];
    if (!len) continue;
    const canonical = next[len]++;
    maps[len].set(reverseBits(canonical, len), symbol);
  }
  return { max, maps };
}

const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
let fixedLit = null, fixedDist = null;
function fixedTables() {
  if (fixedLit) return [fixedLit, fixedDist];
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
  fixedLit = buildHuffman(lit);
  fixedDist = buildHuffman(new Uint8Array(32).fill(5));
  return [fixedLit, fixedDist];
}

export function inflateRawFallback(input, expectedSize = 0) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bytePos = 0, bitPos = 0;
  const readBits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (bytePos >= bytes.length) throw new Error('Unexpected end of DEFLATE stream.');
      value |= ((bytes[bytePos] >>> bitPos) & 1) << i;
      if (++bitPos === 8) { bitPos = 0; bytePos++; }
    }
    return value >>> 0;
  };
  const alignByte = () => { if (bitPos) { bitPos = 0; bytePos++; } };
  let out = new Uint8Array(Math.max(1024, expectedSize || 8192)), outPos = 0;
  const ensure = (extra) => {
    if (outPos + extra <= out.length) return;
    let size = out.length;
    while (size < outPos + extra) size *= 2;
    const next = new Uint8Array(size); next.set(out); out = next;
  };
  const writeByte = (value) => { ensure(1); out[outPos++] = value; };
  const decode = (table) => {
    if (!table.max) throw new Error('Invalid empty DEFLATE Huffman table.');
    let code = 0;
    for (let len = 1; len <= table.max; len++) {
      code |= readBits(1) << (len - 1);
      const symbol = table.maps[len].get(code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('Invalid DEFLATE Huffman code.');
  };
  const decodeBlock = (litTable, distTable) => {
    while (true) {
      const symbol = decode(litTable);
      if (symbol < 256) { writeByte(symbol); continue; }
      if (symbol === 256) return;
      if (symbol < 257 || symbol > 285) throw new Error(`Invalid DEFLATE length symbol ${symbol}.`);
      const li = symbol - 257;
      const length = LENGTH_BASE[li] + readBits(LENGTH_EXTRA[li]);
      const ds = decode(distTable);
      if (ds > 29) throw new Error(`Invalid DEFLATE distance symbol ${ds}.`);
      const distance = DIST_BASE[ds] + readBits(DIST_EXTRA[ds]);
      if (distance > outPos) throw new Error('Invalid DEFLATE back-reference distance.');
      ensure(length);
      for (let i = 0; i < length; i++) out[outPos] = out[outPos++ - distance];
    }
  };
  let final = false;
  while (!final) {
    final = Boolean(readBits(1));
    const type = readBits(2);
    if (type === 0) {
      alignByte();
      if (bytePos + 4 > bytes.length) throw new Error('Truncated DEFLATE stored block.');
      const len = bytes[bytePos] | (bytes[bytePos + 1] << 8);
      const nlen = bytes[bytePos + 2] | (bytes[bytePos + 3] << 8); bytePos += 4;
      if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error('Invalid DEFLATE stored-block length.');
      if (bytePos + len > bytes.length) throw new Error('Truncated DEFLATE stored block payload.');
      ensure(len); out.set(bytes.subarray(bytePos, bytePos + len), outPos); outPos += len; bytePos += len;
      continue;
    }
    if (type === 3) throw new Error('Reserved DEFLATE block type.');
    let litTable, distTable;
    if (type === 1) [litTable, distTable] = fixedTables();
    else {
      const hlit = readBits(5) + 257, hdist = readBits(5) + 1, hclen = readBits(4) + 4;
      const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) codeLengths[order[i]] = readBits(3);
      const codeTable = buildHuffman(codeLengths);
      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const sym = decode(codeTable);
        if (sym <= 15) lengths.push(sym);
        else if (sym === 16) {
          if (!lengths.length) throw new Error('Invalid DEFLATE repeat code.');
          const prev = lengths[lengths.length - 1], repeat = readBits(2) + 3;
          for (let i = 0; i < repeat; i++) lengths.push(prev);
        } else if (sym === 17) {
          const repeat = readBits(3) + 3; for (let i = 0; i < repeat; i++) lengths.push(0);
        } else if (sym === 18) {
          const repeat = readBits(7) + 11; for (let i = 0; i < repeat; i++) lengths.push(0);
        } else throw new Error('Invalid DEFLATE code-length symbol.');
        if (lengths.length > hlit + hdist) throw new Error('DEFLATE code-length table overflow.');
      }
      litTable = buildHuffman(lengths.slice(0, hlit));
      distTable = buildHuffman(lengths.slice(hlit));
    }
    decodeBlock(litTable, distTable);
  }
  return out.slice(0, outPos);
}
