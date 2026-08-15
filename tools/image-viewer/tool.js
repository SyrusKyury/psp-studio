const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

const input = document.querySelector('#viewer-input');
const openButton = document.querySelector('#viewer-open');
const openEmptyButton = document.querySelector('#viewer-open-empty');
const main = document.querySelector('#viewer-drop');
const empty = document.querySelector('#viewer-empty');
const workspace = document.querySelector('#viewer-workspace');
const stage = document.querySelector('#image-stage');
const image = document.querySelector('#image-preview');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const zoomValue = document.querySelector('#zoom-value');
const zoomFit = document.querySelector('#zoom-fit');
const status = document.querySelector('#viewer-status');
const dimensions = document.querySelector('#viewer-dimensions');
const formatLabel = document.querySelector('#viewer-format');
const sizeLabel = document.querySelector('#viewer-size');

const fallbackStudio = { toast: console.info, title(value){ if(value) document.title=value; }, dirty(){} };
const studio = () => window.studio || fallbackStudio;
const state = { file: null, url: '', zoom: 1, fit: true, width: 0, height: 0, openSerial: 0, cancelDecode: null };

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KiB','MiB','GiB']; let n = value / 1024; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}
function extension(name) { const match = /\.([^.]+)$/.exec(name || ''); return match ? match[1].toUpperCase() : 'IMAGE'; }
function imageMime(file) {
  if (String(file?.type || '').startsWith('image/')) return file.type;
  const ext = extension(file?.name).toLowerCase();
  return ({ png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', bmp:'image/bmp', avif:'image/avif', ico:'image/x-icon' })[ext] || 'application/octet-stream';
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function decodeCandidate(url) {
  const probe = new Image();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.onload = null;
      probe.onerror = null;
      if (state.cancelDecode === cancel) state.cancelDecode = null;
      callback(value);
    };
    const cancel = () => finish(resolve, null);
    state.cancelDecode = cancel;
    probe.onload = () => finish(resolve, probe);
    probe.onerror = () => finish(reject, new Error('The browser could not decode this image format.'));
    timer = setTimeout(() => finish(reject, new Error('Image decoding timed out.')), 15000);
    probe.src = url;
  });
}

function setControls(enabled) {
  for (const element of [zoomOut, zoomIn, zoomValue, zoomFit]) element.disabled = !enabled;
}

function fitZoom() {
  if (!state.width || !state.height) return 1;
  const padding = 56;
  const availableWidth = Math.max(1, stage.clientWidth - padding);
  const availableHeight = Math.max(1, stage.clientHeight - padding);
  return clamp(Math.min(availableWidth / state.width, availableHeight / state.height), MIN_ZOOM, MAX_ZOOM);
}

function applyZoom({ preserveCenter = false } = {}) {
  if (!state.file || !state.width || !state.height) return;
  const oldWidth = image.getBoundingClientRect().width || state.width;
  const oldHeight = image.getBoundingClientRect().height || state.height;
  const centerX = preserveCenter ? (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, oldWidth + 56) : 0;
  const centerY = preserveCenter ? (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, oldHeight + 56) : 0;

  if (state.fit) state.zoom = fitZoom();
  image.style.width = `${Math.max(1, state.width * state.zoom)}px`;
  image.style.height = `${Math.max(1, state.height * state.zoom)}px`;
  stage.classList.toggle('fit-mode', state.fit && state.width * state.zoom <= stage.clientWidth - 56 && state.height * state.zoom <= stage.clientHeight - 56);
  zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;

  if (preserveCenter) requestAnimationFrame(() => {
    stage.scrollLeft = Math.max(0, centerX * (image.getBoundingClientRect().width + 56) - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, centerY * (image.getBoundingClientRect().height + 56) - stage.clientHeight / 2);
  });
}

function setZoom(value) {
  state.fit = false;
  state.zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
  applyZoom({ preserveCenter: true });
}

async function openImage(file) {
  if (!(file instanceof Blob)) return;
  const serial = ++state.openSerial;
  const source = String(file.type || '').startsWith('image/') ? file : new Blob([file], { type: imageMime(file) });
  const url = URL.createObjectURL(source);
  state.cancelDecode?.();
  status.textContent = `Opening ${file.name || 'image'}...`;

  let probe;
  try {
    probe = await decodeCandidate(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    if (serial !== state.openSerial) return;
    status.textContent = error.message;
    studio().toast(error.message, 'error', 6000);
    throw error;
  }

  if (!probe || serial !== state.openSerial) { URL.revokeObjectURL(url); return; }

  const previousUrl = state.url;
  state.file = file;
  state.url = url;
  state.width = probe.naturalWidth;
  state.height = probe.naturalHeight;
  state.zoom = 1;
  state.fit = true;

  empty.classList.add('hidden');
  workspace.classList.remove('hidden');
  image.src = url;
  image.alt = file.name || 'Image preview';
  if (previousUrl) URL.revokeObjectURL(previousUrl);

  sizeLabel.textContent = formatBytes(file.size);
  formatLabel.textContent = extension(file.name);
  dimensions.textContent = `${state.width} × ${state.height}`;
  image.classList.toggle('pixelated', state.width <= 256 && state.height <= 256);
  setControls(true);
  applyZoom();
  status.textContent = file.name || 'Image';
  studio().title(`${file.name || 'Image'} - Image Viewer`);
  studio().dirty(false);
}

openButton.addEventListener('click', () => input.click());
openEmptyButton.addEventListener('click', () => input.click());
input.addEventListener('change', () => { const [file] = input.files; if (file) openImage(file).catch(() => {}); input.value = ''; });
zoomOut.addEventListener('click', () => setZoom(state.zoom / ZOOM_STEP));
zoomIn.addEventListener('click', () => setZoom(state.zoom * ZOOM_STEP));
zoomValue.addEventListener('click', () => setZoom(1));
zoomFit.addEventListener('click', () => { state.fit = true; applyZoom(); });
stage.addEventListener('wheel', (event) => {
  if (!state.file || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setZoom(state.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
}, { passive: false });
window.addEventListener('resize', () => { if (state.fit) applyZoom(); });
window.addEventListener('beforeunload', () => { state.cancelDecode?.(); if (state.url) URL.revokeObjectURL(state.url); });

main.addEventListener('dragover', (event) => { if (!document.documentElement.dataset.studioHosted && event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
main.addEventListener('drop', (event) => {
  if (document.documentElement.dataset.studioHosted) return;
  const [file] = event.dataTransfer?.files || [];
  if (file) { event.preventDefault(); openImage(file).catch(() => {}); }
});

window.tool = Object.freeze({
  open: openImage,
  replace(_id, file) { return openImage(file); }
});
