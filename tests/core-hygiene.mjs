import { File } from 'node:buffer';
import { access, readFile, readdir } from 'node:fs/promises';
import { ProjectStore } from '../js/core/project-store.js';
import { Registry } from '../js/core/registry.js';
import { TransferRegistry } from '../js/core/transfer-registry.js';
import { TabManager } from '../js/core/tab-manager.js';
import { formatBytes, safeText, errorText, isAbortError } from '../shared/utils/format.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

// Keep the wrapper dependency graph statically analyzable and acyclic. Cycles are
// legal ECMAScript, but the core has no use case that justifies their harder
// linking/evaluation semantics.
async function collectJs(url) {
  const out = [];
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url);
    if (entry.isDirectory()) out.push(...await collectJs(child));
    else if (entry.name.endsWith('.js')) out.push(child);
  }
  return out;
}
const graphFiles = [...await collectJs(new URL('../js/', import.meta.url)), ...await collectJs(new URL('../shared/', import.meta.url))];
const importPattern = /(?:import\s+(?:[^'"]+?\s+from\s+)?|import\()\s*['"]([^'"]+)['"]/g;
const graph = new Map();
for (const url of graphFiles) {
  const source = await readFile(url, 'utf8');
  assert(!/\bimport\s*\(/.test(source), `Dynamic import entered the wrapper core: ${url.pathname}`);
  graph.set(url.href.split('?')[0], [...source.matchAll(importPattern)].map((match) => new URL(match[1].split('?')[0], url).href));
}
const visiting = new Set(); const visited = new Set();
function visitModule(url, trail = []) {
  if (visiting.has(url)) throw new Error(`Wrapper module cycle detected: ${[...trail, url].map((item) => item.split('/').at(-1)).join(' -> ')}`);
  if (visited.has(url) || !graph.has(url)) return;
  visiting.add(url);
  for (const dependency of graph.get(url)) visitModule(dependency, [...trail, url]);
  visiting.delete(url); visited.add(url);
}
for (const url of graph.keys()) visitModule(url);
async function rejects(fn, pattern, message) {
  try { await fn(); } catch (error) { if (!pattern || pattern.test(String(error?.message || error))) return; throw new Error(`${message}: unexpected error ${error?.message || error}`); }
  throw new Error(`${message}: expected rejection`);
}

// Dead/future-only code does not belong in the frozen wrapper baseline.
for (const relative of ['../shared/binary/reader.js', '../shared/psp/crypto']) {
  let exists = true;
  try { await access(new URL(relative, import.meta.url)); } catch { exists = false; }
  assert(!exists, `Dormant code returned to the core baseline: ${relative}`);
}

// Removed APIs had no production caller. Keep the shell surface deliberately small.
assert(!('snapshot' in ProjectStore.prototype), 'Dead ProjectStore.snapshot API returned');
assert(!('clearFileAssociation' in ProjectStore.prototype), 'Dead ProjectStore.clearFileAssociation API returned');
assert(!('pinnable' in Registry.prototype), 'Dead Registry.pinnable API returned');
assert(!('closeAll' in TabManager.prototype), 'Dead TabManager.closeAll API returned');
assert(!('flatten' in ProjectStore.prototype), 'Test-only ProjectStore.flatten API returned');
assert(!('safeName' in ProjectStore.prototype), 'Internal ProjectStore.safeName API returned');
assert(!('addFile' in ProjectStore.prototype), 'Redundant ProjectStore.addFile API returned');
assert(!('markSaved' in ProjectStore.prototype), 'ProjectStore exposes a public dirty-state bypass');
const privateIndexProject = new ProjectStore('Private indexes');
assert(!('nodesById' in privateIndexProject) && !('nodesByPath' in privateIndexProject), 'ProjectStore exposes mutable internal node indexes');
const immutableNameProject = new ProjectStore('Immutable Name');
try { immutableNameProject.name = 'Changed'; } catch {}
assert(immutableNameProject.name === 'Immutable Name', 'Project name can be mutated without a ProjectStore operation');
assert(!('core' in Registry.prototype), 'Redundant Registry.core convenience API returned');
for (const internal of ['ensureCapacity', 'ensurePayload', 'registerNode', 'unregisterSubtree', 'unindexSubtree', 'reindexSubtree', 'resolveNode', 'uniqueName']) assert(!(internal in ProjectStore.prototype), `Internal ProjectStore helper leaked onto the public class surface: ${internal}`);
assert(formatBytes(-1) === '-', 'Negative byte sizes must be rejected by the shared formatter');
const hostileText = new Proxy({}, { get() { throw new Error('hostile getter'); } });
const hostileString = { toString() { throw new Error('hostile toString'); } };
assert(safeText(hostileString, 32, 'fallback') === 'fallback', 'Shared presentation text normalization can throw on hostile values');
assert(errorText(hostileText, 'fallback') === 'fallback', 'Shared error normalization can throw on hostile values');
assert(isAbortError(hostileText) === false, 'Abort classification can throw on hostile values');

// Stateless/simple mechanisms must not regrow object wrappers or lookup tables.
const shortcutSource = await readFile(new URL('../js/core/shortcut-manager.js', import.meta.url), 'utf8');
assert(!shortcutSource.includes('class ShortcutManager'), 'Stateless ShortcutManager class returned');
const iconSource = await readFile(new URL('../js/core/file-icon-service.js', import.meta.url), 'utf8');
assert(!iconSource.includes('const ICONS'), 'Redundant file-icon filename map returned');
assert(!iconSource.includes('export function fileIconKind'), 'Internal file icon categorizer became public again');
const blobSource = await readFile(new URL('../js/core/blob-utils.js', import.meta.url), 'utf8');
assert(!blobSource.includes('asBlobLike'), 'Removed Blob compatibility wrapper returned');
const zipSource = await readFile(new URL('../shared/archive/zip-store.js', import.meta.url), 'utf8');
const registrySource = await readFile(new URL('../js/core/registry.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../js/core/ui-service.js', import.meta.url), 'utf8');
assert(!zipSource.includes('export async function crc32Blob'), 'Internal ZIP CRC helper became public again');
assert(registrySource.includes('#catalogUrl') && registrySource.includes('#items') && registrySource.includes('#errors') && registrySource.includes('#loadGeneration'), 'Registry internal state became publicly mutable again');

// There is one catalog schema. Legacy array catalogs are rejected rather than
// carrying compatibility branches forever.
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify(['old-tool']), { status: 200 });
  await rejects(() => new Registry(new URL('https://example.test/tools/catalog.json')).load(), /Expected \{ "core": \[\], "tools": \[\] \}/, 'Legacy catalog array was accepted');
} finally { globalThis.fetch = originalFetch; }

// Catalog/tool discovery never follows redirects into an unexpected resource.
try {
  globalThis.fetch = async () => {
    const response = new Response(JSON.stringify({ core: [], tools: [] }), { status: 200 });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  await rejects(() => new Registry(new URL('https://example.test/tools/catalog.json')).load(), /must not redirect/, 'Registry silently followed a redirected catalog');
} finally { globalThis.fetch = originalFetch; }

// Registry metadata exposed to the shell is normalized to what the shell uses.
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['one'], tools: [] }), { status: 200 });
    if (url.endsWith('/one/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'One', description: 'One tool', author: 'Audit', version: '1.0.0', icon: 'icon.svg', accepts: ['.bin'] }), { status: 200 });
    if (url.endsWith('/one/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const metadataRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  const tool = metadataRegistry.get('one');
  assert(tool?.pageUrl && tool.iconUrl, 'Required Registry metadata missing');
  assert(Object.isFrozen(metadataRegistry.errors), 'Registry error snapshot is externally mutable');
  assert(!('apiVersion' in tool), 'Registry still duplicates already-validated Tool API version metadata');
  for (const dead of ['api', 'icon', 'manifestUrl', 'baseUrl']) assert(!(dead in tool), `Registry still exposes unused metadata field: ${dead}`);
} finally { globalThis.fetch = originalFetch; }

// Registry reload is transactional: a fatal refresh failure cannot erase the
// last known-good catalog from the running Studio.
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['stable'], tools: [] }), { status: 200 });
    if (url.endsWith('/stable/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Stable', description: 'Stable tool', author: 'Audit', version: '1.0.0' }), { status: 200 });
    if (url.endsWith('/stable/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const stableRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  globalThis.fetch = async () => new Response('broken', { status: 503 });
  await rejects(() => stableRegistry.load(), /HTTP 503/, 'Fatal Registry reload unexpectedly succeeded');
  assert(stableRegistry.get('stable')?.name === 'Stable', 'Fatal Registry reload destroyed the last known-good catalog');
} finally { globalThis.fetch = originalFetch; }

// Concurrent Registry refreshes are generation-safe. An older slow load may
// finish later, but it must never overwrite the newer catalog already committed.
try {
  let catalogCalls = 0;
  let releaseSlowManifest;
  let slowManifestRequestedResolve;
  const slowManifestRequested = new Promise((resolve) => { slowManifestRequestedResolve = resolve; });
  const slowManifestGate = new Promise((resolve) => { releaseSlowManifest = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) {
      catalogCalls += 1;
      return new Response(JSON.stringify(catalogCalls === 1 ? { core: ['slow'], tools: [] } : { core: ['fast'], tools: [] }), { status: 200 });
    }
    if (url.endsWith('/slow/tool.json')) {
      slowManifestRequestedResolve();
      await slowManifestGate;
      return new Response(JSON.stringify({ api: 1, name: 'Slow', description: 'Old slow load', author: 'Audit', version: '1.0.0' }), { status: 200 });
    }
    if (url.endsWith('/fast/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Fast', description: 'New fast load', author: 'Audit', version: '1.0.0' }), { status: 200 });
    if (url.endsWith('/slow/index.html') || url.endsWith('/fast/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const concurrentRegistry = new Registry(new URL('https://example.test/tools/catalog.json'));
  const slowLoad = concurrentRegistry.load();
  await slowManifestRequested;
  await concurrentRegistry.load();
  assert(concurrentRegistry.get('fast')?.name === 'Fast' && !concurrentRegistry.get('slow'), 'Newer Registry load did not commit first');
  releaseSlowManifest();
  await slowLoad;
  assert(concurrentRegistry.get('fast')?.name === 'Fast' && !concurrentRegistry.get('slow'), 'Stale Registry load overwrote a newer catalog');
} finally { globalThis.fetch = originalFetch; }

// Bad file-handler declarations belong to the tool, not the wrapper. The
// Registry isolates the malformed tool and keeps the catalog usable.
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['bad'], tools: [] }), { status: 200 });
    if (url.endsWith('/bad/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Bad', description: 'Bad tool', author: 'Audit', version: '1.0.0', accepts: ['../escape.bin'] }), { status: 200 });
    if (url.endsWith('/bad/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const badRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(!badRegistry.get('bad') && /invalid file rule/i.test(badRegistry.errors[0]?.error?.message || ''), 'Malformed accepts rule escaped Registry isolation');
} finally { globalThis.fetch = originalFetch; }

// Optional manifest fields are optional, not loosely typed. Tool author errors
// are isolated instead of being silently normalized into surprising behavior.
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['bad-shape'], tools: [] }), { status: 200 });
    if (url.endsWith('/bad-shape/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Bad Shape', description: 'Bad manifest shape', author: 'Audit', version: '1.0.0', accepts: '.bin' }), { status: 200 });
    if (url.endsWith('/bad-shape/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const strictRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(!strictRegistry.get('bad-shape') && /array of strings/i.test(strictRegistry.errors[0]?.error?.message || ''), 'Malformed manifest list was silently normalized');
} finally { globalThis.fetch = originalFetch; }

// Resolved transfers expose only transfer semantics, not internal resolver/owner state.
const transfers = new TransferRegistry();
const owner = {};
const token = transfers.register({ kind: 'file', name: 'one.bin', owner, getResource: () => new Blob(['1']) });
const resolved = await transfers.consume(token, (item) => item);
assert(Object.keys(resolved).sort().join(',') === 'kind,name,resource', 'TransferRegistry leaked internal state in resolved payloads');
const hostileNameToken = transfers.register({ kind: 'file', name: hostileString, getResource: () => new Blob(['2']) });
const hostileNameTransfer = await transfers.consume(hostileNameToken, (item) => item);
assert(hostileNameTransfer.name === 'File', 'Malformed transfer display name escaped shared safe-text normalization');

// Persisted duplicate tabs collapse to one canonical descriptor.
const project = new ProjectStore('Dedup Tabs');
project.addBlob('/', 'a.bin', new Blob(['a']));
const tabs = [
  { editorId: 'one', filePath: '/a.bin', title: 'A' },
  { editorId: 'one', filePath: '/a.bin', title: 'Duplicate title should not matter for a file tab' },
];
const zip = await project.toZipBlob({ tabs });
const reopened = await ProjectStore.open(new File([zip], 'dedup.pspstudio'));
assert(reopened.manifest.tabs.length === 1 && reopened.manifest.tabs[0].filePath === '/a.bin', 'Saved tab descriptors are not canonical/deduplicated');

// Large Explorer trees must use event delegation rather than N listeners per row.
const explorerSource = await readFile(new URL('../js/core/project-explorer.js', import.meta.url), 'utf8');
assert(!explorerSource.includes("querySelectorAll('.project-node').forEach"), 'Project Explorer returned to per-row event listener binding');
assert(explorerSource.includes("tree.addEventListener('click'") && explorerSource.includes("tree.addEventListener('dragstart'"), 'Project Explorer event delegation guard missing');
for (const stale of ['boundProject', 'this.onProjectChange', 'data-project-root-drop', 'data-project-drop-surface']) assert(!explorerSource.includes(stale), `Project Explorer redundant lifecycle/DOM state returned: ${stale}`);
assert(!explorerSource.includes("tree.addEventListener('dragover'") && !explorerSource.includes("tree.addEventListener('drop'"), 'Explorer regrew a second tree-specific drop pipeline');

// ModuleHost must not retain dead iframe/session objects after the cleanup refactor.
const hostSource = await readFile(new URL('../js/core/module-host.js', import.meta.url), 'utf8');
for (const stale of ['loadController', 'transferTokens', 'this.current', 'this.observer']) assert(!hostSource.includes(stale), `ModuleHost still retains redundant lifecycle state: ${stale}`);
assert(hostSource.indexOf("iframe.addEventListener('load'") < hostSource.indexOf('this.container.appendChild(iframe)'), 'Tool iframe is attached before lifecycle handlers and can lose a fast load event');

// Timeout/abort semantics have one owner instead of drifting across lifecycle layers.
const asyncSource = await readFile(new URL('../js/core/async-utils.js', import.meta.url), 'utf8');
const transferSource = await readFile(new URL('../js/core/transfer-registry.js', import.meta.url), 'utf8');
assert(transferSource.includes('#items') && transferSource.includes('#activeControllers'), 'TransferRegistry lifecycle state became publicly mutable again');
assert('cancel' in TransferRegistry.prototype && !('forget' in TransferRegistry.prototype), 'TransferRegistry token cancellation contract is missing or ambiguously named');
assert(transferSource.includes('AbortSignal.any([controller.signal, signal])'), 'TransferRegistry returned to manual parent-signal listener bookkeeping');
assert(registrySource.includes('AbortSignal.timeout(timeoutMs)'), 'Registry returned to a custom fetch timeout timer instead of the platform AbortSignal timeout');
assert(explorerSource.includes("project?.addEventListener('change'") && explorerSource.includes('{ signal }') && !explorerSource.includes('projectCleanup'), 'Explorer project listener lifecycle is manually tracked again');
assert(asyncSource.includes('export async function waitBounded'), 'Shared bounded-wait primitive is missing');
const formatSource = await readFile(new URL('../shared/utils/format.js', import.meta.url), 'utf8');
assert(formatSource.includes('export function safeText') && !uiSource.includes('function safeText'), 'Presentation-safe text normalization has more than one owner again');
assert(asyncSource.includes("typeof task === 'function'"), 'Bounded-wait primitive no longer normalizes synchronous task failures');
assert(blobSource.includes('hasBlobBrand') && blobSource.includes('blob.size === value.size') && blobSource.includes('file.size === value.size'), 'Cross-realm Blob/File conversion can silently accept structural impostors or stringified malformed payloads');
for (const [name, source] of [['ModuleHost', hostSource], ['TransferRegistry', transferSource], ['ProjectExplorer', explorerSource]]) {
  assert(source.includes('waitBounded'), `${name} bypasses the shared bounded-wait primitive`);
  assert(!source.includes('function withTimeout'), `${name} regrew a private timeout helper`);
}

// Shell actions route to logical commands; do not reintroduce synthetic click proxies.
const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const tabSource = await readFile(new URL('../js/core/tab-manager.js', import.meta.url), 'utf8');
const projectSource = await readFile(new URL('../js/core/project-store.js', import.meta.url), 'utf8');
assert(projectSource.includes('function resolveNode(project, nodeOrPath)') && !projectSource.includes('  resolveNode('), 'ProjectStore node resolution escaped its module-private boundary');
assert(projectSource.includes('manifestBlob.size > MAX_MANIFEST_BYTES'), 'Project writer can emit a manifest its own reader rejects');
assert(zipSource.includes('maxCentralDirectoryBytes') && projectSource.includes('maxCentralDirectoryBytes: MAX_PROJECT_CENTRAL_DIRECTORY_BYTES'), 'Project writer can emit a central directory its own reader rejects');
assert(!appSource.includes('data-proxy-click') && !indexSource.includes('data-proxy-click'), 'Synthetic shell click proxy returned');
assert(appSource.includes('requiredElement(selector)') && appSource.includes('Studio shell is missing required element'), 'Studio shell no longer fails fast on structural DOM mismatches');
assert(appSource.includes('els.app.inert = projectBusy') && appSource.includes("aria-busy"), 'Project lifecycle operations no longer lock the Studio surface');
const openProjectBlock = appSource.slice(appSource.indexOf('els.openInput.onchange'), appSource.indexOf('async function saveProject'));
assert(openProjectBlock.indexOf('ProjectStore.open(file)') < openProjectBlock.indexOf('canReplaceProject()'), 'Project replacement confirmation moved before isolated project validation and can lose late dirty-state changes');
assert(hostSource.includes('A data-file target accepts exactly one file.'), 'Tool data-file drops silently accept ambiguous multi-file payloads again');
assert(hostSource.includes('normalizeToolApi') && hostSource.includes('tool.${name} must be a function'), 'Malformed Tool API methods are no longer rejected at the wrapper boundary');
assert(hostSource.includes('The source tool did not return a valid file resource.'), 'Tool transfer bridge no longer rejects malformed file resources explicitly');
assert(hostSource.includes("hasOwnProperty.call(win, 'studio')") && hostSource.includes("Object.defineProperty(win, 'studio'") && hostSource.includes('writable: false') && hostSource.includes('configurable: false'), 'Reserved presentation bridge can be preempted or overwritten by a tool again');
assert(asyncSource.includes('isStudioAbort'), 'Wrapper-owned cancellation is no longer distinguishable from a tool-thrown AbortError');
assert(uiSource.includes('safeText(') && uiSource.indexOf('const text = safeText') < uiSource.indexOf("document.createElement('div')"), 'Tool presentation input is normalized only after UI mutation');
assert(registrySource.includes('#loadGeneration') && registrySource.includes('generation === this.#loadGeneration'), 'Registry concurrent refresh generation guard is missing');
for (const stale of ['data-explorer-action', 'data-open-tool-menu', 'data-open-library-menu']) assert(!appSource.includes(stale) && !indexSource.includes(stale), `Duplicate shell command vocabulary returned: ${stale}`);
assert(appSource.includes('savedTabKey') && !appSource.includes('function tabDescriptorKey'), 'Saved tab key semantics drifted back into app.js');
assert(!projectSource.includes('this.nodeCount') && !projectSource.includes('this.kind = kind'), 'Project model regrew redundant derived state');
assert(projectSource.includes('#name') && projectSource.includes('#workspace') && projectSource.includes('#revision') && projectSource.includes('#savedRevision') && projectSource.includes('#payloadBytes'), 'Critical ProjectStore persistence state is publicly mutable again');
for (const stale of ["editorId: manifest.id", "kind: 'welcome'", "kind: 'studio'"]) assert(!tabSource.includes(stale), `TabManager regrew redundant live-tab state: ${stale}`);
const storeSource = await readFile(new URL('../js/views/tool-library.js', import.meta.url), 'utf8');
assert(!storeSource.includes('onChanged'), 'Tool Library duplicate manual rerender callback returned');
assert(!storeSource.includes('this.openTool'), 'Tool Library regrew a second tool-opening router');
assert(!appSource.includes('toolLibraryView'), 'Tool Library view leaked back into global shell lifecycle state');
assert(storeSource.includes('this.render();'), 'Tool Library no longer owns its own pin/unpin rerender');
assert(!storeSource.includes('!project || !tool || tool.core'), 'Core tools became artificially unpinnable again');
assert(explorerSource.includes('NON_TREE_PROJECT_CHANGES'), 'Workspace-only preference changes trigger pointless Explorer rebuilds again');

// Known dead CSS from pre-IDE layouts stays deleted.
const css = await Promise.all([
  readFile(new URL('../assets/css/base.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/css/components.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/css/shell.css', import.meta.url), 'utf8'),
]);
assert(!/sr-only|project-root-drop-hint|ide-inspector-icon/.test(css.join('\n')), 'Dead shell CSS selectors returned');

// Shared theme tokens must have a current stylesheet consumer.
const tokenCss = await readFile(new URL('../assets/css/tokens.css', import.meta.url), 'utf8');
const toolCss = await Promise.all(['umd-forge', 'sfo-studio', 'image-studio'].map((tool) => readFile(new URL(`../tools/${tool}/style.css`, import.meta.url), 'utf8')));
const cssUsage = [tokenCss, ...css, ...toolCss].join('\n');
const declaredTokens = new Set([...tokenCss.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]));
for (const token of declaredTokens) assert(cssUsage.includes(`var(--${token})`), `Unused shared CSS token returned: --${token}`);

// v0.14.5 shell reduction: wrapper UI contains only real responsibilities.
const helpSource = await readFile(new URL('../help.html', import.meta.url), 'utf8');
for (const stale of ['ide-toolbar', 'inspector-dock', 'studio-statusbar', 'sidebar-tools-list', 'theme-toggle', 'data-left-pane-content']) assert(!indexSource.includes(stale), `Removed shell surface returned: ${stale}`);
for (const stale of ['inspectorSource', 'showTabInspector', 'showProjectNodeInspector', 'safeStorageGet', 'psp-studio-theme', 'switchLeftPane', 'toggleInspector']) assert(!appSource.includes(stale), `Removed shell state returned: ${stale}`);
assert(!tabSource.includes('openWelcome') && !tabSource.includes("id = 'welcome'") && !css.join('\n').includes('studio-welcome'), 'Special Welcome tab returned');
assert(indexSource.includes('id="activity-tools-list"') && appSource.includes('renderToolAccess()'), 'Pinned tools are no longer rendered in the activity rail');
assert(indexSource.includes('href="./help.html"') && helpSource.includes('id="developer-guide"') && helpSource.includes('Tool API v1'), 'Help is not an independent static HTML page');
assert(helpSource.includes('v0.14.5') && !helpSource.includes('v0.12.8') && [...helpSource.matchAll(/\?v=([^"']+)/g)].every((match) => match[1] === '0.14.5'), 'Standalone Help page is not release/cache coherent with the frozen wrapper');
assert(indexSource.includes('content="dark"') && !tokenCss.includes('[data-theme=') && !appSource.includes('dataset.theme'), 'Light-theme machinery returned to the wrapper');
assert(!/data-menu-button|ide-menu-popup|ide-menubar/.test(indexSource) && !appSource.includes('closeIdeMenus'), 'Traditional top menus returned after the direct-action shell simplification');
for (const command of ['new', 'open', 'save']) assert(indexSource.includes(`data-shell-command="${command}"`), `Direct top-bar project command missing: ${command}`);
assert(indexSource.includes('id="activity-explorer"') && indexSource.includes('id="activity-search"') && indexSource.includes('id="activity-tool-library"') && indexSource.includes('href="./help.html"'), 'Final activity rail is incomplete');
assert(appSource.includes("combo: 'Mod+B'") && appSource.includes("combo: 'Mod+Shift+F'"), 'Sidebar/Search shortcuts are missing');
assert(explorerSource.includes('data-action="new-file"') && explorerSource.includes('data-action="new-folder"') && explorerSource.includes('data-action="import-files"'), 'Explorer quick actions are incomplete');
assert(!explorerSource.includes('data-action="rename"') && !explorerSource.includes('data-action="delete"'), 'Rename/Delete returned as redundant Explorer header controls');
assert(!explorerSource.includes('onSelectionChange') && !explorerSource.includes('notifySelection'), 'Inspector-era Explorer selection callback returned');

const projectSearchSource = await readFile(new URL('../js/views/project-search.js', import.meta.url), 'utf8');
assert(projectSearchSource.includes('AUTO_SCAN_LIMIT') && projectSearchSource.includes('AUTO_SCAN_BUDGET') && projectSearchSource.includes("new Worker(WORKER_URL, { type: 'module' })"), 'Workspace search lost bounded deferred/worker isolation');
assert(projectSearchSource.includes("mode === 'hex'") && projectSearchSource.includes('TextEncoder'), 'Workspace search lost Text/Hex semantics');
assert(!hostSource.includes('studio:') && !hostSource.includes('openTool('), 'Cross-tool routing leaked into the Tool presentation bridge');
const openWithSource = await readFile(new URL('../js/core/open-with-dialog.js', import.meta.url), 'utf8');
const pinnedGroup = openWithSource.indexOf("['Pinned', groups.pinned]");
const suggestedGroup = openWithSource.indexOf("['Suggested', groups.suggested]");
const coreGroup = openWithSource.indexOf("['Core', groups.core]");
assert(pinnedGroup >= 0 && suggestedGroup > pinnedGroup && coreGroup > suggestedGroup, 'Open With ranking is not Pinned -> Suggested -> Core');
assert(openWithSource.includes('!pinnedSet.has(tool.id)') && openWithSource.includes('suggestedSet.has(tool.id)'), 'Pinned core tools can leak into a lower Open With group');
const openProjectFileSource = appSource.slice(appSource.indexOf('async function openProjectFile'), appSource.indexOf('function openToolLibrary'));
assert(openProjectFileSource.indexOf('const opened = await openTool') < openProjectFileSource.indexOf('ownerProject.suggestTool(tool.id)'), 'Suggested state is persisted before the selected tool successfully opens');
assert(openProjectFileSource.includes('if (!opened || !choice') && openProjectFileSource.indexOf('ownerProject.suggestTool(tool.id)') < openProjectFileSource.indexOf('ownerProject.setFileAssociation'), 'Open With preferences are not committed transactionally after a successful tool open');

// Transfer consumption owns the complete lazy-resource lifecycle. Do not regress
// to a resolve-then-consume split that releases source ownership too early.
assert(transferSource.includes('async consume(token, consumer'), 'TransferRegistry lifecycle-safe consume() API is missing');
assert(!/\basync\s+resolve\s*\(/.test(transferSource) && !/\.resolve\(token/.test(explorerSource), 'TransferRegistry regrew the old resolve() lifecycle split');
assert(explorerSource.includes('transfers.consume(token') && explorerSource.includes('transferStepTimeout'), 'Explorer folder transfer bypasses lifecycle-safe consumption or strict deadline budgeting');

// Auto-restore must contain a broken tool to that tool for the current pass,
// while preserving pending descriptors for future sessions.
assert(appSource.includes('const failedTools = new Set()') && appSource.includes('failedTools.has(saved.editorId)'), 'Saved-tab restore repeatedly retries the same broken tool');
assert(appSource.includes('reuse: true, activate: false'), 'Saved-tab restore can create duplicate tabs or steal activation');

// Project content must be detached through the real-Blob boundary before it can
// enter persistent state.
assert(projectSource.includes('function detachProjectBlob') && projectSource.includes('toRealmBlob(value, globalThis)'), 'ProjectStore no longer owns the real-Blob persistence boundary');

// Declared manifest fields are strict tool-author contracts, not values the
// wrapper should silently repair.
assert(registrySource.includes('must be an array of strings') && registrySource.includes('must contain only strings'), 'Registry list manifest fields became loosely typed again');

console.log('Core hygiene validation passed: reduced public surface, canonical catalog/tabs, delegated Explorer events, simplified helpers and dormant-code removal');

// v0.14.5 lifecycle/security maintenance rules: prefer AbortSignal ownership,
// keep the wrapper document same-origin by policy, and keep historical notes consolidated.
assert(!shortcutSource.includes('removeEventListener'), 'Shortcut binder regrew a manual listener-cleanup API instead of AbortSignal ownership');
assert(appSource.includes('projectEventController') && appSource.includes("project.addEventListener(type, onProjectEvent, { signal: projectEventController.signal })") && !appSource.includes('projectEventCleanup'), 'Project event lifecycle returned to manual removeEventListener bookkeeping');
for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert(indexSource.includes(directive), `Main Studio CSP is missing required directive: ${directive}`);
const docNames = (await readdir(new URL('../docs/', import.meta.url))).sort();
assert(docNames.includes('HISTORY.md'), 'Consolidated docs/HISTORY.md is missing');
assert(!docNames.some((name) => /^V0.*_NOTES\.md$/i.test(name)) && !docNames.includes('SCALABILITY_REVIEW.md'), 'Superseded per-release/stale documentation returned');
