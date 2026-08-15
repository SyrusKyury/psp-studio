import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { IsoReader } from '../tools/umd-forge/core/iso-reader.js';
import { UmdWorkspace } from '../tools/umd-forge/core/workspace.js';
import { buildRebuiltIsoBlob } from '../tools/umd-forge/core/iso-writer.js';
import { parseSfoDetailed, buildSfo, parseSfo, SFO_FORMAT } from '../shared/psp/sfo.js';

const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

const fixturePath = new URL('./fixtures/umd-forge-test.iso', import.meta.url);
const sourceBytes = await readFile(fixturePath);
const source = new File([sourceBytes], 'umd-forge-test.iso');
const iso = await IsoReader.open(source);
if (!iso.get('/PSP_GAME/PARAM.SFO')) throw new Error('Fixture ISO parser failed');

const workspace = new UmdWorkspace(iso);

// File layout is initialized by original LBA and manual ordering is undoable.
const layoutTarget = workspace.get('/PSP_GAME/ICON0.PNG');
const originalPosition = workspace.layoutPosition(layoutTarget);
if (originalPosition == null || originalPosition < 1) throw new Error('Fixture cannot test file layout ordering');
const predecessor = workspace.fileLayout()[originalPosition - 1];
workspace.moveLayout(layoutTarget, -1);
if (workspace.layoutPosition(layoutTarget) !== originalPosition - 1) throw new Error('Layout move failed');
workspace.undo();
if (workspace.layoutPosition(layoutTarget) !== originalPosition) throw new Error('Layout undo failed');
workspace.redo();

const usrdir = workspace.get('/PSP_GAME/USRDIR');
workspace.addFile(usrdir, new File([new TextEncoder().encode('hello rebuild')], 'ADDED.TXT'));
workspace.addDirectory(usrdir, 'NEWDIR');
const replace = workspace.get('/PSP_GAME/USRDIR/REPLACE_ME.BIN');
workspace.replace(replace, new File([new Uint8Array(400000)], 'REPLACE_ME.BIN'));
const pattern = workspace.get('/PSP_GAME/USRDIR/DATA/PATTERN.BIN');
workspace.rename(pattern, 'RENAMED.BIN');
const text = workspace.get('/PSP_GAME/USRDIR/README.TXT');
workspace.delete(text);
if (!workspace.needsFullRebuild()) throw new Error('Workspace did not request full rebuild');

const rebuiltBlob = await buildRebuiltIsoBlob(workspace);
const rebuilt = await IsoReader.open(new File([rebuiltBlob], 'rebuilt.iso'));
if (!rebuilt.get('/PSP_GAME/USRDIR/ADDED.TXT')) throw new Error('Added file missing after rebuild');
if (!rebuilt.get('/PSP_GAME/USRDIR/NEWDIR')) throw new Error('Added directory missing after rebuild');
if (!rebuilt.get('/PSP_GAME/USRDIR/DATA/RENAMED.BIN')) throw new Error('Renamed file missing after rebuild');
if (rebuilt.get('/PSP_GAME/USRDIR/README.TXT')) throw new Error('Deleted file survived rebuild');
if (rebuilt.get('/PSP_GAME/USRDIR/REPLACE_ME.BIN').size !== 400000) throw new Error('Large replacement size wrong after rebuild');
if (!(rebuilt.get(layoutTarget.path).lba < rebuilt.get(predecessor.path).lba)) throw new Error('Rebuilt ISO did not honor manual disc order');

// PARAM.SFO round-trip/editor.
const sfoNode = workspace.get('/PSP_GAME/PARAM.SFO');
const sfoBlob = await workspace.readNode(sfoNode);
const detailed = parseSfoDetailed(await sfoBlob.arrayBuffer());
const rebuiltSfo = buildSfo(detailed, { TITLE: 'Edited Test Title', PSP_SYSTEM_VER: '6.61' });
const parsed = parseSfo(rebuiltSfo.buffer);
if (parsed.TITLE !== 'Edited Test Title' || parsed.PSP_SYSTEM_VER !== '6.61') throw new Error('SFO rebuild/editor smoke test failed');

// SFO Studio needs typed round-trips, including binary/unknown values and newly-added entries.
const studioSfo = parseSfoDetailed(rebuiltSfo.buffer);
studioSfo.entries.push({ key: 'PSPMS_BINARY_TEST', format: SFO_FORMAT.BINARY, length: 4, maxLength: 4, value: new Uint8Array([0xde,0xad,0xbe,0xef]) });
studioSfo.entries.push({ key: 'PSPMS_UINT_TEST', format: SFO_FORMAT.UINT32, length: 4, maxLength: 4, value: 0x12345678 });
const studioRoundTrip = parseSfoDetailed(buildSfo(studioSfo).buffer);
const binaryEntry = studioRoundTrip.entries.find((entry) => entry.key === 'PSPMS_BINARY_TEST');
const intEntry = studioRoundTrip.entries.find((entry) => entry.key === 'PSPMS_UINT_TEST');
if (!binaryEntry || hex(binaryEntry.value) !== 'deadbeef') throw new Error('SFO binary entry did not round-trip');
if (!intEntry || intEntry.value !== 0x12345678) throw new Error('SFO integer entry did not round-trip');

console.log('Smoke test passed: SFO regressions + ISO parse/rebuild/layout');

// UMD Forge patch round-trip: create from edit plan, load, apply to a fresh workspace, rebuild and verify.
const { createUmdPatch, openUmdPatch, checkPatchCompatibility, applyUmdPatch } = await import('../tools/umd-forge/core/patch.js');
const patchSourceIso = await IsoReader.open(new File([sourceBytes], 'umd-forge-test.iso'));
const patchWorkspace = new UmdWorkspace(patchSourceIso);
const patchReplace = patchWorkspace.get('/PSP_GAME/USRDIR/REPLACE_ME.BIN');
patchWorkspace.replace(patchReplace, new File([new TextEncoder().encode('patched from umdpatch')], 'REPLACE_ME.BIN'));
const patchUsrdir = patchWorkspace.get('/PSP_GAME/USRDIR');
patchWorkspace.addFile(patchUsrdir, new File([new TextEncoder().encode('new patch file')], 'PATCHED.TXT'));
const patchCreated = await createUmdPatch(patchWorkspace);
const patchOpened = await openUmdPatch(new File([patchCreated.blob], 'test.umdpatch'));
const freshIso = await IsoReader.open(new File([sourceBytes], 'umd-forge-test.iso'));
const freshWorkspace = new UmdWorkspace(freshIso);
const compat = await checkPatchCompatibility(freshWorkspace, patchOpened);
if (!compat.compatible) throw new Error('UMD patch compatibility fingerprint failed');
await applyUmdPatch(freshWorkspace, patchOpened);
const patchRebuiltBlob = await buildRebuiltIsoBlob(freshWorkspace);
const patchRebuilt = await IsoReader.open(new File([patchRebuiltBlob], 'patched.iso'));
const patchedText = new TextDecoder().decode(new Uint8Array(await (await patchRebuilt.readEntry(patchRebuilt.get('/PSP_GAME/USRDIR/REPLACE_ME.BIN'))).arrayBuffer()));
if (patchedText !== 'patched from umdpatch') throw new Error('UMD patch replace did not round-trip');
if (!patchRebuilt.get('/PSP_GAME/USRDIR/PATCHED.TXT')) throw new Error('UMD patch add did not round-trip');

// .pspstudio ZIP project round-trip with nested folders and files.
const { ProjectStore } = await import('../js/core/project-store.js');
const projectTest = new ProjectStore('Smoke Project');
projectTest.createFolder('/', 'Original');
projectTest.createFolder('/', 'Modified');
projectTest.createFolder('/Modified', 'Graphics');
projectTest.addBlob('/Original', 'notes.txt', new Blob(['original notes']));
projectTest.addBlob('/Modified/Graphics', 'logo.bin', new Blob([new Uint8Array([1,2,3,4])]));
const projectZip = await projectTest.toZipBlob({ tabs: [{ editorId: 'umd-forge', filePath: null, title: 'UMD Forge' }] });
const { project: loadedProject, manifest: loadedManifest } = await ProjectStore.open(new File([projectZip], 'smoke.pspstudio'));
if (!loadedProject.get('/Original/notes.txt') || !loadedProject.get('/Modified/Graphics/logo.bin')) throw new Error('Project ZIP tree round-trip failed');
if ((await loadedProject.get('/Original/notes.txt').blob.text()) !== 'original notes') throw new Error('Project ZIP file contents failed');
if (loadedManifest.tabs?.[0]?.editorId !== 'umd-forge') throw new Error('Project tab manifest failed');

console.log('Smoke test passed: project ZIP + UMD patch round-trip');

// Layout-only patches are valid too.
const layoutOnlyIso = await IsoReader.open(new File([sourceBytes], 'umd-forge-test.iso'));
const layoutOnlyWs = new UmdWorkspace(layoutOnlyIso);
const layoutNode = layoutOnlyWs.get('/PSP_GAME/ICON0.PNG');
layoutOnlyWs.moveLayout(layoutNode, -1);
const layoutOnlyPatch = await createUmdPatch(layoutOnlyWs);
if (!layoutOnlyPatch.manifest.layout?.length || layoutOnlyPatch.manifest.operations.length !== 0) throw new Error('Layout-only UMD patch generation failed');
console.log('Smoke test passed: layout-only UMD patch');


// Tool API v1 static conventions: JSON metadata + semantic file/folder tree markup.
const toolJson = JSON.parse(await readFile(new URL('../tools/umd-forge/tool.json', import.meta.url), 'utf8'));
if (toolJson.api !== 1 || toolJson.name !== 'UMD Forge' || !toolJson.description || !toolJson.author || !toolJson.version) throw new Error('Tool API v1 metadata failed');
if (!toolJson.accepts?.includes('.iso')) throw new Error('Tool API accepts metadata failed');
const { renderTree } = await import('../tools/umd-forge/ui/tree.js');
const fakeTree = { innerHTML: '' };
renderTree(fakeTree, freshWorkspace.root, freshWorkspace, '', new Set(['/PSP_GAME', '/PSP_GAME/SYSDIR']));
if (!fakeTree.innerHTML.includes('data-folder="/PSP_GAME"') || !fakeTree.innerHTML.includes('data-file="/PSP_GAME/PARAM.SFO"')) throw new Error('Tool API semantic tree attributes failed');
console.log('Smoke test passed: Tool API v1 manifest + semantic resources');


// Tool-folder -> Project bridge: a folder name comes from the semantic resource id/token metadata,
// while relative paths rebuild nested project folders without tool-specific Project knowledge.
const { ProjectExplorer } = await import('../js/core/project-explorer.js');
const folderProject = new ProjectStore('Folder Transfer');
const folderTransfer = {
  async consume(_token, consumer, { signal } = {}) {
    return consumer({
      kind: 'folder',
      name: 'USRDIR',
      resource: {
        async *files() {
          yield { path: 'A.TXT', file: new File(['a'], 'A.TXT') };
          yield { path: 'DATA/B.BIN', file: new File([new Uint8Array([9,8,7])], 'B.BIN') };
        }
      }
    }, signal || new AbortController().signal);
  }
};
const folderExplorer = new ProjectExplorer({}, { getProject: () => folderProject, transfers: folderTransfer, onOpenFile() {}, ui: { toast() {} } });
await folderExplorer.importToolTransfer(folderProject.root, 'folder-token');
if (!folderProject.get('/USRDIR/A.TXT') || !folderProject.get('/USRDIR/DATA/B.BIN')) throw new Error('Tool folder -> Project transfer failed');
console.log('Smoke test passed: Tool folder -> Project workspace transfer');

// Cross-realm Tool API resources must be recognized by interface shape, not
// by instanceof Blob/File (which is realm-specific in browsers/iframes).
const { isBlobLike, isFileLike, toRealmBlob, toRealmFile } = await import('../js/core/blob-utils.js');
const foreignBlobLike = {
  size: 4,
  type: 'application/octet-stream',
  slice() { return this; },
  async arrayBuffer() { return new Uint8Array([1,2,3,4]).buffer; },
};
const foreignFileLike = { ...foreignBlobLike, name: 'foreign.bin' };
if (!isBlobLike(foreignBlobLike) || isFileLike(foreignBlobLike)) throw new Error('Cross-realm Blob-like detection failed');
if (!isFileLike(foreignFileLike)) throw new Error('Cross-realm File-like detection failed');
if (toRealmBlob(foreignBlobLike, { Blob }) !== null) throw new Error('Structural Blob impostor crossed the Tool API boundary');
if (toRealmFile(foreignFileLike, 'fallback.bin', { Blob, File }) !== null) throw new Error('Structural File impostor crossed the Tool API boundary');
const realBridgeBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });
const convertedBridgeBlob = toRealmBlob(realBridgeBlob, { Blob });
if (!(convertedBridgeBlob instanceof Blob) || convertedBridgeBlob.size !== 4) throw new Error('Real Blob conversion failed');
const realBridgeFile = new File([new Uint8Array([5, 6, 7, 8])], 'real.bin', { type: 'application/octet-stream' });
const convertedBridgeFile = toRealmFile(realBridgeFile, 'fallback.bin', { Blob, File });
if (!(convertedBridgeFile instanceof File) || convertedBridgeFile.name !== 'real.bin' || convertedBridgeFile.size !== 4) throw new Error('Real File conversion failed');
console.log('Smoke test passed: cross-realm Tool API Blob/File bridge');


// Explorer owns snapshot creation while ProjectStore owns the single validated
// insertion path. This keeps clipboard UI logic local without duplicating tree
// validation / capacity rules in the Explorer.
const explorerClipboardProject = new ProjectStore('Explorer Clipboard');
explorerClipboardProject.createFolder('/', 'Source');
explorerClipboardProject.createFolder('/Source', 'Nested');
explorerClipboardProject.addBlob('/Source/Nested', 'copy.bin', new Blob([new Uint8Array([0xaa, 0xbb])]));
const explorerClipboardUi = { toast() {}, async confirm() { return true; } };
const explorerClipboardContainer = { querySelector() { return null; } };
const clipboardExplorer = new ProjectExplorer(explorerClipboardContainer, { getProject: () => explorerClipboardProject, transfers: null, onOpenFile() {}, ui: explorerClipboardUi });
clipboardExplorer.selectedId = explorerClipboardProject.get('/Source').id;
clipboardExplorer.copySelected();
clipboardExplorer.selectedId = 'root';
clipboardExplorer.pasteClipboard(explorerClipboardProject.root);
if (!explorerClipboardProject.get('/Source 2/Nested/copy.bin')) throw new Error('Explorer clipboard insertSnapshot integration failed');
if (hex(new Uint8Array(await explorerClipboardProject.get('/Source 2/Nested/copy.bin').blob.arrayBuffer())) !== 'aabb') throw new Error('Explorer clipboard content regression');
console.log('Smoke test passed: Explorer clipboard + validated ProjectStore insertion path');

// Shortcut architecture is intentionally shell-scoped and tool-independent.
const shortcutSource = await readFile(new URL('../js/core/shortcut-manager.js', import.meta.url), 'utf8');
const architectureSource = await readFile(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
if (!shortcutSource.includes('function bindShortcuts') || !architectureSource.includes('Tool iframe A') || !architectureSource.includes('narrowest possible target/scope')) throw new Error('Scoped shortcut architecture documentation failed');
console.log('Smoke test passed: scoped shortcut architecture');
const shellCss = await readFile(new URL('../assets/css/shell.css', import.meta.url), 'utf8');
if (/studio-context-menu\{[^}]*var\(--surface-1\)/s.test(shellCss)) throw new Error('Context menu references undefined --surface-1 token');
if (!/studio-context-menu\{[^}]*background:var\(--surface\)/s.test(shellCss)) throw new Error('Context menu must have an opaque Studio surface background');
console.log('Smoke test passed: opaque Studio context menu styling');

// Project Explorer icons are shell-owned and inferred only from project resource names.
const { projectNodeIcon } = await import('../js/core/file-icon-service.js');
const iconCase = (name, expected) => {
  const url = projectNodeIcon({ isDirectory: false, name });
  if (!url.endsWith(`/${expected}.svg`)) throw new Error(`${name} icon mapping failed: ${url}`);
};
for (const [name, expected] of [
  ['EBOOT.BIN', 'executable'], ['PARAM.SFO', 'metadata'], ['game.iso', 'disc'], ['translation.xdelta', 'patch'],
  ['texture.png', 'image'], ['texture.gim', 'image'], ['character.gmo', 'model'], ['font.pgf', 'font'],
  ['menu.rco', 'resource'], ['theme.ptf', 'resource'], ['movie.pmf', 'video'], ['mux.mps', 'video'],
  ['voice.at3', 'audio'], ['voice.oma', 'audio'], ['effect.vag', 'audio'], ['DATA.PSAR', 'archive'],
  ['assets.cpk', 'archive'], ['game.chd', 'disc'], ['EBOOT.PBP', 'package'], ['data.bin', 'binary'],
  ['readme.txt', 'text'], ['notes.md', 'markdown'], ['main.js', 'code'], ['settings.ini', 'config'], ['cache.db', 'database'], ['something.unknown', 'file'],
]) iconCase(name, expected);
if (!projectNodeIcon({ isDirectory: true }).endsWith('/folder.svg')) throw new Error('Folder icon mapping failed');
if (!projectNodeIcon({ isDirectory: true }, { open: true }).endsWith('/folder-open.svg')) throw new Error('Open folder icon mapping failed');
const toolContractIcons = await readFile(new URL('../docs/TOOL_CONTRACT.md', import.meta.url), 'utf8');
if (/fileIcons|iconMappings|data-icon/.test(toolContractIcons)) throw new Error('Tool API must not acquire Project Explorer icon coupling');
console.log('Smoke test passed: shell-owned Project Explorer file icons');

// v0.8 workspace customization persists pins and file associations without changing Tool API v1.
const workspaceProject = new ProjectStore('Workspace Preferences');
workspaceProject.pinTool('tactics-ogre-script');
workspaceProject.pinTool('texture-tool');
workspaceProject.suggestTool('image-studio');
workspaceProject.suggestTool('sfo-studio');
workspaceProject.setFileAssociation('ext:.bin', 'tactics-ogre-script');
workspaceProject.setFileAssociation('name:eboot.bin', 'eboot-studio');
const workspaceZip = await workspaceProject.toZipBlob();
const { project: workspaceLoaded, manifest: workspaceManifest } = await ProjectStore.open(new File([workspaceZip], 'workspace.pspstudio'));
if (workspaceLoaded.workspace.pinnedTools.join(',') !== 'tactics-ogre-script,texture-tool') throw new Error('Workspace pinned tools did not round-trip');
if (workspaceLoaded.workspace.suggestedTools.join(',') !== 'sfo-studio,image-studio') throw new Error('Workspace suggested tools did not round-trip in recency order');
if (workspaceLoaded.workspace.fileAssociations['ext:.bin'] !== 'tactics-ogre-script' || workspaceLoaded.workspace.fileAssociations['name:eboot.bin'] !== 'eboot-studio') throw new Error('Workspace file associations did not round-trip');
if (workspaceManifest.workspace?.pinnedTools?.length !== 2 || workspaceManifest.workspace?.suggestedTools?.length !== 2) throw new Error('Workspace preferences missing from project.json');
workspaceLoaded.unpinTool('texture-tool');
if (workspaceLoaded.workspace.pinnedTools.includes('texture-tool')) throw new Error('Workspace unpin failed');
console.log('Smoke test passed: workspace pins + suggestions + file associations round-trip');

const { associationKeys, preferredAssociationKey, associationLabel } = await import('../js/core/file-associations.js');
if (associationKeys('script.bin').join(',') !== 'name:script.bin,ext:.bin') throw new Error('File association lookup order failed');
if (preferredAssociationKey('EBOOT.BIN', []) !== 'name:eboot.bin') throw new Error('PSP exact-name association specificity failed');
if (preferredAssociationKey('script.bin', []) !== 'ext:.bin') throw new Error('Extension association specificity failed');
if (associationLabel('ext:.sfo') !== '.sfo') throw new Error('Association label failed');
console.log('Smoke test passed: Open With association specificity');

const catalogV08 = JSON.parse(await readFile(new URL('../tools/catalog.json', import.meta.url), 'utf8'));
if (!catalogV08.core?.includes('umd-forge') || !Array.isArray(catalogV08.tools)) throw new Error('v0.8 Tool Catalog core/tools structure failed');
const appV08 = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
if (/gameRegistry|games\/catalog|DISC_ID/.test(appV08)) throw new Error('Game context/registry leaked into v0.8 shell');
if (!appV08.includes('openWithDialog') || !appV08.includes('pinnedTools')) throw new Error('v0.8 Open With/pinning integration missing');
const projectExplorerV08 = await readFile(new URL('../js/core/project-explorer.js', import.meta.url), 'utf8');
if (!projectExplorerV08.includes("command: 'open-with'") || !projectExplorerV08.includes("combo: 'Shift+Enter'")) throw new Error('Project Explorer Open With command/shortcut missing');
const toolContractV08 = await readFile(new URL('../docs/TOOL_CONTRACT.md', import.meta.url), 'utf8');
if (/window\.tool\s*=\s*\{[^}]*pin|window\.tool\s*=\s*\{[^}]*association/s.test(toolContractV08)) throw new Error('Workspace pinning must not enter Tool API v1');
console.log('Smoke test passed: Tool Library/Open With remain shell-owned');


// v0.9 adds dedicated generic tools without extending Tool API v1.
const catalogV09 = JSON.parse(await readFile(new URL('../tools/catalog.json', import.meta.url), 'utf8'));
for (const id of ['umd-forge','sfo-studio','image-studio']) if (!catalogV09.core?.includes(id)) throw new Error(`Missing v0.9 core tool: ${id}`);
const sfoManifest = JSON.parse(await readFile(new URL('../tools/sfo-studio/tool.json', import.meta.url), 'utf8'));
const imageManifest = JSON.parse(await readFile(new URL('../tools/image-studio/tool.json', import.meta.url), 'utf8'));
if (sfoManifest.api !== 1 || !sfoManifest.accepts.includes('.sfo')) throw new Error('SFO Studio manifest failed');
if (imageManifest.api !== 1 || !imageManifest.accepts.includes('.png') || !imageManifest.accepts.includes('.jpg')) throw new Error('Image Studio manifest failed');
const sfoToolSource = await readFile(new URL('../tools/sfo-studio/tool.js', import.meta.url), 'utf8');
const imageToolSource = await readFile(new URL('../tools/image-studio/tool.js', import.meta.url), 'utf8');
for (const method of ['open','get','replace']) {
  if (!sfoToolSource.includes(method) || !imageToolSource.includes(method)) throw new Error(`v0.9 tool missing Tool API method: ${method}`);
}
if (!imageToolSource.includes('saveToOE') || !imageToolSource.includes('https://www.photopea.com')) throw new Error('Image Studio Photopea bridge missing');
const imageToolHtml = await readFile(new URL('../tools/image-studio/index.html', import.meta.url), 'utf8');
if (!imageToolHtml.includes('https://www.photopea.com#%7B%22environment%22%3A%7B%7D%7D')) throw new Error('Image Studio must bootstrap Photopea in API mode, not the bare landing page');
if (imageToolHtml.includes('src="https://www.photopea.com/"')) throw new Error('Image Studio regressed to the Photopea marketing landing page');
if (/window\.tool\s*=\s*Object\.freeze\([^)]*saveToOE/s.test(imageToolSource)) throw new Error('Photopea-specific API leaked into Tool API surface');
const appV09 = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
if (!appV09.includes("const VERSION = '0.14.5'")) throw new Error('Studio version was not updated to v0.14.5');
console.log('Smoke test passed: v0.9 SFO Studio + Image Studio use unchanged Tool API v1');

// v0.14 final shell keeps only direct project actions + activity rail surfaces.
const shellHtmlV014 = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const shellCssV014 = await readFile(new URL('../assets/css/shell.css', import.meta.url), 'utf8');
const shellAppV014 = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const explorerV014 = await readFile(new URL('../js/core/project-explorer.js', import.meta.url), 'utf8');
const searchV014 = await readFile(new URL('../js/views/project-search.js', import.meta.url), 'utf8');
if (/data-menu-button|ide-menu-popup|ide-menubar/.test(shellHtmlV014)) throw new Error('Traditional application menus returned');
for (const command of ['new','open','save']) if (!shellHtmlV014.includes(`data-shell-command="${command}"`)) throw new Error(`Missing direct project command: ${command}`);
if (!explorerV014.includes("surface.addEventListener('dragover'")) throw new Error('Explorer full-surface drop target regression');
const componentsCssV014 = await readFile(new URL('../assets/css/components.css', import.meta.url), 'utf8');
for (const icon of ['new-project','open-project','save','explorer','search','tool-library','help','file-plus','folder-plus','import']) {
  if (!shellHtmlV014.includes(`icon-${icon}`) && !explorerV014.includes(`icon-${icon}`)) throw new Error(`Missing clear UI icon class: ${icon}`);
  if (!componentsCssV014.includes(`.icon-${icon}{--icon:url("../ui-icons/${icon}.svg")}`)) throw new Error(`Missing stylesheet-relative UI icon mapping: ${icon}`);
}
for (const stale of ['ide-toolbar','inspector-dock','studio-statusbar','sidebar-tools-list','theme-toggle']) if (shellHtmlV014.includes(stale)) throw new Error(`Removed shell surface returned: ${stale}`);
if (shellAppV014.includes('openWelcome') || shellCssV014.includes('studio-welcome')) throw new Error('Special Welcome tab returned');
if (!shellHtmlV014.includes('id="activity-search"') || !shellHtmlV014.includes('id="activity-tool-library"')) throw new Error('Search or Tool Library activity is missing');
if (!explorerV014.includes('data-action="new-file"') || !explorerV014.includes('data-action="new-folder"') || !explorerV014.includes('data-action="import-files"')) throw new Error('Explorer quick-create/import actions missing');
if (!searchV014.includes("new Worker(WORKER_URL, { type: 'module' })") || !searchV014.includes('AUTO_SCAN_LIMIT')) throw new Error('Workspace search is not worker-backed/deferred');
if (!shellCssV014.includes('grid-template-rows:auto minmax(0,1fr)')) throw new Error('Editor does not collapse the empty tab strip naturally');
const helpHtml = await readFile(new URL('../help.html', import.meta.url), 'utf8');
if (!shellHtmlV014.includes('href="./help.html"') || !helpHtml.includes('id="developer-guide"') && helpHtml.includes('Tool API v1')) throw new Error('Standalone Help page is not wired');
console.log('Smoke test passed: v0.14 direct-action shell + Explorer/Search activity rail');
