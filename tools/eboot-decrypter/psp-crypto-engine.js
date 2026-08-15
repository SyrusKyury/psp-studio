const UPSTREAM_COMMIT = '98a7203ecc507e584eafc21cd48a6ea2b2e791b4';
const UPSTREAM_BASE = `https://raw.githubusercontent.com/euan-forrester/save-file-converter/${UPSTREAM_COMMIT}/frontend/src/save-formats/PSP/psp-encryption`;
const ENGINE_JS_URL = `${UPSTREAM_BASE}/psp-encryption.js`;
const ENGINE_WASM_URL = `${UPSTREAM_BASE}/psp-encryption.wasm`;

let enginePromise = null;

async function fetchAsset(url, kind) {
  let response;
  try {
    response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  } catch (error) {
    throw new Error(`Could not load the PSP ${kind} engine. Check the Internet connection.`, { cause: error });
  }
  if (!response.ok) throw new Error(`Could not load the PSP ${kind} engine (HTTP ${response.status}).`);
  return response;
}

async function createEngine() {
  const [scriptResponse, wasmResponse] = await Promise.all([
    fetchAsset(ENGINE_JS_URL, 'JavaScript'),
    fetchAsset(ENGINE_WASM_URL, 'WebAssembly'),
  ]);

  const [scriptSource, wasmBinary] = await Promise.all([
    scriptResponse.text(),
    wasmResponse.arrayBuffer(),
  ]);

  const moduleUrl = URL.createObjectURL(new Blob([scriptSource], { type: 'text/javascript' }));
  try {
    const imported = await import(moduleUrl);
    const createModule = imported.default;
    if (typeof createModule !== 'function') throw new Error('The PSP crypto module did not expose its loader.');

    const module = await createModule({
      wasmBinary: new Uint8Array(wasmBinary),
      locateFile: (name) => name.endsWith('.wasm') ? ENGINE_WASM_URL : name,
    });

    if (typeof module._kirk_init !== 'function' || typeof module._decrypt_executable !== 'function' || typeof module._malloc !== 'function' || typeof module._free !== 'function' || !(module.HEAPU8 instanceof Uint8Array)) {
      throw new Error('The PSP crypto module is missing required exports.');
    }

    module._kirk_init();
    return module;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

export async function loadPspCryptoEngine() {
  if (!enginePromise) enginePromise = createEngine().catch((error) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

export async function decryptPrxBuffer(inputBytes, outputCapacity) {
  const module = await loadPspCryptoEngine();
  const input = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  const capacity = Math.max(input.length, Number(outputCapacity) || 0);
  if (!input.length || !capacity) throw new Error('The executable buffer is empty.');

  const inputPtr = module._malloc(input.length);
  const outputPtr = module._malloc(capacity);
  if (!inputPtr || !outputPtr) {
    if (inputPtr) module._free(inputPtr);
    if (outputPtr) module._free(outputPtr);
    throw new Error('The PSP crypto engine could not allocate enough memory.');
  }

  try {
    module.HEAPU8.set(input, inputPtr);
    module.HEAPU8.fill(0, outputPtr, outputPtr + capacity);
    const result = module._decrypt_executable(inputPtr, outputPtr, input.length);
    if (result <= 0) return { code: result, bytes: null };
    if (result > capacity) throw new Error(`The PSP crypto engine returned an invalid output size (${result} bytes).`);
    return { code: result, bytes: module.HEAPU8.slice(outputPtr, outputPtr + result) };
  } finally {
    module._free(outputPtr);
    module._free(inputPtr);
  }
}

export const PSP_CRYPTO_UPSTREAM = Object.freeze({
  commit: UPSTREAM_COMMIT,
  javascript: ENGINE_JS_URL,
  wasm: ENGINE_WASM_URL,
});
