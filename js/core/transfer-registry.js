import { waitBounded } from './async-utils.js?v=0.14.3';
import { safeText } from '../../shared/utils/format.js?v=0.14.3';
export const TOOL_TRANSFER_MIME = 'application/x-psp-studio-transfer';
export const PROJECT_NODE_MIME = 'application/x-psp-project-node';
const TRANSFER_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_TRANSFERS = 256;
// Outer fail-safe; ModuleHost Tool API calls time out first with method-specific diagnostics.
const TRANSFER_RESOURCE_TIMEOUT_MS = 65 * 1000;

export class TransferRegistry {
  #items = new Map();
  #activeControllers = new Map();
  #activeProjectDrag = null;


  beginProjectDrag(nodeId) {
    const id = String(nodeId || '').trim();
    if (!id) return false;
    this.#activeProjectDrag = { nodeId: id, startedAt: Date.now() };
    return true;
  }

  endProjectDrag(nodeId = null) {
    if (!this.#activeProjectDrag) return false;
    if (nodeId != null && String(nodeId) !== this.#activeProjectDrag.nodeId) return false;
    this.#activeProjectDrag = null;
    return true;
  }

  activeProjectNodeId() {
    return this.#activeProjectDrag?.nodeId || '';
  }

  register({ kind = 'file', name, getResource, owner = null }) {
    if (!['file', 'folder'].includes(kind)) throw new Error(`Unsupported transfer kind: ${kind}`);
    if (typeof getResource !== 'function') throw new Error('Transfer resource resolver must be a function.');
    while (this.#items.size >= MAX_PENDING_TRANSFERS) this.cancel(this.#items.keys().next().value);
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const timeoutId = setTimeout(() => this.cancel(token), TRANSFER_TTL_MS);
    this.#items.set(token, {
      kind,
      name: safeText(name, 1024, kind === 'folder' ? 'Folder' : 'File').trim() || (kind === 'folder' ? 'Folder' : 'File'),
      getResource,
      owner,
      timeoutId,
    });
    return token;
  }

  async consume(token, consumer, { signal = null } = {}) {
    if (typeof consumer !== 'function') throw new Error('Transfer consumer must be a function.');
    const item = this.#items.get(token);
    if (!item) throw new Error('Drag payload expired.');
    this.cancel(token);

    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.#activeControllers.set(controller, item.owner);
    try {
      const resource = await waitBounded(item.getResource, {
        timeoutMs: TRANSFER_RESOURCE_TIMEOUT_MS,
        timeoutMessage: 'Tool transfer timed out while resolving its resource.',
        signal: combinedSignal,
        abortMessage: 'Tool transfer cancelled.',
      });
      return await consumer({ kind: item.kind, name: item.name, resource }, combinedSignal);
    } finally { this.#activeControllers.delete(controller); }
  }

  cancel(token) {
    const item = this.#items.get(token);
    if (item?.timeoutId) clearTimeout(item.timeoutId);
    return this.#items.delete(token);
  }

  cancelOwner(owner) {
    if (!owner) return;
    for (const [token, item] of this.#items) if (item.owner === owner) this.cancel(token);
    for (const [controller, activeOwner] of this.#activeControllers) if (activeOwner === owner) controller.abort();
  }

  clear() {
    this.#activeProjectDrag = null;
    for (const token of this.#items.keys()) this.cancel(token);
    for (const controller of this.#activeControllers.keys()) controller.abort();
    this.#activeControllers.clear();
  }
}
