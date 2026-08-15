const ROW_BYTES = 16;
const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 36;
const MAX_SCROLL_HEIGHT = 8_000_000;

const input = document.querySelector('#hex-input');
const openButton = document.querySelector('#hex-open');
const openEmptyButton = document.querySelector('#hex-open-empty');
const main = document.querySelector('#hex-drop');
const empty = document.querySelector('#hex-empty');
const editor = document.querySelector('#hex-editor');
const scroll = document.querySelector('#hex-scroll');
const spacer = document.querySelector('#hex-spacer');
const windowEl = document.querySelector('#hex-window');
const head = document.querySelector('#hex-head');
const gotoInput = document.querySelector('#hex-goto');
const gotoButton = document.querySelector('#hex-go');
const status = document.querySelector('#hex-status');
const position = document.querySelector('#hex-position');
const sizeLabel = document.querySelector('#hex-size');

const fallbackStudio = { toast: console.info, title(value){ if(value) document.title=value; }, dirty(){} };
const studio = () => window.studio || fallbackStudio;
const state = { file: null, renderSerial: 0, raf: 0, offsetDigits: 8, totalRows: 1, scrollHeight: ROW_HEIGHT, scaledScroll: false };

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KiB','MiB','GiB','TiB']; let n = value / 1024; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

function offsetText(value) { return value.toString(16).toUpperCase().padStart(state.offsetDigits, '0'); }
function printable(byte) { return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

function renderHeader() {
  const bytes = Array.from({ length: ROW_BYTES }, (_, index) => `<span>${index.toString(16).toUpperCase().padStart(2,'0')}</span>`).join('');
  head.innerHTML = `<span class="offset-head">OFFSET</span><span class="byte-head">${bytes}</span><span class="ascii-head">ASCII</span>`;
}

function rowHtml(bytes, absoluteOffset) {
  const cells = [];
  let ascii = '';
  for (let index = 0; index < ROW_BYTES; index += 1) {
    if (index < bytes.length) {
      const value = bytes[index];
      cells.push(`<span class="hex-byte">${value.toString(16).toUpperCase().padStart(2, '0')}</span>`);
      ascii += printable(value);
    } else {
      cells.push('<span class="hex-byte empty">00</span>');
      ascii += ' ';
    }
  }
  return `<div class="hex-row" data-offset="${absoluteOffset}"><span class="offset">${offsetText(absoluteOffset)}</span><span class="hex-bytes">${cells.join('')}</span><span class="hex-ascii">${escapeHtml(ascii)}</span></div>`;
}

async function renderVisible() {
  state.raf = 0;
  const file = state.file;
  if (!file) return;
  const serial = ++state.renderSerial;
  const totalRows = state.totalRows;
  const visibleRows = Math.max(1, Math.ceil(scroll.clientHeight / ROW_HEIGHT));
  const maxScrollTop = Math.max(1, state.scrollHeight - scroll.clientHeight);
  const firstVisible = state.scaledScroll
    ? Math.floor((scroll.scrollTop / maxScrollTop) * Math.max(0, totalRows - visibleRows))
    : Math.floor(scroll.scrollTop / ROW_HEIGHT);
  const startRow = Math.max(0, firstVisible - OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, firstVisible + visibleRows + OVERSCAN_ROWS);
  const start = startRow * ROW_BYTES;
  const end = Math.min(file.size, endRow * ROW_BYTES);
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  if (serial !== state.renderSerial || file !== state.file) return;
  const rows = [];
  for (let row = startRow; row < endRow; row += 1) {
    const local = (row - startRow) * ROW_BYTES;
    rows.push(rowHtml(bytes.subarray(local, Math.min(local + ROW_BYTES, bytes.length)), row * ROW_BYTES));
  }
  const visualY = state.scaledScroll
    ? Math.min(Math.max(0, scroll.scrollTop - OVERSCAN_ROWS * ROW_HEIGHT), Math.max(0, state.scrollHeight - rows.length * ROW_HEIGHT))
    : startRow * ROW_HEIGHT;
  windowEl.style.transform = `translateY(${visualY}px)`;
  windowEl.innerHTML = rows.join('');
  const current = Math.min(file.size, firstVisible * ROW_BYTES);
  position.textContent = `0x${offsetText(current)}`;
}

function scheduleRender() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => { renderVisible().catch((error) => { console.error(error); status.textContent = error.message; }); });
}

async function openFile(file) {
  if (!(file instanceof Blob)) return;
  state.file = file;
  state.renderSerial += 1;
  state.offsetDigits = Math.max(8, Math.max(0, file.size - 1).toString(16).length);
  empty.classList.add('hidden'); editor.classList.remove('hidden');
  gotoInput.disabled = false; gotoButton.disabled = false;
  state.totalRows = Math.max(1, Math.ceil(file.size / ROW_BYTES));
  const naturalHeight = state.totalRows * ROW_HEIGHT;
  state.scaledScroll = naturalHeight > MAX_SCROLL_HEIGHT;
  state.scrollHeight = state.scaledScroll ? MAX_SCROLL_HEIGHT : naturalHeight;
  spacer.style.height = `${state.scrollHeight}px`;
  scroll.scrollTop = 0;
  status.textContent = file.name || 'Binary file';
  sizeLabel.textContent = formatBytes(file.size);
  studio().title(`${file.name || 'Binary file'} - Hex Viewer`);
  studio().dirty(false);
  await renderVisible();
}

function parseOffset(text) {
  const value = String(text || '').trim().replace(/_/g, '');
  if (!value) return null;
  const parsed = /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value.slice(2), 16)
    : /^[0-9a-f]+h$/i.test(value) ? Number.parseInt(value.slice(0, -1), 16)
    : /^[0-9]+$/.test(value) ? Number.parseInt(value, 10)
    : /^[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function goToOffset() {
  if (!state.file) return;
  const parsed = parseOffset(gotoInput.value);
  if (parsed == null) { studio().toast('Enter a valid hexadecimal or decimal offset.', 'warning'); return; }
  const target = Math.min(Math.max(0, parsed), Math.max(0, state.file.size - 1));
  const targetRow = Math.floor(target / ROW_BYTES);
  if (state.scaledScroll) {
    const visibleRows = Math.max(1, Math.ceil(scroll.clientHeight / ROW_HEIGHT));
    const rowRange = Math.max(1, state.totalRows - visibleRows);
    const maxScrollTop = Math.max(0, state.scrollHeight - scroll.clientHeight);
    scroll.scrollTop = (targetRow / rowRange) * maxScrollTop;
  } else scroll.scrollTop = targetRow * ROW_HEIGHT;
  gotoInput.value = `0x${offsetText(target)}`;
  scheduleRender();
}

openButton.addEventListener('click', () => input.click());
openEmptyButton.addEventListener('click', () => input.click());
input.addEventListener('change', () => { const [file] = input.files; if (file) openFile(file); input.value = ''; });
gotoButton.addEventListener('click', goToOffset);
gotoInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') goToOffset(); });
scroll.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

// Native drops keep the tool useful when index.html is opened standalone.
main.addEventListener('dragover', (event) => { if (!document.documentElement.dataset.studioHosted && event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
main.addEventListener('drop', (event) => {
  if (document.documentElement.dataset.studioHosted) return;
  const [file] = event.dataTransfer?.files || [];
  if (file) { event.preventDefault(); openFile(file); }
});

renderHeader();
window.tool = Object.freeze({
  open: openFile,
  replace(_id, file) { return openFile(file); }
});
