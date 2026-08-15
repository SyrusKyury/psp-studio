import { searchBlob } from '../js/core/blob-search.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
async function rejects(action, pattern, message) {
  try { await action(); }
  catch (error) { if (!pattern.test(String(error?.message || error))) throw new Error(`${message}: ${error}`); return; }
  throw new Error(`${message}: expected rejection`);
}

const utf8 = (text) => new TextEncoder().encode(text);

const boundary = await searchBlob(new Blob(['xxABCyyABCz']), utf8('ABC'), { chunkBytes: 4, limit: 20 });
assert(boundary.offsets.join(',') === '2,7', `Cross-chunk text search failed: ${boundary.offsets}`);
assert(boundary.truncated === false, 'Cross-chunk search was incorrectly marked truncated');

const overlapping = await searchBlob(new Blob(['AAAAA']), utf8('AAA'), { chunkBytes: 3, limit: 20 });
assert(overlapping.offsets.join(',') === '0,1,2', `Overlapping matches failed: ${overlapping.offsets}`);

const binary = await searchBlob(new Blob([new Uint8Array([0, 0xde, 0xad, 0xbe, 0xef, 1, 0xde, 0xad, 0xbe, 0xef])]), new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { chunkBytes: 5, limit: 20 });
assert(binary.offsets.join(',') === '1,6', `Binary search failed: ${binary.offsets}`);

const capped = await searchBlob(new Blob(['aaaaa']), utf8('a'), { chunkBytes: 4, limit: 2 });
assert(capped.offsets.join(',') === '0,1' && capped.truncated, 'Search result cap/truncation failed');

const finalChunkCapped = await searchBlob(new Blob(['aaaaa']), utf8('a'), { chunkBytes: 8, limit: 2 });
assert(finalChunkCapped.offsets.join(',') === '0,1' && finalChunkCapped.truncated, 'Final-chunk result cap was not marked truncated');

const none = await searchBlob(new Blob(['abcdef']), utf8('XYZ'), { chunkBytes: 4, limit: 20 });
assert(none.offsets.length === 0 && none.truncated === false, 'No-match search failed');

await rejects(() => searchBlob(new Blob(['abcdef']), utf8('abcd'), { chunkBytes: 3, limit: 20 }), /chunk size/, 'Search accepted a chunk smaller than its pattern');
await rejects(() => searchBlob(new Blob(['abcdef']), new Uint8Array(0)), /non-empty/, 'Search accepted an empty pattern');

console.log('Workspace search validation passed: text/hex bytes, chunk boundaries, overlapping matches and result limits');
