import { parseSfo } from '../lib/sfo.js';
import { escapeHtml, formatBytes, hex } from '../lib/format.js';
import { icon } from './icons.js';
import { treeStats } from './tree.js';

export function hexDump(bytes, baseOffset = 0) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const left = [...chunk].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ').padEnd(47, ' ');
    const right = [...chunk].map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(baseOffset + i).toString(16).padStart(8, '0').toUpperCase()}  ${left}  ${right}`);
  }
  return lines.join('\n');
}

function nodeModified(node) { return Boolean(node.added || node.renamed || node.file || node.linkedTo || node.dummy || node.trimmed || node.requestedLba != null); }
function semantic(entry) { return entry.isDirectory ? `data-folder="${escapeHtml(entry.path)}"` : `data-file="${escapeHtml(entry.path)}"`; }
function currentSize(entry) { if (entry.isDirectory) return entry.children.length; const source = entry.linkedTo || entry; return source.dummy ? (source.dummySize ?? source.sourceEntry?.size ?? source.size ?? 0) : (source.file?.size ?? source.sourceEntry?.size ?? source.size ?? 0); }
function modifiedBadge(entry) { return nodeModified(entry) ? `<span class="umd-modified-badge">${icon('bolt')} Modified</span>` : ''; }
function transferChip(entry) { return `<div class="umd-transfer-chip" ${semantic(entry)} title="Drag to export this ${entry.isDirectory ? 'folder' : 'file'}">${icon('drag')}<strong>Drag to export</strong></div>`; }
function previewHeader(entry) {
  const back = entry.parent ? `<button class="umd-mini-button umd-preview-back" type="button" data-preview-action="up" title="Back to ${escapeHtml(entry.parent.path)}">${icon('chevronLeft')} Back to folder</button>` : '';
  return `<div class="umd-preview-head">
    <div class="umd-preview-head-icon ${entry.isDirectory ? 'folder' : ''}">${icon(entry.isDirectory ? 'folder' : 'file')}</div>
    <div class="umd-preview-head-copy"><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.path)}</p></div>
    <div class="umd-preview-head-actions">${back}${modifiedBadge(entry)}${transferChip(entry)}</div>
  </div>`;
}
async function getBlob(workspace, entry) { return workspace.readNode(entry); }

async function gameAssetUrl(workspace, path, objectUrls) {
  const entry = workspace.get(path); if (!entry || entry.isDirectory) return '';
  try { const url = URL.createObjectURL(await getBlob(workspace, entry)); objectUrls?.add(url); return url; } catch { return ''; }
}

function quickPath(workspace, path, label, hint) {
  const entry = workspace.get(path); if (!entry) return '';
  return `<button class="umd-quick-path" type="button" data-open-path="${escapeHtml(path)}">${icon(entry.isDirectory ? 'folder' : 'file')}<span>${escapeHtml(label)}</span><span>${escapeHtml(hint)}</span></button>`;
}

export async function renderDashboard(container, workspace, gameInfo = {}, objectUrls = null) {
  const stats = treeStats(workspace);
  const [iconUrl, pic0Url, pic1Url] = await Promise.all([
    gameAssetUrl(workspace, '/PSP_GAME/ICON0.PNG', objectUrls),
    gameAssetUrl(workspace, '/PSP_GAME/PIC0.PNG', objectUrls),
    gameAssetUrl(workspace, '/PSP_GAME/PIC1.PNG', objectUrls),
  ]);
  const gameIcon = iconUrl ? `<div class="umd-xmb-icon-wrap"><img class="umd-xmb-icon" src="${iconUrl}" alt="Game icon"></div>` : '';
  const pic0 = pic0Url ? `<img class="umd-xmb-pic0" src="${pic0Url}" alt="Game overlay">` : '';
  const bg = pic1Url ? ` style="--xmb-bg:url('${pic1Url}')"` : '';
  const rebuild = workspace.needsFullRebuild();
  const saveMode = rebuild ? 'Full rebuild' : 'In-place patch';
  const quick = [
    quickPath(workspace, '/PSP_GAME', 'PSP_GAME', 'Game content'),
    quickPath(workspace, '/PSP_GAME/SYSDIR', 'SYSDIR', 'Executables'),
    quickPath(workspace, '/PSP_GAME/USRDIR', 'USRDIR', 'Game data'),
    quickPath(workspace, '/PSP_GAME/PARAM.SFO', 'PARAM.SFO', 'Metadata'),
  ].filter(Boolean).join('');


  container.innerHTML = `<div class="umd-preview"><div class="umd-dashboard">
    <section class="umd-xmb-preview ${pic1Url ? 'has-background' : ''}"${bg}>
      <div class="umd-xmb-shade"></div><div class="umd-xmb-grid"></div>
      <div class="umd-xmb-content">${gameIcon}<div class="umd-xmb-copy"><div class="umd-kicker">PlayStation Portable  |  ${escapeHtml(workspace.iso.format.toUpperCase())} UMD Image</div><h2>${escapeHtml(gameInfo.TITLE || workspace.iso.file.name)}</h2><p>${escapeHtml(gameInfo.DISC_ID || workspace.iso.volume.volumeId || 'PSP ISO')}${gameInfo.DISC_VERSION ? `  |  Disc v${escapeHtml(gameInfo.DISC_VERSION)}` : ''}${gameInfo.PSP_SYSTEM_VER ? `  |  Firmware ${escapeHtml(gameInfo.PSP_SYSTEM_VER)}` : ''}</p></div>${pic0}</div>
    </section>
    <div class="umd-overview-strip">
      <div class="umd-stat"><div class="umd-stat-top">${icon('file')} Files</div><strong>${stats.files.toLocaleString()}</strong></div>
      <div class="umd-stat"><div class="umd-stat-top">${icon('folder')} Directories</div><strong>${stats.directories.toLocaleString()}</strong></div>
      <div class="umd-stat"><div class="umd-stat-top">${icon('disc')} ${workspace.iso.format === 'iso' ? 'Image size' : 'Stored / ISO'}</div><strong>${workspace.iso.storageSize === workspace.iso.file.size ? formatBytes(workspace.iso.file.size) : `${formatBytes(workspace.iso.storageSize)} / ${formatBytes(workspace.iso.file.size)}`}</strong></div>
      <div class="umd-stat"><div class="umd-stat-top">${icon(rebuild ? 'warning' : 'check')} Save strategy</div><strong>${saveMode}</strong></div>
    </div>
    <div class="umd-dashboard-grid">
      <section class="umd-panel-card"><div class="umd-card-head">${icon('folder')} Key game locations</div><div class="umd-card-body"><div class="umd-quick-paths">${quick || '<p>No standard PSP_GAME paths were detected.</p>'}</div></div></section>
      <section class="umd-panel-card"><div class="umd-card-head">${icon('bolt')} Disc mastering</div><div class="umd-card-body"><p>Relink files, preserve or import exact LBAs, inspect sectors, and rebuild with explicit padding rules. Validation rejects overlapping or impossible layouts instead of silently producing a broken image.</p>${workspace.get('/UMD_DATA.BIN') ? '<div class="umd-inline-ok">UMD_DATA.BIN detected</div>' : '<div class="umd-inline-note">UMD_DATA.BIN is not present.</div>'}</div></section>
      <section class="umd-panel-card"><div class="umd-card-head">${icon('drag')} Flexible file workflow</div><div class="umd-card-body"><p>Browse directories, preview files, drag entries out to export them, or drop files onto a matching target to replace or add content.</p></div></section>
    </div>
  </div></div>`;
}

function sfoTable(values) {
  const rows = Object.entries(values).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('');
  return `<div class="umd-readonly-note">${icon('info')}<span>This PARAM.SFO view is read-only. UMD Forge treats metadata files as ordinary disc files: replace the complete file if you need different contents.</span></div><table class="umd-sfo-table"><tbody>${rows}</tbody></table>`;
}

function detectExecutable(bytes) {
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic === '~PSP') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = bytes.length >= 0xD4 ? view.getUint32(0xD0, true) : null;
    return `<div class="umd-file-format"><span class="umd-format-badge">PSP</span><strong>Encrypted PRX / EBOOT</strong>${tag == null ? '' : `<span class="mono">tag ${hex(tag)}</span>`}</div>`;
  }
  if (bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) return '<div class="umd-file-format"><span class="umd-format-badge">ELF</span><strong>MIPS executable</strong></div>';
  return '<div class="umd-file-format"><span class="umd-format-badge">BIN</span><strong>Binary preview</strong><span>First 1 KiB</span></div>';
}

function rowActions(child) {
  const path = escapeHtml(child.path);
  return `<span class="umd-directory-actions" aria-label="Actions for ${escapeHtml(child.name)}">
    <button type="button" data-row-action="duplicate" data-row-path="${path}" title="Duplicate" aria-label="Duplicate ${escapeHtml(child.name)}">${icon('copy')}</button>
    <button type="button" data-row-action="rename" data-row-path="${path}" title="Rename" aria-label="Rename ${escapeHtml(child.name)}">${icon('rename')}</button>
    <button type="button" class="danger" data-row-action="delete" data-row-path="${path}" title="Delete" aria-label="Delete ${escapeHtml(child.name)}">${icon('trash')}</button>
  </span>`;
}

function directoryContent(entry) {
  const semanticFolder = `data-folder="${escapeHtml(entry.path)}"`;
  if (!entry.children.length) return `<div class="umd-directory-list umd-directory-list-empty" ${semanticFolder}><div class="umd-tree-empty"><strong>Empty directory</strong>Drop a file here or use Add.</div></div>`;
  return `<div class="umd-directory-list" ${semanticFolder}>${entry.children.map((child) => `<div class="umd-directory-row ${child.isDirectory ? 'folder' : ''}" role="button" tabindex="0" data-open-path="${escapeHtml(child.path)}" ${semantic(child)}>${icon(child.isDirectory ? 'folder' : 'file')}<span class="umd-directory-name">${escapeHtml(child.name)}</span><small>${child.isDirectory ? `${child.children.length} items` : formatBytes(currentSize(child))}</small>${rowActions(child)}</div>`).join('')}<div class="umd-directory-drop-hint">${icon('filePlus')} Drop files here to add them to ${escapeHtml(entry.path)}</div></div>`;
}

export async function renderPreview(container, workspace, entry, objectUrls) {
  if (!entry) return;
  if (entry.isDirectory) {
    container.innerHTML = `<div class="umd-preview"><div class="umd-preview-card">${previewHeader(entry)}<div class="umd-preview-content">${directoryContent(entry)}</div></div></div>`;
    return;
  }
  const lower = entry.name.toLowerCase();
  const blob = await getBlob(workspace, entry);
  let content = '';
  if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(lower)) {
    const url = URL.createObjectURL(blob); objectUrls.add(url);
    content = `<div class="umd-image-preview"><img src="${url}" alt="${escapeHtml(entry.name)}"></div>`;
  } else if (lower === 'param.sfo') {
    try { content = sfoTable(parseSfo(await blob.arrayBuffer())); }
    catch (error) { content = `<div class="umd-content-pad">Could not parse PARAM.SFO: ${escapeHtml(error.message)}</div>`; }
  } else if (/\.(txt|ini|cfg|xml|json|lua|csv|log|md)$/i.test(lower) && blob.size < 2 * 1024 * 1024) {
    content = `<pre class="umd-text-preview">${escapeHtml((await blob.text()).slice(0, 300000))}</pre>`;
  } else {
    const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    content = `${detectExecutable(bytes)}<div class="umd-hex-wrap"><pre class="umd-hex">${hexDump(bytes)}</pre></div>`;
  }
  container.innerHTML = `<div class="umd-preview"><div class="umd-preview-card">${previewHeader(entry)}<div class="umd-preview-content">${content}</div></div></div>`;
}

export async function readSfoAtPath(workspace, path) {
  const entry = workspace.get(path);
  if (!entry || entry.isDirectory) return {};
  try { return parseSfo(await (await workspace.readNode(entry)).arrayBuffer()); } catch { return {}; }
}

export async function readGameInfo(workspace) {
  return readSfoAtPath(workspace, '/PSP_GAME/PARAM.SFO');
}

export function renderInspector(container, workspace, entry) {
  if (!entry) {
    container.innerHTML = `<div class="umd-pane-title">${icon('info')} Inspector</div><div class="umd-inspector"><div class="umd-inspector-empty">${icon('info')}Select a file or directory to inspect its ISO properties.</div></div>`;
    return;
  }
  const size = currentSize(entry);
  const layoutIndex = entry.isDirectory ? null : workspace.layoutPosition(entry);
  const total = workspace.fileLayout().length;
  const transfer = `<div class="umd-transfer-card" ${semantic(entry)} title="Drag to export"><div class="umd-transfer-card-head">${icon('drag')} Drag to export ${icon('chevronRight')}</div><p>Export this ${entry.isDirectory ? 'folder and its contents' : 'file'} as a drag-and-drop resource.</p></div>`;
  const badges = [entry.added ? 'Added' : '', entry.file && !entry.dummy ? 'Replaced' : '', entry.renamed ? 'Renamed' : '', entry.dummy ? 'Dummy' : '', entry.trimmed ? 'Trimmed' : '', entry.linkedTo ? 'Relinked' : '', entry.requestedLba != null ? 'LBA locked' : ''].filter(Boolean);
  container.innerHTML = `<div class="umd-pane-title">${icon('info')} Inspector</div><div class="umd-inspector">
    ${transfer}
    <div class="umd-inspector-group"><div class="umd-inspector-group-title">Identity</div><dl>
      <div class="umd-inspector-row"><dt>Name</dt><dd>${escapeHtml(entry.name)}</dd></div>
      <div class="umd-inspector-row"><dt>Type</dt><dd>${entry.isDirectory ? 'Directory' : 'File'}</dd></div>
      <div class="umd-inspector-row"><dt>Path</dt><dd>${escapeHtml(entry.path)}</dd></div>
    </dl>${badges.length ? `<div class="umd-inspector-badges">${badges.map((b) => `<span class="umd-inspector-badge">${b}</span>`).join('')}</div>` : ''}</div>
    <div class="umd-inspector-group"><div class="umd-inspector-group-title">Disc properties</div><dl>
      <div class="umd-inspector-row"><dt>${entry.isDirectory ? 'Entries' : 'Size'}</dt><dd>${entry.isDirectory ? size : formatBytes(size)}</dd></div>
      ${entry.sourceEntry ? `<div class="umd-inspector-row"><dt>Original LBA</dt><dd>${entry.sourceEntry.lba ?? '-'}</dd></div><div class="umd-inspector-row"><dt>Offset</dt><dd>${entry.sourceEntry.offset == null ? '-' : hex(entry.sourceEntry.offset)}</dd></div>${entry.sourceEntry.recordedAt ? `<div class="umd-inspector-row"><dt>Recorded</dt><dd>${escapeHtml(new Date(entry.sourceEntry.recordedAt).toLocaleString())}</dd></div>` : ''}` : ''}
      ${entry.requestedLba != null ? `<div class="umd-inspector-row"><dt>Locked LBA</dt><dd>${entry.requestedLba}</dd></div>` : ''}
      ${entry.linkedTo ? `<div class="umd-inspector-row"><dt>Relink source</dt><dd>${escapeHtml(entry.linkedTo.path)}</dd></div>` : ''}
      ${layoutIndex == null ? '' : `<div class="umd-inspector-row"><dt>Disc order</dt><dd>${layoutIndex + 1} / ${total}</dd></div>`}
    </dl>${layoutIndex == null ? '' : `<div class="umd-layout-controls"><button class="umd-mini-button" type="button" data-inspector-action="layout-up" ${layoutIndex <= 0 ? 'disabled' : ''}>${icon('up')} Earlier</button><button class="umd-mini-button" type="button" data-inspector-action="layout-down" ${layoutIndex >= total - 1 ? 'disabled' : ''}>${icon('down')} Later</button></div>`}</div>
  </div>`;
}
