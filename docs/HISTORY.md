# PSP Modding Studio - compact history

- **0.14.5** - pins UMD Forge by default for newly created projects while preserving the exact pin state of existing/loaded `.pspstudio` workspaces.
- **0.14.4** - adds Hex Viewer and Image Viewer as lightweight core inspection tools. File routing now treats Image Viewer as the default image handler, uses Hex Viewer as the wildcard fallback for files without a dedicated handler, and keeps saved workspace associations plus Open With overrides authoritative.
- **Tool: EBOOT Decrypter 1.0.0** - adds a Tool API v1 executable utility that opens/drops PSP EBOOT/PRX files, decrypts supported ~PSP payloads with a lazily loaded KIRK WebAssembly engine, handles gzip-compressed payloads, verifies ELF output and exposes the result as a draggable workspace file.
- **0.14.3** - Drag-and-drop lifecycle hardening: project drop overlays are cleared deterministically across main-document/tool-iframe boundaries on drag end, drop, cancellation, blur, Escape and subsequent pointer interaction; tool drops also close active project drag sessions. Release cache tags are coherent at 0.14.3.
This file replaces the former per-release `V0.x_NOTES.md` collection. It records architectural milestones only; the current contract is defined by `CORE_BASELINE.md`, `ARCHITECTURE.md`, `TOOL_CONTRACT.md` and `PROJECT_FORMAT.md`.

## 0.14 - final wrapper shell and workspace search

- **0.14.2** - UI icon path hotfix: shell icons now declare mask URLs in `components.css`, relative to that stylesheet, instead of embedding relative `url()` values in inline custom properties; asset tests validate the real CSS URL resolution path.
- **0.14.0** - final wrapper baseline: traditional menus removed in favor of direct project actions; Explorer/Search live in the activity rail; Tool Library and Help move to the rail footer; Project Explorer gains New File/New Folder/Import quick actions; workspace Text/Hex search is chunked, worker-backed and bounded, with large/excess automatic work deferred; local icon coverage is release-validated. This supersedes the 0.13.0 freeze candidate.

## 0.13 / 0.12.x - wrapper hardening and reduction

- **0.13.0** - shell reduced to menubar + activity rail + Project Explorer + document/tool area; Inspector, toolbar, status bar, Tools sidebar, Project menu duplication, light theme and special Welcome tab removed; Help moved to independent `help.html`; explicit pinning now places any tool, including core tools, in the activity rail; Open With adds a bounded per-workspace Suggested ranking only after a chosen tool opens successfully.
- **0.12.7** - lifecycle listeners are increasingly AbortSignal-owned; wrapper/core module graph is guarded as static and acyclic; wrapper cancellation is distinguished from a tool-thrown `AbortError`; `window.studio` is a reserved read-only bridge; main Studio document receives a restrictive CSP; historical documentation is consolidated.
- **0.12.6** - strict Tool API boundary validation, real Blob/File persistence boundary, complete lazy-transfer lifecycle ownership, transactional/generation-safe Registry loading, strict manifest validation and runtime/save/reopen parity.
- **0.12.5** - reduced duplicate ProjectStore/TabManager state, unified Explorer drop pipeline, smaller shell vocabulary and fewer public convenience APIs.
- **0.12.4** - shared bounded async primitive, simpler project reconstruction and folder-transfer indexing, unified shell commands.
- **0.12.3** - simplified core helpers, smaller persisted-tab state, less duplicated rendering and internal API surface.
- **0.12.2** - dormant/future-only crypto and binary helpers removed; Explorer event delegation introduced; core-hygiene regression suite added.
- **0.12.1** - deep persistence/lifecycle audit: node/path indexes, stricter ZIP validation, pending-tab preservation and project fuzz/property tests.
- **0.12.0** - first formal core baseline and wrapper-focused hardening pass.

## 0.11.x - IDE shell

- **0.11.0** - old web-app shell replaced by a desktop IDE-style menubar, toolbar, Explorer/Tools dock, document tabs, Inspector and status bar.
- **0.11.1** - decorative Output/Problems panel removed; menu hover switching fixed; whole Explorer became a drop surface; duplicate/unclear shell controls removed.

## 0.9-0.10 - core tools and visual experiments

- **0.10** - visual redesign work and clearer Image Studio workspace-export affordance.
- **0.9.2** - Photopea bootstrap fixed by using its configured URL-fragment entry point.
- **0.9** - SFO Studio and Image Studio added as generic core tools; shared detailed SFO parser/builder introduced.

## 0.8 - catalog, pins and Open With

Tool Store/catalog, per-workspace pinned tools and file associations were introduced. Pinning controls convenience/visibility only; all compatible catalog tools remain available to Open With.

## 0.6-0.7 - frozen Tool API and Project Explorer

- **0.6** - Tool API v1 frozen at `open/get/replace/add`; same-origin iframe hosting and semantic `data-file`/`data-folder` resources introduced.
- **0.6.1** - cross-realm Blob/File transfer fix.
- **0.7** - Project Explorer context menu, copy/paste, nested folders and scoped keyboard shortcuts.
- **0.7.1-0.7.3** - Studio-owned PSP-aware file icons and Explorer fixes.

## 0.3-0.5 - UMD Forge foundation

Early releases established client-side ISO browsing/editing, rebuild/layout handling, PSP metadata/artwork preview and `.umdpatch` support. Later architecture deliberately moved generic metadata/image capabilities into independent tools rather than growing UMD Forge or the wrapper.
