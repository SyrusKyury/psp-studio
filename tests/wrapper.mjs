import { File } from 'node:buffer';
import { access, readFile } from 'node:fs/promises';
import { ProjectStore } from '../js/core/project-store.js';
import { ProjectExplorer } from '../js/core/project-explorer.js';
import { Registry } from '../js/core/registry.js';
import { TransferRegistry } from '../js/core/transfer-registry.js';
import { bindShortcuts } from '../js/core/shortcut-manager.js';
import { createStoredZip } from '../shared/archive/zip-store.js';

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

// New workspaces expose the primary disc tool immediately without mutating loaded project preferences.
const defaultProject = ProjectStore.createNew('Default Tools');
assert(defaultProject.workspace.pinnedTools.join(',') === 'umd-forge', 'New projects no longer pin UMD Forge by default');
assert(defaultProject.dirty === false, 'Default new-project pin incorrectly marks a fresh project dirty');
const plainProject = new ProjectStore('Loaded-style Project');
assert(plainProject.workspace.pinnedTools.length === 0, 'Base ProjectStore unexpectedly injects defaults into loaded/legacy workspace state');

// ProjectStore must never persist traversal/control path segments.
const safeProject = new ProjectStore('Core Baseline');
const strange = safeProject.createFolder('/', '..');
assert(strange.path !== '/..' && !strange.path.includes('/../'), 'ProjectStore accepted a traversal folder segment');
safeProject.addBlob(strange.path, '../bad.bin', new Blob(['safe']));
for (const node of flatten(safeProject)) {
  assert(!node.path.split('/').some((part) => part === '.' || part === '..'), `Unsafe Project path survived: ${node.path}`);
}

// A malicious .pspstudio path must be rejected before it mutates the tree.
const manifest = new Blob([JSON.stringify({ format: 'psp-modding-studio-project', version: 1, name: 'Unsafe' })], { type: 'application/json' });
const unsafeZip = await createStoredZip([
  { name: 'project.json', blob: manifest },
  { name: 'workspace/../escape.bin', blob: new Blob(['x']) },
]);
await rejects(() => ProjectStore.open(new File([unsafeZip], 'unsafe.pspstudio')), /Unsafe project path/, 'Unsafe project path validation failed');

// Malformed advisory tab state should be normalized rather than crashing startProject.
const malformedTabsZip = await createStoredZip([
  { name: 'project.json', blob: new Blob([JSON.stringify({ format: 'psp-modding-studio-project', version: 1, name: 'Tabs', tabs: { bad: true } })]) },
]);
const malformedTabsOpen = await ProjectStore.open(new File([malformedTabsZip], 'tabs.pspstudio'));
assert(Array.isArray(malformedTabsOpen.manifest.tabs) && malformedTabsOpen.manifest.tabs.length === 0, 'Malformed tab state was not normalized');
const malformedNameZip = await createStoredZip([
  { name: 'project.json', blob: new Blob([JSON.stringify({ format: 'psp-modding-studio-project', version: 1, name: { bad: true } })]) },
]);
await rejects(() => ProjectStore.open(new File([malformedNameZip], 'bad-name.pspstudio')), /name must be a string/, 'Malformed structural project name was silently stringified');

// Folder transfers are materialized before mutation: generator failure must leave the Project untouched.
const rollbackProject = new ProjectStore('Transfer Rollback');
const rollbackExplorer = new ProjectExplorer({}, {
  getProject: () => rollbackProject,
  transfers: {
    async consume(_token, consumer, { signal } = {}) {
      return consumer({
        kind: 'folder', name: 'BROKEN', resource: {
          async *files() {
            yield { path: 'one.bin', file: new File(['1'], 'one.bin') };
            throw new Error('synthetic transfer failure');
          },
        },
      }, signal || new AbortController().signal);
    },
  },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
await rejects(() => rollbackExplorer.importToolTransfer(rollbackProject.root, 'broken'), /synthetic transfer failure/, 'Folder transfer rollback failed');
assert(flatten(rollbackProject).length === 0 && rollbackProject.dirty === false, 'Failed folder transfer partially mutated the Project');

// Unsafe virtual folder paths are rejected atomically.
const unsafeTransferProject = new ProjectStore('Unsafe Transfer');
const unsafeTransferExplorer = new ProjectExplorer({}, {
  getProject: () => unsafeTransferProject,
  transfers: {
    async consume(_token, consumer, { signal } = {}) {
      return consumer({ kind: 'folder', name: 'DATA', resource: { files: [{ path: '../evil.bin', file: new File(['x'], 'evil.bin') }] } }, signal || new AbortController().signal);
    },
  },
  onOpenFile() {}, onOpenWith() {}, ui: { toast() {} },
});
await rejects(() => unsafeTransferExplorer.importToolTransfer(unsafeTransferProject.root, 'unsafe'), /Invalid transferred path segment/, 'Unsafe Tool folder path validation failed');
assert(flatten(unsafeTransferProject).length === 0, 'Unsafe folder transfer mutated the Project');

// Transfer handles are validated and one-shot so completed drags cannot retain tool realms for minutes.
const transferRegistry = new TransferRegistry();
const token = transferRegistry.register({ kind: 'file', name: 'one.bin', getResource: async () => new Blob(['1']) });
const resolved = await transferRegistry.consume(token, (item) => item);
assert(resolved.kind === 'file' && resolved.resource.size === 1, 'TransferRegistry did not resolve a valid item');
await rejects(() => transferRegistry.consume(token, (item) => item), /expired/, 'TransferRegistry token was not consumed');
transferRegistry.clear();

// Registry must isolate a broken future tool instead of taking down every valid tool.
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/tools/catalog.json')) return new Response(JSON.stringify({ core: ['good-tool'], tools: ['bad-tool', '../unsafe'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/good-tool/tool.json')) return new Response(JSON.stringify({ api: 1, name: 'Good', description: 'Good tool', author: 'Test', version: '1.0.0', accepts: ['.bin'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/good-tool/index.html')) return new Response(null, { status: 200 });
    if (url.endsWith('/bad-tool/tool.json')) return new Response('broken', { status: 500 });
    return new Response('not found', { status: 404 });
  };
  const registry = await new Registry(new URL('https://example.test/tools/catalog.json')).load();
  assert(registry.get('good-tool')?.core === true, 'Registry lost a valid core tool because another tool failed');
  assert(!registry.get('bad-tool') && registry.errors.length === 2, 'Registry did not isolate invalid tool entries');
} finally { globalThis.fetch = originalFetch; }

// Shortcut binder explicit Ctrl/Meta support and Space normalization are core utility invariants.
const OriginalElement = globalThis.Element;
try {
  globalThis.Element = class Element {};
  const target = new EventTarget();
  let ctrlHit = 0; let spaceHit = 0;
  const shortcutController = new AbortController();
  bindShortcuts(target, [
    { id: 'ctrl', combo: 'Ctrl+K', handler: () => { ctrlHit += 1; } },
    { id: 'space', combo: 'Space', handler: () => { spaceHit += 1; } },
  ], { signal: shortcutController.signal });
  const ctrl = new Event('keydown', { cancelable: true });
  Object.defineProperties(ctrl, { key: { value: 'k' }, ctrlKey: { value: true }, metaKey: { value: false }, shiftKey: { value: false }, altKey: { value: false } });
  target.dispatchEvent(ctrl);
  const space = new Event('keydown', { cancelable: true });
  Object.defineProperties(space, { key: { value: ' ' }, ctrlKey: { value: false }, metaKey: { value: false }, shiftKey: { value: false }, altKey: { value: false } });
  target.dispatchEvent(space);
  await new Promise((resolve) => setTimeout(resolve, 0));
  shortcutController.abort();
  const afterAbort = new Event('keydown', { cancelable: true });
  Object.defineProperties(afterAbort, { key: { value: 'k' }, ctrlKey: { value: true }, metaKey: { value: false }, shiftKey: { value: false }, altKey: { value: false } });
  target.dispatchEvent(afterAbort);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(ctrlHit === 1 && spaceHit === 1, 'Shortcut binder normalization or AbortSignal cleanup regression');
} finally { if (OriginalElement === undefined) delete globalThis.Element; else globalThis.Element = OriginalElement; }

// ZIP32 limits must fail explicitly rather than wrap 32-bit fields and create corrupt projects.
await rejects(() => createStoredZip(new Array(0xFFFF).fill({ name: 'x/', blob: new Blob([]) })), /too many entries/, 'ZIP entry-count limit missing');
const hugeFakeBlob = { size: 0x1_0000_0000, slice() { return this; }, async arrayBuffer() { return new ArrayBuffer(0); } };
await rejects(() => createStoredZip([{ name: 'huge.bin', blob: hugeFakeBlob }]), /ZIP32 limit/, 'ZIP32 file-size limit missing');

// Wrapper should not depend on a remote font/CDN and dead prototype/core files must stay gone.
const tokens = await readFile(new URL('../assets/css/tokens.css', import.meta.url), 'utf8');
assert(!/https?:\/\//i.test(tokens) && !/@import/i.test(tokens), 'Wrapper still has a remote font/style dependency');
for (const relative of ['../preview.html', '../js/core/event-bus.js', '../js/core/zip-store.js']) {
  let exists = true; try { await access(new URL(relative, import.meta.url)); } catch { exists = false; }
  assert(!exists, `Obsolete wrapper artifact still exists: ${relative}`);
}

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const host = await readFile(new URL('../js/core/module-host.js', import.meta.url), 'utf8');
const tabs = await readFile(new URL('../js/core/tab-manager.js', import.meta.url), 'utf8');
assert(app.includes("const VERSION = '0.14.5'"), 'Core baseline version mismatch');
assert(host.includes('TOOL_LOAD_TIMEOUT_MS'), 'Tool iframe load timeout missing');
assert(tabs.includes('catch (error)') && tabs.includes('panel.remove()'), 'Transactional tab cleanup missing');

console.log('Wrapper validation passed: project safety, transfer atomicity, registry isolation, shortcuts, ZIP32 guards and dependency hygiene');
