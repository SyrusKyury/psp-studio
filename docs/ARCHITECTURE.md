# Architecture

## Core model

```text
Studio Shell
|
|--- ProjectStore        generic files + folders + workspace preferences
|--- Project Explorer   user workspace and drag/drop surface
|--- Tab Manager        tool + shell-owned utility tabs
|--- Tool Registry      reads the static tool catalog + tool.json metadata
|--- Tool Library         pin/unpin tools into the workspace activity rail
|--- ModuleHost         wraps standalone tool pages
|--- Transfer Registry  opaque temporary resource handles
`--- Open With          shell-owned file association chooser
```

There is no game context and no separate game registry. A game-specific editor is simply a normal tool in the Tool Catalog. The user finds it and pins it when useful.


## Shell surface

The wrapper intentionally keeps only a small set of persistent UI owners:

```text
direct project-action top bar
activity rail     Explorer + explicitly pinned tools
Project Explorer  project file/folder operations
document tabs     tools + shell-owned utility pages such as Tool Library
```

There is no global Inspector, toolbar, status bar, Tools sidebar or special Welcome tab. Tool-specific properties belong inside the tool iframe. The wrapper is dark-only. `Help` opens the independent static `help.html`; documentation therefore does not participate in Studio tab, project or tool lifecycle.

## Project is format agnostic

A Project knows files, folders, Blob contents, names and small workspace preferences. It does not understand ISO, PRX, SFO, patches, game IDs or tool internals.

`.pspstudio` is a ZIP containing `project.json` and `workspace/`.

`project.json` may contain:

```json
{
  "workspace": {
    "pinnedTools": ["some-game-script-editor"],
    "suggestedTools": ["image-studio"],
    "fileAssociations": {
      "ext:.bin": "some-game-script-editor",
      "name:eboot.bin": "eboot-studio"
    }
  }
}
```

These values only customize the Studio UI. They do not change a tool's runtime API.

## Tool API v1

A tool is a normal page under `tools/<id>/index.html`. The directory name is its ID and `tool.json` contains discoverable metadata without running tool code.

Each tab hosts the page in a separate same-origin iframe. This gives each tool instance its own DOM, CSS, JavaScript globals and lifecycle. Switching tabs leaves the iframe alive; closing the tab destroys it.

This is an **operational isolation boundary, not a hostile-code security sandbox**. Bundled same-origin tools are trusted code and can technically reach the parent origin. Supporting untrusted/remote marketplace code would require a different sandboxed or cross-origin `postMessage` architecture.

The shell observes semantic elements inside the same-origin page:

```html
<div data-file="id">...</div>
<div data-folder="id">...</div>
```

If the tool exposes `window.tool.get`, the Studio makes those resources draggable. If it exposes `replace`, file resources accept dropped files. If it exposes `add`, folder resources accept dropped files. No tool handles Studio MIME types or Project node IDs.

The complete standardized v1 surface is:

```text
open(file)
get(id)
replace(id, file)
add(id, files)
```

All methods are optional.

## Tool Catalog and pinning

`tools/catalog.json` is Studio-owned:

```json
{
  "core": ["umd-forge"],
  "tools": ["some-game-script-editor", "texture-tool"]
}
```

- `core`: always available Studio tools. They may also be pinned for quick access.
- `tools`: all other catalog tools. They may be pinned per workspace.

Tool authors do not declare `core` or `pinned` in `tool.json`. Pinning is purely a workspace presentation choice.

The Tool Library searches all catalog metadata. A game-specific tool can make itself easy to find with a descriptive name, description and optional `keywords`; the Studio does not infer or track the current game.

## Open With and file associations

`accepts` in `tool.json` declares which filenames a tool can open. When a Project file is opened:

```text
saved association
    v
one compatible tool
    v
Open With chooser when multiple tools are possible
```

The chooser orders compatible tools as:

```text
Pinned
Suggested
Core
Other compatible tools
```

Pinned and Suggested are ranking/presentation hints, not availability filters. Any compatible catalog tool remains available in Open With. Suggested is updated only after a tool chosen explicitly in the chooser opens successfully.

Associations are saved per workspace and use filename or extension keys. They never become tool state.

## Transfer model

Tool -> Project:

```text
data-file/data-folder
       v
ModuleHost asks tool.get(id)
       v
opaque transfer token
       v
Project Explorer materializes File or folder tree
```

Project -> Tool:

```text
Project file
    v
ModuleHost resolves Project node
    v
File
    v
replace(id,file) or add(id,files)
```

The Project and tools never import each other.

## Dependency direction

Allowed:

```text
tool -> shared libraries
shell -> tool.json/tool page
```

Forbidden:

```text
tool A -> tool B
project -> PSP parser
tool -> shell internal modules
```

A hosted tool may optionally use the tiny `window.studio` presentation bridge for toast, confirm, dirty state and tab title. The name is reserved by the host and is installed as a read-only, non-configurable property after the tool page loads; the host then dispatches `studio-ready` inside the tool window. Tools should use the bridge lazily or listen for that event rather than occupying the namespace during early top-level evaluation.

## Wrapper lifecycle and failure containment

The shell treats tool and transfer operations as fallible asynchronous boundaries. Where the Web Platform supports it, listener ownership is tied to an `AbortSignal` instead of parallel remove-listener bookkeeping:

```text
Registry discovery  -> isolated per tool + bounded concurrency/time
Tool page load      -> transactional tab load + timeout
Tool open()         -> bounded host call
Tool get()          -> one-shot transfer + timeout/cancellation
Folder iteration    -> bounded steps + atomic Project materialization
Project replacement -> abort old Explorer/transfer lifecycle
Tab close           -> iframe/panel removed even if unload cleanup fails
```

Project persistence uses a monotonic revision. A save serializes a snapshot and may report success, but it marks the Project clean only if the revision did not change while the ZIP/write operation was in progress.

Project nodes have both an ID index and canonical path index. ID is used for stable linkage across rename/move; canonical path is used for unambiguous lookup and efficient large workspaces.

## Keyboard ownership

Keyboard input is scoped by browsing context and UI surface rather than globally registered by tools.

```text
Studio document
|--- Shell shortcuts      Ctrl/Cmd+S, Ctrl/Cmd+B
`--- Project Explorer     F2, Delete, Copy/Paste, tree navigation, Open With

Tool iframe A            owns its own keyboard events
Tool iframe B            owns its own keyboard events
```

The Project Explorer binds its shortcuts to its own focusable tree. Tool iframe events are not forwarded to the Studio. Tools do not register with the Studio internal `bindShortcuts()` helper.

## Project Explorer icons are shell-owned

Project Explorer file/folder icons are presentation owned entirely by PSP Modding Studio. The shell maps filenames/extensions to its own icon assets. Tools do not declare, register, override or depend on those mappings. Resource transfer carries data/resources, never the source tool's icon or HTML representation.

Implementation rule: every Studio shortcut must be bound to the **narrowest possible target/scope**. Never widen Project or shell shortcuts just to reach tool iframes.

## Baseline code ownership

The wrapper baseline does not retain speculative implementations for hypothetical future tools. `shared/` is for code used by the current wrapper or at least one current tool. A future tool may introduce a reviewed shared dependency when it actually needs one; until then, keeping the implementation out of the baseline reduces audit surface, cache surface and maintenance obligations.

The same rule applies inside `js/`: internal helper methods and metadata are not treated as compatibility APIs. If the production wrapper has no caller and the symbol is not part of Tool API v1, removal is preferred.
