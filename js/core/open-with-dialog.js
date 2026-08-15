import { escapeHtml as esc } from '../../shared/utils/format.js?v=0.14.5';

function groupHandlers(handlers, pinnedIds, suggestedIds) {
  const pinnedSet = new Set(pinnedIds);
  const suggestedSet = new Set(suggestedIds);
  const pinned = handlers.filter((tool) => pinnedSet.has(tool.id));
  const suggested = handlers.filter((tool) => !pinnedSet.has(tool.id) && suggestedSet.has(tool.id));
  const core = handlers.filter((tool) => tool.core && !pinnedSet.has(tool.id) && !suggestedSet.has(tool.id));
  const other = handlers.filter((tool) => !pinnedSet.has(tool.id) && !suggestedSet.has(tool.id) && !tool.core);
  return { pinned, suggested, core, other };
}

export class OpenWithDialog {
  #root;
  #active = null;

  constructor(root) { this.#root = root; }

  close(result = null) {
    if (!this.#active) return;
    const { overlay, resolve, controller } = this.#active;
    controller.abort(); overlay.remove(); this.#active = null; resolve(result);
  }

  choose({ fileName, handlers, pinnedIds = [], suggestedIds = [], defaultToolId = null, associationKey = null, associationLabel = 'this file type' }) {
    if (this.#active) this.close(null);
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'studio-modal-overlay';
      overlay.innerHTML = `<section class="studio-modal open-with-modal" role="dialog" aria-modal="true" aria-labelledby="open-with-title">
        <header class="studio-modal-head"><div><div class="eyebrow">Open with</div><h2 id="open-with-title">${esc(fileName)}</h2></div><button class="icon-button modal-close" type="button" aria-label="Close">×</button></header>
        <div class="open-with-search-wrap"><input class="studio-input open-with-search" type="search" placeholder="Search compatible tools..." autocomplete="off"></div>
        <div class="open-with-list"></div>
        <footer class="studio-modal-foot">
          ${associationKey ? `<label class="remember-choice"><input type="checkbox" data-remember> <span>Always use the selected tool for <strong>${esc(associationLabel)}</strong></span></label>` : '<span></span>'}
          <button class="button" type="button" data-cancel>Cancel</button>
        </footer>
      </section>`;
      this.#root.appendChild(overlay);

      const list = overlay.querySelector('.open-with-list');
      const search = overlay.querySelector('.open-with-search');
      const remember = overlay.querySelector('[data-remember]');
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const filtered = handlers.filter((tool) => !q || [tool.name, tool.description, tool.author, ...tool.keywords, ...tool.accepts].join(' ').toLowerCase().includes(q));
        const groups = groupHandlers(filtered, pinnedIds, suggestedIds);
        const sections = [
          ['Pinned', groups.pinned],
          ['Suggested', groups.suggested],
          ['Core', groups.core],
          ['Other compatible tools', groups.other],
        ].filter(([, items]) => items.length);
        list.innerHTML = sections.length ? sections.map(([label, items]) => `<div class="open-with-group"><div class="open-with-group-title">${esc(label)}</div>${items.map((tool) => `<button class="open-with-tool ${tool.id === defaultToolId ? 'default' : ''}" type="button" data-tool-id="${esc(tool.id)}">
          <img src="${esc(tool.iconUrl)}" alt=""><span class="open-with-tool-copy"><strong>${esc(tool.name)}</strong><small>${esc(tool.description)}</small><span>${esc(tool.author)}  |  v${esc(tool.version)}</span></span>${tool.id === defaultToolId ? '<span class="default-badge">Default</span>' : ''}
        </button>`).join('')}</div>`).join('') : '<div class="open-with-empty">No compatible tools match your search.</div>';
      };
      render();
      search.addEventListener('input', render);
      list.addEventListener('click', (event) => {
        const id = event.target.closest('[data-tool-id]')?.dataset.toolId;
        if (id) this.close({ toolId: id, remember: Boolean(remember?.checked) });
      });
      overlay.querySelector('[data-cancel]').onclick = () => this.close(null);
      overlay.querySelector('.modal-close').onclick = () => this.close(null);
      overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) this.close(null); });
      const controller = new AbortController();
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); this.close(null); } }, { capture: true, signal: controller.signal });
      this.#active = { overlay, resolve, controller };
      queueMicrotask(() => search.focus());
    });
  }
}
