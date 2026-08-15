import { safeText } from '../../shared/utils/format.js?v=0.14.3';
const TOAST_TYPES = new Set(['info', 'success', 'error', 'warning']);
const MAX_TOASTS = 8;

function toastDelay(value) {
  try {
    const number = Number(value);
    return Math.max(800, Math.min(30000, Number.isFinite(number) ? number : 3200));
  } catch { return 3200; }
}

export class UIService {
  #root;
  #timers = new Map();

  constructor(toastRoot) { this.#root = toastRoot; }

  #remove(node) {
    clearTimeout(this.#timers.get(node));
    this.#timers.delete(node);
    node?.remove();
  }

  toast(message, type = 'info', timeout = 3200) {
    if (!this.#root) return;
    const text = safeText(message, 4000, 'Tool message could not be displayed.');
    const kind = typeof type === 'string' && TOAST_TYPES.has(type) ? type : 'info';
    const delay = toastDelay(timeout);
    while (this.#root.children.length >= MAX_TOASTS) this.#remove(this.#root.firstElementChild);
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = text;
    this.#root.appendChild(node);
    this.#timers.set(node, setTimeout(() => this.#remove(node), delay));
  }

  confirm(message) { return window.confirm(safeText(message, 8000, 'Confirm?')); }
}
