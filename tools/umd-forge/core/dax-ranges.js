import { IsoReader } from './iso-reader.js';

const VIDEO_EXTENSIONS = new Set(['pmf', 'mps', 'psmf', 'mp4', 'm4v', 'avi']);
const AUDIO_EXTENSIONS = new Set(['at3', 'aa3', 'oma', 'mp3', 'wav', 'adx', 'vag', 'at9']);

function extension(path) {
  const name = String(path || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export async function deriveDaxNcRanges(isoBlob, { forceVideoNc = false, forceAudioNc = false } = {}) {
  if (!forceVideoNc && !forceAudioNc) return [];
  const source = isoBlob instanceof File ? isoBlob : new File([isoBlob], 'umd-forge-output.iso', { type: 'application/x-iso9660-image' });
  const iso = await IsoReader.open(source, { force: true });
  const ranges = [];
  for (const entry of iso.all()) {
    if (entry.isDirectory || !entry.size) continue;
    const ext = extension(entry.path);
    const forced = (forceVideoNc && VIDEO_EXTENSIONS.has(ext)) || (forceAudioNc && AUDIO_EXTENSIONS.has(ext));
    if (forced) ranges.push({ start: entry.offset, end: entry.offset + entry.size, path: entry.path });
  }
  return ranges;
}
