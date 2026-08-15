import { Registry } from './core/registry.js?v=0.14.5';
import { UIService } from './core/ui-service.js?v=0.14.5';
import { ProjectStore, savedTabKey } from './core/project-store.js?v=0.14.5';
import { ProjectExplorer } from './core/project-explorer.js?v=0.14.5';
import { TransferRegistry } from './core/transfer-registry.js?v=0.14.5';
import { TabManager } from './core/tab-manager.js?v=0.14.5';
import { bindShortcuts } from './core/shortcut-manager.js?v=0.14.5';
import { OpenWithDialog } from './core/open-with-dialog.js?v=0.14.5';
import { associationKeys, preferredAssociationKey, associationLabel } from './core/file-associations.js?v=0.14.5';
import { automaticHandler } from './core/file-open-policy.js?v=0.14.5';
import { ToolLibraryView } from './views/tool-library.js?v=0.14.5';
import { ProjectSearch } from './views/project-search.js?v=0.14.5';
import { escapeHtml, errorText, isAbortError } from '../shared/utils/format.js?v=0.14.5';

const VERSION = '0.14.5';

function requiredElement(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Studio shell is missing required element: ${selector}`);
  return element;
}

const ui = new UIService(requiredElement('#toast-root'));
const transfers = new TransferRegistry();
const registry = new Registry(new URL('../tools/catalog.json', import.meta.url));
const registryReady = registry.load().then(() => null, (error) => {
  console.error('Tool catalog failed to load.', error);
  return error;
});
const openWithDialog = new OpenWithDialog(requiredElement('#modal-root'));

let project = null;
let tabs = null;
let explorer = null;
let search = null;
let activeSidebar = 'explorer';
let projectEventController = null;
let projectBusy = false;
let pendingTabs = new Map();

const els = {
  app: requiredElement('#app'),
  gate: requiredElement('#project-gate'),
  title: requiredElement('#project-title'),
  save: requiredElement('#save-project'),
  sidebar: requiredElement('#project-sidebar'),
  explorer: requiredElement('#project-explorer'),
  strip: requiredElement('#document-tabs'),
  content: requiredElement('#tab-content'),
  openInput: requiredElement('#project-open-input'),
  body: requiredElement('.studio-body'),
  search: requiredElement('#project-search'),
  activityExplorer: requiredElement('#activity-explorer'),
  activitySearch: requiredElement('#activity-search'),
  activityTools: requiredElement('#activity-tools-list'),
};

function reportStudioError(prefix, error, timeout = 7000) {
  if (isAbortError(error)) return;
  console.error(prefix, error);
  ui.toast(`${prefix}: ${errorText(error)}`, 'error', timeout);
}

function activityToolButton(tool) {
  return `<button class="activity-button activity-tool" data-open-tool="${escapeHtml(tool.id)}" type="button" title="${escapeHtml(tool.name)}" aria-label="${escapeHtml(tool.name)}"><img src="${escapeHtml(tool.iconUrl)}" alt=""></button>`;
}

function renderToolAccess() {
  const pinned = (project?.workspace?.pinnedTools || []).map((id) => registry.get(id)).filter(Boolean);
  els.activityTools.innerHTML = pinned.map(activityToolButton).join('');
}

function setProjectBusy(value) {
  projectBusy = Boolean(value);
  els.app.inert = projectBusy;
  els.gate.inert = projectBusy;
  els.app.setAttribute('aria-busy', String(projectBusy));
  updateProjectChrome();
}

async function runProjectTask(action, errorPrefix) {
  if (projectBusy) return;
  setProjectBusy(true);
  try { return await action(); }
  catch (error) { reportStudioError(errorPrefix, error); }
  finally { setProjectBusy(false); }
}

function updateProjectChrome() {
  const dirty = Boolean(project?.dirty);
  els.title.textContent = project ? `${project.name}${dirty ? ' *' : ''}` : 'No project';
  els.save.disabled = !project || projectBusy;
  document.title = project ? `${dirty ? '● ' : ''}${project.name} - PSP Modding Studio` : 'PSP Modding Studio';
}

async function canReplaceProject() {
  if (!project) return true;
  if (tabs?.getLeaveWarning() && !(await ui.confirm('A tool has unsaved changes. Close the current project and discard them?'))) return false;
  if (project.dirty && !(await ui.confirm(`Project "${project.name}" has unsaved changes. Close it anyway?`))) return false;
  return true;
}

function makeTabManager() {
  els.strip.replaceChildren();
  els.content.replaceChildren();
  tabs = new TabManager({ strip: els.strip, content: els.content, api: { ui, project, transfers } });
  els.strip.onclick = async (event) => {
    const button = event.target.closest('[data-tab-id]');
    if (!button) return;
    const id = button.dataset.tabId;
    if (event.target.closest('[data-tab-close]')) {
      event.stopPropagation();
      try { await tabs.close(id); }
      catch (error) { reportStudioError('Could not close tab', error); }
    } else tabs.activate(id);
  };
}

function serializableTabs() {
  const merged = new Map((tabs?.listSerializable() || []).map((tab) => [savedTabKey(tab), tab]));
  for (const pending of pendingTabs.values()) {
    const linked = pending.projectNodeId ? project?.byId(pending.projectNodeId) : null;
    if (pending.projectNodeId && (!linked || linked.isDirectory)) continue;
    const tab = { editorId: pending.editorId, filePath: linked?.path || pending.filePath || null, title: pending.title || null };
    const key = savedTabKey(tab);
    if (!merged.has(key)) merged.set(key, tab);
  }
  return [...merged.values()];
}

async function restoreSavedTabs(manager, ownerProject) {
  if (!pendingTabs.size) return;
  await registryReady;
  if (tabs !== manager || project !== ownerProject) return;

  let firstRestoredId = null;
  const failedTools = new Set();
  for (const [key, saved] of pendingTabs) {
    if (tabs !== manager || project !== ownerProject) return;
    if (failedTools.has(saved.editorId)) continue;
    const node = saved.projectNodeId ? ownerProject.byId(saved.projectNodeId) : (saved.filePath ? ownerProject.get(saved.filePath) : null);
    if (saved.filePath && (!node || node.isDirectory)) { pendingTabs.delete(key); continue; }
    const tool = registry.get(saved.editorId);
    if (!tool) continue;
    const file = node ? new File([node.blob], node.name, { type: node.blob.type }) : null;
    try {
      const tab = await manager.openTool(tool, { file, filePath: node?.path || null, projectNodeId: node?.id || null, title: saved.title || null, reuse: true, activate: false });
      firstRestoredId ||= tab.id;
      if (tabs === manager && project === ownerProject) pendingTabs.delete(key);
    } catch (error) {
      failedTools.add(saved.editorId);
      reportStudioError(`Could not restore ${saved.title || tool.name}`, error, 6500);
    }
  }
  if (tabs === manager && project === ownerProject && !manager.activeId && firstRestoredId) manager.activate(firstRestoredId);
}

function bindProjectEvents() {
  projectEventController?.abort();
  projectEventController = new AbortController();
  const onProjectEvent = (event) => {
    updateProjectChrome();
    if (event.type === 'change' && ['tool-pinned', 'tool-unpinned'].includes(event.detail?.reason)) {
      renderToolAccess();
    }
  };
  for (const type of ['change', 'saved']) project.addEventListener(type, onProjectEvent, { signal: projectEventController.signal });

  explorer = new ProjectExplorer(els.explorer, {
    getProject: () => project,
    transfers,
    onOpenFile: (node) => openProjectFile(node),
    onOpenWith: (node) => openProjectFile(node, { forceChooser: true }),
    ui,
  });
  explorer.bind(project);
  search ||= new ProjectSearch(els.search, { getProject: () => project, onOpenFile: (node) => openProjectFile(node) });
  search.bind(project);
}

async function startProject(nextProject, manifest = {}) {
  openWithDialog.close(null);
  explorer?.destroy?.();
  search?.bind(null);
  transfers.clear();
  if (tabs) await tabs.discardAll();

  project = nextProject;
  pendingTabs = new Map((Array.isArray(manifest.tabs) ? manifest.tabs : []).map((tab) => {
    const node = tab?.filePath ? nextProject.get(tab.filePath) : null;
    return [savedTabKey(tab), { ...tab, projectNodeId: node && !node.isDirectory ? node.id : null }];
  }));
  bindProjectEvents();
  makeTabManager();
  const manager = tabs;
  els.gate.classList.add('hidden');
  updateProjectChrome();
  renderToolAccess();
  void restoreSavedTabs(manager, nextProject);
}

async function createProject() {
  await runProjectTask(async () => {
    if (!(await canReplaceProject())) return;
    const name = prompt('Project name', 'My PSP Project')?.trim();
    if (!name) return;
    await startProject(ProjectStore.createNew(name));
    ui.toast('Project created. Add files or open a tool.', 'success');
  }, 'Could not create project');
}

async function chooseProjectFile() { if (!projectBusy) els.openInput.click(); }
els.openInput.onchange = async () => {
  const [file] = els.openInput.files || [];
  els.openInput.value = '';
  if (!file || projectBusy) return;
  await runProjectTask(async () => {
    const { project: loaded, manifest } = await ProjectStore.open(file);
    if (!(await canReplaceProject())) return;
    await startProject(loaded, manifest);
    ui.toast(`${loaded.name} opened.`, 'success');
  }, 'Could not open project');
};

async function saveProject() {
  if (!project || projectBusy) return;
  await runProjectTask(async () => {
    const result = await project.save({ tabs: serializableTabs() });
    if (result.clean) ui.toast(`Project saved as ${result.name}.`, 'success');
    else ui.toast(`Saved ${result.name}, but the project changed during the save and still has unsaved changes.`, 'info', 6500);
  }, 'Project save failed');
}

async function openTool(id, options = {}) {
  if (!project || projectBusy) return;
  const ownerProject = project;
  const manager = tabs;
  await registryReady;
  if (project !== ownerProject || tabs !== manager || projectBusy) return;
  const manifest = registry.get(id);
  if (!manifest) return ui.toast(`Tool not found: ${id}`, 'error');
  try { return await manager.openTool(manifest, options); }
  catch (error) { reportStudioError(`Could not open ${manifest.name}`, error); return null; }
}

function resolveSavedAssociation(fileName, handlers) {
  for (const key of associationKeys(fileName)) {
    const toolId = project?.workspace?.fileAssociations?.[key];
    if (toolId && handlers.some((tool) => tool.id === toolId)) return { key, toolId };
  }
  return null;
}

async function openProjectFile(node, { forceChooser = false } = {}) {
  const ownerProject = project;
  await registryReady;
  if (!ownerProject || project !== ownerProject || projectBusy || !node || ownerProject.byId(node.id) !== node) return;
  const handlers = registry.findHandlers(node.name);
  if (!handlers.length) return ui.toast(`No tool in the catalog declares support for ${node.name}.`, 'info', 4200);

  const saved = resolveSavedAssociation(node.name, handlers);
  let tool = !forceChooser && saved ? registry.get(saved.toolId) : null;
  if (!tool && !forceChooser) tool = automaticHandler(node.name, handlers);

  let choice = null;
  let associationKey = null;
  if (!tool) {
    associationKey = preferredAssociationKey(node.name, handlers);
    choice = await openWithDialog.choose({
      fileName: node.name,
      handlers,
      pinnedIds: ownerProject.workspace.pinnedTools,
      suggestedIds: ownerProject.workspace.suggestedTools,
      defaultToolId: saved?.toolId || null,
      associationKey,
      associationLabel: associationLabel(associationKey),
    });
    if (!choice || project !== ownerProject || ownerProject.byId(node.id) !== node) return;
    tool = registry.get(choice.toolId);
    if (!tool) return;
  }

  const file = new File([node.blob], node.name, { type: node.blob.type || 'application/octet-stream' });
  const opened = await openTool(tool.id, { file, filePath: node.path, projectNodeId: node.id, title: `${node.name} - ${tool.name.replace(/ \(.*\)$/, '')}`, reuse: true });
  if (!opened || !choice || project !== ownerProject || ownerProject.byId(node.id) !== node) return;

  ownerProject.suggestTool(tool.id);
  if (choice.remember && ownerProject.workspace.fileAssociations[associationKey] !== tool.id && !ownerProject.setFileAssociation(associationKey, tool.id)) {
    ui.toast(`Could not remember the Open With association for ${associationLabel(associationKey)}.`, 'warning', 4200);
  }
}

function openToolLibrary() {
  if (!project || !tabs || projectBusy) return;
  try {
    tabs.openStudioPage('tool-library', {
      title: 'Tool Library',
      render: (panel) => new ToolLibraryView({ registry, getProject: () => project, ui }).mount(panel),
    });
  } catch (error) {
    reportStudioError('Could not open Tool Library', error, 6000);
  }
}

function setSidebarVisible(show) {
  els.sidebar.classList.toggle('collapsed', !show);
  els.body.classList.toggle('explorer-hidden', !show);
  els.activityExplorer.classList.toggle('active', show && activeSidebar === 'explorer');
  els.activitySearch.classList.toggle('active', show && activeSidebar === 'search');
}

function selectSidebar(activity, { toggle = false } = {}) {
  if (!['explorer', 'search'].includes(activity)) return;
  const visible = !els.sidebar.classList.contains('collapsed');
  if (toggle && visible && activeSidebar === activity) { setSidebarVisible(false); return; }
  activeSidebar = activity;
  els.explorer.classList.toggle('hidden', activity !== 'explorer');
  els.search.classList.toggle('hidden', activity !== 'search');
  setSidebarVisible(true);
  if (activity === 'search') queueMicrotask(() => els.search.querySelector('[data-search-query]')?.focus());
}

function toggleSidebar() { setSidebarVisible(els.sidebar.classList.contains('collapsed')); }

els.activityExplorer.onclick = () => selectSidebar('explorer', { toggle: true });
els.activitySearch.onclick = () => selectSidebar('search', { toggle: true });

document.addEventListener('click', (event) => {
  const toolId = event.target.closest('[data-open-tool]')?.dataset.openTool;
  if (toolId) { openTool(toolId); return; }
  if (event.target.closest('[data-open-library]')) { openToolLibrary(); return; }
  const shellCommand = event.target.closest('[data-shell-command]')?.dataset.shellCommand;
  if (shellCommand) ({ new: createProject, open: chooseProjectFile, save: saveProject })[shellCommand]?.();
});

bindShortcuts(window, [
  { id: 'studio.project.save', combo: 'Mod+S', handler: () => saveProject() },
  { id: 'studio.project.new', combo: 'Mod+N', handler: () => createProject() },
  { id: 'studio.project.open', combo: 'Mod+O', handler: () => chooseProjectFile() },
  { id: 'studio.sidebar.toggle', combo: 'Mod+B', handler: () => toggleSidebar() },
  { id: 'studio.search.open', combo: 'Mod+Shift+F', handler: () => selectSidebar('search') },
], { scope: 'studio-shell' });

window.addEventListener('unhandledrejection', (event) => reportStudioError('Unhandled Studio promise rejection', event.reason));
window.addEventListener('error', (event) => { if (event.error) reportStudioError('Unhandled Studio error', event.error); });
window.addEventListener('beforeunload', (event) => {
  if (project?.dirty || tabs?.getLeaveWarning()) { event.preventDefault(); event.returnValue = ''; }
});

updateProjectChrome();
registryReady.then((loadError) => {
  renderToolAccess();
  if (loadError) ui.toast(`Tool catalog unavailable: ${errorText(loadError)}. Project features remain available.`, 'error', 8000);
  else if (registry.errors.length) ui.toast(`${registry.errors.length} tool${registry.errors.length === 1 ? '' : 's'} could not be loaded. The Studio is still usable.`, 'error', 7000);
});
