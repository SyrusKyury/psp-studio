function skipTable(pattern) {
  const table = new Uint32Array(256);
  table.fill(pattern.length || 1);
  for (let index = 0; index < pattern.length - 1; index += 1) table[pattern[index]] = pattern.length - 1 - index;
  return table;
}

function findMatches(bytes, pattern, baseOffset, limit, table) {
  const matches = [];
  const length = pattern.length;
  if (!length || bytes.length < length || limit <= 0) return matches;
  if (length === 1) {
    for (let index = 0; index < bytes.length && matches.length < limit; index += 1) if (bytes[index] === pattern[0]) matches.push(baseOffset + index);
    return matches;
  }

  let index = 0;
  const last = length - 1;
  while (index <= bytes.length - length && matches.length < limit) {
    let cursor = last;
    while (cursor >= 0 && bytes[index + cursor] === pattern[cursor]) cursor -= 1;
    if (cursor < 0) { matches.push(baseOffset + index); index += 1; }
    else index += table[bytes[index + last]] || length;
  }
  return matches;
}

export async function searchBlob(blob, pattern, { chunkBytes = 4 * 1024 * 1024, limit = 200 } = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('Search input must be a Blob.');
  if (!(pattern instanceof Uint8Array) || !pattern.length) throw new TypeError('Search pattern must be a non-empty Uint8Array.');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < pattern.length) throw new RangeError('Search chunk size must fit the pattern.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Search match limit must be positive.');
  if (pattern.length > blob.size) return { offsets: [], truncated: false };

  const table = skipTable(pattern);
  const overlapSize = pattern.length - 1;
  let overlap = new Uint8Array(0);
  let offset = 0;
  let truncated = false;
  const offsets = [];

  while (offset < blob.size && !truncated) {
    const end = Math.min(blob.size, offset + chunkBytes);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    let bytes = chunk;
    let baseOffset = offset;
    if (overlap.length) {
      bytes = new Uint8Array(overlap.length + chunk.length);
      bytes.set(overlap);
      bytes.set(chunk, overlap.length);
      baseOffset -= overlap.length;
    }
    const found = findMatches(bytes, pattern, baseOffset, limit - offsets.length + 1, table);
    offsets.push(...found);
    offset = end;
    if (offsets.length > limit) { offsets.length = limit; truncated = true; break; }
    if (offsets.length === limit && offset < blob.size) { truncated = true; break; }
    overlap = overlapSize ? bytes.slice(Math.max(0, bytes.length - overlapSize)) : new Uint8Array(0);
  }

  return { offsets, truncated };
}
