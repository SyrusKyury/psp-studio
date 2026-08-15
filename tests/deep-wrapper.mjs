import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../js/core/project-store.js';
import { ProjectExplorer } from '../js/core/project-explorer.js';
import { TabManager } from '../js/core/tab-manager.js';
import { Registry } from '../js/core/registry.js';
import { ModuleHost } from '../js/core/module-host.js';
import { waitBounded } from '../js/core/async-utils.js';
import { createStoredZip, readZip } from '../shared/archive/zip-store.js';
import { crc32 } from 'node:zlib';

function assert(condition, message) { if (!condition) throw new Error(message); }
function flatten(project) { const out = []; const stack = [...project.root.children].reverse(); while (stack.length) { const node = stack.pop(); out.push(node); if (node.isDirectory) stack.push(...[...node.children].reverse()); } return out; }
async function rejects(fn, pattern, message) {
  try { await fn(); }
  catch (error) {
    if (pattern && !pattern.test(String(error?.message || error))) throw new Error(`${message}: unexpected error: ${error?.message || error}`);
    return error;
  }
  throw new Error(`${message}: expected rejection`);
}

const manifestBlob = (value) => new Blob([JSON.stringify({ format: 'psp-modding-studio-project', version: 1, name: 'Deep Audit', ...value })], { type: 'application/json' });
const fixtureCrc32 = async (blob) => crc32(new Uint8Array(await blob.arrayBuffer())) >>> 0;

// Project archives are strict containers. Unknown top-level payloads are not silently ignored.
const extraZip = await createStoredZip([
  { name: 'project.json', blob: manifestBlob({}) },
  { name: 'notes.txt', blob: new Blob(['unexpected']) },
]);
await rejects(() => ProjectStore.open(new File([extraZip], 'extra.pspstudio')), /Unexpected project archive entry/, 'Unexpected archive payload was accepted');

// Persisted tab paths must be canonical, and persisted tool identifiers use the same grammar as the Registry.
const normalizedZip = await createStoredZip([{ name: 'project.json', blob: manifestBlob({
  workspace: {
    pinnedTools: ['umd-forge', '../escape', 'bad_'],
    suggestedTools: ['sfo-studio', '../escape', 'sfo-studio', 'image-studio'],
    fileAssociations: { 'ext:.bin': '../escape', 'name:eboot.bin': 'umd-forge' },
  },
  tabs: [
    { editorId: 'umd-forge', filePath: '/PSP_GAME//PARAM.SFO', title: 'bad path' },
    { editorId: '../escape', filePath: '/ok.bin', title: 'bad editor' },
    { editorId: 'sfo-studio', filePath: '/PSP_GAME/PARAM.SFO', title: 'valid' },
  ],
}) }]);
const normalizedOpen = await ProjectStore.open(new File([normalizedZip], 'normalized.pspstudio'));
assert(normalizedOpen.manifest.workspace.pinnedTools.join(',') === 'umd-forge', 'Invalid persisted tool ids survived normalization');
assert(normalizedOpen.manifest.workspace.suggestedTools.join(',') === 'sfo-studio,image-studio', 'Invalid or duplicate Suggested tool ids survived normalization');
assert(normalizedOpen.manifest.workspace.fileAssociations['name:eboot.bin'] === 'umd-forge' && !normalizedOpen.manifest.workspace.fileAssociations['ext:.bin'], 'Invalid file association tool id survived normalization');
assert(normalizedOpen.manifest.tabs.length === 1, 'Invalid saved editor id/path survived normalization');
assert(normalizedOpen.manifest.tabs[0].filePath === '/PSP_GAME/PARAM.SFO', 'Canonical saved tab path was lost');

// Manifest CRC is checked before JSON is trusted.
const crcZip = await createStoredZip([{ name: 'project.json', blob: manifestBlob({ name: 'CRC Integrity Marker' }) }]);
const crcBytes = new Uint8Array(await crcZip.arrayBuffer());
const marker = new TextEncoder().encode('CRC Integrity Marker');
let markerOffset = -1;
outer: for (let i = 0; i <= crcBytes.length - marker.length; i += 1) {
  for (let j = 0; j < marker.length; j += 1) if (crcBytes[i + j] !== marker[j]) continue outer;
  markerOffset = i; break;
}
assert(markerOffset >= 0, 'Could not locate manifest payload in synthetic ZIP');
crcBytes[markerOffset] ^= 0x01;
await rejects(() => ProjectStore.open(new File([crcBytes], 'crc.pspstudio')), /integrity check/, 'Corrupted project.json payload passed CRC validation');

// Local ZIP headers must agree with the central directory instead of being trusted independently.
const headerZip = await createStoredZip([{ name: 'x.bin', blob: new Blob(['abc']) }]);
const headerBytes = new Uint8Array(await headerZip.arrayBuffer());
headerBytes[14] ^= 0x01; // local CRC32 only; central directory remains intact
await rejects(() => readZip(new File([headerBytes], 'header.zip')), /local sizes\/CRC disagree/, 'ZIP local/central CRC mismatch was accepted');
const localNameLengthZip = await createStoredZip([{ name: 'name.bin', blob: new Blob(['x']) }]);
const localNameLengthBytes = new Uint8Array(await localNameLengthZip.arrayBuffer());
new DataView(localNameLengthBytes.buffer).setUint16(26, 'name.bin'.length - 1, true);
await rejects(() => readZip(new File([localNameLengthBytes], 'local-name-length.zip')), /filename length disagrees/, 'ZIP local/central filename-length mismatch was accepted');
const countZip = await createStoredZip([{ name: 'a', blob: new Blob([]) }, { name: 'b', blob: new Blob([]) }]);
await rejects(() => readZip(new File([countZip], 'count.zip'), { maxEntries: 1 }), /too many entries/, 'ZIP maxEntries guard failed');
await rejects(() => createStoredZip([{ name: 'dup.bin', blob: new Blob([]) }, { name: 'dup.bin', blob: new Blob([]) }]), /duplicate output entry/, 'ZIP writer accepted duplicate output names');
const sentinelBlob = { size: 0xFFFFFFFF, slice() { return this; }, async arrayBuffer() { return new ArrayBuffer(0); } };
await rejects(() => createStoredZip([{ name: 'sentinel.bin', blob: sentinelBlob }]), /ZIP32 limit/, 'ZIP writer accepted the ZIP32 sentinel value as a real size');

await rejects(() => createStoredZip([{ name: 'a', blob: new Blob([]) }], { maxCentralDirectoryBytes: 46 }), /central directory exceeds/, 'ZIP writer ignored its configured central-directory budget');

// The writer must never emit a project that its own reader rejects. Manifest
// size is checked before ZIP generation, including persisted tab metadata.
const hugeTabs = Array.from({ length: 256 }, (_, index) => ({
  editorId: 'umd-forge',
  filePath: `/${'a'.repeat(1000)}/${'b'.repeat(1000)}/${'c'.repeat(1000)}/${String(index).padStart(4, '0')}${'d'.repeat(995)}`,
  title: 'T'.repeat(512),
}));
await rejects(() => new ProjectStore('Manifest Budget').toZipBlob({ tabs: hugeTabs }), /manifest exceeds/, 'Project writer emitted an oversized manifest that its reader would reject');

// If bit 3 advertises a data descriptor, the descriptor must actually exist and agree with the central directory.
const descriptorZip = await createStoredZip([{ name: 'descriptor.bin', blob: new Blob(['payload']) }]);
const descriptorBytes = new Uint8Array(await descriptorZip.arrayBuffer());
const descriptorView = new DataView(descriptorBytes.buffer);
descriptorView.setUint16(6, descriptorView.getUint16(6, true) | 0x0008, true);
let centralSignature = -1;
for (let i = 0; i <= descriptorBytes.length - 4; i += 1) if (descriptorBytes[i] === 0x50 && descriptorBytes[i + 1] === 0x4B && descriptorBytes[i + 2] === 0x01 && descriptorBytes[i + 3] === 0x02) { centralSignature = i; break; }
assert(centralSignature >= 0, 'Synthetic ZIP central directory not found');
descriptorView.setUint16(centralSignature + 8, descriptorView.getUint16(centralSignature + 8, true) | 0x0008, true);
await rejects(() => readZip(new File([descriptorBytes], 'descriptor.zip')), /data descriptor/, 'ZIP advertised a missing data descriptor and was accepted');

// Prefix file/folder collisions are rejected before the logical Project tree is constructed.
const prefixZip = await createStoredZip([
  { name: 'project.json', blob: manifestBlob({}) },
  { name: 'workspace/a/b.bin', blob: new Blob(['b']) },
  { name: 'workspace/a', blob: new Blob(['a']) },
]);
await rejects(() => ProjectStore.open(new File([prefixZip], 'prefix.pspstudio')), /conflicting file\/folder roles/, 'Project file/folder prefix collision was accepted');

// Registry failures are isolated, including manifests that try to escape the trusted local icon surface.
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['good-tool'], tools: ['remote-icon'] }), { status: 200 });
    if (url.endsWith('/good-tool/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Good', description: 'valid', author: 'Audit', version: '1.0.0' }), { status: 200 });
    if (url.endsWith('/good-tool/index.html')) return new Response(null, { status: 200 });
    if (url.endsWith('/remote-icon/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Bad Icon', description: 'invalid', author: 'Audit', version: '1.0.0', icon: 'https://example.invalid/icon.svg' }), { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const auditedRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(auditedRegistry.get('good-tool') && !auditedRegistry.get('remote-icon') && auditedRegistry.errors.length === 1, 'Registry did not isolate an escaping icon manifest');

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: [], tools: ['missing-page'] }), { status: 200 });
    if (url.endsWith('/missing-page/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Missing', description: 'missing page', author: 'Audit', version: '1.0.0' }), { status: 200 });
    if (url.endsWith('/missing-page/index.html')) return new Response(null, { status: 404 });
    return new Response('missing', { status: 404 });
  };
  const missingPageRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(!missingPageRegistry.get('missing-page') && missingPageRegistry.errors.length === 1, 'Registry accepted a tool with missing index.html');

  globalThis.fetch = async () => new Response('x'.repeat(300 * 1024), { status: 200 });
  await rejects(() => new Registry(new URL('https://example.test/tools/catalog.json')).load(), /unexpectedly large/, 'Registry body-size guard failed without Content-Length');
} finally { globalThis.fetch = originalFetch; }

// A save completion may only clear dirty if the Project revision has not advanced meanwhile.
// Exercise the real save path; there is intentionally no public dirty-state bypass.
const revisionProject = new ProjectStore('Revision');
revisionProject.addBlob('/', 'one.bin', new Blob(['1']));
const previousDocument = globalThis.document;
globalThis.document = { createElement() { return { click() {}, remove() {} }; }, body: { appendChild() {} } };
try {
  let mutatedDuringSave = false;
  const staleSave = await revisionProject.save({ onProgress() {
    if (!mutatedDuringSave) { mutatedDuringSave = true; revisionProject.addBlob('/', 'two.bin', new Blob(['2'])); }
  } });
  assert(staleSave.clean === false && revisionProject.dirty === true, 'Mutation during save incorrectly cleared dirty state');
  const cleanSave = await revisionProject.save();
  assert(cleanSave.clean === true && revisionProject.dirty === false, 'Stable save could not clear dirty state');
} finally {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
}

// Workspace preferences are immutable snapshots: direct mutation cannot bypass revision/dirty tracking.
const immutableProject = new ProjectStore('Immutable Workspace');
assert(Object.isFrozen(immutableProject.workspace) && Object.isFrozen(immutableProject.workspace.pinnedTools) && Object.isFrozen(immutableProject.workspace.suggestedTools) && Object.isFrozen(immutableProject.workspace.fileAssociations), 'Workspace preference snapshot is mutable');
let directMutationFailed = false;
try { immutableProject.workspace.pinnedTools.push('umd-forge'); } catch { directMutationFailed = true; }
assert(directMutationFailed && immutableProject.workspace.pinnedTools.length === 0 && immutableProject.revision === 0, 'Direct workspace mutation bypassed ProjectStore mutation methods');
assert(immutableProject.pinTool('umd-forge') && immutableProject.workspace.pinnedTools[0] === 'umd-forge' && immutableProject.dirty, 'ProjectStore workspace mutation method stopped working');
const suggestionProject = new ProjectStore('Suggestion Ranking');
for (let index = 0; index < 35; index += 1) assert(suggestionProject.suggestTool(`tool-${index}`), `Could not record Suggested tool ${index}`);
assert(suggestionProject.workspace.suggestedTools.length === 32, 'Suggested tool history exceeded its bounded workspace limit');
assert(suggestionProject.workspace.suggestedTools[0] === 'tool-34' && suggestionProject.workspace.suggestedTools.at(-1) === 'tool-3', 'Suggested tool recency/cap ordering regressed');
const suggestionRevision = suggestionProject.revision;
assert(suggestionProject.suggestTool('tool-10') && suggestionProject.workspace.suggestedTools[0] === 'tool-10' && suggestionProject.workspace.suggestedTools.filter((id) => id === 'tool-10').length === 1, 'Suggested tool promotion stopped being deduplicated');
const promotedRevision = suggestionProject.revision;
assert(promotedRevision === suggestionRevision + 1 && !suggestionProject.suggestTool('tool-10') && suggestionProject.revision === promotedRevision, 'No-op Suggested selection dirtied the ProjectStore');

// Linked document tabs serialize the current Project path after move/rename and disappear after deletion.
const linkProject = new ProjectStore('Links');
const linkedFile = linkProject.addBlob('/', 'EBOOT.BIN', new Blob(['x']));
const linkedFolder = linkProject.createFolder('/', 'PSP_GAME');
const tabManager = new TabManager({ strip: {}, content: {}, api: { project: linkProject } });
const linkedTool = { id: 'umd-forge' };
tabManager.tabs = [{ id: 'linked', tool: linkedTool, filePath: '/EBOOT.BIN', projectNodeId: linkedFile.id, title: 'EBOOT' }];
tabManager.updateTab('linked', { title: 'Retitled', dirty: 1, id: 'hijacked', tool: { id: 'other' }, filePath: '/hijacked.bin' });
assert(tabManager.tabs[0].id === 'linked' && tabManager.tabs[0].tool === linkedTool && tabManager.tabs[0].filePath === '/EBOOT.BIN' && tabManager.tabs[0].title === 'Retitled' && tabManager.tabs[0].dirty === true, 'Tool presentation patch escaped title/dirty TabManager boundary');
linkProject.move(linkedFile, linkedFolder);
linkProject.rename(linkedFile, 'BOOT.BIN');
assert(tabManager.listSerializable()[0]?.filePath === '/PSP_GAME/BOOT.BIN', 'Linked tab serialized a stale Project path');
linkProject.remove(linkedFile);
assert(tabManager.listSerializable().length === 0, 'Deleted linked Project file remained in serialized tab state');

// Native multi-file imports are committed through one ProjectStore batch, so a late invalid item cannot leave earlier files behind.
const importProject = new ProjectStore('Atomic Native Import');
const importToasts = [];
const importExplorer = new ProjectExplorer({ querySelector() { return null; } }, {
  getProject: () => importProject,
  transfers: null,
  onOpenFile() {}, onOpenWith() {},
  ui: { toast(message) { importToasts.push(String(message)); } },
});
const badName = `${'x'.repeat(1025)}.bin`;
await importExplorer.handleDrop(importProject.root, { dataTransfer: {
  getData() { return ''; },
  files: [new File(['ok'], 'ok.bin'), new File(['bad'], badName)],
} });
assert(flatten(importProject).length === 0 && importProject.dirty === false, 'Native file batch partially mutated Project before validation finished');
assert(importToasts.length === 1, 'Invalid native file batch did not produce one contained error');

// Runtime ProjectStore limits mirror the limits used when reopening .pspstudio.
// Oversized files / aggregate payloads are rejected before a batch mutates the tree.
const fakeBlob = (size) => ({ size, type: 'application/octet-stream', slice() { return this; }, async arrayBuffer() { return new ArrayBuffer(0); } });
const payloadProject = new ProjectStore('Payload Limits');
await rejects(() => payloadProject.addBlobs('/', [
  { name: 'a.bin', blob: fakeBlob(500 * 1024 * 1024) },
  { name: 'b.bin', blob: fakeBlob(500 * 1024 * 1024) },
  { name: 'c.bin', blob: fakeBlob(30 * 1024 * 1024) },
]), /payloads exceed/, 'Oversized aggregate Project payload was accepted');
assert(flatten(payloadProject).length === 0 && payloadProject.dirty === false, 'Rejected Project payload batch mutated the tree');
await rejects(() => payloadProject.addBlob('/', 'huge.bin', fakeBlob(513 * 1024 * 1024)), /cannot exceed/, 'Oversized individual Project file was accepted');
await rejects(() => new ProjectStore('Real Blob Boundary').addBlob('/', 'fake.bin', fakeBlob(4)), /real Blob or File/, 'Structural Blob impostor entered ProjectStore runtime state');
assert(flatten(payloadProject).length === 0, 'Rejected oversized Project file mutated the tree');

// Clipboard paste preflights target depth before the first mutation.
const deepProject = new ProjectStore('Deep Paste');
let target = deepProject.root;
for (let i = 0; i < 127; i += 1) target = deepProject.createFolder(target.path, `d${i}`, { silent: true });
const beforeDeepPaste = flatten(deepProject).length;
const clipboardExplorer = new ProjectExplorer({ querySelector() { return null; } }, {
  getProject: () => deepProject,
  transfers: null,
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
clipboardExplorer.clipboard = { kind: 'folder', name: 'copy', children: [{ kind: 'file', name: 'x.bin', blob: new Blob(['x']) }] };
clipboardExplorer.pasteClipboard(target);
assert(flatten(deepProject).length === beforeDeepPaste, 'Too-deep clipboard paste partially mutated Project');

// Static module graph: every relative dependency must resolve, contain no cycle, and wrapper imports share one cache version.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseVersion = '0.14.3';
const importRe = /^\s*import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"];?/gm;
const graph = new Map();
async function walkModule(relative) {
  const canonical = relative.replace(/\\/g, '/');
  if (graph.has(canonical)) return;
  const abs = path.join(rootDir, canonical);
  const source = await readFile(abs, 'utf8');
  const deps = [];
  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    const [clean, query = ''] = spec.split('?');
    const resolved = path.relative(rootDir, path.resolve(path.dirname(abs), clean)).replace(/\\/g, '/');
    await readFile(path.join(rootDir, resolved), 'utf8');
    deps.push(resolved);
    if ((canonical === 'js/app.js' || canonical.startsWith('js/core/')) && !query.includes(`v=${releaseVersion}`)) throw new Error(`Unversioned wrapper dependency: ${canonical} -> ${spec}`);
    await walkModule(resolved);
  }
  graph.set(canonical, deps);
}
await walkModule('js/app.js');
const visiting = new Set(); const visited = new Set();
function visit(node) {
  if (visiting.has(node)) throw new Error(`Wrapper module dependency cycle detected at ${node}`);
  if (visited.has(node)) return;
  visiting.add(node); for (const dep of graph.get(node) || []) visit(dep); visiting.delete(node); visited.add(node);
}
visit('js/app.js');
assert(graph.size >= 10, 'Wrapper dependency-graph validation did not traverse the expected core modules');

// DOM shell IDs and top-level local references are deterministic.
const index = await readFile(path.join(rootDir, 'index.html'), 'utf8');
const ids = [...index.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);
assert(new Set(ids).size === ids.length, 'index.html contains duplicate element IDs');
assert(!/ide-bottom-dock|Problems\s*</.test(index), 'Removed decorative bottom dock returned');
assert(index.includes(`app.js?v=${releaseVersion}`), 'Top-level app cache version is not release-coherent');

// High-value lifecycle hardening must stay explicit in source.
const appSource = await readFile(path.join(rootDir, 'js/app.js'), 'utf8');
const hostSource = await readFile(path.join(rootDir, 'js/core/module-host.js'), 'utf8');
const transferSource = await readFile(path.join(rootDir, 'js/core/transfer-registry.js'), 'utf8');
const uiSource = await readFile(path.join(rootDir, 'js/core/ui-service.js'), 'utf8');
const registrySource = await readFile(path.join(rootDir, 'js/core/registry.js'), 'utf8');
assert(!/await\s+registry\.load\s*\(/.test(appSource), 'Registry loading blocks wrapper bootstrap again');
assert(!appSource.includes('localStorage'), 'Wrapper reintroduced startup storage state after becoming dark-only');
assert(hostSource.includes("toRealmFile(file, file.name || 'file.bin', win)"), 'Initial tool.open File realm normalization regressed');
assert(hostSource.includes('files.map((file) => toRealmFile'), 'Native file drop realm normalization regressed');
assert(transferSource.includes('TRANSFER_RESOURCE_TIMEOUT_MS'), 'Tool transfer outer fail-safe timeout missing');
assert(uiSource.includes('#timers') && uiSource.includes('#remove('), 'Toast timer count is no longer bounded with DOM count');
assert(registrySource.includes('response.body?.getReader?.()') && registrySource.includes('readTextLimited'), 'Registry body limit regressed to unbounded response.text() allocation');



// Project nodes are indexed by identity: foreign or detached nodes cannot mutate a store,
// and byId remains O(1) rather than walking a 50k-node tree.
const indexedA = new ProjectStore('Indexed A');
const indexedB = new ProjectStore('Indexed B');
const indexedNode = indexedA.addBlob('/', 'owned.bin', new Blob(['owned']));
const foreignNode = indexedB.addBlob('/', 'foreign.bin', new Blob(['foreign']));
assert(indexedA.byId(indexedNode.id) === indexedNode && indexedA.owns(indexedNode), 'Project node index did not register a live node');
assert(indexedA.get('/owned.bin') === indexedNode, 'Project canonical path index did not register a live node');
assert(indexedA.get('//owned.bin') === null && indexedA.get('owned.bin') === null && indexedA.get('/owned.bin/') === null, 'Project path lookup accepted a non-canonical alias');
assert(indexedA.rename(foreignNode, 'should-not-work.bin') === false, 'Foreign Project node mutated another ProjectStore');
assert(indexedA.remove(foreignNode) === false, 'Foreign Project node was removed through another ProjectStore');
assert(indexedA.remove(indexedNode) === true && indexedA.byId(indexedNode.id) === null && !indexedA.owns(indexedNode), 'Removed Project node remained reachable through the identity index');
assert(indexedA.get('/owned.bin') === null, 'Removed Project node remained reachable through the path index');

// ZIP payload integrity applies to workspace data too, not only project.json.
const workspaceCrcZip = await createStoredZip([
  { name: 'project.json', blob: manifestBlob({}) },
  { name: 'workspace/data.bin', blob: new Blob(['WORKSPACE_CRC_MARKER']) },
]);
const workspaceCrcBytes = new Uint8Array(await workspaceCrcZip.arrayBuffer());
const workspaceMarker = new TextEncoder().encode('WORKSPACE_CRC_MARKER');
let workspaceMarkerOffset = -1;
workspaceCrcSearch: for (let i = 0; i <= workspaceCrcBytes.length - workspaceMarker.length; i += 1) {
  for (let j = 0; j < workspaceMarker.length; j += 1) if (workspaceCrcBytes[i + j] !== workspaceMarker[j]) continue workspaceCrcSearch;
  workspaceMarkerOffset = i; break;
}
assert(workspaceMarkerOffset >= 0, 'Could not locate workspace payload in synthetic ZIP');
workspaceCrcBytes[workspaceMarkerOffset] ^= 0x01;
await rejects(() => ProjectStore.open(new File([workspaceCrcBytes], 'workspace-crc.pspstudio')), /CRC32 integrity check/, 'Corrupted workspace payload passed ZIP CRC validation');

// Logical uncompressed limits also apply to stored entries, preventing a huge stored
// archive from bypassing the project-size policy just because no inflate step is needed.
const logicalLimitZip = await createStoredZip([
  { name: 'a.bin', blob: new Blob(['123456']) },
  { name: 'b.bin', blob: new Blob(['abcdef']) },
]);
await rejects(() => readZip(new File([logicalLimitZip], 'logical-limit.zip'), { maxInflatedTotalBytes: 10 }), /total uncompressed-size limit/, 'Stored ZIP entries bypassed total logical-size limit');
await rejects(() => readZip(new File([logicalLimitZip], 'entry-limit.zip'), { maxInflatedEntryBytes: 5 }), /uncompressed-size limit/, 'Stored ZIP entry bypassed per-entry logical-size limit');

// Deflate output is bounded while it is produced, not only by trusting the central
// directory's declared uncompressed size. This prevents metadata-lie ZIP bombs.
async function syntheticDeflateZip(name, payloadText) {
  const nameBytes = new TextEncoder().encode(name);
  const payload = new Blob([payloadText]);
  const compressed = new Uint8Array(await new Response(payload.stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const crc = await fixtureCrc32(payload);
  const local = new Uint8Array(30 + nameBytes.length); const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034B50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 8, true);
  lv.setUint32(14, crc, true); lv.setUint32(18, compressed.length, true); lv.setUint32(22, payload.size, true); lv.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length); const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014B50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true); cv.setUint32(20, compressed.length, true); cv.setUint32(24, payload.size, true); cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, 0, true); central.set(nameBytes, 46);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer); const centralOffset = local.length + compressed.length;
  ev.setUint32(0, 0x06054B50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, centralOffset, true);
  return new Uint8Array(await new Blob([local, compressed, central, eocd]).arrayBuffer());
}
const validDeflate = await syntheticDeflateZip('payload.bin', 'A'.repeat(200000));
const validDeflateEntries = await readZip(new File([validDeflate], 'valid-deflate.zip'));
assert(validDeflateEntries[0].blob.size === 200000, 'Valid bounded Deflate entry did not round-trip');
const lyingDeflate = validDeflate.slice(); const lyingView = new DataView(lyingDeflate.buffer);
const lyingNameLength = lyingView.getUint16(26, true); const lyingCompressedSize = lyingView.getUint32(18, true);
const lyingCentralOffset = 30 + lyingNameLength + lyingCompressedSize;
lyingView.setUint32(22, 1024, true); lyingView.setUint32(lyingCentralOffset + 24, 1024, true);
await rejects(() => readZip(new File([lyingDeflate], 'lying-deflate.zip')), /expands beyond its declared uncompressed size/, 'Deflate stream expanded beyond its declared size without being stopped');

// Local records may have gaps but may never overlap. Craft an internally CRC-consistent
// first record whose declared payload reaches into the second local header.
const overlapZip = await createStoredZip([
  { name: 'a', blob: new Blob(['x']) },
  { name: 'b', blob: new Blob(['y']) },
]);
const overlapBytes = new Uint8Array(await overlapZip.arrayBuffer());
const overlapView = new DataView(overlapBytes.buffer);
const firstNameLength = overlapView.getUint16(26, true);
const firstDataOffset = 30 + firstNameLength + overlapView.getUint16(28, true);
const secondLocalOffset = firstDataOffset + 1;
const extendedSize = 10;
const extendedBlob = new Blob([overlapBytes.slice(firstDataOffset, firstDataOffset + extendedSize)]);
const extendedCrc = await fixtureCrc32(extendedBlob);
overlapView.setUint32(14, extendedCrc, true);
overlapView.setUint32(18, extendedSize, true);
overlapView.setUint32(22, extendedSize, true);
let overlapCentral = -1;
for (let i = secondLocalOffset; i <= overlapBytes.length - 4; i += 1) {
  if (overlapBytes[i] === 0x50 && overlapBytes[i + 1] === 0x4B && overlapBytes[i + 2] === 0x01 && overlapBytes[i + 3] === 0x02) { overlapCentral = i; break; }
}
assert(overlapCentral >= 0, 'Synthetic overlap ZIP central directory not found');
overlapView.setUint32(overlapCentral + 16, extendedCrc, true);
overlapView.setUint32(overlapCentral + 20, extendedSize, true);
overlapView.setUint32(overlapCentral + 24, extendedSize, true);
await rejects(() => readZip(new File([overlapBytes], 'overlap.zip')), /local records overlap/, 'Overlapping ZIP local records were accepted');

// Registry loading is bounded and normalized metadata is immutable. A large catalog
// must not create one fetch burst per tool.
const boundedFetch = globalThis.fetch;
try {
  const ids = Array.from({ length: 20 }, (_, i) => `tool-${i}`);
  let active = 0; let maxActive = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: [], tools: ids }), { status: 200 });
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
    if (url.endsWith('/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Bounded', description: 'bounded registry load', author: 'Audit', version: '1.0.0', accepts: ['.bin'], keywords: ['audit'], extra: { mutable: true } }), { status: 200 });
    if (url.endsWith('/index.html')) return new Response(null, { status: 200 });
    return new Response('missing', { status: 404 });
  };
  const boundedRegistry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(boundedRegistry.all().length === ids.length, 'Bounded Registry load lost valid tools');
  assert(maxActive <= 8, `Registry exceeded bounded concurrency: ${maxActive}`);
  const normalizedTool = boundedRegistry.all()[0];
  assert(Object.isFrozen(normalizedTool) && Object.isFrozen(normalizedTool.accepts) && Object.isFrozen(normalizedTool.keywords), 'Registry metadata is not immutable');
  assert(!('extra' in normalizedTool), 'Registry leaked arbitrary manifest fields into the shell metadata surface');
} finally { globalThis.fetch = boundedFetch; }

// Release-source guards for the non-destructive restore and transfer amplification caps.
assert(appSource.includes('if (!tool) continue;') && appSource.includes('pendingTabs.delete(key)') && appSource.includes('pendingTabs = new Map'), 'Unavailable-tool tab descriptors are destructive again');
const explorerSource = await readFile(path.join(rootDir, 'js/core/project-explorer.js'), 'utf8');
assert(explorerSource.includes('MAX_TRANSFER_NODES = 50000') && explorerSource.includes('nodeCount > MAX_TRANSFER_NODES'), 'Tool folder transfer can amplify into an unbounded implicit-folder snapshot');
assert(registrySource.includes('MAX_CONCURRENT_TOOL_LOADS = 8') && registrySource.includes('mapSettledLimited'), 'Registry bounded-concurrency loader regressed');
assert(registrySource.includes('MAX_REGISTRY_LOAD_MS = 20000') && registrySource.includes('deadlineAt'), 'Registry discovery has no global time budget');
const asyncUtilsSource = await readFile(path.join(rootDir, 'js/core/async-utils.js'), 'utf8');
assert(asyncUtilsSource.includes("signal.removeEventListener('abort', onAbort)"), 'Shared bounded wait leaks lifecycle abort listeners');
const projectStoreSource = await readFile(path.join(rootDir, 'js/core/project-store.js'), 'utf8');
const saveSource = projectStoreSource.slice(projectStoreSource.indexOf('async save('), projectStoreSource.indexOf('static async open('));
assert(saveSource.indexOf('showSaveFilePicker') >= 0 && saveSource.indexOf('showSaveFilePicker') < saveSource.indexOf('toZipBlob'), 'Native save picker is acquired after ZIP generation and may lose transient user activation');
assert(projectStoreSource.includes('projectIndexes = new WeakMap') && projectStoreSource.includes('resolveNode(project, nodeOrPath)'), 'Project node identity index/ownership guard is missing or publicly exposed');
assert(projectStoreSource.includes('byPath: new Map') && projectStoreSource.includes('canonicalProjectPath'), 'Project canonical path index regressed');
assert(saveSource.includes("writable?.abort?.()"), 'Failed native File System Access writes are not rolled back best-effort');



// A host cleanup failure can never keep a tab/iframe alive. Cleanup errors are
// diagnostic only: the wrapper remains authoritative over its own lifecycle.
const fakeStrip = { innerHTML: '', replaceChildren() {} };
const fakeContent = { replaceChildren() {} };
const lifecycleTabs = new TabManager({ strip: fakeStrip, content: fakeContent, api: { ui: { async confirm() { return true; } }, project: null } });
let failedPanelRemoved = false;
const failedPanel = { hidden: false, remove() { failedPanelRemoved = true; } };
lifecycleTabs.tabs = [
  { id: 'failed', title: 'Failed', panel: failedPanel, host: { async unload() { throw new Error('synthetic unload failure'); } } },
];
lifecycleTabs.activeId = 'failed';
const oldWarn = console.warn; console.warn = () => {};
try { assert(await lifecycleTabs.close('failed') === true, 'Host cleanup error prevented tab close'); }
finally { console.warn = oldWarn; }
assert(failedPanelRemoved && lifecycleTabs.tabs.length === 0 && lifecycleTabs.activeId === null, 'Unload failure left a zombie tab/panel');

// Single-file Tool transfers use the same strict path-segment policy as folder transfers.
const badFileTransferProject = new ProjectStore('Bad File Transfer');
const badFileTransferExplorer = new ProjectExplorer({}, {
  getProject: () => badFileTransferProject,
  transfers: { async consume(_token, consumer, { signal } = {}) { return consumer({ kind: 'file', name: '../escape.bin', resource: new Blob(['x']) }, signal || new AbortController().signal); } },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
await rejects(() => badFileTransferExplorer.importToolTransfer(badFileTransferProject.root, 'bad-file'), /Invalid transferred path segment/, 'Invalid single-file Tool transfer name was silently sanitized');
assert(flatten(badFileTransferProject).length === 0 && badFileTransferProject.dirty === false, 'Rejected single-file transfer mutated the Project');

// Folder resources are inspected exactly once. A getter with state must not be
// invoked twice by wrapper type detection before the transfer starts.
const getterProject = new ProjectStore('Getter Folder Transfer');
let filesGetterReads = 0;
const getterResource = {};
Object.defineProperty(getterResource, 'files', { get() {
  filesGetterReads += 1;
  return [{ path: 'one.bin', file: new Blob(['1']) }];
} });
const getterExplorer = new ProjectExplorer({}, {
  getProject: () => getterProject,
  transfers: { async consume(_token, consumer, { signal } = {}) { return consumer({ kind: 'folder', name: 'Folder', resource: getterResource }, signal || new AbortController().signal); } },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
await getterExplorer.importToolTransfer(getterProject.root, 'getter-folder');
assert(filesGetterReads === 1 && getterProject.get('/Folder/one.bin'), 'Folder resource.files was evaluated more than once by the wrapper');
const malformedFolderProject = new ProjectStore('Malformed Folder');
const malformedFolderExplorer = new ProjectExplorer({}, {
  getProject: () => malformedFolderProject,
  transfers: { async consume(_token, consumer, { signal } = {}) { return consumer({ kind: 'folder', name: 'Broken', resource: { files: null } }, signal || new AbortController().signal); } },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
await rejects(() => malformedFolderExplorer.importToolTransfer(malformedFolderProject.root, 'broken-folder'), /did not provide a file list/, 'Malformed folder resource was silently converted to an empty folder');
assert(!malformedFolderProject.get('/Broken'), 'Malformed folder transfer partially modified the ProjectStore');

// Folder entry paths are a strict relative-POSIX contract. The wrapper must not
// silently repair absolute or Windows-style paths emitted by a buggy tool.
for (const badPath of ['/absolute.bin', 'dir\\file.bin']) {
  const strictPathProject = new ProjectStore(`Strict path ${badPath}`);
  const strictPathExplorer = new ProjectExplorer({}, {
    getProject: () => strictPathProject,
    transfers: { async consume(_token, consumer, { signal } = {}) {
      return consumer({ kind: 'folder', name: 'Broken', resource: { files: [{ path: badPath, file: new Blob(['x']) }] } }, signal || new AbortController().signal);
    } },
    onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
  });
  await rejects(() => strictPathExplorer.importToolTransfer(strictPathProject.root, `strict-${badPath}`), /relative POSIX paths/, `Malformed folder path ${badPath} was silently normalized`);
  assert(flatten(strictPathProject).length === 0 && strictPathProject.dirty === false, `Rejected folder path ${badPath} partially modified the ProjectStore`);
}

const preAborted = new AbortController(); preAborted.abort();
let preAbortedTaskRan = false;
await rejects(() => waitBounded(() => { preAbortedTaskRan = true; }, { signal: preAborted.signal, abortMessage: 'pre-aborted' }), /pre-aborted/, 'Pre-aborted bounded task did not reject');
assert(!preAbortedTaskRan, 'Pre-aborted bounded task still invoked its factory');
let expiredTaskRan = false;
await rejects(() => waitBounded(() => { expiredTaskRan = true; }, { timeoutMs: 0, timeoutMessage: 'expired' }), /expired/, 'Expired bounded task did not reject');
assert(!expiredTaskRan, 'Expired bounded task still invoked its factory');

const boundedHost = new ModuleHost({}, { ui: { toast() {} } });
const boundedCallStarted = Date.now();
await rejects(() => boundedHost.callTool(() => new Promise(() => {}), 'Synthetic tool call', { signal: null, timeoutMs: 25 }), /timed out/, 'ModuleHost tool-call timeout did not fire');
assert(Date.now() - boundedCallStarted < 1000, 'ModuleHost tool-call timeout waited unexpectedly long');
const toolAbort = await rejects(() => boundedHost.callTool(() => { throw new DOMException('tool-level abort', 'AbortError'); }, 'Synthetic tool call', { signal: null, timeoutMs: 1000 }), /Synthetic tool call failed: tool-level abort/, 'Tool-thrown AbortError was mistaken for wrapper lifecycle cancellation');
assert(toolAbort.name === 'Error', 'Tool-thrown AbortError escaped wrapper attribution unchanged');
await rejects(() => boundedHost.callTool(() => { throw 'boom'; }, 'Broken Tool get()', { signal: null, timeoutMs: 1000 }), /Broken Tool get\(\) failed: boom/, 'Tool API errors are not attributed to the failing tool/method');
assert(hostSource.includes('TOOL_CALL_TIMEOUT_MS = 60000') && hostSource.includes('this.callTool(() => tool.open') && hostSource.includes('this.callTool(() => tool.replace') && hostSource.includes('this.callTool(() => tool.get'), 'Tool API execution is no longer bounded by the host');
assert(hostSource.includes('normalizeToolApi') && hostSource.includes('tool.open(file), required to open a project file'), 'Malformed Tool API fail-fast boundary regressed');
assert(hostSource.includes('if (hasFile === hasFolder) return null') && hostSource.includes("attributeFilter: ['data-file', 'data-folder']"), 'Semantic resource ambiguity/dynamic-attribute guard regressed');
assert(appSource.includes('pending.projectNodeId') && appSource.includes('linked?.path || pending.filePath'), 'Pending saved tabs no longer follow renamed/moved Project nodes');



// Clearing the transfer registry cancels resolvers that were already consumed from
// the token map; project replacement must not wait for their timeout.
const activeTransferRegistry = new (await import('../js/core/transfer-registry.js')).TransferRegistry();
const hangingToken = activeTransferRegistry.register({ kind: 'file', name: 'hang.bin', getResource: () => new Promise(() => {}) });
const hangingResolve = activeTransferRegistry.consume(hangingToken, (item) => item);
await new Promise((resolve) => setTimeout(resolve, 0));
activeTransferRegistry.clear();
const cancelledTransfer = await rejects(() => hangingResolve, /cancelled/, 'Active transfer resolver survived TransferRegistry.clear()');
assert(cancelledTransfer.name === 'AbortError', 'Active transfer cancellation did not use AbortError semantics');

const transferRegistrySource = await readFile(path.join(rootDir, 'js/core/transfer-registry.js'), 'utf8');
assert(transferRegistrySource.includes('activeControllers') && transferRegistrySource.includes('controller.abort()'), 'Active Tool transfer cancellation guard regressed');
const ownerTransferRegistry = new (await import('../js/core/transfer-registry.js')).TransferRegistry();
const owner = {}; const foreignOwner = {};
const ownerToken = ownerTransferRegistry.register({ kind: 'file', name: 'owner.bin', owner, getResource: () => new Promise(() => {}) });
const foreignToken = ownerTransferRegistry.register({ kind: 'file', name: 'foreign.bin', owner: foreignOwner, getResource: () => new Blob(['ok']) });
const ownerResolve = ownerTransferRegistry.consume(ownerToken, (item) => item);
await new Promise((resolve) => setTimeout(resolve, 0));
ownerTransferRegistry.cancelOwner(owner);
const ownerCancelled = await rejects(() => ownerResolve, /cancelled/, 'Closing a source host did not cancel its active transfer resolver');
assert(ownerCancelled.name === 'AbortError', 'Owner-scoped transfer cancellation lost AbortError semantics');
assert((await ownerTransferRegistry.consume(foreignToken, (item) => item)).resource.size === 2, 'Owner-scoped cancellation affected another host');
const targetTransferRegistry = new (await import('../js/core/transfer-registry.js')).TransferRegistry();
const targetToken = targetTransferRegistry.register({ kind: 'file', name: 'target.bin', getResource: () => new Promise(() => {}) });
const targetController = new AbortController();
const targetResolve = targetTransferRegistry.consume(targetToken, (item) => item, { signal: targetController.signal });
await new Promise((resolve) => setTimeout(resolve, 0));
targetController.abort();
const targetCancelled = await rejects(() => targetResolve, /cancelled/, 'Closing a target host did not cancel its in-flight transfer resolver');
assert(targetCancelled.name === 'AbortError', 'Target-scoped transfer cancellation lost AbortError semantics');
assert(transferRegistrySource.includes('cancelOwner(owner)') && hostSource.includes('cancelOwner?.(this)') && hostSource.includes('owner: this'), 'ModuleHost-owned transfer lifecycle guard regressed');
assert(transferRegistrySource.includes('AbortSignal.any([controller.signal, signal])') && hostSource.includes('incomingFiles(event, win, { signal })') && hostSource.includes('`${manifest.name} replace()`, { signal }'), 'Target-host lifecycle is not propagated through tool-to-tool drops');
assert(explorerSource.includes('project.owns?.(target)') && explorerSource.includes('isCurrentProject(project)'), 'Explorer async transfer lifecycle/ownership recheck regressed');
assert(explorerSource.includes('iterator cleanup is best-effort') && !explorerSource.includes('await iterator.return?.()'), 'Async iterator cleanup can block folder-transfer timeout again');



// Explorer lifecycle abort interrupts a hanging async folder iterator immediately,
// rather than waiting for the per-step timeout after a project switch/destroy.
const lifecycleTransferProject = new ProjectStore('Lifecycle Transfer');
const lifecycleTransferExplorer = new ProjectExplorer({}, {
  getProject: () => lifecycleTransferProject,
  transfers: { async consume(_token, consumer, { signal } = {}) {
    return consumer({ kind: 'folder', name: 'HANG', resource: { files: { [Symbol.asyncIterator]() { return { next() { return new Promise(() => {}); }, return() { return Promise.resolve({ done: true }); } }; } } } }, signal || new AbortController().signal);
  } },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
const lifecycleTransferPromise = lifecycleTransferExplorer.importToolTransfer(lifecycleTransferProject.root, 'hang-folder');
await new Promise((resolve) => setTimeout(resolve, 0));
const lifecycleAbortStarted = Date.now();
lifecycleTransferExplorer.destroy();
const lifecycleAbort = await rejects(() => lifecycleTransferPromise, /cancelled/, 'Explorer destroy did not interrupt hanging folder iterator');
assert(lifecycleAbort.name === 'AbortError' && Date.now() - lifecycleAbortStarted < 1000, 'Explorer lifecycle abort waited for the transfer step timeout');
assert(flatten(lifecycleTransferProject).length === 0 && lifecycleTransferProject.dirty === false, 'Cancelled lifecycle transfer mutated the Project');

console.log('Deep wrapper validation passed: archive integrity, canonical persistence, revision safety, atomic batches, linked tabs, module coherence and lifecycle guards, node identity, CRC completeness, bounded registry loading and persistence recovery and teardown containment and transfer cancellation and Explorer lifecycle abort');
