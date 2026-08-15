import { parseSfoDetailed, buildSfo, cloneSfoDetailed, SFO_FORMAT, SFO_FORMAT_NAMES } from '../../shared/psp/sfo.js';

const KNOWN_FIELDS = Object.freeze({
  TITLE: 'Title',
  DISC_ID: 'Disc ID',
  DISC_VERSION: 'Disc version',
  APP_VER: 'Application version',
  PSP_SYSTEM_VER: 'Required firmware',
  CATEGORY: 'Category',
  PARENTAL_LEVEL: 'Parental level',
  REGION: 'Region bitmask',
  BOOTABLE: 'Bootable',
  DISC_NUMBER: 'Disc number',
  DISC_TOTAL: 'Disc total',
  ATTRIBUTE: 'Attributes',
  MEMSIZE: 'Memory mode',
  HRKGMP_VER: 'HRKGMP version',
  UPDATER_VER: 'Updater version',
  USE_USB: 'USB flag',
  DRIVER_PATH: 'Driver path',
  PBOOT_TITLE: 'PBOOT title',
});
const INTEGER_HINTS = new Set(['PARENTAL_LEVEL','REGION','BOOTABLE','DISC_NUMBER','DISC_TOTAL','ATTRIBUTE','MEMSIZE','USE_USB']);
const encoder = new TextEncoder();

const state = { file: null, original: null, model: null, dirty: false, query: '' };
const el = (selector) => document.querySelector(selector);
const studio = () => window.studio || { toast: console.info, dirty() {}, title() {} };

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function formatHex(bytes) { return [...(bytes || [])].map((b) => b.toString(16).padStart(2,'0')).join(' ').replace(/((?:[0-9a-f]{2} ){15}[0-9a-f]{2}) /gi, '$1\n'); }
function parseHex(text) {
  const clean = String(text || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('Binary hex data must contain complete bytes.');
  return new Uint8Array(clean.match(/.{2}/g)?.map((pair) => parseInt(pair,16)) || []);
}
function currentName() { return state.file?.name || 'PARAM.SFO'; }
function valueText(entry) {
  if (entry.value instanceof Uint8Array) return formatHex(entry.value);
  return String(entry.value ?? '');
}
function markDirty(value = true) {
  state.dirty = Boolean(value);
  el('#sfo-current').classList.toggle('dirty', state.dirty);
  studio().dirty(state.dirty);
}
function summaryValue(key) {
  const entry = state.model?.entries.find((item) => item.key === key);
  if (!entry) return '-';
  if (entry.value instanceof Uint8Array) return `${entry.value.length} bytes`;
  return String(entry.value ?? '-');
}
function summaryMarkup() {
  return [
    ['Title', summaryValue('TITLE')],
    ['Disc ID', summaryValue('DISC_ID')],
    ['Category', summaryValue('CATEGORY')],
    ['Firmware', summaryValue('PSP_SYSTEM_VER')],
    ['Disc version', summaryValue('DISC_VERSION')],
    ['Parental level', summaryValue('PARENTAL_LEVEL')],
  ].map(([label,value]) => `<div class="sfo-summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}
function workspaceMarkup() {
  return `<div class="sfo-workspace"><aside class="sfo-sidebar"><h2 class="sfo-side-title">PSP summary</h2><div class="sfo-summary" id="sfo-summary"></div><div class="sfo-help">SFO Studio preserves the original entry types and unknown binary values. Edit only fields you understand; games may rely on title-specific metadata.</div></aside><section class="sfo-editor"><div class="sfo-editor-head"><div><h2>PARAM.SFO entries</h2><p>Keys, types and values are editable. Changes are rebuilt into a valid PSF table on export.</p></div></div><div class="sfo-entry-list" id="sfo-entry-list"></div></section></div>`;
}
function typeOptions(format) {
  const formats = [SFO_FORMAT.UTF8, SFO_FORMAT.UINT32, SFO_FORMAT.BINARY];
  if (!formats.includes(format)) formats.push(format);
  return formats.map((value) => `<option value="${value}" ${value === format ? 'selected' : ''}>${escapeHtml(SFO_FORMAT_NAMES[value] || `Unknown 0x${value.toString(16).padStart(4,'0')}`)}</option>`).join('');
}
function valueControl(entry, index) {
  if (entry.format === SFO_FORMAT.UINT32) return `<input data-role="value" data-index="${index}" type="number" min="0" max="4294967295" step="1" value="${escapeHtml(entry.value)}">`;
  if (entry.format === SFO_FORMAT.BINARY || entry.value instanceof Uint8Array || !SFO_FORMAT_NAMES[entry.format]) return `<textarea data-role="value" data-index="${index}" spellcheck="false" placeholder="00 ff 1a...">${escapeHtml(valueText(entry))}</textarea>`;
  return `<input data-role="value" data-index="${index}" type="text" value="${escapeHtml(entry.value)}">`;
}
function entryMatches(entry) {
  if (!state.query) return true;
  return `${entry.key} ${KNOWN_FIELDS[entry.key] || ''} ${entry.value instanceof Uint8Array ? '' : entry.value}`.toLowerCase().includes(state.query);
}
function renderEntries() {
  if (!state.model) return;
  const list = el('#sfo-entry-list');
  const visible = state.model.entries.map((entry,index) => ({ entry,index })).filter(({entry}) => entryMatches(entry));
  list.innerHTML = visible.length ? visible.map(({entry,index}) => {
    const known = KNOWN_FIELDS[entry.key];
    return `<article class="sfo-entry" data-index="${index}">
      <label class="sfo-entry-key"><span>Key ${known ? `<b class="sfo-known"> |  ${escapeHtml(known)}</b>` : ''}</span><input data-role="key" data-index="${index}" type="text" value="${escapeHtml(entry.key)}"></label>
      <label><span>Type</span><select data-role="format" data-index="${index}">${typeOptions(entry.format)}</select></label>
      <label class="sfo-entry-value"><span>Value</span>${valueControl(entry,index)}</label>
      <div class="sfo-entry-size" title="Current / reserved size">${entry.length || 0}/${entry.maxLength || 0}</div>
      <button class="sfo-delete" data-delete="${index}" type="button" title="Delete entry">×</button>
    </article>`;
  }).join('') : '<div class="sfo-empty">No entries match this filter.</div>';
  el('#sfo-summary').innerHTML = summaryMarkup();
  el('#sfo-entry-count').textContent = `${state.model.entries.length} ${state.model.entries.length === 1 ? 'entry' : 'entries'}`;
}
function renderWorkspace() {
  el('#sfo-main').innerHTML = workspaceMarkup();
  renderEntries();
}
function syncControls() {
  const active = Boolean(state.model);
  el('#sfo-add').disabled = !active;
  el('#sfo-save').disabled = !active;
  el('#sfo-search').disabled = !active;
  el('#sfo-file-name').textContent = active ? currentName() : 'No file';
  el('#sfo-current').dataset.file = active ? currentName() : 'PARAM.SFO';
  el('#sfo-current').classList.toggle('empty', !active);
  el('#sfo-version').textContent = active ? `PSF 0x${state.model.version.toString(16).padStart(8,'0')}` : 'PSF -';
}
function updateEntryFromControl(target) {
  const index = Number(target.dataset.index);
  const entry = state.model?.entries[index];
  if (!entry) return;
  const role = target.dataset.role;
  if (role === 'key') {
    const next = target.value.trim();
    if (!next) { target.setCustomValidity('Key cannot be empty.'); return; }
    const duplicate = state.model.entries.some((item,i) => i !== index && item.key === next);
    target.setCustomValidity(duplicate ? 'Duplicate key.' : '');
    if (duplicate) return;
    entry.key = next;
  } else if (role === 'format') {
    const next = Number(target.value);
    entry.format = next;
    if (next === SFO_FORMAT.UINT32) entry.value = Number(entry.value) >>> 0;
    else if (next === SFO_FORMAT.UTF8) entry.value = entry.value instanceof Uint8Array ? '' : String(entry.value ?? '');
    else if (!(entry.value instanceof Uint8Array)) entry.value = encoder.encode(String(entry.value ?? ''));
    entry.maxLength = next === SFO_FORMAT.UINT32 ? 4 : 0;
    renderEntries();
  } else if (role === 'value') {
    try {
      if (entry.format === SFO_FORMAT.UINT32) entry.value = Math.max(0, Math.min(0xffffffff, Number(target.value) || 0)) >>> 0;
      else if (entry.format === SFO_FORMAT.UTF8) entry.value = target.value;
      else entry.value = parseHex(target.value);
      target.setCustomValidity('');
    } catch (error) { target.setCustomValidity(error.message); return; }
  }
  markDirty(true);
  el('#sfo-summary').innerHTML = summaryMarkup();
}
function addEntry() {
  if (!state.model) return;
  let n = 1; let key = 'NEW_KEY';
  while (state.model.entries.some((entry) => entry.key === key)) key = `NEW_KEY_${++n}`;
  state.model.entries.push({ key, format: SFO_FORMAT.UTF8, length: 1, maxLength: 4, value: '', raw: new Uint8Array([0]) });
  state.query = ''; el('#sfo-search').value = '';
  markDirty(true); renderEntries();
  queueMicrotask(() => el(`.sfo-entry[data-index="${state.model.entries.length - 1}"] input[data-role="key"]`)?.select());
}
function deleteEntry(index) {
  if (!state.model?.entries[index]) return;
  state.model.entries.splice(index,1); markDirty(true); renderEntries();
}
async function openSfo(file) {
  if (!file) return;
  try {
    const parsed = parseSfoDetailed(await file.arrayBuffer());
    state.file = file; state.original = parsed; state.model = cloneSfoDetailed(parsed); state.query = '';
    el('#sfo-search').value = '';
    renderWorkspace(); syncControls(); markDirty(false);
    el('#sfo-status').textContent = `${file.name} loaded`;
    studio().title(`${file.name} - SFO Studio`);
    studio().toast('PARAM.SFO loaded locally.', 'success');
  } catch (error) {
    console.error(error); studio().toast(`Could not open SFO: ${error.message}`, 'error', 6000);
  }
}
function buildCurrentFile() {
  if (!state.model) throw new Error('No PARAM.SFO is open.');
  const bytes = buildSfo(state.model);
  return new File([bytes], currentName(), { type:'application/octet-stream' });
}
async function downloadCurrent() {
  try {
    const file = buildCurrentFile();
    const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    markDirty(false); el('#sfo-status').textContent = `${file.name} exported`;
  } catch (error) { studio().toast(error.message, 'error'); }
}

const input = el('#sfo-input');
el('#sfo-open').addEventListener('click', () => input.click());
el('#sfo-welcome-open').addEventListener('click', () => input.click());
input.addEventListener('change', () => { const [file] = input.files; openSfo(file); input.value = ''; });
el('#sfo-add').addEventListener('click', addEntry);
el('#sfo-save').addEventListener('click', downloadCurrent);
el('#sfo-search').addEventListener('input', (event) => { state.query = event.target.value.trim().toLowerCase(); renderEntries(); });
el('#sfo-main').addEventListener('input', (event) => { if (event.target.matches('[data-role]')) updateEntryFromControl(event.target); });
el('#sfo-main').addEventListener('change', (event) => { if (event.target.matches('[data-role]')) updateEntryFromControl(event.target); });
el('#sfo-main').addEventListener('click', (event) => { const button = event.target.closest('[data-delete]'); if (button) deleteEntry(Number(button.dataset.delete)); });

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.model) { event.preventDefault(); downloadCurrent(); }
});

syncControls();
window.tool = Object.freeze({
  open: openSfo,
  get() { return buildCurrentFile(); },
  replace(_id, file) { return openSfo(file); },
});
