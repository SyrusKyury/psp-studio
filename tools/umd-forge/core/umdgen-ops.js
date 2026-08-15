import { SECTOR_SIZE } from './iso-reader.js';

function sectors(size) { return Math.ceil(Math.max(0, size) / SECTOR_SIZE); }
function currentSize(node) {
  const source = node?.linkedTo || node;
  return source?.dummy ? (source.dummySize ?? source.sourceEntry?.size ?? source.size ?? 0) : (source?.file?.size ?? source?.sourceEntry?.size ?? source?.size ?? 0);
}
function safePath(path) { return String(path || '').replace(/\\/g, '/'); }

export function exportFileList(workspace) {
  const rows = [
    '# UMD Forge file list',
    '# Compatible workflow: export before edits, import after replacements to preserve file order/LBAs.',
    '# LBA\tSECTORS\tSIZE\tPATH',
  ];
  for (const node of workspace.fileLayout()) {
    const lba = node.requestedLba ?? node.sourceEntry?.lba ?? node.lba ?? 0;
    const size = currentSize(node);
    rows.push(`${lba}\t${sectors(size)}\t${size}\t${node.path}`);
  }
  return new Blob([`${rows.join('\r\n')}\r\n`], { type: 'text/plain;charset=utf-8' });
}

export function parseFileList(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const tab = line.split('\t');
    if (tab.length >= 4 && /^\d+$/.test(tab[0])) {
      items.push({ lba: Number(tab[0]), path: safePath(tab.slice(3).join('\t').trim()) });
      continue;
    }
    // Tolerate common hand-edited UMDGen-style lists where a numeric LBA precedes a path.
    const match = line.match(/^\s*(\d+)\s+(?:\d+\s+)?(?:\d+\s+)?([\\/].+)$/);
    if (match) items.push({ lba: Number(match[1]), path: safePath(match[2].trim()) });
  }
  if (!items.length) throw new Error('No LBA/path entries were found in this file list.');
  return items;
}

export function importFileList(workspace, text) {
  const parsed = parseFileList(text);
  const valid = parsed.filter((item) => workspace.get(item.path) && !workspace.get(item.path).isDirectory);
  if (!valid.length) throw new Error('The file list does not match any file in the current image.');
  const order = valid.map((item) => item.path);
  workspace.setLayoutOrder(order);
  workspace.setRequestedLbas(valid);
  return { imported: valid.length, missing: parsed.length - valid.length };
}

export function parseUmdDataText(text) {
  const raw = String(text || '').replace(/\0+$/g, '').trim();
  const parts = raw.split('|');
  const discId = String(parts[0] || '').trim().toUpperCase();
  const copyrightHolder = String(parts[1] || '').trim().toUpperCase();
  const partition = String(parts[2] || '0001').trim() || '0001';
  const mediaType = String(parts[3] || 'G').trim() || 'G';
  return { raw, discId, copyrightHolder, partition, mediaType };
}

export async function readUmdData(workspace) {
  const node = workspace.get('/UMD_DATA.BIN');
  if (!node || node.isDirectory) return null;
  const bytes = new Uint8Array(await (await workspace.readNode(node)).slice(0, 128).arrayBuffer());
  return parseUmdDataText(new TextDecoder('ascii').decode(bytes));
}

export function createUmdDataFile({ discId, copyrightHolder, partition = '0001', mediaType = 'G' } = {}) {
  const compact = String(discId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (compact.length !== 9) throw new Error('UMD_DATA.BIN requires a valid 9-character PSP title ID.');
  const titleId = `${compact.slice(0, 4)}-${compact.slice(4, 9)}`;
  const holder = String(copyrightHolder || '').replace(/[^A-F0-9]/gi, '').toUpperCase();
  if (holder.length !== 16) throw new Error('UMD_DATA.BIN requires the original 16-character hexadecimal copyright-holder field.');
  const part = String(partition || '0001').replace(/[^0-9]/g, '').padStart(4, '0').slice(-4);
  const kind = String(mediaType || 'G').replace(/[^A-Z0-9 ]/gi, '').toUpperCase().slice(0, 2) || 'G';
  const fields = `${titleId}|${holder}|${part}|${kind}|`;
  const out = new Uint8Array(48); out.set(new TextEncoder().encode(fields).subarray(0, 48));
  return new File([out], 'UMD_DATA.BIN', { type: 'application/octet-stream', lastModified: Date.now() });
}

export function upsertUmdData(workspace, fields = {}) {
  const file = createUmdDataFile(fields);
  const existing = workspace.get('/UMD_DATA.BIN');
  if (existing && !existing.isDirectory) return workspace.replace(existing, file);
  return workspace.addFiles(workspace.root, [file])[0];
}

export function layoutRows(workspace) {
  return workspace.fileLayout().map((node, index) => {
    const source = node.linkedTo || node;
    return {
      index,
      path: node.path,
      name: node.name,
      size: currentSize(node),
      sectors: sectors(currentSize(node)),
      originalLba: node.sourceEntry?.lba ?? null,
      recordedAt: node.sourceEntry?.recordedAt ?? null,
      requestedLba: node.requestedLba ?? null,
      linkedTo: node.linkedTo?.path || null,
      dummy: Boolean(node.dummy),
      trimmed: Boolean(node.trimmed),
      modified: Boolean(node.added || node.renamed || node.file || node.linkedTo || node.dummy || node.trimmed || node.requestedLba != null),
      sourcePath: source?.path || node.path,
    };
  });
}
