const PHOTOPEA_ORIGIN = 'https://www.photopea.com';
// Photopea API mode is activated by an encoded JSON configuration in the URL fragment.
// Loading the bare origin opens Photopea's marketing landing page instead.
const PHOTOPEA_API_URL = `${PHOTOPEA_ORIGIN}#%7B%22environment%22%3A%7B%7D%7D`;
const frame = document.querySelector('#photopea-frame');
const input = document.querySelector('#image-input');
const resource = document.querySelector('#image-resource');
const fileNameLabel = document.querySelector('#image-file-name');
const statusLabel = document.querySelector('#image-status');
const formatLabel = document.querySelector('#image-format');
const exportHint = document.querySelector('#image-export-hint');
const engineStatus = document.querySelector('#engine-status');
const engineDot = document.querySelector('#engine-dot');
const loading = document.querySelector('#image-loading');
const downloadButton = document.querySelector('#image-download');

const fallbackStudio = { toast: console.info, dirty() {}, title(value) { if (value) document.title = value; } };
const studio = () => window.studio || fallbackStudio;
const state = { ready: false, file: null, opening: false, handshakeStarted: false, handshakeAttempts: 0 };
const doneWaiters = [];
const binaryWaiters = [];
let readyResolve;
const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

function timeoutPromise(message, ms = 25000) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
function waitDone() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Photopea did not finish the requested operation.')), 25000);
    doneWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
}
function waitBinary() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Photopea did not return the edited image.')), 30000);
    binaryWaiters.push((buffer) => { clearTimeout(timer); resolve(buffer); });
  });
}
async function ensureReady() {
  if (state.ready) return;
  await Promise.race([readyPromise, timeoutPromise('Could not connect to Photopea. Check your Internet connection.', 30000)]);
}
function post(data, transfer = []) {
  if (!frame.contentWindow) throw new Error('The Photopea frame is not available yet.');
  frame.contentWindow.postMessage(data, PHOTOPEA_ORIGIN, transfer);
}
function beginHandshake() {
  // Keep the iframe pinned to API mode if a browser / navigation ever strips the fragment.
  if (!frame.src.includes('#')) frame.src = PHOTOPEA_API_URL;
  if (state.ready || state.handshakeStarted) return;
  state.handshakeStarted = true;
  state.handshakeAttempts = 0;
  statusLabel.textContent = 'Connecting to Photopea...';
  const tick = () => {
    if (state.ready) return;
    state.handshakeAttempts += 1;
    try {
      post('app.echoToOE(\'pspms-ready\')');
    } catch {}
    if (!state.ready && state.handshakeAttempts < 30) setTimeout(tick, 1000);
  };
  tick();
}
async function sendScript(script) {
  await ensureReady();
  const done = waitDone();
  post(script);
  await done;
}
function setEngineReady() {
  state.ready = true;
  engineDot.classList.add('ready'); engineDot.classList.remove('error');
  engineStatus.textContent = 'Photopea ready';
  loading.classList.add('hidden-engine');
  if (!state.file) statusLabel.textContent = 'Photopea is ready. Open an image, edit it, then drag the export tile in the top panel back into the Project Explorer.';
  readyResolve?.(); readyResolve = null;
}
function setEngineError(message) {
  engineDot.classList.add('error'); engineDot.classList.remove('ready');
  engineStatus.textContent = 'Photopea unavailable';
  loading.querySelector('strong').textContent = 'Image Studio unavailable';
  loading.querySelector('span').textContent = message;
  statusLabel.textContent = message;
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== PHOTOPEA_ORIGIN) return;
  if (event.data === 'pspms-ready') {
    setEngineReady();
    return;
  }
  if (event.data === 'done') {
    if (!state.ready) { setEngineReady(); return; }
    const next = doneWaiters.shift(); if (next) next();
    return;
  }
  if (event.data instanceof ArrayBuffer) {
    const next = binaryWaiters.shift(); if (next) next(event.data);
  }
});
frame.addEventListener('load', beginHandshake);
frame.addEventListener('error', () => setEngineError('Photopea could not be loaded. Image Studio requires Internet access.'));
setTimeout(() => { if (!state.ready) setEngineError('Photopea API mode did not become ready. Check the iframe URL, Internet connection, or content blocking settings.'); }, 30000);

function extension(name) { const match = /\.([^.]+)$/.exec(name || ''); return match ? match[1].toLowerCase() : 'png'; }
function exportInfo(file) {
  const ext = extension(file?.name);
  if (ext === 'jpg' || ext === 'jpeg') return { script:'jpg:0.92', ext, mime:'image/jpeg' };
  if (ext === 'webp') return { script:'webp:0.92', ext, mime:'image/webp' };
  if (ext === 'gif') return { script:'gif', ext, mime:'image/gif' };
  if (ext === 'svg') return { script:'svg', ext, mime:'image/svg+xml' };
  return { script:'png', ext:'png', mime:'image/png' };
}
function exportName(file, info) {
  const original = file?.name || 'image.png';
  const oldExt = extension(original);
  if (oldExt === info.ext || (oldExt === 'jpeg' && info.ext === 'jpeg')) return original;
  return original.replace(/\.[^.]+$/, '') + `.${info.ext}`;
}
function updateFileUi() {
  const info = state.file ? exportInfo(state.file) : null;
  const name = state.file ? exportName(state.file, info) : 'image.png';
  fileNameLabel.textContent = state.file?.name || 'No image';
  exportHint.textContent = state.file
    ? 'Drag this tile into the Project Explorer to add the edited image back into the workspace.'
    : 'Open an image to prepare an export tile.';
  resource.dataset.file = name;
  resource.classList.toggle('empty', !state.file);
  formatLabel.textContent = state.file ? `${extension(state.file.name).toUpperCase()}  |  export ${info.ext.toUpperCase()}` : '-';
  downloadButton.disabled = !state.file || !state.ready;
}

async function openImage(file) {
  if (!file || state.opening) return;
  state.opening = true;
  statusLabel.textContent = `Opening ${file.name}...`;
  try {
    await ensureReady();
    const buffer = await file.arrayBuffer();
    const done = waitDone();
    post(buffer, [buffer]);
    await done;
    const safeName = JSON.stringify(file.name);
    await sendScript(`if(app.documents.length){app.activeDocument.name=${safeName};app.activeDocument.source=${safeName};app.activeDocument.clearHistory();}`);
    state.file = file;
    updateFileUi();
    studio().title(`${file.name} - Image Studio`);
    studio().dirty(false);
    statusLabel.textContent = `${file.name} is open in Photopea. Drag the export tile in the top panel back into the Project Explorer when you are done.`;
    studio().toast('Image loaded into Image Studio.', 'success');
  } catch (error) {
    console.error(error); statusLabel.textContent = error.message; studio().toast(error.message, 'error', 6500);
  } finally { state.opening = false; }
}

async function exportCurrent() {
  if (!state.file) throw new Error('No image is open.');
  await ensureReady();
  const info = exportInfo(state.file);
  const binary = waitBinary();
  const done = waitDone();
  post(`if(app.documents.length){app.activeDocument.saveToOE(${JSON.stringify(info.script)});}`);
  const [buffer] = await Promise.all([binary, done]);
  const name = exportName(state.file, info);
  const file = new File([buffer], name, { type: info.mime });
  resource.dataset.file = name;
  studio().dirty(false);
  return file;
}
async function downloadCurrent() {
  try {
    statusLabel.textContent = 'Exporting edited image...';
    const file = await exportCurrent();
    const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    statusLabel.textContent = `${file.name} exported`;
  } catch (error) { console.error(error); studio().toast(error.message, 'error', 6500); statusLabel.textContent = error.message; }
}

document.querySelector('#image-open').addEventListener('click', () => input.click());
input.addEventListener('change', () => { const [file] = input.files; openImage(file); input.value = ''; });
downloadButton.addEventListener('click', downloadCurrent);
updateFileUi();

window.tool = Object.freeze({
  open: openImage,
  get: exportCurrent,
  replace(_id, file) { return openImage(file); },
});
