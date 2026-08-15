import { extensionOf } from './file-associations.js?v=0.14.5';

const ICON_BASE = new URL('../../assets/file-icons/', import.meta.url);

const EXACT_NAMES = new Map([
  ['EBOOT.BIN', 'executable'],
  ['BOOT.BIN', 'executable'],
  ['PARAM.SFO', 'metadata'],
  ['UMD_DATA.BIN', 'disc'],
  ['ICON0.PNG', 'image'],
  ['PIC0.PNG', 'image'],
  ['PIC1.PNG', 'image'],
  ['SND0.AT3', 'audio'],
  ['ICON1.PMF', 'video'],
  ['EBOOT.PBP', 'package'],
  ['PBOOT.PBP', 'package'],
  ['DATA.PSAR', 'archive'],
]);

const EXTENSIONS = new Map();

function map(kind, extensions) {
  for (const extension of extensions) EXTENSIONS.set(extension, kind);
}

map('disc', ['.iso', '.cso', '.dax', '.jso', '.zso', '.chd']);
map('patch', ['.umdpatch', '.xdelta', '.vcdiff', '.ppf']);
map('executable', ['.prx', '.elf', '.self']);
map('package', ['.pbp']);
map('resource', ['.rco', '.ptf', '.ctf']);
map('metadata', ['.sfo']);
map('binary', ['.bin', '.dat']);
map('archive', ['.pak', '.arc', '.pac', '.cpk', '.afs', '.psar']);
map('image', ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.gim', '.tm2', '.tim2', '.tga', '.dds']);
map('model', ['.gmo']);
map('audio', ['.at3', '.aa3', '.oma', '.vag', '.atx', '.adx', '.wav', '.mp3', '.ogg', '.flac']);
map('video', ['.pmf', '.mps', '.pmp', '.264', '.bsf', '.mp4', '.avi', '.mkv']);
map('text', ['.txt', '.log', '.csv']);
map('markdown', ['.md', '.markdown']);
map('code', ['.js', '.mjs', '.cjs', '.ts', '.html', '.htm', '.css', '.xml', '.py', '.c', '.cc', '.cpp', '.h', '.hpp', '.lua', '.asm', '.s']);
map('config', ['.ini', '.cfg', '.conf', '.yaml', '.yml', '.toml']);
map('archive', ['.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz']);
map('font', ['.ttf', '.otf', '.pgf']);
map('database', ['.db', '.sqlite', '.sqlite3']);

function fileIconKind(name) {
  const exact = EXACT_NAMES.get(String(name || '').toUpperCase());
  if (exact) return exact;
  return EXTENSIONS.get(extensionOf(name)) || 'file';
}

export function projectNodeIcon(node, { open = false } = {}) {
  const kind = node?.isDirectory ? (open ? 'folderOpen' : 'folder') : fileIconKind(node?.name || '');
  return new URL(kind === 'folderOpen' ? 'folder-open.svg' : `${kind}.svg`, ICON_BASE).href;
}
