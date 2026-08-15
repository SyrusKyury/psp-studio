import { escapeHtml, formatBytes } from '../lib/format.js';
import { icon } from './icons.js';

function modified(node) { return Boolean(node.added || node.renamed || node.file || node.linkedTo || node.dummy || node.trimmed || node.requestedLba != null); }
function semantics(entry) { const attr = entry.isDirectory ? 'data-folder' : 'data-file'; return `${attr}="${escapeHtml(entry.path)}"`; }
function stateLabel(entry) { if (entry.added) return '<span class="umd-tree-state" title="Added">A</span>'; if (entry.dummy) return '<span class="umd-tree-state dummy" title="Dummied">D</span>'; if (entry.trimmed) return '<span class="umd-tree-state dummy" title="Trimmed padding">T</span>'; if (entry.linkedTo) return '<span class="umd-tree-state link" title="Relinked">L</span>'; if (entry.renamed) return '<span class="umd-tree-state" title="Renamed">R</span>'; if (entry.file) return '<span class="umd-tree-state" title="Replaced">M</span>'; return ''; }

function nodeHtml(entry, expanded) {
  const isOpen = entry.isDirectory && expanded.has(entry.path);
  const toggle = entry.isDirectory ? `<span class="umd-tree-toggle ${isOpen ? 'open' : ''}" data-tree-toggle>${icon('chevronRight')}</span>` : '<span class="umd-tree-toggle"></span>';
  const fileIcon = entry.isDirectory ? icon('folder') : icon('file');
  const children = entry.isDirectory && isOpen ? `<ul>${entry.children.map((child) => nodeHtml(child, expanded)).join('')}</ul>` : '';
  return `<li data-tree-node="${escapeHtml(entry.path)}">
    <div class="umd-tree-row" ${semantics(entry)} data-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
      ${toggle}<span class="umd-tree-icon ${entry.isDirectory ? 'folder' : ''}">${fileIcon}</span>
      <span class="umd-tree-name">${escapeHtml(entry.name)}</span>${stateLabel(entry)}${modified(entry) ? '<span class="umd-tree-mod" title="Modified"></span>' : '<span></span>'}
    </div>${children}
  </li>`;
}

export function renderTree(container, root, workspace, filter = '', expanded = new Set()) {
  const query = filter.trim().toLowerCase();
  if (!query) {
    container.innerHTML = `<ul>${root.children.map((entry) => nodeHtml(entry, expanded)).join('')}</ul>`;
    return;
  }
  const matches = workspace.all().filter((entry) => entry.path !== '/' && entry.path.toLowerCase().includes(query)).slice(0, 500);
  if (!matches.length) {
    container.innerHTML = '<div class="umd-tree-empty"><strong>No matching files</strong>Try a different filename or path.</div>';
    return;
  }
  container.innerHTML = `<ul>${matches.map((entry) => `<li><div class="umd-tree-row" ${semantics(entry)} data-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
    <span class="umd-tree-toggle"></span><span class="umd-tree-icon ${entry.isDirectory ? 'folder' : ''}">${icon(entry.isDirectory ? 'folder' : 'file')}</span>
    <span class="umd-tree-name">${escapeHtml(entry.path)}</span>${stateLabel(entry)}${modified(entry) ? '<span class="umd-tree-mod"></span>' : '<span></span>'}
  </div></li>`).join('')}</ul>`;
}

export function treeStats(workspace) {
  let files = 0; let directories = 0; let bytes = 0;
  for (const entry of workspace.all()) {
    if (entry.isDirectory) directories++;
    else { files++; bytes += entry.file?.size ?? entry.sourceEntry?.size ?? entry.size ?? 0; }
  }
  return { files, directories, bytes, formattedBytes: formatBytes(bytes) };
}
