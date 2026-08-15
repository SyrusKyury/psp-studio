// Cross-realm Blob/File helpers. Tool API v1 uses the Web API shape rather
// than `instanceof`, because iframe Blob/File constructors belong to another
// realm. Conversion still verifies the resulting byte length so malformed
// blob-like objects cannot silently become stringified data.

export function isBlobLike(value) {
  try {
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof value.size === 'number' &&
      Number.isFinite(value.size) &&
      value.size >= 0 &&
      typeof value.slice === 'function' &&
      typeof value.arrayBuffer === 'function'
    );
  } catch { return false; }
}

export function isFileLike(value) {
  try { return isBlobLike(value) && typeof value.name === 'string' && value.name.length > 0; }
  catch { return false; }
}

function hasBlobBrand(value) {
  try { globalThis.Blob.prototype.slice.call(value, 0, 0); return true; }
  catch { return false; }
}

export function toRealmBlob(value, realm) {
  if (!isBlobLike(value) || !hasBlobBrand(value) || !realm?.Blob) return null;
  try {
    if (value instanceof realm.Blob) return value;
    const blob = new realm.Blob([value], { type: typeof value.type === 'string' ? value.type : 'application/octet-stream' });
    return blob.size === value.size ? blob : null;
  } catch { return null; }
}

export function toRealmFile(value, fallbackName = 'file.bin', realm) {
  if (!isBlobLike(value) || !hasBlobBrand(value) || !realm?.File) return null;
  try {
    if (value instanceof realm.File) return value;
    const file = new realm.File([value], isFileLike(value) ? value.name : fallbackName, {
      type: typeof value.type === 'string' ? value.type : 'application/octet-stream',
      lastModified: typeof value.lastModified === 'number' ? value.lastModified : Date.now(),
    });
    return file.size === value.size ? file : null;
  } catch { return null; }
}
