const TOOL_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MAX_CATALOG_TOOLS = 256;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const CATALOG_TIMEOUT_MS = 7000;
const MANIFEST_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_TOOL_LOADS = 8;
const MAX_REGISTRY_LOAD_MS = 20000;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function normalizeStringList(value, field, id, maxItems = 128, maxLength = 256) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid tool.json for ${id}: ${field} must be an array of strings.`);
  if (value.length > maxItems) throw new Error(`Invalid tool.json for ${id}: ${field} exceeds the ${maxItems}-item limit.`);
  const out = []; const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Invalid tool.json for ${id}: ${field} must contain only strings.`);
    const clean = item.trim();
    if (!clean || clean.length > maxLength) throw new Error(`Invalid tool.json for ${id}: ${field} contains an invalid value.`);
    if (!seen.has(clean)) { seen.add(clean); out.push(clean); }
  }
  return out;
}

function validAcceptRule(rule) {
  return rule === '*' || (!/[\\/\x00-\x1F\x7F]/.test(rule) && (rule.startsWith('.') ? rule.length > 1 : !rule.startsWith('.')));
}

function normalizeToolId(value) {
  if (typeof value !== 'string') throw new Error('Invalid tool catalog entry.');
  const id = value.trim().replace(/^\.\//, '').replace(/\/$/, '');
  if (!id || !TOOL_ID_RE.test(id) || id.length > 128) throw new Error(`Invalid tool id: ${value}`);
  return id;
}

function resolveToolIcon(value, baseUrl) {
  if (value == null || value === '') return new URL('../../assets/tool-default.svg', baseUrl).href;
  if (typeof value !== 'string') throw new Error('Tool icon must be a relative path string.');
  const raw = value.trim();
  if (!raw || raw.length > 512 || raw.startsWith('/') || raw.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error('Tool icon must be relative to the tool folder.');
  const parts = raw.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) throw new Error('Tool icon cannot escape the tool folder.');
  const url = new URL(raw, baseUrl);
  if (!url.href.startsWith(baseUrl.href)) throw new Error('Tool icon cannot escape the tool folder.');
  if (url.pathname.endsWith('/')) throw new Error('Tool icon must reference a file.');
  return url.href;
}

function requiredString(value, field, id, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Incomplete tool.json for ${id}: ${field} is required.`);
  const clean = value.trim();
  if (clean.length > maxLength) throw new Error(`Invalid tool.json for ${id}: ${field} is too long.`);
  return clean;
}

async function readTextLimited(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} is unexpectedly large.`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`${label} is unexpectedly large.`);
    return text;
  }
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new Error(`${label} is unexpectedly large.`); }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return utf8Decoder.decode(bytes); }
  catch { throw new Error(`${label} is not valid UTF-8.`); }
}

async function withFetchTimeout(label, timeoutMs, action) {
  const signal = AbortSignal.timeout(timeoutMs);
  try { return await action(signal); }
  catch (error) {
    if (signal.aborted) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`, { cause: error });
    throw error;
  }
}

async function fetchJson(url, { timeoutMs, maxBytes, label }) {
  return withFetchTimeout(label, timeoutMs, async (signal) => {
    const response = await fetch(url, { cache: 'no-cache', redirect: 'error', signal });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    if (response.redirected) throw new Error(`${label} must not redirect.`);
    const text = await readTextLimited(response, maxBytes, label);
    try { return JSON.parse(text); }
    catch { throw new Error(`${label} is not valid JSON.`); }
  });
}

async function assertToolPageAvailable(url, id, timeoutMs) {
  const label = `${id}/index.html`;
  return withFetchTimeout(label, timeoutMs, async (signal) => {
    let response = await fetch(url, { method: 'HEAD', cache: 'no-cache', redirect: 'error', signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-cache', redirect: 'error', signal });
      try { await response.body?.cancel?.(); } catch {}
    }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    if (response.redirected) throw new Error(`${label} must not redirect.`);
  });
}

function remainingTimeout(deadlineAt, cap) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Tool catalog discovery exceeded its time budget.');
  return Math.min(cap, remaining);
}

async function mapSettledLimited(items, mapper, deadlineAt) {
  const results = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_TOOL_LOADS, items.length) }, async () => {
    while (true) {
      const index = cursor; cursor += 1;
      if (index >= items.length) return;
      if (Date.now() >= deadlineAt) { results[index] = { status: 'rejected', reason: new Error('Tool catalog discovery exceeded its time budget.') }; continue; }
      try { results[index] = { status: 'fulfilled', value: await mapper(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

export class Registry {
  #catalogUrl;
  #items = new Map();
  #errors = Object.freeze([]);
  #loadGeneration = 0;

  constructor(catalogUrl) {
    this.#catalogUrl = catalogUrl instanceof URL ? catalogUrl : new URL(catalogUrl, document.baseURI);
  }

  async load() {
    const generation = ++this.#loadGeneration;
    const errors = [];
    const nextItems = new Map();
    const deadlineAt = Date.now() + MAX_REGISTRY_LOAD_MS;

    const catalog = await fetchJson(this.#catalogUrl, { timeoutMs: CATALOG_TIMEOUT_MS, maxBytes: MAX_CATALOG_BYTES, label: 'Tool catalog' });
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || !Array.isArray(catalog.core) || !Array.isArray(catalog.tools)) {
      throw new Error('Invalid tools/catalog.json. Expected { "core": [], "tools": [] }.');
    }
    const coreRefs = catalog.core;
    const regularRefs = catalog.tools;
    if (coreRefs.length + regularRefs.length > MAX_CATALOG_TOOLS) throw new Error(`Tool catalog exceeds the ${MAX_CATALOG_TOOLS}-tool safety limit.`);

    const refsById = new Map();
    for (const [refs, core] of [[coreRefs, true], [regularRefs, false]]) for (const rawRef of refs) {
      try {
        const id = normalizeToolId(rawRef);
        if (!refsById.has(id) || core) refsById.set(id, core);
      } catch (error) {
        errors.push({ id: String(rawRef ?? ''), error });
      }
    }
    const normalizedRefs = [...refsById];

    const results = await mapSettledLimited(normalizedRefs, async ([id, core]) => {
      const baseUrl = new URL(`./${id}/`, this.#catalogUrl);
      const manifestUrl = new URL('tool.json', baseUrl);
      const raw = await fetchJson(manifestUrl, { timeoutMs: remainingTimeout(deadlineAt, MANIFEST_TIMEOUT_MS), maxBytes: MAX_MANIFEST_BYTES, label: `${id}/tool.json` });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid tool.json for ${id}.`);
      if (raw.api !== 1) throw new Error(`${id} uses Tool API v${raw.api ?? '?'}, Studio supports v1.`);
      const name = requiredString(raw.name, 'name', id, 160);
      const description = requiredString(raw.description, 'description', id, 1200);
      const author = requiredString(raw.author, 'author', id, 160);
      const version = requiredString(raw.version, 'version', id, 64);
      if (raw.subtitle != null && typeof raw.subtitle !== 'string') throw new Error(`Invalid tool.json for ${id}: subtitle must be a string.`);
      const subtitle = raw.subtitle?.trim() || '';
      if (subtitle.length > 240) throw new Error(`Invalid tool.json for ${id}: subtitle is too long.`);
      const accepts = Object.freeze(normalizeStringList(raw.accepts, 'accepts', id));
      if (accepts.some((rule) => !validAcceptRule(rule))) throw new Error(`Invalid tool.json for ${id}: accepts contains an invalid file rule.`);
      const keywords = Object.freeze(normalizeStringList(raw.keywords, 'keywords', id));
      const pageUrl = new URL('index.html', baseUrl).href;
      await assertToolPageAvailable(pageUrl, id, remainingTimeout(deadlineAt, MANIFEST_TIMEOUT_MS));
      return Object.freeze({
        id,
        core,
        name,
        subtitle,
        description,
        author,
        version,
        accepts,
        keywords,
        pageUrl,
        iconUrl: resolveToolIcon(raw.icon, baseUrl),
      });
    }, deadlineAt);

    results.forEach((result, index) => {
      const id = normalizedRefs[index][0];
      if (result.status === 'fulfilled') nextItems.set(id, result.value);
      else errors.push({ id, error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)) });
    });
    if (generation === this.#loadGeneration) {
      this.#items = nextItems;
      this.#errors = Object.freeze(errors.map((item) => Object.freeze(item)));
    }
    return this;
  }

  get errors() { return this.#errors; }
  get(id) { return this.#items.get(id); }
  all() { return [...this.#items.values()]; }
  findHandlers(fileName = '') {
    const name = String(fileName).toLowerCase();
    return this.all().filter((manifest) => manifest.accepts.some((rule) => {
      const normalized = rule.toLowerCase();
      if (normalized === '*') return true;
      if (normalized.startsWith('.')) return name.endsWith(normalized);
      return name === normalized;
    }));
  }
}
