import {
  CIP_TYPES,
  CPJ_PROFILES,
  CPM_GIM_HEADER,
  CPM_IMAGE_PAYLOAD_SIZE,
  buildArchiveBlob,
  buildArchivePlan,
  decodeSlotPayload,
  entryCompatibilityWarning,
  makeEntryName,
  makeStandaloneGimBlob,
  readArchiveIndex,
  parseEntryFilename,
  validateEntryBytes,
} from './cip.js';

const $ = (selector) => document.querySelector(selector);

const ui = {
  openBtn: $('#open-btn'),
  newBtn: $('#new-btn'),
  addBtn: $('#add-btn'),
  buildBtn: $('#build-btn'),
  testBtn: $('#test-btn'),
  infoBtn: $('#info-btn'),
  undoBtn: $('#undo-btn'),
  redoBtn: $('#redo-btn'),
  deleteSelectedBtn: $('#delete-selected-btn'),
  renameBtn: $('#rename-btn'),
  search: $('#search'),
  openInput: $('#open-input'),
  addInput: $('#add-input'),
  welcome: $('#welcome'),
  workspace: $('#workspace'),
  welcomeOpen: $('#welcome-open'),
  welcomeNew: $('#welcome-new'),
  entryBody: $('#entry-body'),
  empty: $('#empty'),
  entriesResource: $('#entries-resource'),
  archiveResource: $('#archive-resource'),
  archiveResourceName: $('#archive-resource-name'),
  resourceCount: $('#resource-count'),
  status: $('#status'),
  statusType: $('#status-type'),
  statusDirty: $('#status-dirty'),
  summaryFile: $('#summary-file'),
  summaryType: $('#summary-type'),
  summaryEntries: $('#summary-entries'),
  summaryRange: $('#summary-range'),
  summarySlot: $('#summary-slot'),
  summaryHeader: $('#summary-header'),
  profileWrap: $('#profile-wrap'),
  profile: $('#cpj-profile'),
  warningsWrap: $('#warnings-wrap'),
  warnings: $('#warnings'),
  browserNote: $('#browser-note'),
  selectionResource: $('#selection-resource'),
  selectionSummary: $('#selection-summary'),
  selectedCount: $('#selected-count'),
  selectAll: $('#select-all'),
  newDialog: $('#new-dialog'),
  newForm: $('#new-form'),
  newType: $('#new-type'),
  newProfileWrap: $('#new-profile-wrap'),
  newProfile: $('#new-profile'),
  newName: $('#new-name'),
  newCancel: $('#new-cancel'),
  renameDialog: $('#rename-dialog'),
  renameForm: $('#rename-form'),
  renameCardId: $('#rename-card-id'),
  renameAltIndex: $('#rename-alt-index'),
  renameCancel: $('#rename-cancel'),
  infoDialog: $('#info-dialog'),
  infoBody: $('#info-body'),
  infoClose: $('#info-close'),
  testDialog: $('#test-dialog'),
  testReport: $('#test-report'),
  testClose: $('#test-close'),
  tableWrap: $('.cip-table-wrap'),
};

const RENDER_BATCH = 300;
const LAZY_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const TEST_YIELD_EVERY = 24;

const state = {
  type: null,
  cpjProfile: 'standard',
  name: 'cards.cip',
  entries: [],
  header: null,
  warnings: [],
  originalFile: null,
  dirty: false,
  renderLimit: RENDER_BATCH,
  selectedKeys: new Set(),
  selectionAnchor: null,
  sortKey: 'cardId',
  sortDirection: 'asc',
  renameTargetKey: null,
  lazyCache: new Map(),
  lazyCacheBytes: 0,
  testRunId: 0,
  testRunning: false,
};

const historyState = { undo: [], redo: [], limit: 50 };


function studioCall(name, ...args) {
  try {
    return window.studio?.[name]?.(...args);
  } catch {
    return undefined;
  }
}


async function confirmCompatibilityWarning(message) {
  if (!message) return true;
  const prompt = `Heads up: ${message}\n\nReplace anyway?`;
  return window.studio?.confirm ? await window.studio.confirm(prompt) : window.confirm(prompt);
}

function setStatus(message, kind = 'info') {
  ui.status.textContent = message;
  if (kind === 'error') studioCall('toast', message, 'error');
  else if (kind === 'success') studioCall('toast', message, 'success');
}

function setDirty(value) {
  state.dirty = Boolean(value);
  ui.statusDirty.textContent = state.dirty ? 'Modified' : 'Clean';
  studioCall('dirty', state.dirty);
}

function updateTitle() {
  if (!state.type) {
    studioCall('title', '7-CIP');
    return;
  }
  studioCall('title', `${state.name} - 7-CIP`);
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  if (window.studio?.confirm) return Boolean(await window.studio.confirm('Discard the current 7-CIP changes?'));
  return window.confirm('Discard the current 7-CIP changes?');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function clearLazyCache() {
  state.lazyCache.clear();
  state.lazyCacheBytes = 0;
}

function cacheEntryBytes(key, bytes) {
  const existing = state.lazyCache.get(key);
  if (existing) state.lazyCacheBytes -= existing.byteLength;
  state.lazyCache.delete(key);
  state.lazyCache.set(key, bytes);
  state.lazyCacheBytes += bytes.byteLength;

  while (state.lazyCacheBytes > LAZY_CACHE_MAX_BYTES && state.lazyCache.size > 1) {
    const oldestKey = state.lazyCache.keys().next().value;
    const oldest = state.lazyCache.get(oldestKey);
    state.lazyCache.delete(oldestKey);
    state.lazyCacheBytes -= oldest.byteLength;
  }
}

function cachedEntryBytes(key) {
  const bytes = state.lazyCache.get(key);
  if (!bytes) return null;
  state.lazyCache.delete(key);
  state.lazyCache.set(key, bytes);
  return bytes;
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cloneEntry(entry) {
  return { ...entry };
}

function snapshotState(label = '') {
  return {
    label,
    type: state.type,
    cpjProfile: state.cpjProfile,
    name: state.name,
    entries: state.entries.map(cloneEntry),
    header: state.header ? { ...state.header } : null,
    warnings: [...state.warnings],
    originalFile: state.originalFile,
    dirty: state.dirty,
    selectedKeys: new Set(state.selectedKeys),
    selectionAnchor: state.selectionAnchor,
  };
}

function restoreSnapshot(snapshot) {
  state.type = snapshot.type;
  state.cpjProfile = snapshot.cpjProfile;
  state.name = snapshot.name;
  state.entries = snapshot.entries.map(cloneEntry);
  state.header = snapshot.header ? { ...snapshot.header } : null;
  state.warnings = [...snapshot.warnings];
  state.originalFile = snapshot.originalFile;
  clearLazyCache();
  state.selectedKeys = new Set(snapshot.selectedKeys);
  state.selectionAnchor = snapshot.selectionAnchor;
  ui.search.value = '';
  setDirty(snapshot.dirty);
  render();
}

function clearHistory() {
  historyState.undo.length = 0;
  historyState.redo.length = 0;
  updateHistoryControls();
}

function pushHistory(label) {
  historyState.undo.push(snapshotState(label));
  if (historyState.undo.length > historyState.limit) historyState.undo.shift();
  historyState.redo.length = 0;
  updateHistoryControls();
}

function undo() {
  const snapshot = historyState.undo.pop();
  if (!snapshot) return;
  historyState.redo.push(snapshotState(snapshot.label));
  restoreSnapshot(snapshot);
  setStatus(`Undo: ${snapshot.label || 'change'}.`, 'success');
  updateHistoryControls();
}

function redo() {
  const snapshot = historyState.redo.pop();
  if (!snapshot) return;
  historyState.undo.push(snapshotState(snapshot.label));
  restoreSnapshot(snapshot);
  setStatus(`Redo: ${snapshot.label || 'change'}.`, 'success');
  updateHistoryControls();
}

function updateHistoryControls() {
  if (!ui.undoBtn) return;
  ui.undoBtn.disabled = historyState.undo.length === 0;
  ui.redoBtn.disabled = historyState.redo.length === 0;
  ui.undoBtn.title = historyState.undo.length ? `Undo ${historyState.undo.at(-1).label || 'change'} (Ctrl/Cmd+Z)` : 'Nothing to undo';
  ui.redoBtn.title = historyState.redo.length ? `Redo ${historyState.redo.at(-1).label || 'change'} (Ctrl/Cmd+Y)` : 'Nothing to redo';
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return 'Unavailable in this browser context';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const source = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function entryKey(entry) {
  return `${entry.cardId}:${entry.altIndex == null ? 'base' : entry.altIndex}`;
}

function entrySizeValue(entry) {
  if (entry.bytes instanceof Uint8Array) return entry.bytes.byteLength;
  if (Number.isInteger(entry.loadedSize)) return entry.loadedSize;
  if (Number.isInteger(entry.sizeHint)) return entry.sizeHint;
  if (Number.isInteger(entry.sourceSlotSize)) return entry.sourceSlotSize;
  return 0;
}

function entrySizeText(entry) {
  if (Number.isInteger(entry.exportSize)) return humanSize(entry.exportSize);
  if (entry.bytes instanceof Uint8Array) return humanSize(entry.bytes.byteLength);
  if (Number.isInteger(entry.loadedSize)) return humanSize(entry.loadedSize);
  if (Number.isInteger(entry.sizeHint)) return humanSize(entry.sizeHint);
  if (Number.isInteger(entry.sourceSlotSize)) return `<= ${humanSize(entry.sourceSlotSize)}`;
  return 'lazy';
}

function visibleEntries() {
  const filter = ui.search.value.trim().toLowerCase();
  const entries = state.entries.filter((entry) => {
    const name = makeEntryName(state.type, entry.cardId, entry.altIndex).toLowerCase();
    return !filter || name.includes(filter) || String(entry.cardId).includes(filter);
  });

  const direction = state.sortDirection === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    let result = 0;
    switch (state.sortKey) {
      case 'art':
        result = (a.altIndex ?? -1) - (b.altIndex ?? -1);
        break;
      case 'name':
        result = makeEntryName(state.type, a.cardId, a.altIndex).localeCompare(makeEntryName(state.type, b.cardId, b.altIndex), undefined, { numeric: true });
        break;
      case 'size':
        result = entrySizeValue(a) - entrySizeValue(b);
        break;
      case 'cardId':
      default:
        result = a.cardId - b.cardId;
        break;
    }
    if (result === 0) result = a.cardId - b.cardId || (a.altIndex ?? -1) - (b.altIndex ?? -1);
    return result * direction;
  });
  return entries;
}

function updateSortHeaders() {
  for (const button of document.querySelectorAll('[data-sort]')) {
    const active = button.dataset.sort === state.sortKey;
    button.classList.toggle('active', active);
    const indicator = button.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = active ? (state.sortDirection === 'asc' ? '^' : 'v') : '';
    button.closest('th')?.setAttribute('aria-sort', active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
  }
}

function setSort(key) {
  if (state.sortKey === key) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  else {
    state.sortKey = key;
    state.sortDirection = 'asc';
  }
  state.renderLimit = RENDER_BATCH;
  renderEntries();
}

function selectedEntries() {
  return state.entries.filter((entry) => state.selectedKeys.has(entryKey(entry)));
}

function exportStem() {
  const raw = String(state.name || 'cards').replace(/\.(?:cip|cpm|cpj|cpl)$/i, '');
  const safe = raw.replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '');
  return safe || 'cards';
}

function allFolderId() {
  return `${exportStem()}_extracted`;
}

function selectionFolderId() {
  return `${exportStem()}_selected`;
}

function clearSelection() {
  state.selectedKeys.clear();
  state.selectionAnchor = null;
}

function pruneSelection() {
  const valid = new Set(state.entries.map(entryKey));
  for (const key of state.selectedKeys) {
    if (!valid.has(key)) state.selectedKeys.delete(key);
  }
  if (state.selectionAnchor && !valid.has(state.selectionAnchor)) state.selectionAnchor = null;
}

function updateSelectionControls() {
  pruneSelection();
  const visible = visibleEntries();
  const visibleSelected = visible.filter((entry) => state.selectedKeys.has(entryKey(entry))).length;
  const totalSelected = state.selectedKeys.size;

  ui.selectionSummary.textContent = `${totalSelected} selected`;
  ui.selectedCount.textContent = String(totalSelected);
  ui.selectionResource.classList.toggle('empty', totalSelected === 0);
  ui.selectionResource.dataset.folder = selectionFolderId();
  ui.selectionResource.title = totalSelected
    ? `Drag ${totalSelected} selected entr${totalSelected === 1 ? 'y' : 'ies'} into the Project Explorer`
    : 'Select one or more entries first';

  ui.selectAll.disabled = visible.length === 0;
  ui.selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
  ui.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  ui.deleteSelectedBtn.disabled = totalSelected === 0;
  ui.renameBtn.disabled = totalSelected !== 1;
}

function selectEntry(entry, event, { checkbox = false } = {}) {
  const key = entryKey(entry);
  const visible = visibleEntries();
  const additive = checkbox || event.ctrlKey || event.metaKey;
  const range = event.shiftKey && state.selectionAnchor;

  if (range) {
    const keys = visible.map(entryKey);
    const anchorIndex = keys.indexOf(state.selectionAnchor);
    const currentIndex = keys.indexOf(key);
    if (anchorIndex >= 0 && currentIndex >= 0) {
      if (!additive) state.selectedKeys.clear();
      const start = Math.min(anchorIndex, currentIndex);
      const end = Math.max(anchorIndex, currentIndex);
      for (let i = start; i <= end; i += 1) state.selectedKeys.add(keys[i]);
    } else {
      if (!additive) state.selectedKeys.clear();
      state.selectedKeys.add(key);
    }
  } else if (additive) {
    if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
    else state.selectedKeys.add(key);
  } else {
    state.selectedKeys.clear();
    state.selectedKeys.add(key);
  }

  state.selectionAnchor = key;
  renderEntries();
}

function idFromResource(resourceId) {
  if (!resourceId.startsWith('entry:')) return null;
  return resourceId.slice('entry:'.length);
}

function mimeForEntry() {
  return state.type === 'CPJ' ? 'image/jpeg' : 'application/octet-stream';
}

function hasLazySource(entry) {
  return Boolean(
    state.originalFile
    && Number.isInteger(entry.sourceSlotOffset)
    && Number.isInteger(entry.sourceSlotSize)
    && entry.sourceSlotSize > 0
  );
}

async function loadEntryBytes(entry, { cache = true } = {}) {
  if (entry.bytes instanceof Uint8Array) return entry.bytes;

  const key = entryKey(entry);
  if (cache) {
    const cached = cachedEntryBytes(key);
    if (cached) return cached;
  }

  if (!hasLazySource(entry)) throw new Error(`${makeEntryName(state.type, entry.cardId, entry.altIndex)} has no source payload.`);
  const raw = new Uint8Array(await state.originalFile
    .slice(entry.sourceSlotOffset, entry.sourceSlotOffset + entry.sourceSlotSize)
    .arrayBuffer());
  const decoded = decodeSlotPayload(state.type, raw, { cpjProfile: state.cpjProfile });
  entry.loadedSize = decoded.byteLength;
  if (cache) cacheEntryBytes(key, decoded);
  return decoded;
}

async function readIndexedEntryBytes(blob, entry, type, cpjProfile) {
  const raw = new Uint8Array(await blob
    .slice(entry.sourceSlotOffset, entry.sourceSlotOffset + entry.sourceSlotSize)
    .arrayBuffer());
  return decodeSlotPayload(type, raw, { cpjProfile });
}

async function fileForEntry(entry, { cache = true } = {}) {
  const name = makeEntryName(state.type, entry.cardId, entry.altIndex);

  async function asStandaloneFile(sourceBlob) {
    if (state.type === 'CPJ') return new File([sourceBlob], name, { type: mimeForEntry() });
    const { blob, info } = await makeStandaloneGimBlob(sourceBlob);
    if (info) {
      entry.exportSize = blob.size;
      entry.gimExportMissingBytes = info.missingBytes;
      entry.gimExportTrailingBytes = info.trailingBytes;
    }
    return new File([blob], name, { type: mimeForEntry() });
  }

  if (entry.bytes instanceof Uint8Array) {
    return asStandaloneFile(new Blob([entry.bytes], { type: mimeForEntry() }));
  }

  // Keep archive payloads lazy and raw internally. GIM normalization happens only
  // at the extraction boundary, so stock CIP layout/rebuild remains byte-identical.
  if (hasLazySource(entry) && state.type !== 'CPJ') {
    const slice = state.originalFile.slice(entry.sourceSlotOffset, entry.sourceSlotOffset + entry.sourceSlotSize);
    const source = state.type === 'CPM'
      ? new Blob([CPM_GIM_HEADER, slice.slice(0, CPM_IMAGE_PAYLOAD_SIZE)], { type: mimeForEntry() })
      : slice;
    return asStandaloneFile(source);
  }

  const bytes = await loadEntryBytes(entry, { cache });
  return asStandaloneFile(new Blob([bytes], { type: mimeForEntry() }));
}

function currentArchiveName() {
  const trimmed = String(state.name || '').trim() || 'cards.cip';
  return /\.(?:cip|cpm|cpj|cpl)$/i.test(trimmed) ? trimmed : `${trimmed}.cip`;
}

async function buildCurrent() {
  if (!state.type) throw new Error('No archive is open.');
  if (!state.entries.length) throw new Error('Add at least one entry before building an archive.');

  // An untouched archive is already the best possible build: return the source
  // Blob directly instead of allocating/copying hundreds of megabytes.
  if (!state.dirty && state.originalFile) {
    state.header = state.header || (await readArchiveIndex(state.originalFile, { cpjProfile: state.cpjProfile })).header;
    return new File([state.originalFile], currentArchiveName(), { type: 'application/octet-stream' });
  }

  const result = await buildArchiveBlob({
    type: state.type,
    cpjProfile: state.cpjProfile,
    entries: state.entries,
    sourceBlob: state.originalFile,
    yieldEvery: 128,
  });
  state.header = result.info;
  return new File([result.blob], currentArchiveName(), { type: 'application/octet-stream' });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderWarnings() {
  ui.warnings.replaceChildren();
  ui.warningsWrap.classList.toggle('hidden', state.warnings.length === 0);
  for (const warning of state.warnings) {
    const line = document.createElement('div');
    line.textContent = warning;
    ui.warnings.append(line);
  }
}

function rangeText() {
  if (!state.entries.length) return '-';
  const ids = state.entries.map((entry) => entry.cardId);
  return `${Math.min(...ids)} - ${Math.max(...ids)}`;
}

function renderSummary() {
  ui.summaryFile.textContent = state.name || '-';
  ui.summaryType.textContent = state.type ? CIP_TYPES[state.type].label : '-';
  ui.summaryEntries.textContent = String(state.entries.length);
  ui.summaryRange.textContent = rangeText();
  ui.summarySlot.textContent = state.header?.slotSize ? `${humanSize(state.header.slotSize)} (${state.header.bitshiftSize} x 0x800)` : 'Calculated on build';
  ui.summaryHeader.textContent = state.header?.headerSize ? `0x${state.header.headerSize.toString(16).toUpperCase()}` : 'Calculated on build';
  ui.profileWrap.classList.toggle('hidden', state.type !== 'CPJ');
  ui.profile.value = state.cpjProfile;
  ui.statusType.textContent = state.type ? state.type : 'No archive';
  ui.browserNote.textContent = state.type === 'CPJ'
    ? `CPJ profile: ${CPJ_PROFILES[state.cpjProfile].label}. Payloads are decoded on demand. Select entries, then drag Selected or All entries to the Project Explorer.`
    : 'Payloads are loaded on demand. Select entries, then drag Selected or All entries to the Project Explorer.';
  renderWarnings();
}

function rowForEntry(entry) {
  const tr = document.createElement('tr');
  const key = entryKey(entry);
  const selected = state.selectedKeys.has(key);
  tr.className = `cip-entry${selected ? ' selected' : ''}`;
  tr.dataset.file = `entry:${key}`;
  tr.title = selected && state.selectedKeys.size > 1
    ? 'Selected. Drag the Selected resource above to export the whole selection.'
    : 'Drag to extract. Drop a compatible file here to replace this entry.';
  tr.setAttribute('aria-selected', selected ? 'true' : 'false');
  tr.addEventListener('click', (event) => {
    if (event.target.closest('button, input')) return;
    selectEntry(entry, event);
  });

  const select = document.createElement('td');
  select.className = 'entry-select';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'cip-check';
  checkbox.checked = selected;
  checkbox.setAttribute('aria-label', `Select ${makeEntryName(state.type, entry.cardId, entry.altIndex)}`);
  checkbox.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectEntry(entry, event, { checkbox: true });
  });
  select.append(checkbox);

  const id = document.createElement('td');
  id.className = 'entry-id';
  id.textContent = String(entry.cardId);

  const art = document.createElement('td');
  art.className = 'entry-art';
  art.textContent = entry.altIndex == null ? 'base' : `alt ${entry.altIndex}`;

  const name = document.createElement('td');
  name.className = 'entry-name';
  name.textContent = makeEntryName(state.type, entry.cardId, entry.altIndex);

  const size = document.createElement('td');
  size.className = 'entry-size';
  size.textContent = entrySizeText(entry);
  if (!(entry.bytes instanceof Uint8Array) && entry.loadedSize == null) size.title = 'Loaded on demand';

  const actions = document.createElement('td');
  actions.className = 'entry-actions';

  const download = document.createElement('button');
  download.className = 'icon-btn';
  download.type = 'button';
  download.title = 'Download entry';
  download.textContent = 'Get';
  download.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      const file = await fileForEntry(entry);
      downloadFile(file);
      size.textContent = entrySizeText(entry);
      if (entry.gimExportMissingBytes > 0) {
        size.title = `Standalone GIM: ${entry.gimExportMissingBytes} missing archive bytes were zero-filled on export.`;
        setStatus(`${file.name}: reconstructed standalone GIM size by zero-filling ${entry.gimExportMissingBytes} bytes absent from the compact archive slot.`);
      }
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  });

  const remove = document.createElement('button');
  remove.className = 'icon-btn danger';
  remove.type = 'button';
  remove.title = 'Delete entry';
  remove.textContent = 'Del';
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    await deleteEntries([entry]);
  });

  actions.append(download, remove);
  tr.append(select, id, art, name, size, actions);
  return tr;
}

function renderEntries() {
  const visible = visibleEntries();
  const rendered = visible.slice(0, state.renderLimit);
  ui.entryBody.replaceChildren();

  for (const entry of rendered) ui.entryBody.append(rowForEntry(entry));

  if (rendered.length < visible.length) {
    const tr = document.createElement('tr');
    tr.className = 'cip-load-more-row';
    const td = document.createElement('td');
    td.colSpan = 6;
    const button = document.createElement('button');
    button.className = 'button';
    button.type = 'button';
    button.textContent = `Show ${Math.min(RENDER_BATCH, visible.length - rendered.length)} more (${visible.length - rendered.length} remaining)`;
    button.addEventListener('click', () => {
      state.renderLimit += RENDER_BATCH;
      renderEntries();
    });
    td.append(button);
    tr.append(td);
    ui.entryBody.append(tr);
  }

  ui.empty.classList.toggle('hidden', visible.length !== 0);
  ui.empty.textContent = state.entries.length ? 'No entries match the current filter.' : 'This archive is empty. Add files to begin.';
  updateSelectionControls();
  updateSortHeaders();
}

function renderResources() {
  const hasEntries = state.entries.length > 0;
  ui.resourceCount.textContent = String(state.entries.length);
  ui.entriesResource.classList.toggle('empty', !hasEntries);
  ui.entriesResource.dataset.folder = allFolderId();
  ui.entriesResource.title = hasEntries
    ? `Drag all ${state.entries.length} entries into the Project Explorer`
    : 'This archive has no entries';
  ui.archiveResource.classList.toggle('empty', !hasEntries);
  ui.archiveResourceName.textContent = state.type ? currentArchiveName() : 'No archive';
  ui.archiveResource.dataset.file = state.type ? currentArchiveName() : 'archive.cip';
  ui.buildBtn.disabled = !hasEntries;
  ui.testBtn.disabled = !hasEntries;
  ui.infoBtn.disabled = !hasEntries;
  ui.addBtn.disabled = !state.type;
  ui.search.disabled = !state.type;
  updateSelectionControls();
  updateHistoryControls();
}

function render() {
  const active = Boolean(state.type);
  ui.welcome.classList.toggle('hidden', active);
  ui.workspace.classList.toggle('hidden', !active);
  renderResources();
  if (active) {
    renderSummary();
    renderEntries();
  }
  updateTitle();
}

function resetState({ type, cpjProfile = 'standard', name = 'cards.cip', entries = [], header = null, warnings = [], originalFile = null, dirty = false }) {
  state.type = type;
  state.cpjProfile = cpjProfile;
  state.name = name;
  state.entries = entries;
  state.header = header;
  state.warnings = warnings;
  state.originalFile = originalFile;
  state.renderLimit = RENDER_BATCH;
  clearLazyCache();
  clearSelection();
  ui.search.value = '';
  setDirty(dirty);
  clearHistory();
  render();
}

async function openArchive(file, { skipConfirm = false } = {}) {
  if (!skipConfirm && !(await confirmDiscard())) return;
  try {
    setStatus(`Indexing ${file.name || 'archive'}...`);
    const parsed = await readArchiveIndex(file, { cpjProfile: 'standard' });
    const warnings = [...parsed.warnings];
    if (parsed.type === 'CPJ') {
      warnings.unshift('CPJ magic does not distinguish Tag Force 3-6 from Tag Force Special. Select the correct CPJ profile in the sidebar. Payloads are decoded lazily when accessed.');
    }
    resetState({
      type: parsed.type,
      cpjProfile: 'standard',
      name: file.name || 'cards.cip',
      entries: parsed.entries,
      header: parsed.header,
      warnings,
      originalFile: file,
      dirty: false,
    });
    setStatus(`Opened ${file.name}: ${parsed.entries.length} entries indexed lazily.`, 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
    throw error;
  }
}

function openNewDialog() {
  ui.newType.value = 'CIP';
  ui.newProfile.value = 'standard';
  ui.newName.value = 'cards.cip';
  ui.newProfileWrap.classList.add('hidden');
  ui.newDialog.showModal();
}

async function createNewArchive() {
  if (!(await confirmDiscard())) return;
  const type = ui.newType.value;
  const cpjProfile = ui.newProfile.value;
  const name = ui.newName.value.trim() || 'cards.cip';
  resetState({ type, cpjProfile, name, dirty: true });
  setStatus(`Created empty ${type} archive.`);
}

function assertNoBaseAltMix(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.cardId) || { base: false, alts: new Set() };
    if (entry.altIndex == null) group.base = true;
    else group.alts.add(entry.altIndex);
    groups.set(entry.cardId, group);
  }
  for (const [cardId, group] of groups) {
    if (group.base && group.alts.size) throw new Error(`Card ${cardId} cannot contain both a base file and alternate-art files.`);
  }
}

function assertValidEntryLayout(entries) {
  assertNoBaseAltMix(entries);
  const groups = new Map();
  for (const entry of entries) {
    if (entry.altIndex == null) continue;
    const alts = groups.get(entry.cardId) || [];
    alts.push(entry.altIndex);
    groups.set(entry.cardId, alts);
  }
  for (const [cardId, indices] of groups) {
    indices.sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i += 1) {
      if (indices[i] !== i) throw new Error(`Card ${cardId} alternate arts must be contiguous from _0 (missing _${i}).`);
      if (i > 0 && indices[i] === indices[i - 1]) throw new Error(`Card ${cardId} has duplicate alternate-art index ${indices[i]}.`);
    }
  }
  const keys = new Set();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (keys.has(key)) throw new Error(`Duplicate archive entry ${makeEntryName(state.type, entry.cardId, entry.altIndex)}.`);
    keys.add(key);
  }
}

function normalizeAlternateArtIndices(entries) {
  const next = entries.map(cloneEntry);
  const groups = new Map();
  for (const entry of next) {
    if (entry.altIndex == null) continue;
    const list = groups.get(entry.cardId) || [];
    list.push(entry);
    groups.set(entry.cardId, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.altIndex - b.altIndex);
    list.forEach((entry, index) => {
      entry.altIndex = index;
      entry.name = makeEntryName(state.type, entry.cardId, index);
      entry.modified = true;
    });
  }
  return next;
}

async function deleteEntries(entries, { confirm = false } = {}) {
  if (!entries.length) return;
  if (confirm) {
    const message = `Delete ${entries.length} selected entr${entries.length === 1 ? 'y' : 'ies'} from the archive?`;
    const allowed = window.studio?.confirm ? await window.studio.confirm(message) : window.confirm(message);
    if (!allowed) return;
  }
  const keys = new Set(entries.map(entryKey));
  pushHistory(entries.length === 1 ? `delete ${makeEntryName(state.type, entries[0].cardId, entries[0].altIndex)}` : `delete ${entries.length} entries`);
  state.entries = normalizeAlternateArtIndices(state.entries.filter((entry) => !keys.has(entryKey(entry))));
  clearSelection();
  setDirty(true);
  setStatus(`Deleted ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`, 'success');
  render();
}

function openRenameDialog() {
  const entries = selectedEntries();
  if (entries.length !== 1) return;
  const entry = entries[0];
  state.renameTargetKey = entryKey(entry);
  ui.renameCardId.value = String(entry.cardId);
  ui.renameAltIndex.value = entry.altIndex == null ? '' : String(entry.altIndex);
  ui.renameDialog.showModal();
  requestAnimationFrame(() => ui.renameCardId.select());
}

function commitRename() {
  const targetKey = state.renameTargetKey;
  const index = state.entries.findIndex((entry) => entryKey(entry) === targetKey);
  if (index < 0) throw new Error('The selected entry no longer exists.');
  const cardId = Number(ui.renameCardId.value);
  const altRaw = ui.renameAltIndex.value.trim();
  const altIndex = altRaw === '' ? null : Number(altRaw);
  if (!Number.isInteger(cardId) || cardId < 0 || cardId > 0xFFFFFFFF) throw new Error('Card ID must be an integer between 0 and 4294967295.');
  if (altIndex != null && (!Number.isInteger(altIndex) || altIndex < 0)) throw new Error('Alternate-art index must be a non-negative integer or blank for base art.');

  const next = state.entries.map(cloneEntry);
  next[index] = { ...next[index], cardId, altIndex, name: makeEntryName(state.type, cardId, altIndex), modified: true };
  assertValidEntryLayout(next);
  const oldName = makeEntryName(state.type, state.entries[index].cardId, state.entries[index].altIndex);
  const newName = makeEntryName(state.type, cardId, altIndex);
  if (oldName === newName) return;
  pushHistory(`rename ${oldName}`);
  state.entries = next.sort((a, b) => a.cardId - b.cardId || (a.altIndex ?? -1) - (b.altIndex ?? -1));
  clearSelection();
  state.selectedKeys.add(`${cardId}:${altIndex == null ? 'base' : altIndex}`);
  state.selectionAnchor = `${cardId}:${altIndex == null ? 'base' : altIndex}`;
  setDirty(true);
  setStatus(`Renamed ${oldName} to ${newName}.`, 'success');
  render();
}

async function addFiles(files) {
  if (!state.type) throw new Error('Create or open an archive first.');
  const incoming = [...files];
  if (!incoming.length) return;

  const next = state.entries.map(cloneEntry);
  const messages = [];
  let changedCount = 0;

  for (const file of incoming) {
    const parsedName = parseEntryFilename(state.type, file.name);
    if (!parsedName) {
      messages.push(`${file.name}: expected ${state.type === 'CPJ' ? '123.jpg or 123_0.jpg' : '123.gim or 123_0.gim'}`);
      continue;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      validateEntryBytes(state.type, bytes, { cpjProfile: state.cpjProfile });
      const warning = entryCompatibilityWarning(state.type, bytes, { cpjProfile: state.cpjProfile });
      if (warning && !(await confirmCompatibilityWarning(warning))) {
        messages.push(`${file.name}: replacement cancelled`);
        continue;
      }
      const key = `${parsedName.cardId}:${parsedName.altIndex == null ? 'base' : parsedName.altIndex}`;
      const existing = next.findIndex((entry) => entryKey(entry) === key);
      const record = {
        cardId: parsedName.cardId,
        altIndex: parsedName.altIndex,
        name: makeEntryName(state.type, parsedName.cardId, parsedName.altIndex),
        bytes,
        rawSlot: null,
        modified: true,
      };
      if (existing >= 0) next[existing] = record;
      else next.push(record);
      changedCount += 1;
    } catch (error) {
      messages.push(`${file.name}: ${error.message || error}`);
    }
  }

  if (changedCount) {
    assertValidEntryLayout(next);
    pushHistory(changedCount === 1 ? 'add/replace entry' : `add/replace ${changedCount} entries`);
    next.sort((a, b) => a.cardId - b.cardId || (a.altIndex ?? -1) - (b.altIndex ?? -1));
    state.entries = next;
    setDirty(true);
    render();
  }

  if (messages.length) {
    setStatus(`${changedCount ? `${changedCount} file${changedCount === 1 ? '' : 's'} added. ` : ''}Skipped: ${messages.join(' | ')}`, changedCount ? 'info' : 'error');
  } else if (changedCount) {
    setStatus(`Added ${changedCount} file${changedCount === 1 ? '' : 's'}.`, 'success');
  }
}

async function replaceEntry(resourceId, file) {
  const key = idFromResource(resourceId);
  if (!key) return;
  const index = state.entries.findIndex((entry) => entryKey(entry) === key);
  if (index < 0) throw new Error('The target entry no longer exists.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  validateEntryBytes(state.type, bytes, { cpjProfile: state.cpjProfile });
  const warning = entryCompatibilityWarning(state.type, bytes, { cpjProfile: state.cpjProfile });
  if (warning && !(await confirmCompatibilityWarning(warning))) return;
  pushHistory(`replace ${makeEntryName(state.type, state.entries[index].cardId, state.entries[index].altIndex)}`);
  state.entries[index] = { ...state.entries[index], bytes, rawSlot: null, modified: true };
  setDirty(true);
  setStatus(`Replaced ${makeEntryName(state.type, state.entries[index].cardId, state.entries[index].altIndex)}.`, 'success');
  render();
}

async function switchCpjProfile(nextProfile) {
  if (state.type !== 'CPJ' || nextProfile === state.cpjProfile) return;
  const previous = state.cpjProfile;

  try {
    for (const entry of state.entries.filter((item) => item.modified && item.bytes instanceof Uint8Array)) {
      validateEntryBytes('CPJ', entry.bytes, { cpjProfile: nextProfile });
    }

    pushHistory(`switch CPJ profile to ${CPJ_PROFILES[nextProfile].label}`);
    state.cpjProfile = nextProfile;
    clearLazyCache();
    for (const entry of state.entries) {
      if (!(entry.bytes instanceof Uint8Array)) entry.loadedSize = null;
    }
    if (state.entries.some((entry) => entry.modified)) setDirty(true);
    render();
    setStatus(`CPJ profile set to ${CPJ_PROFILES[nextProfile].label}. Lazy payload cache cleared.`, 'success');
  } catch (error) {
    state.cpjProfile = previous;
    ui.profile.value = previous;
    setStatus(`Cannot switch CPJ profile: ${error.message || error}`, 'error');
  }
}

async function downloadArchive() {
  try {
    setStatus('Preparing archive...');
    const file = await buildCurrent();
    downloadFile(file);
    renderSummary();
    setStatus(`Built ${file.name} (${humanSize(file.size)}).`, 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

async function showArchiveInfo() {
  try {
    const plan = buildArchivePlan({ type: state.type, cpjProfile: state.cpjProfile, entries: state.entries });
    const uniqueCards = new Set(state.entries.map((entry) => entry.cardId)).size;
    const altEntries = state.entries.filter((entry) => entry.altIndex != null).length;
    let knownExtractedBytes = 0;
    let unknownExtractedCount = 0;
    for (const entry of state.entries) {
      if (entry.bytes instanceof Uint8Array) knownExtractedBytes += entry.bytes.byteLength;
      else if (Number.isInteger(entry.loadedSize)) knownExtractedBytes += entry.loadedSize;
      else if (Number.isInteger(entry.sizeHint)) knownExtractedBytes += entry.sizeHint;
      else unknownExtractedCount += 1;
    }

    const sourceSize = state.originalFile?.size ?? null;
    const large = plan.info.fullFileSize >= 32 * 1024 * 1024;
    let sha256 = 'Deferred';
    if (!large) {
      const built = await buildCurrent();
      sha256 = await sha256Hex(new Uint8Array(await built.arrayBuffer()));
    } else {
      sha256 = 'Deferred for large archives (avoids a full in-memory copy)';
    }

    const extractedLabel = unknownExtractedCount
      ? `${humanSize(knownExtractedBytes)} known + ${unknownExtractedCount} lazy CPJ entr${unknownExtractedCount === 1 ? 'y' : 'ies'}`
      : humanSize(knownExtractedBytes);

    const rows = [
      ['File', currentArchiveName()],
      ['Type', CIP_TYPES[state.type].label],
      ...(state.type === 'CPJ' ? [['CPJ profile', CPJ_PROFILES[state.cpjProfile].label]] : []),
      ['Entries', String(state.entries.length)],
      ['Card IDs', String(uniqueCards)],
      ['Alternate-art entries', String(altEntries)],
      ['Card range', `${plan.info.minCardNumber} - ${plan.info.maxCardNumber}`],
      ['Header size', `0x${plan.info.headerSize.toString(16).toUpperCase()} (${humanSize(plan.info.headerSize)})`],
      ['Slot size', `${humanSize(plan.info.slotSize)} (${plan.info.bitshiftSize} x 0x800)`],
      ...(sourceSize != null ? [['Source archive size', humanSize(sourceSize)]] : []),
      ['Planned archive size', humanSize(plan.info.fullFileSize)],
      ['Extracted entry bytes', extractedLabel],
      ['Lazy payload cache', `${humanSize(state.lazyCacheBytes)} / ${humanSize(LAZY_CACHE_MAX_BYTES)}`],
      ['SHA-256', sha256],
    ];
    ui.infoBody.replaceChildren();
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      ui.infoBody.append(row);
    }
    ui.infoDialog.showModal();
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

async function testArchive() {
  const runId = ++state.testRunId;
  state.testRunning = true;
  ui.testClose.textContent = 'Cancel';
  ui.testReport.textContent = '7-CIP archive test: RUNNING\n\nPreparing lazy build...';
  ui.testDialog.showModal();
  ui.testBtn.disabled = true;

  try {
    const built = await buildCurrent();
    const parsed = await readArchiveIndex(built, { cpjProfile: state.cpjProfile });
    if (!compareEntryKeys(state.entries, parsed.entries)) throw new Error('Entry identity mismatch in the planned archive.');

    let decoded = 0;
    if (parsed.type === 'CPJ') {
      for (let index = 0; index < parsed.entries.length; index += 1) {
        if (runId !== state.testRunId) {
          const cancelled = new Error('Archive test cancelled.');
          cancelled.name = 'AbortError';
          throw cancelled;
        }
        await readIndexedEntryBytes(built, parsed.entries[index], parsed.type, state.cpjProfile);
        decoded += 1;
        if (index % TEST_YIELD_EVERY === 0) {
          const percent = Math.floor(((index + 1) / parsed.entries.length) * 100);
          ui.testReport.textContent = [
            '7-CIP archive test: RUNNING',
            '',
            `Streaming CPJ payload validation: ${index + 1}/${parsed.entries.length} (${percent}%)`,
            `Memory mode: one slot at a time; payloads are not retained`,
          ].join('\n');
          setStatus(`Testing CPJ: ${index + 1}/${parsed.entries.length} (${percent}%)`);
          await yieldToUi();
        }
      }
    }

    const lines = [
      '7-CIP archive test: PASS',
      '',
      `Type: ${state.type}${state.type === 'CPJ' ? ` / ${CPJ_PROFILES[state.cpjProfile].label}` : ''}`,
      `Entries checked: ${parsed.entries.length}`,
      `Card range: ${parsed.header.minCardNumber} - ${parsed.header.maxCardNumber}`,
      `Header: 0x${parsed.header.headerSize.toString(16).toUpperCase()}`,
      `Slot size: ${humanSize(parsed.header.slotSize)}`,
      `Built size: ${humanSize(built.size)}`,
      '',
      'Checks:',
      '  OK header and offset-table structure',
      '  OK slot IDs and bounds',
      '  OK entry IDs and alternate-art chains',
      ...(parsed.type === 'CPJ' ? [`  OK ${decoded} CPJ slots decoded and contain a JPEG EOI marker`] : []),
      '  OK generated archive index matches the editor entry set',
      '',
      'Large-file mode: payloads are read one slot at a time. The test does not create two full archive copies in RAM.',
    ];
    if (parsed.warnings.length) lines.push('', 'Warnings:', ...parsed.warnings.map((warning) => `  ${warning}`));
    ui.testReport.textContent = lines.join('\n');
    setStatus('Archive test passed.', 'success');
  } catch (error) {
    if (error?.name === 'AbortError') {
      ui.testReport.textContent = '7-CIP archive test: CANCELLED';
      setStatus('Archive test cancelled.');
    } else {
      ui.testReport.textContent = `7-CIP archive test: FAIL\n\n${error.message || error}`;
      setStatus(`Archive test failed: ${error.message || error}`, 'error');
    }
  } finally {
    if (runId === state.testRunId) state.testRunning = false;
    ui.testClose.textContent = 'Close';
    ui.testBtn.disabled = !state.entries.length;
  }
}

ui.openBtn.addEventListener('click', () => ui.openInput.click());
ui.welcomeOpen.addEventListener('click', () => ui.openInput.click());
ui.openInput.addEventListener('change', async () => {
  const [file] = ui.openInput.files || [];
  ui.openInput.value = '';
  if (file) await openArchive(file);
});

ui.newBtn.addEventListener('click', openNewDialog);
ui.welcomeNew.addEventListener('click', openNewDialog);
ui.newType.addEventListener('change', () => ui.newProfileWrap.classList.toggle('hidden', ui.newType.value !== 'CPJ'));
ui.newCancel.addEventListener('click', () => ui.newDialog.close());
ui.newForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  ui.newDialog.close();
  await createNewArchive();
});

ui.addBtn.addEventListener('click', () => {
  if (!state.type) return;
  ui.addInput.accept = state.type === 'CPJ' ? '.jpg,.jpeg,image/jpeg' : '.gim,application/octet-stream';
  ui.addInput.click();
});
ui.addInput.addEventListener('change', async () => {
  const files = [...(ui.addInput.files || [])];
  ui.addInput.value = '';
  try {
    await addFiles(files);
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
});

for (const button of document.querySelectorAll('[data-sort]')) {
  button.addEventListener('click', () => setSort(button.dataset.sort));
}

ui.search.addEventListener('input', () => {
  state.renderLimit = RENDER_BATCH;
  renderEntries();
});

ui.tableWrap?.addEventListener('scroll', () => {
  if (ui.tableWrap.scrollTop + ui.tableWrap.clientHeight < ui.tableWrap.scrollHeight - 160) return;
  const total = visibleEntries().length;
  if (state.renderLimit >= total) return;
  state.renderLimit = Math.min(total, state.renderLimit + RENDER_BATCH);
  renderEntries();
});
ui.selectAll.addEventListener('change', () => {
  const visible = visibleEntries();
  if (ui.selectAll.checked) {
    for (const entry of visible) state.selectedKeys.add(entryKey(entry));
    if (visible.length) state.selectionAnchor = entryKey(visible[visible.length - 1]);
  } else {
    for (const entry of visible) state.selectedKeys.delete(entryKey(entry));
    if (state.selectionAnchor && !state.selectedKeys.has(state.selectionAnchor)) state.selectionAnchor = null;
  }
  renderEntries();
});

document.addEventListener('keydown', async (event) => {
  const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  const command = event.ctrlKey || event.metaKey;

  if (command && event.key.toLowerCase() === 'f') {
    if (!state.type) return;
    event.preventDefault();
    ui.search.focus();
    ui.search.select();
    return;
  }

  if (inField || !state.type) return;

  if (command && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if ((command && event.key.toLowerCase() === 'y') || (command && event.shiftKey && event.key.toLowerCase() === 'z')) {
    event.preventDefault();
    redo();
    return;
  }
  if (command && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    const visible = visibleEntries();
    for (const entry of visible) state.selectedKeys.add(entryKey(entry));
    if (visible.length) state.selectionAnchor = entryKey(visible[visible.length - 1]);
    renderEntries();
    return;
  }
  if (event.key === 'Delete' && state.selectedKeys.size) {
    event.preventDefault();
    await deleteEntries(selectedEntries(), { confirm: state.selectedKeys.size > 1 });
    return;
  }
  if (event.key === 'F2' && state.selectedKeys.size === 1) {
    event.preventDefault();
    openRenameDialog();
    return;
  }
  if (event.key === 'Escape' && state.selectedKeys.size) {
    clearSelection();
    renderEntries();
  }
});

ui.profile.addEventListener('change', () => switchCpjProfile(ui.profile.value));
ui.buildBtn.addEventListener('click', downloadArchive);
ui.testBtn.addEventListener('click', testArchive);
ui.infoBtn.addEventListener('click', showArchiveInfo);
ui.undoBtn.addEventListener('click', undo);
ui.redoBtn.addEventListener('click', redo);
ui.deleteSelectedBtn.addEventListener('click', () => deleteEntries(selectedEntries(), { confirm: state.selectedKeys.size > 1 }));
ui.renameBtn.addEventListener('click', openRenameDialog);
ui.renameCancel.addEventListener('click', () => ui.renameDialog.close());
ui.renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    commitRename();
    ui.renameDialog.close();
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
});
ui.infoClose.addEventListener('click', () => ui.infoDialog.close());
ui.testClose.addEventListener('click', () => {
  if (state.testRunning) {
    state.testRunId += 1;
    state.testRunning = false;
    setStatus('Archive test cancellation requested.');
  }
  ui.testDialog.close();
});

async function folderResourceForEntries(entries) {
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    files.push({
      path: makeEntryName(state.type, entry.cardId, entry.altIndex),
      file: await fileForEntry(entry, { cache: false }),
    });
    if (state.type === 'CPJ' && index > 0 && index % TEST_YIELD_EVERY === 0) {
      setStatus(`Preparing export: ${index + 1}/${entries.length}`);
      await yieldToUi();
    }
  }
  return { files };
}

window.tool = {
  async open(file) {
    await openArchive(file, { skipConfirm: true });
  },

  async get(id) {
    if (id === 'archive' || id === currentArchiveName()) {
      if (!state.entries.length) return null;
      return buildCurrent();
    }

    if (id === allFolderId()) {
      return folderResourceForEntries(state.entries);
    }

    if (id === selectionFolderId()) {
      const entries = selectedEntries();
      if (!entries.length) return null;
      return folderResourceForEntries(entries);
    }

    const key = idFromResource(id);
    if (key) {
      const entry = state.entries.find((candidate) => entryKey(candidate) === key);
      return entry ? fileForEntry(entry) : null;
    }
    return null;
  },

  async replace(id, file) {
    try {
      await replaceEntry(id, file);
    } catch (error) {
      setStatus(error.message || String(error), 'error');
      throw error;
    }
  },

  async add(id, files) {
    if (id !== allFolderId() && id !== selectionFolderId()) return;
    try {
      await addFiles(files);
    } catch (error) {
      setStatus(error.message || String(error), 'error');
      throw error;
    }
  },
};

render();
