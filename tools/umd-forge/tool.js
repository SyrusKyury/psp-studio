import { IsoReader } from './core/iso-reader.js';
import { UmdWorkspace } from './core/workspace.js';
import { saveImage as saveWorkspaceImage, buildWorkspaceIsoBlob } from './core/save-patched.js';
import { createUmdPatch, openUmdPatch, checkPatchCompatibility, applyUmdPatch, downloadUmdPatch } from './core/patch.js';
import { renderTree, treeStats } from './ui/tree.js';
import { renderDashboard, renderPreview, renderInspector, readGameInfo, readSfoAtPath, hexDump } from './ui/preview.js';
import { icon } from './ui/icons.js';
import { formatBytes, escapeHtml } from './lib/format.js';
import { exportFileList, importFileList, readUmdData, upsertUmdData, layoutRows } from './core/umdgen-ops.js';
import { createStoredZip } from './lib/zip-store.js';
import { parsePpf, validatePpf, applyPpf } from './core/ppf.js';
import { createBlankIso } from './core/blank-iso.js';
import { saveBlob } from './lib/download.js';

const appRoot = document.querySelector('#umd-app');
if (!(appRoot instanceof HTMLElement)) throw new Error('UMD Forge root element #umd-app was not found.');

const state = {
  container: appRoot,
  workspace: null,
  selected: null,
  gameInfo: {},
  objectUrls: new Set(),
  expanded: new Set(),
  busy: false,
  relinkSource: null,
  view: 'dashboard',
  sectorLba: 16,
  paddingMode: 'standard',
  paddingSectors: 0,
  daxOptions: { useNcAreas: true, forceVideoNc: false, forceAudioNc: false, frameCandidateSize: 8192 },
  ppfUndo: false,
};

function localToast(message, type = 'info', timeout = 3800) {
  const root = document.querySelector('#umd-local-toasts');
  if (!root) { console.info(message); return; }
  const toast = document.createElement('div');
  toast.className = `umd-local-toast ${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  window.setTimeout(() => toast.remove(), timeout);
}

const fallbackStudio = Object.freeze({
  toast: localToast,
  confirm(message) { return Promise.resolve(window.confirm(message)); },
  dirty() {},
  title(value) { if (value) document.title = value; },
});
function studio() { return window.studio || fallbackStudio; }

function welcomeMarkup() {
  return `<div class="umd-welcome">
    <section class="umd-drop-zone" id="umd-drop-zone">
      <div class="umd-welcome-content">
        <div class="umd-disc-mark">${icon('disc')}</div>
        <div class="umd-kicker">UMD Forge  |  based on UMDGen</div>
        <h1>Open a PSP UMD image</h1>
        <p>ISO, CSO and DAX are first-class: browse and edit without pre-converting, rebuild safely, preserve LBAs, apply PPF patches and export in any supported image format.</p>
        <div class="umd-welcome-actions"><button class="umd-primary-action" id="umd-welcome-open" type="button">${icon('open')} Choose image</button></div>
        <div class="umd-drop-caption">or drop an .iso, .cso or .dax file anywhere in this panel</div>
      </div>
    </section>
    <aside class="umd-welcome-side">
      <div class="umd-welcome-card"><div class="umd-welcome-card-head">${icon('folder')} Full filesystem <span class="umd-shortcut">F</span></div><p>Browse, filter, add, replace, rename and remove files without extracting the whole image.</p></div>
      <div class="umd-welcome-card"><div class="umd-welcome-card-head">${icon('drag')} Drag & drop export</div><p>Files and folders can be dragged out as reusable resources, and dropped back onto matching targets for quick replacement or import.</p></div>
      <div class="umd-welcome-card"><div class="umd-welcome-card-head">${icon('patch')} UMD patches</div><p>Create compact .umdpatch packages or apply them after source-image compatibility checks.</p></div>
      <div class="umd-welcome-card"><div class="umd-welcome-card-head">${icon('save')} Safe save strategy</div><p>Small replacements preserve the original layout; structural changes automatically switch to a full rebuild.</p></div>
    </aside>
  </div>`;
}

function workspaceMarkup() {
  return `<div class="umd-layout">
    <aside class="umd-pane umd-tree-pane">
      <div class="umd-pane-title">${icon('disc')} Disc Explorer <span class="umd-pane-title-count" id="umd-tree-count"></span></div>
      <div class="umd-search" id="umd-search-wrap"><div class="umd-search-box">${icon('search')}<input id="umd-search" type="search" placeholder="Filter files and paths...  |  Ctrl+Shift+F" autocomplete="off" spellcheck="false"><button class="umd-search-clear" id="umd-search-clear" type="button" aria-label="Clear search">${icon('close')}</button></div></div>
      <div class="umd-tree" id="umd-tree"></div>
    </aside>
    <section class="umd-pane umd-preview-pane" id="umd-preview"></section>
    <aside class="umd-pane umd-inspector-pane" id="umd-inspector"></aside>
  </div>`;
}

function setStatus(message) { const node = state.container.querySelector('#umd-status'); if (node) node.textContent = message; }
function setProgress(value = null) {
  const wrap = state.container.querySelector('#umd-progress'); if (!wrap) return;
  if (value == null) { wrap.classList.add('hidden'); wrap.querySelector('span').style.width = '0%'; }
  else { wrap.classList.remove('hidden'); wrap.querySelector('span').style.width = `${Math.max(0, Math.min(1, value)) * 100}%`; }
}
function setBusy(value) { state.busy = Boolean(value); state.container.classList.toggle('busy', state.busy); updateControls(); }
function revokePreviewUrls() { for (const url of state.objectUrls) URL.revokeObjectURL(url); state.objectUrls.clear(); }
function selectedDirectory() { if (!state.workspace) return null; if (!state.selected) return state.workspace.root; return state.selected.isDirectory ? state.selected : state.selected.parent; }
function closeMenus() { state.container.querySelector('#umd-context-menu')?.classList.remove('open'); }

function setActiveViewButton(id = null) {
  for (const selector of ['#umd-overview-view', '#umd-properties-view', '#umd-layout-view', '#umd-sector-view']) state.container.querySelector(selector)?.classList.toggle('active', selector === id);
}

function updateControls() {
  const { container, workspace, selected, busy } = state;
  const changed = workspace?.changedCount ?? 0;
  const hasWorkspace = Boolean(workspace);
  const disable = (selector, value) => { const el = container.querySelector(selector); if (el) el.disabled = Boolean(value); };
  for (const id of ['#umd-add', '#umd-folder', '#umd-import-folder', '#umd-patch-menu', '#umd-overview-view', '#umd-properties-view', '#umd-layout-view', '#umd-sector-view', '#umd-filelist-export', '#umd-filelist-import']) disable(id, !hasWorkspace || busy);
  disable('#umd-open', busy); disable('#umd-new', busy);
  disable('#umd-extract', !selected || busy);
  disable('#umd-replace', !selected || selected.isDirectory || busy);
  disable('#umd-rename', !selected || selected === workspace?.root || busy);
  disable('#umd-delete', !selected || selected === workspace?.root || busy);
  for (const id of ['#umd-save-iso', '#umd-save-cso', '#umd-save-dax']) disable(id, !workspace || busy);
  const layoutIndex = selected && !selected.isDirectory ? workspace?.layoutPosition(selected) : null;
  const layoutTotal = workspace?.fileLayout().length ?? 0;
  disable('#umd-layout-up', layoutIndex == null || layoutIndex <= 0 || busy);
  disable('#umd-layout-down', layoutIndex == null || layoutIndex >= layoutTotal - 1 || busy);
  disable('#umd-undo', !workspace?.canUndo || busy);
  disable('#umd-redo', !workspace?.canRedo || busy);

  const changes = container.querySelector('#umd-changes');
  if (changes) { changes.textContent = `${changed} ${changed === 1 ? 'edit' : 'edits'}`; changes.classList.toggle('active', changed > 0); }
  const rebuild = Boolean(workspace?.changedCount && workspace.needsFullRebuild());
  const mode = container.querySelector('#umd-save-mode');
  if (mode) { mode.textContent = !workspace ? 'idle' : !workspace.changedCount ? 'clean' : rebuild ? 'rebuild' : 'patch'; mode.classList.toggle('rebuild', rebuild); }
  container.querySelector('.umd-document-name')?.classList.toggle('dirty', Boolean(workspace?.isDirty));
  studio().dirty(Boolean(workspace?.isDirty));
  studio().title(workspace?.iso?.file?.name ? `${workspace.iso.file.name} - UMD Forge` : 'UMD Forge');
}

async function mountIso(iso, file) {
  const workspace = new UmdWorkspace(iso);
  const gameInfo = await readGameInfo(workspace);
  state.workspace = workspace; state.selected = null; state.gameInfo = gameInfo; state.relinkSource = null; state.view = 'dashboard';
  state.expanded = new Set(['/PSP_GAME', '/PSP_GAME/SYSDIR']); revokePreviewUrls();
  state.container.querySelector('#umd-body').innerHTML = workspaceMarkup();
  state.container.querySelector('#umd-file-name').textContent = `${file.name}  |  ${iso.format.toUpperCase()}`;
  state.container.querySelector('#umd-size').textContent = iso.storageSize === iso.file.size ? formatBytes(iso.file.size) : `${formatBytes(iso.storageSize)}  |  ${formatBytes(iso.file.size)} ISO`;
  bindWorkspaceEvents(); refreshTree();
  await renderDashboard(state.container.querySelector('#umd-preview'), workspace, gameInfo, state.objectUrls);
  renderInspector(state.container.querySelector('#umd-inspector'), workspace, null);
  setStatus(`${gameInfo.DISC_ID || iso.volume.volumeId || 'PSP UMD'}  |  ${iso.format.toUpperCase()}`);
  return workspace;
}

async function loadIso(file) {
  if (!file) return false;
  if (!/\.(iso|cso|dax)$/i.test(file.name || '')) throw new Error('UMD Forge accepts PSP .iso, .cso and .dax images.');
  if (state.workspace) {
    const prompt = state.workspace.isDirty ? `Open another image? Unsaved changes in ${state.workspace.iso.file.name} will be discarded.` : `Open another image and close ${state.workspace.iso.file.name}?`;
    if (!(await studio().confirm(prompt))) return false;
  }
  setBusy(true); setStatus('Opening UMD image...'); setProgress(.08);
  try {
    let iso;
    try { iso = await IsoReader.open(file); }
    catch (error) {
      if (!/CD001|Primary Volume Descriptor|descriptor sequence/i.test(error.message || '')) throw error;
      if (!(await studio().confirm(`The image is not laid out as a standard ISO 9660 disc (${error.message}).

Force-read it like UMDGen?`))) throw error;
      setStatus('Force-reading non-standard image...'); iso = await IsoReader.open(file, { force: true });
    }
    setProgress(.62); await mountIso(iso, file); setProgress(.9);
    studio().toast(`${iso.format.toUpperCase()} loaded locally.`, 'success'); return true;
  } finally { setProgress(null); setBusy(false); updateControls(); }
}

async function openIso(file, { propagate = false } = {}) {
  try { return await loadIso(file); }
  catch (error) {
    console.error(error); studio().toast(error.message || 'Could not open ISO.', 'error', 6000); setStatus('Could not open ISO');
    if (propagate) throw error;
    return false;
  }
}

function refreshTree() {
  if (!state.workspace) return;
  const tree = state.container.querySelector('#umd-tree');
  const search = state.container.querySelector('#umd-search');
  const filter = search?.value || '';
  renderTree(tree, state.workspace.root, state.workspace, filter, state.expanded);
  if (state.selected) tree.querySelector(`.umd-tree-row[data-path="${CSS.escape(state.selected.path)}"]`)?.classList.add('selected');
  const stats = treeStats(state.workspace);
  const count = state.container.querySelector('#umd-tree-count');
  if (count) count.textContent = filter ? `${tree.querySelectorAll('.umd-tree-row').length} matches` : `${stats.files} files`;
  state.container.querySelector('#umd-search-wrap')?.classList.toggle('has-value', Boolean(filter));
}

async function selectEntry(path, { focusTree = false } = {}) {
  const entry = state.workspace?.get(path); if (!entry) return;
  state.selected = entry; state.view = 'preview'; setActiveViewButton(null);
  state.container.querySelectorAll('.umd-tree-row.selected').forEach((node) => node.classList.remove('selected'));
  const row = state.container.querySelector(`.umd-tree-row[data-path="${CSS.escape(path)}"]`);
  row?.classList.add('selected');
  if (focusTree) row?.scrollIntoView({ block: 'nearest' });
  revokePreviewUrls();
  await renderPreview(state.container.querySelector('#umd-preview'), state.workspace, entry, state.objectUrls);
  renderInspector(state.container.querySelector('#umd-inspector'), state.workspace, entry);
  setStatus(entry.path);
  updateControls();
}

async function showDashboard() {
  if (!state.workspace) return;
  state.selected = null; state.view = 'dashboard'; setActiveViewButton('#umd-overview-view');
  state.container.querySelectorAll('.umd-tree-row.selected').forEach((node) => node.classList.remove('selected'));
  revokePreviewUrls();
  state.gameInfo = await readGameInfo(state.workspace);
  await renderDashboard(state.container.querySelector('#umd-preview'), state.workspace, state.gameInfo, state.objectUrls);
  renderInspector(state.container.querySelector('#umd-inspector'), state.workspace, null);
  setStatus(state.gameInfo.DISC_ID || state.workspace.iso.volume.volumeId || 'PSP ISO');
  updateControls();
}

async function refreshCurrentView() {
  if (!state.workspace) return;
  const view = state.view;
  state.gameInfo = await readGameInfo(state.workspace);
  const selectedId = state.selected?.id;
  refreshTree(); revokePreviewUrls();
  const selected = selectedId ? state.workspace.all().find((node) => node.id === selectedId) : null;
  state.selected = selected || null;
  if (view === 'properties') { await renderPropertiesView(); renderInspector(state.container.querySelector('#umd-inspector'), state.workspace, state.selected); updateControls(); return; }
  if (view === 'layout') { renderLayoutView(); renderInspector(state.container.querySelector('#umd-inspector'), state.workspace, state.selected); updateControls(); return; }
  if (view === 'sectors') { await renderSectorView(); renderInspector(state.container.querySelector('#umd-inspector'), state.workspace, state.selected); updateControls(); return; }
  if (state.selected) await selectEntry(state.selected.path, { focusTree: false });
  else await showDashboard();
}

async function downloadBlob(blob, filename) {
  return saveBlob(blob, filename);
}
function sanitizeArchiveName(name) { return String(name || 'umd').replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'umd'; }

async function extractEntry(entry) {
  if (!entry || !state.workspace || state.busy) return;
  if (!entry.isDirectory) {
    try {
      await downloadBlob(await state.workspace.readNode(entry), entry.name);
      setStatus(`Extracted ${entry.name}`);
    } catch (error) {
      if (error?.name === 'AbortError') setStatus('Extraction cancelled');
      else { console.error(error); studio().toast(error.message || 'Could not extract file.', 'error', 6500); setStatus('Extraction failed'); }
    }
    return;
  }
  setBusy(true); setStatus(`Packing ${entry.path}...`); setProgress(0);
  try {
    const prefix = entry.path === '/' ? '/' : `${entry.path}/`;
    const descendants = state.workspace.all().filter((node) => !node.isDirectory && (entry.path === '/' || node.path.startsWith(prefix)));
    if (!descendants.length) throw new Error('This directory contains no files to extract.');
    const zipEntries = [];
    for (let i = 0; i < descendants.length; i++) {
      const node = descendants[i];
      const relative = entry.path === '/' ? node.path.slice(1) : node.path.slice(prefix.length);
      zipEntries.push({ name: relative, blob: await state.workspace.readNode(node) });
      setProgress((i / Math.max(1, descendants.length)) * .18);
    }
    const blob = await createStoredZip(zipEntries, { onProgress: (value) => setProgress(.18 + value * .82) });
    const base = entry.path === '/' ? state.workspace.iso.file.name.replace(/\.(iso|cso|dax)$/i, '') : entry.name;
    await downloadBlob(blob, `${sanitizeArchiveName(base)}.zip`);
    studio().toast(`${descendants.length} files packed for extraction.`, 'success');
    setStatus(`Extracted ${entry.path}`);
  } catch (error) {
    studio().toast(error.message || 'Could not extract folder.', 'error', 6500);
    setStatus('Extraction failed');
  } finally { setProgress(null); setBusy(false); }
}
async function extractSelected() { return extractEntry(state.selected); }
async function extractWholeImage() { return state.workspace ? extractEntry(state.workspace.root) : undefined; }
async function replaceSelected(file) {
  if (!state.selected || state.selected.isDirectory || !file) return;
  state.workspace.replace(state.selected, file);
  await refreshCurrentView();
  studio().toast(state.workspace.needsFullRebuild() ? 'File replaced. Save will rebuild the ISO.' : 'File replaced in-place.', 'success', 4200);
}
async function addFiles(files) {
  const parent = selectedDirectory(); if (!parent) return;
  const list = Array.from(files || []); if (!list.length) return;
  for (const file of list) state.workspace.addFile(parent, file);
  state.expanded.add(parent.path); await refreshCurrentView();
  studio().toast(`${list.length} ${list.length === 1 ? 'file' : 'files'} added to ${parent.path}.`, 'success');
}

function duplicateName(parent, entry) {
  const original = entry.name;
  const dot = !entry.isDirectory ? original.lastIndexOf('.') : -1;
  const hasExtension = dot > 0 && dot < original.length - 1;
  const stem = hasExtension ? original.slice(0, dot) : original;
  const ext = hasExtension ? original.slice(dot) : '';
  for (let index = 1; index < 10000; index++) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!parent.children.some((child) => child.name.toUpperCase() === candidate.toUpperCase())) return candidate;
  }
  throw new Error(`Could not choose a unique duplicate name for ${original}.`);
}

async function duplicateEntry(entry = state.selected) {
  if (!state.workspace || !entry || entry === state.workspace.root || !entry.parent) return;
  const parent = entry.parent;
  const name = duplicateName(parent, entry);
  setBusy(true); setStatus(`Duplicating ${entry.name}...`);
  try {
    let duplicate;
    if (!entry.isDirectory) {
      const blob = await state.workspace.readNode(entry);
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
      duplicate = state.workspace.addFile(parent, file);
    } else {
      // Read every source file before mutating the workspace. This avoids leaving
      // a half-created directory if one source extent cannot be read.
      const snapshot = [];
      const collect = async (node, relative = '') => {
        for (const child of node.children) {
          const path = relative ? `${relative}/${child.name}` : child.name;
          if (child.isDirectory) { snapshot.push({ type: 'directory', path }); await collect(child, path); }
          else {
            const blob = await state.workspace.readNode(child);
            snapshot.push({ type: 'file', path, blob, name: child.name });
          }
        }
      };
      await collect(entry);
      duplicate = state.workspace.addDirectory(parent, name);
      const directories = new Map([['', duplicate]]);
      for (const item of snapshot) {
        const parts = item.path.split('/');
        const localName = parts.pop();
        const parentKey = parts.join('/');
        const targetParent = directories.get(parentKey);
        if (!targetParent) throw new Error(`Could not duplicate directory path: ${item.path}`);
        if (item.type === 'directory') {
          const created = state.workspace.addDirectory(targetParent, localName);
          directories.set(item.path, created);
        } else {
          state.workspace.addFile(targetParent, new File([item.blob], item.name, { type: item.blob.type || 'application/octet-stream', lastModified: Date.now() }));
        }
      }
    }
    state.selected = duplicate;
    state.expanded.add(parent.path);
    if (duplicate.isDirectory) state.expanded.add(duplicate.path);
    await refreshCurrentView();
    studio().toast(`${entry.name} duplicated as ${duplicate.name}.`, 'success');
    setStatus(`Duplicated ${entry.name}`);
  } catch (error) {
    console.error(error);
    studio().toast(error.message || 'Could not duplicate the entry.', 'error', 6500);
    setStatus('Duplicate failed');
  } finally { setBusy(false); }
}

async function importFolderFiles(files) {
  const target = selectedDirectory();
  const list = Array.from(files || []).filter((file) => file instanceof File);
  if (!target || !list.length) return;
  const created = new Map();
  let operations = 0;
  try {
    const firstParts = String(list[0].webkitRelativePath || list[0].name).split('/').filter(Boolean);
    const rootName = firstParts.length > 1 ? firstParts[0] : 'IMPORTED_FOLDER';
    let root = target.children.find((child) => child.isDirectory && child.name.toLowerCase() === rootName.toLowerCase());
    if (!root) { root = state.workspace.addDirectory(target, rootName); operations++; }
    created.set(rootName, root);
    state.expanded.add(target.path); state.expanded.add(root.path);

    for (const file of list) {
      const parts = String(file.webkitRelativePath || `${rootName}/${file.name}`).split('/').filter(Boolean);
      const relative = parts[0] === rootName ? parts.slice(1) : parts;
      let parent = root, key = rootName;
      for (const segment of relative.slice(0, -1)) {
        key += `/${segment}`;
        let dir = created.get(key) || parent.children.find((child) => child.isDirectory && child.name.toLowerCase() === segment.toLowerCase());
        if (!dir) { dir = state.workspace.addDirectory(parent, segment); operations++; }
        created.set(key, dir); parent = dir; state.expanded.add(dir.path);
      }
      const existing = parent.children.find((child) => child.name.toLowerCase() === file.name.toLowerCase());
      if (existing) throw new Error(`Cannot import folder: ${existing.path} already exists.`);
      state.workspace.addFile(parent, file); operations++;
    }
    state.selected = root; await refreshCurrentView();
    studio().toast(`Imported ${list.length} files from ${rootName}.`, 'success', 5200);
  } catch (error) {
    while (operations-- > 0) state.workspace.undo();
    await refreshCurrentView();
    studio().toast(error.message || 'Folder import failed.', 'error', 6500);
  }
}

function askText({ title, message = '', label = 'Name', value = '', submit = 'Apply' }) {
  const dialog = state.container.querySelector('#umd-dialog');
  const form = state.container.querySelector('#umd-dialog-form');
  const field = state.container.querySelector('#umd-dialog-field');
  const input = state.container.querySelector('#umd-dialog-input');
  state.container.querySelector('#umd-dialog-title').textContent = title;
  state.container.querySelector('#umd-dialog-message').textContent = message;
  state.container.querySelector('#umd-dialog-message').classList.toggle('hidden', !message);
  state.container.querySelector('#umd-dialog-label').textContent = label;
  state.container.querySelector('#umd-dialog-submit').textContent = submit;
  field.classList.remove('hidden'); input.value = value; input.required = true;
  return new Promise((resolve) => {
    const closed = () => resolve(dialog.returnValue === 'default' ? input.value : null);
    dialog.addEventListener('close', closed, { once: true });
    dialog.showModal(); requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

async function newFolder() {
  const parent = selectedDirectory(); if (!parent) return;
  const name = await askText({ title: 'New folder', message: `Create a directory inside ${parent.path}.`, label: 'Folder name', value: 'NEW_FOLDER', submit: 'Create' });
  if (!name) return;
  try { const node = state.workspace.addDirectory(parent, name); state.expanded.add(parent.path); state.selected = node; await refreshCurrentView(); }
  catch (error) { studio().toast(error.message, 'error'); }
}
async function renameSelected() {
  if (!state.selected || state.selected === state.workspace.root) return;
  const name = await askText({ title: 'Rename entry', message: state.selected.path, label: 'New name', value: state.selected.name, submit: 'Rename' });
  if (!name) return;
  try { state.workspace.rename(state.selected, name); await refreshCurrentView(); }
  catch (error) { studio().toast(error.message, 'error'); }
}
async function deleteSelected() {
  if (!state.selected || state.selected === state.workspace.root) return;
  if (!(await studio().confirm(`Delete ${state.selected.name} from this UMD image?`))) return;
  try { state.workspace.delete(state.selected); if (state.relinkSource && !state.workspace.fileLayout().includes(state.relinkSource)) state.relinkSource = null; state.selected = null; await refreshCurrentView(); studio().toast('Entry removed from the workspace.', 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}
async function moveLayout(delta) {
  if (!state.selected || state.selected.isDirectory) return;
  try {
    if (state.workspace.moveLayout(state.selected, delta)) { await refreshCurrentView(); setStatus(`Disc order updated  |  position ${state.workspace.layoutPosition(state.selected) + 1}`); }
  } catch (error) { studio().toast(error.message, 'error'); }
}


function downloadTextBlob(blob, filename) { return downloadBlob(blob, filename); }

function propertyRows(items) {
  return items.map(([label, value]) => `<div class="umd-property-row"><span>${escapeHtml(label)}</span><strong>${value == null || value === '' ? '-' : escapeHtml(String(value))}</strong></div>`).join('');
}
function editableVolumeRows(workspace) {
  const fields = [
    ['System ID', 'systemId'], ['Volume ID', 'volumeId'], ['Volume set', 'volumeSetId'],
    ['Publisher', 'publisherId'], ['Data preparer', 'dataPreparerId'], ['Application', 'applicationId'], ['Copyright file', 'copyrightFileId'],
  ];
  return fields.map(([label, field]) => `<button class="umd-property-row editable" type="button" data-volume-field="${field}" title="Edit ${escapeHtml(label)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(workspace.volumeValue(field) || '-')}</strong>${icon('rename')}</button>`).join('');
}

async function renderPropertiesView() {
  if (!state.workspace) return;
  state.view = 'properties'; setActiveViewButton('#umd-properties-view');
  const workspace = state.workspace;
  const sourceVolume = workspace.iso.volume || {};
  const volume = { ...sourceVolume, ...workspace.volumeMetadata() };
  const updateInfo = await readSfoAtPath(workspace, '/PSP_GAME/SYSDIR/UPDATE/PARAM.SFO');
  const master = await readUmdData(workspace).catch(() => null);
  const stats = treeStats(workspace);
  const relinked = workspace.fileLayout().filter((node) => node.linkedTo).length;
  const umdData = master?.raw || '';
  const standardChecks = [
    ['/PSP_GAME', 'PSP_GAME'], ['/UMD_DATA.BIN', 'UMD_DATA.BIN'], ['/PSP_GAME/PARAM.SFO', 'Game PARAM.SFO'],
    ['/PSP_GAME/SYSDIR/EBOOT.BIN', 'EBOOT.BIN'], ['/PSP_GAME/SYSDIR/BOOT.BIN', 'BOOT.BIN'], ['/PSP_GAME/SYSDIR/UPDATE', 'UPDATE'],
  ];
  const checks = standardChecks.map(([path, label]) => `<div class="umd-check-row ${workspace.get(path) ? 'ok' : 'missing'}">${icon(workspace.get(path) ? 'check' : 'warning')}<span>${escapeHtml(label)}</span><small>${workspace.get(path) ? escapeHtml(path) : 'not found'}</small></div>`).join('');
  const gameRows = Object.keys(state.gameInfo || {}).length ? propertyRows(Object.entries(state.gameInfo)) : '<div class="umd-properties-empty">Game PARAM.SFO is missing or could not be parsed.</div>';
  const updateRows = Object.keys(updateInfo).length ? propertyRows(Object.entries(updateInfo)) : '<div class="umd-properties-empty">No readable UPDATE/PARAM.SFO detected.</div>';
  const estimated = workspace.estimatedRebuiltSize();
  const masterRows = propertyRows([
    ['Disk name / ID', master?.discId || state.gameInfo.DISC_ID || '-'], ['Copyright holder', master?.copyrightHolder || '-'],
    ['Partition', master?.partition || '0001'], ['Media type', master?.mediaType || 'G'],
    ['Files', stats.files], ['Folders', Math.max(0, stats.directories - 1)], ['Relinked files', relinked], ['Compression', workspace.iso.format.toUpperCase()],
  ]);
  state.container.querySelector('#umd-preview').innerHTML = `<div class="umd-preview"><div class="umd-properties-view">
    <div class="umd-layout-head"><div><div class="umd-kicker">UMD properties</div><h2>Master disc & PSP metadata</h2><p>UMDGen-style master information, editable ISO 9660 volume fields, game metadata and firmware-update metadata.</p></div><div class="umd-layout-summary"><span>${escapeHtml(master?.discId || state.gameInfo.DISC_ID || volume.volumeId || 'Unknown disc')}</span><span>${workspace.iso.descriptors.length} descriptors</span></div></div>
    <div class="umd-properties-grid">
      <section class="umd-properties-card"><div class="umd-card-head">${icon('disc')} Master Disc Information <span class="umd-card-head-note">UMD_DATA.BIN</span></div><div class="umd-property-list">${masterRows}</div>${master ? `<div class="umd-master-actions"><button type="button" data-properties-action="disc-name">Edit disk name</button><button type="button" data-properties-action="copyright-holder">Edit copyright holder</button><button type="button" data-properties-action="umd-data">Rewrite UMD_DATA.BIN</button></div>` : '<div class="umd-property-foot">No UMD_DATA.BIN is present. Add a valid file manually if the image requires one.</div>'}</section>
      <section class="umd-properties-card"><div class="umd-card-head">${icon('disc')} ISO 9660 volume <span class="umd-card-head-note">click a field to edit</span></div><div class="umd-property-list">${propertyRows([
        ['Image format', workspace.iso.format.toUpperCase()], ['Stored size', formatBytes(workspace.iso.storageSize)], ['Logical ISO size', formatBytes(workspace.iso.file.size)],
      ])}${editableVolumeRows(workspace)}${propertyRows([['Creation date', volume.creationDate ? new Date(volume.creationDate).toISOString() : '-'], ['Volume sectors', sourceVolume.volumeSpaceSize], ['Logical block', `${sourceVolume.sectorSize || 2048} bytes`], ['PVD sector', sourceVolume.pvdSector]])}</div><div class="umd-master-actions"><button type="button" data-properties-action="creation-date">Edit creation date</button></div></section>
      <section class="umd-properties-card"><div class="umd-card-head">${icon('check')} PSP structure</div><div class="umd-check-list">${checks}</div><div class="umd-property-foot">Current source: ${formatBytes(workspace.iso.file.size)}  |  estimated compact rebuild data: ${formatBytes(estimated)}</div></section>
      <section class="umd-properties-card"><div class="umd-card-head">${icon('info')} Disc structures</div><div class="umd-property-list">${propertyRows([
        ['System area', 'LBA 0-15'], ['PVD', `LBA ${sourceVolume.pvdSector ?? '-'}`], ['Terminator', sourceVolume.descriptorTerminatorSector == null ? '-' : `LBA ${sourceVolume.descriptorTerminatorSector}`],
        ['Path table size', sourceVolume.pathTableSize == null ? '-' : `${sourceVolume.pathTableSize} bytes`], ['L path table', sourceVolume.lPathTableLba == null ? '-' : `LBA ${sourceVolume.lPathTableLba}`], ['M path table', sourceVolume.mPathTableLba == null ? '-' : `LBA ${sourceVolume.mPathTableLba}`], ['Root directory', sourceVolume.rootDirectoryLba == null ? '-' : `LBA ${sourceVolume.rootDirectoryLba}`],
      ])}</div></section>
      <section class="umd-properties-card wide"><div class="umd-card-head">${icon('info')} PSP_GAME/PARAM.SFO <span class="umd-card-head-note">read-only</span></div><div class="umd-property-list two-col">${gameRows}</div></section>
      <section class="umd-properties-card wide"><div class="umd-card-head">${icon('bolt')} UPDATE/PARAM.SFO</div><div class="umd-property-list two-col">${updateRows}</div></section>
      <section class="umd-properties-card wide"><div class="umd-card-head">${icon('file')} Raw UMD_DATA.BIN</div><div class="umd-umd-data">${umdData ? `<code>${escapeHtml(umdData)}</code>` : '<span>Not present or not readable.</span>'}</div></section>
    </div>
  </div></div>`;
  setStatus('UMD properties');
}
function sectorMaxLba() {
  if (!state.workspace) return 0;
  return Math.max(0, Math.ceil(state.workspace.iso.file.size / 2048) - 1);
}

async function renderSectorView(requestedLba = state.sectorLba) {
  if (!state.workspace) return;
  const maxLba = sectorMaxLba();
  const lba = Math.max(0, Math.min(maxLba, Math.trunc(Number(requestedLba) || 0)));
  state.sectorLba = lba; state.view = 'sectors'; setActiveViewButton('#umd-sector-view');
  const bytes = await state.workspace.iso.readSectors(lba, 1);
  const selectedLba = state.selected?.sourceEntry?.lba;
  const descriptor = state.workspace.iso.descriptors.find((item) => item.sector === lba);
  const descriptorName = descriptor ? ({ 0: 'Boot Record', 1: 'Primary Volume Descriptor', 2: 'Supplementary Volume Descriptor', 255: 'Volume Descriptor Terminator' }[descriptor.type] || `Descriptor type ${descriptor.type}`) : '';
  state.container.querySelector('#umd-preview').innerHTML = `<div class="umd-preview"><div class="umd-sector-view">
    <div class="umd-layout-head"><div><div class="umd-kicker">Sector viewer</div><h2>LBA ${lba.toLocaleString()}</h2><p>Raw 2048-byte sector from the original source image. Unsaved workspace replacements are intentionally not overlaid here.</p></div><div class="umd-layout-summary">${descriptorName ? `<span>${escapeHtml(descriptorName)}</span>` : ''}<span>${maxLba.toLocaleString()} max LBA</span></div></div>
    <div class="umd-sector-toolbar">
      <button type="button" data-sector-action="first" ${lba <= 0 ? 'disabled' : ''}>${icon('up')} First</button>
      <button type="button" data-sector-action="prev" ${lba <= 0 ? 'disabled' : ''}>${icon('chevronRight', 'flip-x')} Previous</button>
      <label>LBA <input id="umd-sector-input" type="number" min="0" max="${maxLba}" value="${lba}" inputmode="numeric"></label>
      <button type="button" data-sector-action="go">Go</button>
      <button type="button" data-sector-action="next" ${lba >= maxLba ? 'disabled' : ''}>Next ${icon('chevronRight')}</button>
      ${Number.isInteger(selectedLba) ? `<button type="button" data-sector-action="selected">${icon('file')} Selected file  |  ${selectedLba}</button>` : ''}
      <button type="button" data-sector-action="pvd">${icon('disc')} PVD  |  ${state.workspace.iso.volume.pvdSector ?? 16}</button>
    </div>
    <div class="umd-sector-meta"><span>Offset <code>0x${(lba * 2048).toString(16).toUpperCase()}</code></span><span>${bytes.length} bytes</span></div>
    <div class="umd-sector-hex"><pre>${escapeHtml(hexDump(bytes, lba * 2048))}</pre></div>
  </div></div>`;
  setStatus(`Sector LBA ${lba}`);
}

function renderLayoutView() {
  if (!state.workspace) return;
  state.view = 'layout';
  const rows = layoutRows(state.workspace);
  const locked = rows.filter((row) => row.requestedLba != null).length;
  const linked = rows.filter((row) => row.linkedTo).length;
  const dummies = rows.filter((row) => row.dummy).length;
  const preview = state.container.querySelector('#umd-preview');
  preview.innerHTML = `<div class="umd-preview"><div class="umd-layout-view">
    <div class="umd-layout-head"><div><div class="umd-kicker">Disc layout</div><h2>LBA map</h2><p>UMDGen-compatible workflow for file order, replacement space and LBA-sensitive games.</p></div><div class="umd-layout-summary"><span>${rows.length} files</span><span>${locked} locked</span><span>${linked} relinked</span><span>${dummies} dummy</span></div></div>
    <div class="umd-layout-note">${icon('info')} <span>Export the file list before editing and import it again when exact original LBAs matter. UMD Forge validates overlaps during rebuild instead of silently producing a broken image.</span></div>
    <div class="umd-disc-structures"><span>System  |  LBA 0-15</span><span>PVD  |  LBA ${state.workspace.iso.volume.pvdSector ?? '-'}</span><span>Terminator  |  ${state.workspace.iso.volume.descriptorTerminatorSector == null ? '-' : `LBA ${state.workspace.iso.volume.descriptorTerminatorSector}`}</span><span>L Path  |  ${state.workspace.iso.volume.lPathTableLba == null ? '-' : `LBA ${state.workspace.iso.volume.lPathTableLba}`}</span><span>M Path  |  ${state.workspace.iso.volume.mPathTableLba == null ? '-' : `LBA ${state.workspace.iso.volume.mPathTableLba}`}</span><span>Root  |  ${state.workspace.iso.volume.rootDirectoryLba == null ? '-' : `LBA ${state.workspace.iso.volume.rootDirectoryLba}`}</span></div>
    <div class="umd-layout-table-wrap"><table class="umd-layout-table"><thead><tr><th>#</th><th>Path</th><th>Size</th><th>Sectors</th><th>Original LBA</th><th>Locked LBA</th><th>Recorded</th><th>State</th></tr></thead><tbody>
      ${rows.map((row) => `<tr data-layout-path="${escapeHtml(row.path)}" class="${row.modified ? 'modified' : ''}"><td>${row.index + 1}</td><td class="path">${escapeHtml(row.path)}</td><td>${formatBytes(row.size)}</td><td>${row.sectors}</td><td>${row.originalLba ?? '-'}</td><td>${row.requestedLba ?? '-'}</td><td>${row.recordedAt ? escapeHtml(new Date(row.recordedAt).toLocaleString()) : '-'}</td><td>${row.linkedTo ? `-> ${escapeHtml(row.linkedTo)}` : row.dummy ? 'Dummy' : row.trimmed ? 'Trimmed' : row.modified ? 'Modified' : ''}</td></tr>`).join('')}
    </tbody></table></div>
  </div></div>`;
  setActiveViewButton('#umd-layout-view');
  setStatus(`Layout  |  ${rows.length} files`);
}

async function exportFileListAction() {
  if (!state.workspace) return;
  const stem = state.workspace.iso.file.name.replace(/\.(iso|cso|dax)$/i, '');
  try {
    await downloadTextBlob(exportFileList(state.workspace), `${stem}-filelist.txt`);
    studio().toast('File list exported with LBA positions.', 'success');
    setStatus('File list exported');
  } catch (error) {
    if (error?.name === 'AbortError') setStatus('File list export cancelled');
    else { console.error(error); studio().toast(error.message || 'Could not export file list.', 'error', 6500); setStatus('File list export failed'); }
  }
}

async function importFileListAction(file) {
  if (!state.workspace || !file) return;
  try {
    const result = importFileList(state.workspace, await file.text());
    await refreshCurrentView();
    renderLayoutView();
    studio().toast(`Imported ${result.imported} LBA entries${result.missing ? `  |  ${result.missing} unmatched` : ''}.`, result.missing ? 'warning' : 'success', 5200);
  } catch (error) { studio().toast(error.message, 'error', 6500); }
}

async function dummySelected() {
  if (!state.selected || state.selected.isDirectory) return;
  try { state.workspace.dummy(state.selected); await refreshCurrentView(); studio().toast(`${state.selected.name} dummied while preserving its logical size.`, 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}

async function zeroSelected() {
  if (!state.selected || state.selected.isDirectory) return;
  const name = state.selected.name;
  if (!(await studio().confirm(`Reduce ${name} to a zero-byte file? This is more aggressive than Dummy and can break games that expect the original contents or length.`))) return;
  try { state.workspace.truncate(state.selected); await refreshCurrentView(); studio().toast(`${name} is now zero-byte in the rebuild workspace.`, 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}

function setRelinkSource() {
  if (!state.selected || state.selected.isDirectory) return;
  state.relinkSource = state.selected;
  studio().toast(`Relink source: ${state.selected.path}`, 'info', 5000);
  setStatus(`Relink source  |  ${state.selected.path}`);
}

async function relinkSelectedToSource() {
  if (!state.selected || state.selected.isDirectory || !state.relinkSource) return;
  try {
    const target = state.selected; const source = state.relinkSource;
    state.workspace.relink(target, source);
    await refreshCurrentView();
    studio().toast(`${target.name} now shares disc data with ${source.name}.`, 'success', 5200);
  } catch (error) { studio().toast(error.message, 'error'); }
}

async function unlinkSelected() {
  if (!state.selected?.linkedTo) return;
  try { state.workspace.clearRelink(state.selected); await refreshCurrentView(); studio().toast('Relink removed.', 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}

async function editMasterDiscAction(field) {
  if (!state.workspace) return;
  const current = await readUmdData(state.workspace).catch(() => null);
  if (!current) { studio().toast('UMD_DATA.BIN is not present. Add a valid file first.', 'error'); return; }
  const base = {
    discId: current.discId,
    copyrightHolder: current.copyrightHolder,
    partition: current.partition || '0001', mediaType: current.mediaType || 'G',
  };
  if (field === 'disc-name') {
    const value = await askText({ title: 'Master disc name', message: 'UMD_DATA.BIN disc identifier, normally the PSP title ID.', label: 'Disk name / ID', value: base.discId, submit: 'Apply' });
    if (value == null) return;
    const compact = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (compact.length !== 9) { studio().toast('Disk name must contain a 9-character PSP title ID such as ULUS-12345.', 'error'); return; }
    base.discId = value;
  } else if (field === 'copyright-holder') {
    const value = await askText({ title: 'Copyright holder', message: 'Second UMD_DATA.BIN master-disc field. Use the 16 hexadecimal characters used by the original image.', label: 'Copyright holder', value: base.copyrightHolder, submit: 'Apply' });
    if (value == null) return;
    const holder = value.replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(holder)) { studio().toast('Copyright holder must be exactly 16 hexadecimal characters.', 'error'); return; }
    base.copyrightHolder = holder;
  } else return;
  try { upsertUmdData(state.workspace, base); await refreshCurrentView(); await renderPropertiesView(); studio().toast('Master disc information updated.', 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}

async function rewriteUmdDataAction() {
  if (!state.workspace) return;
  const current = await readUmdData(state.workspace).catch(() => null);
  if (!current) { studio().toast('UMD_DATA.BIN is not present. Add a valid file first.', 'error'); return; }
  try {
    upsertUmdData(state.workspace, {
      discId: current.discId,
      copyrightHolder: current.copyrightHolder,
      partition: current.partition || '0001', mediaType: current.mediaType || 'G',
    });
    await refreshCurrentView(); await renderPropertiesView(); studio().toast('UMD_DATA.BIN written in canonical master-disc format.', 'success');
  } catch (error) { studio().toast(error.message, 'error'); }
}

async function editCreationDateAction() {
  if (!state.workspace) return;
  const current = state.workspace.volumeValue('creationDate') || new Date().toISOString();
  const value = await askText({ title: 'Volume creation date', message: 'ISO 9660 Primary Volume Descriptor creation timestamp.', label: 'ISO date/time', value: current, submit: 'Apply' });
  if (value == null) return;
  try { state.workspace.setVolumeField('creationDate', value); await refreshCurrentView(); await renderPropertiesView(); studio().toast('Volume creation date updated.', 'success'); }
  catch (error) { studio().toast(error.message, 'error'); }
}

function openOptionsDialog() {
  const dialog = state.container.querySelector('#umd-options-dialog');
  dialog.returnValue = '';
  const radio = state.container.querySelector(`input[name="padding-mode"][value="${state.paddingMode}"]`); if (radio) radio.checked = true;
  state.container.querySelector('#umd-padding-sectors').value = String(state.paddingSectors);
  state.container.querySelector('#umd-dax-nc').checked = state.daxOptions.useNcAreas;
  state.container.querySelector('#umd-dax-video-nc').checked = state.daxOptions.forceVideoNc;
  state.container.querySelector('#umd-dax-audio-nc').checked = state.daxOptions.forceAudioNc;
  state.container.querySelector('#umd-dax-frame-candidate').value = String(state.daxOptions.frameCandidateSize);
  dialog.showModal();
}

function applyOptionsDialog() {
  const mode = state.container.querySelector('input[name="padding-mode"]:checked')?.value || 'none';
  const sectors = Number(state.container.querySelector('#umd-padding-sectors').value);
  const candidate = Number(state.container.querySelector('#umd-dax-frame-candidate').value);
  if (!['none', 'standard', 'custom'].includes(mode)) throw new Error('Invalid padding mode.');
  if (!Number.isInteger(sectors) || sectors < 0 || sectors > 1048576) throw new Error('Custom padding must be 0-1048576 sectors.');
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 8192) throw new Error('DAX frame candidate size must be 1-8192 bytes.');
  state.paddingMode = mode; state.paddingSectors = sectors;
  state.daxOptions = {
    useNcAreas: state.container.querySelector('#umd-dax-nc').checked,
    forceVideoNc: state.container.querySelector('#umd-dax-video-nc').checked,
    forceAudioNc: state.container.querySelector('#umd-dax-audio-nc').checked,
    frameCandidateSize: candidate,
  };
  setStatus(`Image options  |  ${mode} padding`);
}

async function saveImage(format = state.workspace?.iso?.format || 'iso') {
  if (!state.workspace || state.busy) return;
  const target = String(format).toLowerCase(); setBusy(true);
  try {
    const rebuild = state.workspace.needsFullRebuild(); setStatus(`Saving ${target.toUpperCase()}  |  ${rebuild ? 'rebuild' : 'patch'}...`); setProgress(0);
    const result = await saveWorkspaceImage(state.workspace, target, { padding: { mode: state.paddingMode, sectors: state.paddingSectors }, dax: state.daxOptions, onProgress: setProgress });
    if (state.workspace.isDirty) state.workspace.markSaved(); updateControls();
    studio().toast(`${target.toUpperCase()} saved  |  ${result.mode}.`, 'success'); setStatus(`${target.toUpperCase()} saved`);
  } catch (error) {
    if (error?.name === 'AbortError') setStatus('Save cancelled');
    else { console.error(error); studio().toast(error.message, 'error', 7000); setStatus('Save failed'); }
  } finally { setProgress(null); setBusy(false); }
}

async function newCompilation() {
  const file = createBlankIso({ volumeId: 'PSP_GAME' }); await openIso(file);
  if (state.workspace?.iso?.physicalFile === file) studio().toast('New empty UMD compilation created. Add PSP_GAME and your files, or build the layout you need.', 'success', 5200);
}

async function workspaceRawIsoBlob() {
  if (!state.workspace) throw new Error('Open an image first.');
  if (!state.workspace.isDirty) {
    if (state.workspace.iso.format === 'iso') return state.workspace.iso.physicalFile;
    return state.workspace.iso.source.materialize({ onProgress: (v) => setProgress(v * .35) });
  }
  return (await buildWorkspaceIsoBlob(state.workspace, { onProgress: (v) => setProgress(v * .45) })).blob;
}

async function applyPpfFile(file, { undo = false } = {}) {
  if (!state.workspace || !file || state.busy) return;
  if (state.workspace.isDirty && !(await studio().confirm('Apply the PPF on top of the current unsaved filesystem edits? UMD Forge will first build those edits into a raw ISO.'))) return;
  setBusy(true); setProgress(0);
  try {
    setStatus('Reading PPF...'); const patch = await parsePpf(file); setProgress(.05);
    const isoBlob = await workspaceRawIsoBlob(); const validation = await validatePpf(isoBlob, patch);
    let force = false;
    if (!validation.valid) {
      force = await studio().confirm(`PPF ${patch.version}.0 validation failed:\n\n${validation.problems.join('\n')}\n\nForce apply anyway?`);
      if (!force) { setStatus('PPF cancelled'); return; }
    }
    if (undo && !patch.undoAvailable) throw new Error('This PPF does not contain PPF3 undo data.');
    setStatus(`${undo ? 'Undoing' : 'Applying'} PPF ${patch.version}.0...`); const result = await applyPpf(isoBlob, patch, { undo, force, onProgress: (v) => setProgress(.48 + v * .45) });
    const stem = state.workspace.iso.file.name.replace(/\.(iso|cso|dax)$/i, ''); const name = `${stem}-${undo ? 'ppf-undo' : 'ppf'}.iso`;
    await downloadBlob(result.blob, name);
    const patchedFile = new File([result.blob], name, { type: 'application/x-iso9660-image' }); const patchedIso = await IsoReader.open(patchedFile, { force: true });
    await mountIso(patchedIso, patchedFile); updateControls();
    studio().toast(`PPF ${patch.version}.0 ${undo ? 'undo applied' : 'applied'}${patch.description ? `  |  ${patch.description}` : ''}. Result exported and opened.`, 'success', 6500); setStatus(`PPF ${patch.version}.0 ${undo ? 'undone' : 'applied'}`);
  } catch (error) { console.error(error); studio().toast(error.message, 'error', 7500); setStatus('PPF failed'); }
  finally { setProgress(null); setBusy(false); }
}

async function editVolumeFieldAction(field) {
  if (!state.workspace) return;
  const labels = { systemId: 'System ID', volumeId: 'Volume ID', volumeSetId: 'Volume Set ID', publisherId: 'Publisher ID', dataPreparerId: 'Data Preparer ID', applicationId: 'Application ID', copyrightFileId: 'Copyright File ID' };
  const label = labels[field]; if (!label) return;
  const value = await askText({ title: `Edit ${label}`, message: 'ISO 9660 Primary Volume Descriptor', label, value: state.workspace.volumeValue(field), submit: 'Apply' });
  if (value == null) return;
  try { if (state.workspace.setVolumeField(field, value)) { await refreshCurrentView(); studio().toast(`${label} updated.`, 'success'); } }
  catch (error) { studio().toast(error.message, 'error'); }
}

async function createPatch() {
  if (!state.workspace || state.busy) return;
  setBusy(true);
  try {
    setStatus('Creating UMD patch...'); setProgress(0);
    const result = await createUmdPatch(state.workspace, { onProgress: setProgress });
    const base = state.workspace.iso.file.name.replace(/\.(iso|cso|dax)$/i, '');
    await downloadUmdPatch(result.blob, `${base}.umdpatch`);
    studio().toast(`Patch created with ${result.manifest.operations.length} operations.`, 'success'); setStatus('UMD patch created');
  } catch (error) { studio().toast(error.message, 'error', 6000); setStatus('Patch creation failed'); }
  finally { setProgress(null); setBusy(false); }
}

async function applyPatchFile(file) {
  if (!state.workspace || !file || state.busy) return;
  setBusy(true);
  try {
    setStatus('Checking patch compatibility...'); setProgress(.1);
    const patch = await openUmdPatch(file); const check = await checkPatchCompatibility(state.workspace, patch);
    if (!check.compatible) {
      const ok = await studio().confirm(`This patch was created for a different source image.\n\nExpected: ${check.expected.volumeId || 'unknown'}  |  ${formatBytes(check.expected.size || 0)}\nCurrent: ${check.actual.volumeId || 'unknown'}  |  ${formatBytes(check.actual.size || 0)}\n\nApply anyway?`);
      if (!ok) { setStatus('Patch cancelled'); return; }
    }
    if (state.workspace.isDirty && !(await studio().confirm('Apply this patch on top of the current unsaved UMD Forge edits?'))) { setStatus('Patch cancelled'); return; }
    setProgress(.45); await applyUmdPatch(state.workspace, patch); setProgress(.88); await refreshCurrentView();
    studio().toast(`${patch.manifest.name || file.name} applied to the workspace.`, 'success'); setStatus('UMD patch applied');
  } catch (error) { console.error(error); studio().toast(`Could not apply patch: ${error.message}`, 'error', 7000); setStatus('Patch failed'); }
  finally { setProgress(null); setBusy(false); }
}

function contextMenuMarkup(entry) {
  const root = entry === state.workspace?.root;
  const file = entry && !entry.isDirectory;
  return `${entry?.isDirectory ? `<button type="button" data-context="add">${icon('filePlus')} Add file...</button><button type="button" data-context="folder">${icon('folderPlus')} New folder...</button><button type="button" data-context="extract">${icon('extract')} Extract folder as ZIP</button><div class="umd-context-sep"></div>` : ''}
    ${file ? `<button type="button" data-context="extract">${icon('extract')} Extract</button><button type="button" data-context="replace">${icon('replace')} Replace...</button><button type="button" data-context="dummy">${icon('dummy')} Dummy file</button><button type="button" data-context="zero">${icon('zero')} Zero-byte file...</button><div class="umd-context-sep"></div><button type="button" data-context="relink-source">${icon('link')} Use as relink source</button>${state.relinkSource && state.relinkSource !== entry ? `<button type="button" data-context="relink">${icon('link')} Relink to ${escapeHtml(state.relinkSource.name)}</button>` : ''}${entry.linkedTo ? `<button type="button" data-context="unlink">${icon('close')} Remove relink</button>` : ''}<div class="umd-context-sep"></div>` : ''}
    <button type="button" data-context="duplicate" ${root ? 'disabled' : ''}>${icon('copy')} Duplicate</button>
    <button type="button" data-context="rename" ${root ? 'disabled' : ''}>${icon('rename')} Rename</button>
    <button type="button" class="danger" data-context="delete" ${root ? 'disabled' : ''}>${icon('trash')} Delete</button>`;
}

function openContextMenu(event, entry) {
  const menu = state.container.querySelector('#umd-context-menu');
  menu.innerHTML = contextMenuMarkup(entry); menu.classList.add('open');
  const box = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - box.width - 6); const y = Math.min(event.clientY, window.innerHeight - box.height - 28);
  menu.style.left = `${Math.max(4, x)}px`; menu.style.top = `${Math.max(4, y)}px`;
}

function bindWorkspaceEvents() {
  const tree = state.container.querySelector('#umd-tree'); const search = state.container.querySelector('#umd-search'); const clear = state.container.querySelector('#umd-search-clear');
  tree.addEventListener('click', async (event) => {
    const row = event.target.closest('.umd-tree-row'); if (!row) return; const path = row.dataset.path;
    if (event.target.closest('[data-tree-toggle]')) { const entry = state.workspace.get(path); if (entry?.isDirectory) { state.expanded.has(path) ? state.expanded.delete(path) : state.expanded.add(path); refreshTree(); } }
    await selectEntry(path);
  });
  tree.addEventListener('dblclick', (event) => { const row = event.target.closest('.umd-tree-row'); if (!row) return; const entry = state.workspace.get(row.dataset.path); if (entry?.isDirectory) { state.expanded.has(entry.path) ? state.expanded.delete(entry.path) : state.expanded.add(entry.path); refreshTree(); } });
  tree.addEventListener('contextmenu', async (event) => { const row = event.target.closest('.umd-tree-row'); if (!row) return; event.preventDefault(); await selectEntry(row.dataset.path); openContextMenu(event, state.selected); });
  search.addEventListener('input', refreshTree);
  clear.addEventListener('click', () => { search.value = ''; refreshTree(); search.focus(); });
}

function bindStaticEvents() {
  const container = state.container;
  container.querySelectorAll('[data-command-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.commandIcon); });
  const openInput = container.querySelector('#umd-file-input'); const replaceInput = container.querySelector('#umd-replace-input'); const addInput = container.querySelector('#umd-add-input'); const folderInput = container.querySelector('#umd-folder-input'); const patchInput = container.querySelector('#umd-patch-input'); const ppfInput = container.querySelector('#umd-ppf-input'); const fileListInput = container.querySelector('#umd-filelist-input');
  container.querySelector('#umd-new').addEventListener('click', newCompilation);
  container.querySelector('#umd-open').addEventListener('click', () => openInput.click());
  openInput.addEventListener('change', () => { const [file] = openInput.files; openIso(file); openInput.value = ''; });
  container.querySelector('#umd-add').addEventListener('click', () => addInput.click());
  container.querySelector('#umd-import-folder').addEventListener('click', () => folderInput.click());
  addInput.addEventListener('change', async () => { try { await addFiles([...addInput.files]); } catch (error) { studio().toast(error.message, 'error'); } addInput.value = ''; });
  folderInput.addEventListener('change', async () => { const files = [...folderInput.files]; folderInput.value = ''; await importFolderFiles(files); });
  container.querySelector('#umd-folder').addEventListener('click', newFolder);
  container.querySelector('#umd-rename').addEventListener('click', renameSelected);
  container.querySelector('#umd-delete').addEventListener('click', deleteSelected);
  container.querySelector('#umd-extract').addEventListener('click', extractSelected);
  container.querySelector('#umd-replace').addEventListener('click', () => replaceInput.click());
  replaceInput.addEventListener('change', async () => { const [file] = replaceInput.files; try { await replaceSelected(file); } catch (error) { studio().toast(error.message, 'error'); } replaceInput.value = ''; });
  container.querySelector('#umd-options').addEventListener('click', openOptionsDialog);
  container.querySelector('#umd-overview-view').addEventListener('click', showDashboard);
  container.querySelector('#umd-properties-view').addEventListener('click', renderPropertiesView);
  container.querySelector('#umd-layout-view').addEventListener('click', renderLayoutView);
  container.querySelector('#umd-sector-view').addEventListener('click', () => renderSectorView(state.selected?.sourceEntry?.lba ?? state.sectorLba));
  container.querySelector('#umd-filelist-export').addEventListener('click', exportFileListAction);
  container.querySelector('#umd-filelist-import').addEventListener('click', () => fileListInput.click());
  fileListInput.addEventListener('change', async () => { const [file] = fileListInput.files; await importFileListAction(file); fileListInput.value = ''; });
  container.querySelector('#umd-layout-up').addEventListener('click', () => moveLayout(-1));
  container.querySelector('#umd-layout-down').addEventListener('click', () => moveLayout(1));
  container.querySelector('#umd-undo').addEventListener('click', async () => { if (state.workspace?.undo()) await refreshCurrentView(); });
  container.querySelector('#umd-redo').addEventListener('click', async () => { if (state.workspace?.redo()) await refreshCurrentView(); });
  container.querySelector('#umd-save-iso').addEventListener('click', () => saveImage('iso'));
  container.querySelector('#umd-save-cso').addEventListener('click', () => saveImage('cso'));
  container.querySelector('#umd-save-dax').addEventListener('click', () => saveImage('dax'));

  const optionsDialog = container.querySelector('#umd-options-dialog');
  optionsDialog.addEventListener('close', () => { if (optionsDialog.returnValue !== 'default') return; try { applyOptionsDialog(); } catch (error) { studio().toast(error.message, 'error'); } });

  const patchDialog = container.querySelector('#umd-patch-dialog'); const patchButton = container.querySelector('#umd-patch-menu');
  patchButton.addEventListener('click', () => { if (!state.workspace || state.busy) return; patchDialog.showModal(); });
  patchDialog.addEventListener('click', (event) => {
    const action = event.target.closest('[data-patch-action]')?.dataset.patchAction;
    if (!action) return;
    patchDialog.close();
    if (action === 'create') { void createPatch(); return; }
    if (action === 'apply') { patchInput.click(); return; }
    if (action === 'ppf' || action === 'ppf-undo') { state.ppfUndo = action === 'ppf-undo'; ppfInput.click(); }
  });
  patchInput.addEventListener('change', () => { const [file] = patchInput.files; applyPatchFile(file); patchInput.value = ''; });
  ppfInput.addEventListener('change', () => { const [file] = ppfInput.files; const undo = state.ppfUndo; state.ppfUndo = false; applyPpfFile(file, { undo }); ppfInput.value = ''; });

  const body = container.querySelector('#umd-body');
  body.addEventListener('click', async (event) => {
    if (event.target.closest('#umd-welcome-open')) { openInput.click(); return; }
    const rowActionButton = event.target.closest('[data-row-action]');
    if (rowActionButton) {
      const entry = state.workspace?.get(rowActionButton.dataset.rowPath);
      if (!entry) return;
      event.preventDefault(); event.stopPropagation(); state.selected = entry;
      const action = rowActionButton.dataset.rowAction;
      if (action === 'duplicate') await duplicateEntry(entry);
      else if (action === 'rename') await renameSelected();
      else if (action === 'delete') await deleteSelected();
      return;
    }
    const quick = event.target.closest('[data-open-path]'); if (quick?.dataset.openPath) { await selectEntry(quick.dataset.openPath, { focusTree: true }); return; }
    const previewAction = event.target.closest('[data-preview-action]')?.dataset.previewAction;
    if (previewAction === 'up') {
      const parent = state.selected?.parent;
      if (parent) await selectEntry(parent.path, { focusTree: true });
      return;
    }
    const volumeField = event.target.closest('[data-volume-field]')?.dataset.volumeField; if (volumeField) { await editVolumeFieldAction(volumeField); return; }
    const propertiesAction = event.target.closest('[data-properties-action]')?.dataset.propertiesAction;
    if (propertiesAction === 'disc-name' || propertiesAction === 'copyright-holder') { await editMasterDiscAction(propertiesAction); return; }
    if (propertiesAction === 'umd-data') { await rewriteUmdDataAction(); return; }
    if (propertiesAction === 'creation-date') { await editCreationDateAction(); return; }
    const sectorAction = event.target.closest('[data-sector-action]')?.dataset.sectorAction;
    if (sectorAction) {
      const input = state.container.querySelector('#umd-sector-input');
      if (sectorAction === 'first') await renderSectorView(0);
      else if (sectorAction === 'prev') await renderSectorView(state.sectorLba - 1);
      else if (sectorAction === 'next') await renderSectorView(state.sectorLba + 1);
      else if (sectorAction === 'go') await renderSectorView(input?.value ?? state.sectorLba);
      else if (sectorAction === 'selected') await renderSectorView(state.selected?.sourceEntry?.lba ?? state.sectorLba);
      else if (sectorAction === 'pvd') await renderSectorView(state.workspace?.iso?.volume?.pvdSector ?? 16);
      return;
    }
    const layoutRow = event.target.closest('[data-layout-path]'); if (layoutRow) { await selectEntry(layoutRow.dataset.layoutPath, { focusTree: true }); return; }
    const inspectorAction = event.target.closest('[data-inspector-action]')?.dataset.inspectorAction;
    if (inspectorAction === 'layout-up') await moveLayout(-1); else if (inspectorAction === 'layout-down') await moveLayout(1);
  });
  body.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' && event.target?.id === 'umd-sector-input') { event.preventDefault(); await renderSectorView(event.target.value); return; }
    if (event.key === 'Enter' && event.target?.matches?.('.umd-directory-row')) { event.preventDefault(); await selectEntry(event.target.dataset.openPath, { focusTree: true }); }
  });
  body.addEventListener('dragover', (event) => { const zone = event.target.closest('#umd-drop-zone'); if (!zone || !event.dataTransfer?.types?.includes('Files')) return; event.preventDefault(); zone.classList.add('dragging'); });
  body.addEventListener('dragleave', (event) => { const zone = event.target.closest('#umd-drop-zone'); if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('dragging'); });
  body.addEventListener('drop', (event) => { const zone = event.target.closest('#umd-drop-zone'); if (!zone || !event.dataTransfer?.files?.length) return; event.preventDefault(); zone.classList.remove('dragging'); openIso(event.dataTransfer.files[0]); });
  // UMDGen's Drop Open, without stealing resource drops onto data-file/data-folder targets.
  body.addEventListener('dragover', (event) => {
    if (event.target.closest('[data-file],[data-folder],#umd-drop-zone')) return;
    const file = event.dataTransfer?.files?.[0];
    if (file && /\.(iso|cso|dax)$/i.test(file.name || '')) event.preventDefault();
  });
  body.addEventListener('drop', (event) => {
    if (event.target.closest('[data-file],[data-folder],#umd-drop-zone')) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file || !/\.(iso|cso|dax)$/i.test(file.name || '')) return;
    event.preventDefault(); openIso(file);
  });

  container.querySelector('#umd-context-menu').addEventListener('click', async (event) => {
    const action = event.target.closest('[data-context]')?.dataset.context; if (!action) return; closeMenus();
    if (action === 'add') addInput.click(); else if (action === 'folder') await newFolder(); else if (action === 'extract') await extractSelected(); else if (action === 'replace') replaceInput.click(); else if (action === 'dummy') await dummySelected(); else if (action === 'zero') await zeroSelected(); else if (action === 'relink-source') setRelinkSource(); else if (action === 'relink') await relinkSelectedToSource(); else if (action === 'unlink') await unlinkSelected(); else if (action === 'duplicate') await duplicateEntry(); else if (action === 'rename') await renameSelected(); else if (action === 'delete') await deleteSelected();
  });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.umd-menu') && !event.target.closest('#umd-context-menu')) closeMenus(); });
  window.addEventListener('blur', closeMenus);
  window.addEventListener('beforeunload', (event) => { if (!state.workspace?.isDirty) return; event.preventDefault(); event.returnValue = ''; });
  window.addEventListener('keydown', handleShortcuts);
}

function editableTarget(target) { return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable; }
function hasTextSelection() { return Boolean(String(globalThis.getSelection?.() || '').trim()); }
async function handleShortcuts(event) {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'o') { event.preventDefault(); state.container.querySelector('#umd-file-input').click(); return; }
  if (mod && key === 'n') { event.preventDefault(); await newCompilation(); return; }
  if (editableTarget(event.target)) return;

  // UMDGen-compatible disc workflow shortcuts. Search uses Ctrl/Cmd+Shift+F so
  // Ctrl/Cmd+F remains New Folder like the original application.
  if (mod && key === 's') { event.preventDefault(); if (state.workspace) await saveImage('iso'); return; }
  if (mod && key === 'c' && !hasTextSelection()) { event.preventDefault(); if (state.workspace) await saveImage('cso'); return; }
  if (mod && key === 'd') { event.preventDefault(); if (state.workspace) await saveImage('dax'); return; }
  if (mod && key === 'f' && event.shiftKey) { if (!state.workspace) return; event.preventDefault(); const search = state.container.querySelector('#umd-search'); search?.focus(); search?.select(); return; }
  if (mod && key === 'f') { if (!state.workspace) return; event.preventDefault(); await newFolder(); return; }
  if (mod && key === 'p') { if (!state.workspace) return; event.preventDefault(); await renderPropertiesView(); return; }
  if (mod && key === 'r') { if (!state.selected) return; event.preventDefault(); await renameSelected(); return; }
  if (mod && key === 'e') { if (!state.workspace) return; event.preventDefault(); await extractWholeImage(); return; }
  if (mod && key === 'm') { if (!state.selected || state.selected.isDirectory) return; event.preventDefault(); setRelinkSource(); return; }
  if (mod && key === 'l') { if (!state.selected || state.selected.isDirectory || !state.relinkSource) return; event.preventDefault(); await relinkSelectedToSource(); return; }
  if (mod && key === 'z' && !event.shiftKey) { event.preventDefault(); if (state.workspace?.undo()) await refreshCurrentView(); return; }
  if (mod && ((key === 'z' && event.shiftKey) || key === 'y')) { event.preventDefault(); if (state.workspace?.redo()) await refreshCurrentView(); return; }
  if (event.key === 'F2') { event.preventDefault(); await renameSelected(); return; }
  if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) { if (!state.selected) return; event.preventDefault(); await deleteSelected(); }
}


async function getResource(id) {
  const entry = state.workspace?.get(id); if (!entry) throw new Error(`Resource not found: ${id}`);
  if (!entry.isDirectory) {
    const blob = await state.workspace.readNode(entry);
    return new File([blob], entry.name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
  }
  const workspace = state.workspace; const prefix = entry.path === '/' ? '/' : `${entry.path}/`;
  return {
    async *files() {
      for (const node of workspace.all()) {
        if (node.isDirectory || !node.path.startsWith(prefix)) continue;
        const blob = await workspace.readNode(node);
        yield { path: node.path.slice(prefix.length), file: new File([blob], node.name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() }) };
      }
    },
  };
}

async function replaceResource(id, file) {
  console.debug('[UMD Forge DnD] replace()', { id, name: file?.name, size: file?.size });
  const entry = state.workspace?.get(id); if (!entry || entry.isDirectory) throw new Error('Replace target is not a file.');
  state.selected = entry; await replaceSelected(file);
}
async function addResource(id, files) {
  console.debug('[UMD Forge DnD] add()', { id, files: Array.from(files || []).map((file) => ({ name: file?.name, size: file?.size })) });
  const entry = state.workspace?.get(id); if (!entry?.isDirectory) throw new Error('Add target is not a folder.');
  state.selected = entry; await addFiles(files);
}

state.container.querySelector('#umd-body').innerHTML = welcomeMarkup();
bindStaticEvents(); updateControls();

window.tool = Object.freeze({
  open(file) { return openIso(file, { propagate: true }); },
  get: getResource,
  replace: replaceResource,
  add: addResource,
});
