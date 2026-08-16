import { decodeGim, encodeGim, inspectGim, replaceGimImage, formatName } from './gim-codec.js';

const sourceInput = document.querySelector('#source-input');
const replaceInput = document.querySelector('#replace-input');
const openSourceButton = document.querySelector('#open-source');
const openEmptyButton = document.querySelector('#open-empty');
const replaceButton = document.querySelector('#replace-image');
const exportPngButton = document.querySelector('#export-png');
const exportJpgButton = document.querySelector('#export-jpg');
const emptyState = document.querySelector('#empty-state');
const workspace = document.querySelector('#workspace');
const dropRoot = document.querySelector('#drop-root');
const canvas = document.querySelector('#preview-canvas');
const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
const createFormat = document.querySelector('#create-format');
const createOrder = document.querySelector('#create-order');
const createPitchAlign = document.querySelector('#create-pitch-align');
const createHeightAlign = document.querySelector('#create-height-align');
const alignmentFields = document.querySelector('#alignment-fields');
const createProfileNotice = document.querySelector('#create-profile-notice');
const orderField = document.querySelector('#order-field');
const buildGimButton = document.querySelector('#build-gim');
const pictureField = document.querySelector('#picture-field');
const pictureSelect = document.querySelector('#picture-select');
const toolbarMode = document.querySelector('#toolbar-mode');
const status = document.querySelector('#status');
const statusDetail = document.querySelector('#status-detail');
const factFile = document.querySelector('#fact-file');
const factSize = document.querySelector('#fact-size');
const factFormat = document.querySelector('#fact-format');
const factOrder = document.querySelector('#fact-order');
const factPalette = document.querySelector('#fact-palette');
const factAlign = document.querySelector('#fact-align');
const pngResource = document.querySelector('#png-resource');
const jpgResource = document.querySelector('#jpg-resource');
const gimResource = document.querySelector('#gim-resource');

const fallbackStudio = {
  toast(message, kind = 'info') { (kind === 'error' ? console.error : console.info)(message); },
  title(value) { if (value) document.title = value; },
  dirty() {}
};
const studio = () => window.studio || fallbackStudio;

const state = {
  mode: null,
  sourceFile: null,
  sourceBytes: null,
  gimInfo: null,
  pictureIndex: 0,
  rgba: null,
  width: 0,
  height: 0,
  pngFile: null,
  jpgFile: null,
  gimFile: null,
  resourceIds: { source: 'source', png: 'png-output', jpg: 'jpg-output', gim: 'gim-output' },
  serial: 0,
  modifiedGim: false
};

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

function basename(name = 'texture') { return String(name).replace(/\\/g, '/').split('/').pop() || 'texture'; }
function stem(name = 'texture') { return basename(name).replace(/\.[^.]*$/, '') || 'texture'; }
function extension(name = '') { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
function isGimFile(file) { return extension(file?.name) === 'gim' || file?.type === 'application/x-psp-gim'; }
function isBrowserImage(file) { return String(file?.type || '').startsWith('image/') || ['png','jpg','jpeg','webp','bmp','gif','avif'].includes(extension(file?.name)); }

function setStatus(message, detail = null) {
  status.textContent = message;
  if (detail !== null) statusDetail.textContent = detail;
}

function failUi(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message, 'Error');
  studio().toast(message, 'error', 7000);
  console.error(error);
}

function fileFromBytes(bytes, name, type) { return new File([bytes], name, { type }); }

function dataUrlToFile(dataUrl, name) {
  const [head, body] = dataUrl.split(',', 2);
  const mime = /data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream';
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

function makeJpegFile(name) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return dataUrlToFile(flat.toDataURL('image/jpeg', 0.94), name);
}

function updateResourceId(element, key, id) {
  state.resourceIds[key] = id;
  element.dataset.file = id;
}

function refreshImageExports() {
  if (!state.rgba) return;
  const base = stem(state.sourceFile?.name || 'texture');
  state.pngFile = dataUrlToFile(canvas.toDataURL('image/png'), `${base}.png`);
  state.jpgFile = makeJpegFile(`${base}.jpg`);
  updateResourceId(pngResource, 'png', `output/${state.pngFile.name}`);
  updateResourceId(jpgResource, 'jpg', `output/${state.jpgFile.name}`);
  pngResource.disabled = false;
  jpgResource.disabled = false;
  exportPngButton.disabled = false;
  exportJpgButton.disabled = false;
}

function setGimOutput(bytes, name) {
  state.gimFile = fileFromBytes(bytes, name, 'application/x-psp-gim');
  updateResourceId(gimResource, 'gim', `output/${name}`);
  gimResource.disabled = false;
}

function clearGimOutput() {
  state.gimFile = null;
  gimResource.disabled = true;
  updateResourceId(gimResource, 'gim', 'gim-output');
}

function renderRgba(rgba, width, height) {
  canvas.width = width;
  canvas.height = height;
  const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  canvas.classList.toggle('pixelated', width <= 256 && height <= 256);
  state.rgba = pixels;
  state.width = width;
  state.height = height;
  refreshImageExports();
}

function updateCommonUi() {
  emptyState.classList.add('hidden');
  workspace.classList.remove('hidden');
  factFile.textContent = state.sourceFile?.name || '-';
  factSize.textContent = state.sourceFile ? formatBytes(state.sourceFile.size) : '-';
  updateResourceId(document.querySelector('#preview-stage'), 'source', `source/${basename(state.sourceFile?.name || 'source')}`);
  studio().title(`${state.sourceFile?.name || 'Texture'} - GIM Studio`);
}

function fillPictureSelect() {
  pictureSelect.replaceChildren();
  const pictures = state.gimInfo?.pictures || [];
  for (const picture of pictures) {
    const option = document.createElement('option');
    option.value = String(picture.index);
    option.textContent = `#${picture.index + 1} - ${picture.width}x${picture.height} ${picture.formatName}`;
    pictureSelect.append(option);
  }
  pictureSelect.value = String(state.pictureIndex);
  pictureField.classList.toggle('hidden', pictures.length <= 1);
}

function updateGimFacts(metadata) {
  factFormat.textContent = `${metadata.formatName} (${metadata.bpp} bpp align)`;
  factOrder.textContent = metadata.pixelOrderName;
  factPalette.textContent = metadata.paletteFormatName || 'none';
  factAlign.textContent = `${metadata.pitchAlign} x ${metadata.heightAlign}`;
  toolbarMode.textContent = `GIM picture ${state.pictureIndex + 1}/${state.gimInfo.pictureCount}`;
  setStatus(state.sourceFile.name, `${metadata.width}x${metadata.height} - ${metadata.formatName}`);
}

async function openGim(file) {
  const serial = ++state.serial;
  setStatus(`Reading ${file.name}...`, 'Parsing GIM');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (serial !== state.serial) return;
  const info = inspectGim(bytes);
  state.mode = 'gim';
  state.sourceFile = file;
  state.sourceBytes = bytes;
  state.gimInfo = info;
  state.pictureIndex = 0;
  state.modifiedGim = false;
  document.body.classList.remove('mode-image');
  document.body.classList.add('mode-gim');
  replaceButton.disabled = false;
  clearGimOutput();
  fillPictureSelect();
  const decoded = decodeGim(bytes, 0);
  if (serial !== state.serial) return;
  renderRgba(decoded.rgba, decoded.width, decoded.height);
  updateGimFacts(decoded.metadata);
  updateCommonUi();
  studio().dirty(false);
}

async function decodeBrowserImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const temp = document.createElement('canvas');
    temp.width = bitmap.width;
    temp.height = bitmap.height;
    const ctx = temp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, temp.width, temp.height);
    return { rgba: image.data, width: temp.width, height: temp.height };
  } finally {
    bitmap.close?.();
  }
}

function selectedFormat() { return Number(createFormat.value); }
function selectedOrder() { return Number(createOrder.value); }
function selectedPitchAlign() { return Number(createPitchAlign.value); }
function selectedHeightAlign() { return Number(createHeightAlign.value); }

function applyCustomDefaults(reason) {
  const format = selectedFormat();
  const dxt = [8, 9, 10].includes(format);
  if (dxt) {
    createOrder.value = '0';
    createPitchAlign.value = '4';
    createHeightAlign.value = '4';
    return;
  }
  if (selectedOrder() === 1) {
    createPitchAlign.value = '16';
    createHeightAlign.value = '8';
    return;
  }
  if (reason === 'format' || reason === 'order') {
    createPitchAlign.value = '16';
    createHeightAlign.value = '1';
  }
}

function updateCreateControls() {
  const dxt = [8, 9, 10].includes(selectedFormat());
  createFormat.disabled = false;
  createOrder.disabled = dxt;
  createPitchAlign.disabled = selectedOrder() === 1 || dxt;
  createHeightAlign.disabled = true;
  orderField.title = dxt ? 'DXT GIMs are emitted with normal pixel order.' : selectedOrder() === 1 ? 'PSP faster storage uses 16-byte x 8-row swizzle blocks.' : '';
  alignmentFields.title = selectedOrder() === 1 ? 'PSP swizzled storage uses PitchAlign 16 and HeightAlign 8.' : dxt ? 'DXT profiles verified here use PitchAlign 4 and HeightAlign 4.' : 'PitchAlign controls the normal row stride. HeightAlign is kept at the verified normal value 1 for new non-DXT files.';
  createProfileNotice.querySelector('strong').textContent = 'Profile matters';
  createProfileNotice.querySelector('span').textContent = 'There is no single universal PSP GIM layout. For an existing asset, open the original GIM and use Replace image. New GIM settings must match the profile expected by the target software.';
}

function buildFromCurrentImage({ markDirty = true } = {}) {
  if (state.mode !== 'image' || !state.rgba) return;
  updateCreateControls();
  const format = selectedFormat();
  const pixelOrder = selectedOrder();
  const pitchAlign = selectedPitchAlign();
  const heightAlign = selectedHeightAlign();
  setStatus('Building GIM...', `${formatName(format)} - ${pixelOrder ? 'faster' : 'normal'} - ${pitchAlign}/${heightAlign}`);
  const bytes = encodeGim({ rgba: state.rgba, width: state.width, height: state.height, format, pixelOrder, paletteFormat: 3, pitchAlign, heightAlign, palettePitchAlign: 16, paletteHeightAlign: 1 });
  setGimOutput(bytes, `${stem(state.sourceFile.name)}.gim`);
  factFormat.textContent = formatName(format);
  factOrder.textContent = pixelOrder ? 'faster (swizzled)' : 'normal';
  factPalette.textContent = [4,5,6,7].includes(format) ? 'RGBA8888 / 256 entries' : 'none';
  factAlign.textContent = `${pitchAlign} x ${heightAlign}`;
  setStatus('GIM ready', `${state.width}x${state.height} - ${formatName(format)} - align ${pitchAlign}/${heightAlign} - ${formatBytes(bytes.length)}`);
  if (markDirty) studio().dirty(true);
}

async function openRegularImage(file) {
  const serial = ++state.serial;
  setStatus(`Opening ${file.name}...`, 'Decoding image');
  const decoded = await decodeBrowserImage(file);
  if (serial !== state.serial) return;
  state.mode = 'image';
  state.sourceFile = file;
  state.sourceBytes = null;
  state.gimInfo = null;
  state.pictureIndex = 0;
  state.modifiedGim = false;
  document.body.classList.remove('mode-gim');
  document.body.classList.add('mode-image');
  replaceButton.disabled = true;
  pictureField.classList.add('hidden');
  renderRgba(decoded.rgba, decoded.width, decoded.height);
  factFormat.textContent = extension(file.name).toUpperCase() || file.type || 'IMAGE';
  factOrder.textContent = '-';
  factPalette.textContent = '-';
  factAlign.textContent = '-';
  toolbarMode.textContent = 'Image -> GIM';
  updateCommonUi();
  updateCreateControls();
  buildFromCurrentImage({ markDirty: false });
  studio().dirty(false);
}

async function openSource(file) {
  if (!(file instanceof Blob)) return;
  try {
    if (isGimFile(file)) await openGim(file);
    else if (isBrowserImage(file)) await openRegularImage(file);
    else {
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const magic = String.fromCharCode(...head);
      if (magic.startsWith('MIG.00.1PSP\0')) await openGim(file);
      else throw new Error('GIM Studio accepts .gim, PNG, JPEG, WebP and BMP files.');
    }
  } catch (error) { failUi(error); throw error; }
}

async function selectPicture(index) {
  if (state.mode !== 'gim' || !state.sourceBytes) return;
  state.pictureIndex = index;
  const decoded = decodeGim(state.sourceBytes, index);
  renderRgba(decoded.rgba, decoded.width, decoded.height);
  if (state.modifiedGim) setGimOutput(state.sourceBytes, state.sourceFile.name || 'texture.gim');
  else clearGimOutput();
  updateGimFacts(decoded.metadata);
  studio().dirty(state.modifiedGim);
}

async function replaceWithImage(file) {
  if (state.mode !== 'gim' || !state.sourceBytes) throw new Error('Open a GIM before replacing its texture.');
  if (!isBrowserImage(file)) throw new Error('Replacement must be a PNG, JPEG, WebP or BMP image.');
  setStatus(`Decoding ${file.name}...`, 'Replacement');
  const decoded = await decodeBrowserImage(file);
  if (decoded.width !== state.width || decoded.height !== state.height) throw new Error(`Replacement must be exactly ${state.width}x${state.height}. Got ${decoded.width}x${decoded.height}.`);
  const rebuilt = replaceGimImage(state.sourceBytes, decoded.rgba, decoded.width, decoded.height, state.pictureIndex);
  state.sourceBytes = rebuilt;
  state.gimInfo = inspectGim(rebuilt);
  state.modifiedGim = true;
  const preview = decodeGim(rebuilt, state.pictureIndex);
  renderRgba(preview.rgba, preview.width, preview.height);
  updateGimFacts(preview.metadata);
  setGimOutput(rebuilt, state.sourceFile.name || 'texture.gim');
  setStatus('Replacement encoded', `${formatName(state.gimInfo.pictures[state.pictureIndex].format)} preserved - ${formatBytes(rebuilt.length)}`);
  studio().dirty(true);
  studio().toast('GIM rebuilt without changing its original container layout.', 'success', 4500);
}

function downloadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

openSourceButton.addEventListener('click', () => sourceInput.click());
openEmptyButton.addEventListener('click', () => sourceInput.click());
sourceInput.addEventListener('change', () => { const [file] = sourceInput.files; if (file) openSource(file).catch(() => {}); sourceInput.value = ''; });
replaceButton.addEventListener('click', () => replaceInput.click());
replaceInput.addEventListener('change', () => { const [file] = replaceInput.files; if (file) replaceWithImage(file).catch(failUi); replaceInput.value = ''; });
exportPngButton.addEventListener('click', () => downloadFile(state.pngFile));
exportJpgButton.addEventListener('click', () => downloadFile(state.jpgFile));
pngResource.addEventListener('click', () => { if (!document.documentElement.dataset.studioHosted) downloadFile(state.pngFile); });
jpgResource.addEventListener('click', () => { if (!document.documentElement.dataset.studioHosted) downloadFile(state.jpgFile); });
gimResource.addEventListener('click', () => { if (!document.documentElement.dataset.studioHosted) downloadFile(state.gimFile); });
buildGimButton.addEventListener('click', () => { try { buildFromCurrentImage(); } catch (error) { failUi(error); } });
createFormat.addEventListener('change', () => { applyCustomDefaults('format'); updateCreateControls(); clearGimOutput(); setStatus('Format changed. Build the GIM to refresh the output.', formatName(selectedFormat())); studio().dirty(true); });
createOrder.addEventListener('change', () => { applyCustomDefaults('order'); updateCreateControls(); clearGimOutput(); setStatus('Pixel order changed. Build the GIM to refresh the output.', createOrder.value === '1' ? 'faster' : 'normal'); studio().dirty(true); });
for (const input of [createPitchAlign, createHeightAlign]) input.addEventListener('change', () => { updateCreateControls(); clearGimOutput(); setStatus('Alignment changed. Build the GIM to refresh the output.', `${selectedPitchAlign()} / ${selectedHeightAlign()}`); studio().dirty(true); });
pictureSelect.addEventListener('change', () => selectPicture(Number(pictureSelect.value)).catch(failUi));

dropRoot.addEventListener('dragover', event => {
  if (!document.documentElement.dataset.studioHosted && event.dataTransfer?.types?.includes('Files')) event.preventDefault();
});
dropRoot.addEventListener('drop', event => {
  if (document.documentElement.dataset.studioHosted) return;
  const [file] = event.dataTransfer?.files || [];
  if (file) { event.preventDefault(); openSource(file).catch(() => {}); }
});

window.tool = Object.freeze({
  open: openSource,
  get(id) {
    if (id === state.resourceIds.source) return state.sourceFile;
    if (id === state.resourceIds.png) return state.pngFile;
    if (id === state.resourceIds.jpg) return state.jpgFile;
    if (id === state.resourceIds.gim) return state.gimFile;
  },
  async replace(id, file) {
    if (id !== state.resourceIds.source) return;
    if (state.mode === 'gim' && isBrowserImage(file)) await replaceWithImage(file);
    else await openSource(file);
  }
});
