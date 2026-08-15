import { decryptPrxBuffer, loadPspCryptoEngine } from './psp-crypto-engine.js';
import { decryptExecutable, formatBytes, inspectExecutable, outputElfName } from './psp-executable.js';

const fallbackStudio = { toast: console.info, dirty() {}, title(value) { if (value) document.title = value; } };
const studio = () => window.studio || fallbackStudio;
const el = (selector) => document.querySelector(selector);
const state = { sourceFile: null, sourceBytes: null, info: null, outputFile: null, busy: false };

function setStatus(message) { el('#decrypt-status').textContent = message; }
function setEngineState(kind, label) {
  const dot = el('#engine-dot');
  dot.className = `engine-dot${kind ? ` ${kind}` : ''}`;
  el('#engine-label').textContent = label;
}
function setBusy(value) {
  state.busy = Boolean(value);
  el('#decrypt-run').disabled = !state.sourceFile || state.busy;
  el('#decrypt-open').disabled = state.busy;
  el('#output-card').classList.toggle('busy', state.busy);
}
function resetOutput() {
  state.outputFile = null;
  const card = el('#output-card');
  card.classList.remove('ready'); card.classList.add('unavailable');
  card.removeAttribute('data-file');
  el('#output-name').textContent = 'Waiting for decryption';
  el('#output-meta').textContent = 'The verified ELF will appear here.';
  el('#drag-note').textContent = 'Decrypt a file first';
  el('#decrypt-download').disabled = true;
  studio().dirty(false);
}
function renderInfo() {
  const info = state.info;
  if (!info) {
    for (const id of ['#detail-module','#detail-psp-size','#detail-elf-size','#detail-compression','#detail-tag','#detail-container']) el(id).textContent = '-';
    return;
  }
  el('#detail-module').textContent = info.moduleName || '-';
  el('#detail-psp-size').textContent = formatBytes(info.pspSize || info.payloadSize);
  el('#detail-elf-size').textContent = info.elfSize ? formatBytes(info.elfSize) : (info.kind === 'elf' ? formatBytes(info.payloadSize) : '-');
  el('#detail-compression').textContent = info.kind === 'elf' ? 'None' : (info.isGzip ? 'GZIP' : 'None');
  el('#detail-tag').textContent = info.tagText || '-';
  el('#detail-container').textContent = info.container || '-';
}
function renderSource() {
  const file = state.sourceFile;
  const info = state.info;
  el('#source-name').textContent = file?.name || 'Open or drop EBOOT.BIN';
  el('#source-format').textContent = info ? (info.kind === 'elf' ? 'ELF' : '~PSP') : 'No file';
  el('#source-meta').textContent = file
    ? `${formatBytes(file.size)}${info?.moduleName && info.moduleName !== '-' ? ` | ${info.moduleName}` : ''}`
    : 'Encrypted ~PSP executables and PRX files are supported.';
  renderInfo();
}

async function openExecutable(file) {
  if (!file || state.busy) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = inspectExecutable(bytes);
    state.sourceFile = file;
    state.sourceBytes = bytes;
    state.info = info;
    resetOutput(); renderSource();
    el('#decrypt-run').disabled = false;
    setStatus(info.kind === 'elf' ? `${file.name} is already an ELF executable.` : `${file.name} loaded and ready to decrypt.`);
    studio().title(`${file.name} - EBOOT Decrypter`);
    studio().toast(info.kind === 'elf' ? 'This executable is already decrypted.' : 'PSP executable loaded locally.', 'success');
  } catch (error) {
    console.error(error);
    studio().toast(`Could not open executable: ${error.message}`, 'error', 6500);
    setStatus(error.message);
  }
}

async function runDecrypt() {
  if (!state.sourceFile || !state.sourceBytes || state.busy) return;
  setBusy(true); resetOutput();
  try {
    if (state.info?.kind !== 'elf') {
      setEngineState('loading', 'Loading KIRK engine');
      setStatus('Loading PSP crypto engine...');
      await loadPspCryptoEngine();
      setEngineState('ready', 'KIRK engine ready');
      setStatus(`Decrypting ${state.sourceFile.name}...`);
    }

    const result = await decryptExecutable(state.sourceBytes, decryptPrxBuffer);
    const name = outputElfName(state.sourceFile.name);
    state.outputFile = new File([result.bytes], name, { type: 'application/octet-stream' });

    const card = el('#output-card');
    card.dataset.file = name; card.classList.remove('unavailable'); card.classList.add('ready');
    el('#output-name').textContent = name;
    el('#output-meta').textContent = `${formatBytes(state.outputFile.size)} | verified ELF executable`;
    el('#drag-note').textContent = 'Drag this ELF into the Project Explorer';
    el('#decrypt-download').disabled = false;
    studio().dirty(false);

    if (result.alreadyElf) {
      setStatus(`${name} prepared. The input was already a valid ELF.`);
      studio().toast('The executable was already decrypted. ELF output is ready.', 'success');
    } else if (result.usedEmbeddedElf) {
      setStatus(`${name} extracted from the executable container.`);
      studio().toast('Embedded ELF extracted and verified.', 'success');
    } else {
      setStatus(`${name} decrypted successfully. Drag the output tile into the Project Explorer.`);
      studio().toast('EBOOT decrypted to a verified ELF.', 'success');
    }
  } catch (error) {
    console.error(error);
    setEngineState('error', 'Decrypt failed');
    setStatus(error.message);
    studio().toast(error.message, 'error', 7000);
  } finally {
    setBusy(false);
  }
}

function downloadOutput() {
  if (!state.outputFile) return;
  const url = URL.createObjectURL(state.outputFile);
  const link = document.createElement('a');
  link.href = url; link.download = state.outputFile.name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setStatus(`${state.outputFile.name} downloaded.`);
}

const input = el('#decrypt-input');
el('#decrypt-open').addEventListener('click', () => input.click());
input.addEventListener('change', () => { const [file] = input.files || []; openExecutable(file); input.value = ''; });
el('#decrypt-run').addEventListener('click', runDecrypt);
el('#decrypt-download').addEventListener('click', downloadOutput);

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!state.busy) input.click(); }
});

window.tool = Object.freeze({
  open: openExecutable,
  get(id) {
    if (id === 'source') return state.sourceFile || undefined;
    if (state.outputFile && (id === state.outputFile.name || id === 'result.elf')) return state.outputFile;
    return undefined;
  },
  replace(_id, file) { return openExecutable(file); },
});
