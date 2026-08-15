import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decryptExecutable, inspectExecutable, outputElfName } from '../tools/eboot-decrypter/psp-executable.js';

function makeElf(size = 96) {
  const bytes = new Uint8Array(size);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0);
  for (let i = 8; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  return bytes;
}

function makePsp({ payloadSize = 0x300, elfSize = 0x180, gzip = false, moduleName = 'TEST_MODULE', tag = 0x12345678 } = {}) {
  const bytes = new Uint8Array(payloadSize);
  bytes.set([0x7e, 0x50, 0x53, 0x50], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(0x06, gzip ? 1 : 0, true);
  const name = new TextEncoder().encode(moduleName);
  bytes.set(name.subarray(0, 27), 0x0a);
  view.setUint32(0x28, elfSize, true);
  view.setUint32(0x2c, payloadSize, true);
  view.setUint32(0xd0, tag, true);
  return bytes;
}

assert.equal(outputElfName('EBOOT.BIN'), 'EBOOT.elf');
assert.equal(outputElfName('module.prx'), 'module.elf');

const psp = makePsp();
const info = inspectExecutable(psp);
assert.equal(info.kind, 'psp');
assert.equal(info.moduleName, 'TEST_MODULE');
assert.equal(info.pspSize, 0x300);
assert.equal(info.elfSize, 0x180);
assert.equal(info.isGzip, false);
assert.equal(info.tagText, '0x12345678');

const elf = makeElf();
let decryptCalled = false;
const already = await decryptExecutable(elf, async () => { decryptCalled = true; return { code: -1, bytes: null }; });
assert.equal(decryptCalled, false);
assert.deepEqual(already.bytes, elf);
assert.equal(already.alreadyElf, true);

const encrypted = makePsp({ elfSize: elf.length });
const normal = await decryptExecutable(encrypted, async () => ({ code: elf.length, bytes: elf.slice() }));
assert.deepEqual(normal.bytes, elf);
assert.equal(normal.alreadyElf, false);
assert.equal(normal.usedEmbeddedElf, false);

const gzippedElf = new Uint8Array(gzipSync(elf));
const compressed = makePsp({ payloadSize: 0x500, elfSize: elf.length, gzip: true });
const gunzipped = await decryptExecutable(compressed, async () => ({ code: gzippedElf.length, bytes: gzippedElf }));
assert.deepEqual(gunzipped.bytes, elf);

const embedded = makePsp({ payloadSize: 0x150 + elf.length, elfSize: elf.length });
embedded.set(elf, 0x150);
const fallback = await decryptExecutable(embedded, async () => ({ code: -7, bytes: null }));
assert.deepEqual(fallback.bytes, elf);
assert.equal(fallback.usedEmbeddedElf, true);

assert.throws(() => inspectExecutable(new Uint8Array([1, 2, 3, 4, 5])), /Unsupported executable format/);

console.log('eboot-decrypter tests: ok');
