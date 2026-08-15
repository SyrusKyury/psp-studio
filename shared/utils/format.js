export function safeText(value, maxLength = Infinity, fallback = '') {
  try { return String(value ?? '').slice(0, maxLength); }
  catch { return fallback; }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toFixed(index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

export function escapeHtml(value = '') {
  return safeText(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

export function errorText(error, fallback = 'Unknown error') {
  try {
    const text = String(error?.message ?? error ?? '').trim();
    return text || fallback;
  } catch { return fallback; }
}

export function isAbortError(error) {
  try { return error?.name === 'AbortError'; }
  catch { return false; }
}
