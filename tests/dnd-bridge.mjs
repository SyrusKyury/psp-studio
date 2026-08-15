import assert from 'node:assert/strict';
import { TransferRegistry, PROJECT_NODE_MIME } from '../js/core/transfer-registry.js?v=0.14.5';
import { ModuleHost } from '../js/core/module-host.js?v=0.14.5';

const transfers = new TransferRegistry();
const node = { id: 'file-1', name: 'PATCH.BIN', path: '/PATCH.BIN', isDirectory: false, blob: new Blob([new Uint8Array([1,2,3,4])], { type: 'application/octet-stream' }) };
transfers.beginProjectDrag(node.id);
assert.equal(transfers.activeProjectNodeId(), node.id);

// Simulate Firefox dropping the custom project MIME while crossing into an iframe:
// dataTransfer has no PROJECT_NODE_MIME, but the in-memory drag session remains active.
const fakeEvent = {
  dataTransfer: {
    files: [],
    types: ['text/plain'],
    getData(type) { return type === PROJECT_NODE_MIME ? '' : ''; },
  },
};
const host = new ModuleHost({ replaceChildren() {} }, {
  transfers,
  project: { byId(id) { return id === node.id ? node : null; } },
});
const files = await host.incomingFiles(fakeEvent, globalThis, { signal: null });
assert.equal(files.length, 1);
assert.equal(files[0].name, 'PATCH.BIN');
assert.equal(files[0].size, 4);
assert.deepEqual([...new Uint8Array(await files[0].arrayBuffer())], [1,2,3,4]);
transfers.endProjectDrag(node.id);
assert.equal(transfers.activeProjectNodeId(), '');

const fs = await import('node:fs/promises');
const explorerSource = await fs.readFile(new URL('../js/core/project-explorer.js', import.meta.url), 'utf8');
const hostSource = await fs.readFile(new URL('../js/core/module-host.js', import.meta.url), 'utf8');
assert.match(explorerSource, /effectAllowed\s*=\s*'copyMove'/);
assert.ok(explorerSource.includes("window.addEventListener('psp-drag-session-end'"), 'Explorer must clear stale drop UI when an iframe drag ends');
assert.ok(explorerSource.includes("window.addEventListener('blur'") && explorerSource.includes("document.addEventListener('pointerdown'"), 'Explorer drag UI fail-safe cleanup is incomplete');
assert.ok(hostSource.includes("window.dispatchEvent(new Event('psp-drag-session-end'))"), 'ModuleHost must signal iframe drag completion to the shell');
assert.ok(hostSource.includes('endProjectDrag?.(activeProjectNodeId)'), 'ModuleHost must close stale project drag sessions after tool drops');
console.log('DnD bridge validation passed: copyMove source + MIME-loss fallback + cross-iframe drag cleanup');
