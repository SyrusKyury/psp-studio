import { escapeHtml as esc } from '../../shared/utils/format.js?v=0.14.5';

export class ToolLibraryView {
  constructor({ registry, getProject, ui }) {
    this.registry = registry;
    this.getProject = getProject;
    this.ui = ui;
    this.container = null;
    this.query = '';
  }

  mount(container) {
    this.container = container;
    container.oninput = (event) => {
      const search = event.target.closest('.tool-library-search'); if (!search) return;
      this.query = search.value; this.render();
      queueMicrotask(() => { const input = this.container?.querySelector('.tool-library-search'); input?.focus(); input?.setSelectionRange(this.query.length, this.query.length); });
    };
    container.onclick = (event) => {
      const button = event.target.closest('[data-pin-tool]');
      if (button) { event.stopPropagation(); this.setPinned(button.dataset.pinTool, button.dataset.pinValue === '1'); }
    };
    this.render();
  }

  setPinned(toolId, pinned) {
    const project = this.getProject();
    const tool = this.registry.get(toolId);
    if (!project || !tool) return;
    const changed = pinned ? project.pinTool(toolId) : project.unpinTool(toolId);
    if (!changed) {
      if (pinned !== project.workspace.pinnedTools.includes(toolId)) this.ui.toast(`Could not update the workspace pin for ${tool.name}.`, 'warning', 4200);
      return;
    }
    this.render();
    this.ui.toast(`${tool.name} ${pinned ? 'pinned to' : 'removed from'} this workspace.`, 'success', 2200);
  }

  render() {
    if (!this.container) return;
    const project = this.getProject();
    const pinned = new Set(project?.workspace?.pinnedTools || []);
    const q = this.query.trim().toLowerCase();
    const tools = this.registry.all().filter((tool) => !q || [tool.name, tool.subtitle, tool.description, tool.author, ...tool.keywords, ...tool.accepts].filter(Boolean).join(' ').toLowerCase().includes(q));
    this.container.className = 'studio-tab-panel studio-page-panel';
    this.container.innerHTML = `<div class="tool-library-page">
      <div class="tool-library-hero"><div><div class="eyebrow">Workspace</div><h1>Tool Library</h1><p>Find a tool and pin it to this workspace activity rail. All compatible tools remain available from Open With.</p></div><input class="studio-input tool-library-search" type="search" placeholder="Search tools..." value="${esc(this.query)}" autocomplete="off"></div>
      <div class="tool-library-results">${tools.length ? tools.map((tool) => `<article class="tool-library-card ${tool.core ? 'core' : ''}">
        <img class="tool-library-icon" src="${esc(tool.iconUrl)}" alt="">
        <div class="tool-library-copy"><div class="tool-library-title"><strong>${esc(tool.name)}</strong>${tool.core ? '<span class="badge accent">Core</span>' : ''}${pinned.has(tool.id) ? '<span class="badge">Pinned</span>' : ''}</div><p>${esc(tool.description)}</p><small>${esc(tool.author)}  |  v${esc(tool.version)}${tool.accepts.length ? `  |  ${esc(tool.accepts.join(', '))}` : ''}</small></div>
        <div class="tool-library-actions"><button class="button" type="button" data-open-tool="${esc(tool.id)}">Open</button><button class="button ${pinned.has(tool.id) ? '' : 'primary'}" type="button" data-pin-tool="${esc(tool.id)}" data-pin-value="${pinned.has(tool.id) ? '0' : '1'}">${pinned.has(tool.id) ? 'Unpin' : 'Pin'}</button></div>
      </article>`).join('') : '<div class="tool-library-empty">No tools match your search.</div>'}</div>
    </div>`;
  }
}
