import { ModuleHost } from './module-host.js?v=0.14.3';
import { escapeHtml, safeText } from '../../shared/utils/format.js?v=0.14.3';

function tabId() { return globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random()}`; }
function safeTabTitle(value, fallback = 'Untitled') { return safeText(value, 512).trim() || safeText(fallback, 512, 'Untitled').trim() || 'Untitled'; }

function removeTab(manager, tab, preferredId = null) {
  const index = manager.tabs.indexOf(tab);
  if (index < 0) { tab.panel.remove(); return false; }
  tab.panel.remove();
  manager.tabs.splice(index, 1);

  if (manager.activeId === tab.id) {
    const fallback = manager.tabs.find((item) => item.id === preferredId) || manager.tabs.at(-1) || null;
    manager.activeId = null;
    if (fallback) manager.activate(fallback.id); else manager.render();
  } else manager.render();

  manager.dispatchEvent(new CustomEvent('change'));
  return true;
}

export class TabManager extends EventTarget {
  constructor({ strip, content, api }) {
    super();
    this.strip = strip;
    this.content = content;
    this.api = api;
    this.tabs = [];
    this.activeId = null;
  }

  get active() { return this.tabs.find((tab) => tab.id === this.activeId) || null; }

  updateTab(id, patch = {}) {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab || !patch || typeof patch !== 'object') return;
    let changed = false;
    if ('title' in patch) {
      const title = safeTabTitle(patch.title, tab.title);
      if (title !== tab.title) { tab.title = title; changed = true; }
    }
    if ('dirty' in patch) {
      const dirty = Boolean(patch.dirty);
      if (dirty !== Boolean(tab.dirty)) { tab.dirty = dirty; changed = true; }
    }
    if (changed) { this.render(); this.dispatchEvent(new CustomEvent('change')); }
  }

  listSerializable() {
    return this.tabs.filter((tab) => tab.tool).flatMap((tab) => {
      const linked = tab.projectNodeId ? this.api.project?.byId(tab.projectNodeId) : null;
      if (tab.projectNodeId && (!linked || linked.isDirectory)) return [];
      return [{ editorId: tab.tool.id, filePath: linked?.path || tab.filePath || null, title: tab.title }];
    });
  }

  async openTool(manifest, { file = null, filePath = null, projectNodeId = null, title = null, reuse = false, activate = true } = {}) {
    if (reuse) {
      const existing = this.tabs.find((tab) => tab.tool?.id === manifest.id && (projectNodeId ? tab.projectNodeId === projectNodeId : tab.filePath === filePath));
      if (existing) { if (activate) this.activate(existing.id); return existing; }
    }

    const previousActiveId = this.activeId;
    const id = tabId();
    const panel = document.createElement('section');
    panel.className = 'studio-tab-panel';
    panel.dataset.tabId = id;
    panel.hidden = true;
    this.content.appendChild(panel);

    const tabApi = Object.freeze({ update: (patch) => this.updateTab(id, patch) });
    const host = new ModuleHost(panel, { ...this.api, tab: tabApi, document: file });
    const tab = { id, title: safeTabTitle(title || file?.name || manifest.name, manifest.name), filePath, projectNodeId, panel, host, tool: manifest };
    this.tabs.push(tab);
    if (activate) this.activate(id); else this.render();

    try {
      await host.load(manifest);
      this.dispatchEvent(new CustomEvent('change'));
      return tab;
    } catch (error) {
      await host.unload().catch(() => {});
      removeTab(this, tab, previousActiveId);
      throw error;
    }
  }

  openStudioPage(key, { title, render } = {}) {
    const existing = this.tabs.find((tab) => tab.studioKey === key);
    if (existing) { this.activate(existing.id); render?.(existing.panel); return existing; }

    const id = tabId();
    const panel = document.createElement('section');
    panel.className = 'studio-tab-panel studio-page-panel';
    panel.dataset.tabId = id;
    panel.hidden = true;
    this.content.appendChild(panel);
    const tab = { id, title: safeTabTitle(title || key, key), studioKey: key, panel };

    try { render?.(panel); }
    catch (error) { panel.remove(); throw error; }

    this.tabs.push(tab);
    this.activate(id);
    this.dispatchEvent(new CustomEvent('change'));
    return tab;
  }

  activate(id) {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return false;
    this.activeId = id;
    for (const item of this.tabs) item.panel.hidden = item.id !== id;
    this.render();
    this.dispatchEvent(new CustomEvent('activate', { detail: { tab } }));
    return true;
  }

  async close(id) {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return false;
    if (tab.dirty && !(await this.api.ui.confirm(`Close ${tab.title}? Unsaved changes in this tool will be discarded.`))) return false;
    try { await tab.host?.unload(); }
    catch (error) { console.warn(`Tab ${tab.title} closed after a host cleanup error.`, error); }
    removeTab(this, tab);
    return true;
  }

  async discardAll() {
    const errors = [];
    for (const tab of [...this.tabs]) {
      try { if (tab.host) await tab.host.unload(); } catch (error) { errors.push(error); }
      tab.panel?.remove();
    }
    this.tabs = [];
    this.activeId = null;
    this.strip.replaceChildren();
    this.content.replaceChildren();
    if (errors.length) console.warn(`Tab cleanup completed with ${errors.length} host unload error(s).`, errors[0]);
  }

  getLeaveWarning() {
    const dirty = this.tabs.find((tab) => tab.dirty);
    return dirty ? `${dirty.title} has unsaved changes.` : null;
  }

  render() {
    this.strip.innerHTML = this.tabs.map((tab) => {
      const icon = tab.tool?.iconUrl ? `<span class="tab-icon tool-tab-icon"><img src="${escapeHtml(tab.tool.iconUrl)}" alt=""></span>` : '';
      const tooltip = tab.tool ? `${tab.tool.name}  |  ${tab.tool.author}  |  v${tab.tool.version}` : tab.title;
      return `<button class="document-tab ${tab.id === this.activeId ? 'active' : ''}" data-tab-id="${tab.id}" type="button" title="${escapeHtml(tooltip)}">${icon}<span class="tab-title">${escapeHtml(tab.title)}</span>${tab.dirty ? '<span class="tab-dirty">●</span>' : ''}<span class="tab-close" data-tab-close>×</span></button>`;
    }).join('');
  }
}
