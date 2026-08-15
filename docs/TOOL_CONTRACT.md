# Tool API v1

The Tool API is intentionally tiny. A tool is a normal same-origin web page wrapped by PSP Modding Studio.

## Minimum tool

A tool folder needs:

```text
tools/my-tool/
|--- tool.json
`--- index.html
```

`tool.js`, CSS, workers, libraries and assets are ordinary web files and are optional.

The folder name is the tool ID. Register only that folder name in `tools/catalog.json`.

## `tool.json`

```json
{
  "api": 1,
  "name": "My Tool",
  "description": "What the tool does.",
  "author": "Your Name",
  "version": "1.0.0",
  "icon": "icon.svg",
  "accepts": [".bin"]
}
```

Fields:

- `api`: Tool API version. v1 is currently supported.
- `name`: display name.
- `description`: short description shown by the Studio.
- `author`: author/maintainer display name.
- `version`: tool version.
- `icon`: optional image relative to the tool folder (`svg`, `png`, `webp`, etc.). The Studio supplies a default image when omitted.
- `accepts`: optional list of filename suffixes the Studio may open with this tool.

`index.html` is a normal page. It can also be opened on its own while developing the tool.

## Semantic HTML

Only two Studio conventions exist:

```html
<div data-file="current">file.bin</div>
<div data-folder="assets">assets</div>
```

The values are opaque IDs owned by the tool. PSP Modding Studio does not interpret them. A semantic element must declare **exactly one** of `data-file` or `data-folder`, and the ID must be non-empty (the host also applies a bounded length). Changing either attribute dynamically is observed by the host and updates drag/drop eligibility.

If the value looks like a path, the final segment is used as the default drag/export name. Example: `/PSP_GAME/USRDIR` becomes `USRDIR`.

The Studio automatically adds drag/drop behavior to these elements. Tool code does not use `DataTransfer`, custom MIME types or Project internals.

## Optional `window.tool` functions

A tool may expose any subset of these four functions:

| Function | Called when | Expected result |
|---|---|---|
| `open(file)` | Studio opens a file with the tool | none |
| `get(id)` | a `data-file` or `data-folder` resource leaves the tool | File/Blob or folder resource |
| `replace(id, file)` | a file is dropped on `data-file="id"` | none |
| `add(id, files)` | files are dropped on `data-folder="id"` | none |

All four are optional.

### `open(file)`

```js
window.tool = {
  async open(file) {
    editor.value = await file.text();
  }
};
```

### `get(id)` for a file

```html
<div data-file="current">result.bin</div>
```

```js
window.tool = {
  get(id) {
    if (id === 'current') return currentFile;
  }
};
```

Return a normal `File` when possible. A `Blob` is also accepted.

### `get(id)` for a folder

```html
<div data-folder="assets">assets</div>
```

Return an object exposing `files`. Each entry uses a path relative to the dragged folder:

```js
window.tool = {
  get(id) {
    if (id !== 'assets') return;
    return {
      files: [
        { path: 'icon.png', file: iconFile },
        { path: 'ui/menu.png', file: menuFile }
      ]
    };
  }
};
```

`files` may also be a function returning an iterable/async iterable. This lets large tools materialize files lazily.

When this folder is dropped into the Project Explorer, the Studio creates the folder name from `data-folder` and reconstructs the relative tree.

### `replace(id, file)`

If `replace` exists, every `data-file` element automatically becomes a valid file drop target.

```js
window.tool = {
  async replace(id, file) {
    await model.replace(id, file);
  }
};
```

### `add(id, files)`

If `add` exists, every `data-folder` element automatically accepts dropped files.

```js
window.tool = {
  async add(id, files) {
    await model.addFiles(id, files);
  }
};
```

## Optional Studio helpers

A hosted tool receives the reserved, read-only `window.studio` bridge after the iframe page has loaded. It is not required for a basic tool. The host dispatches a `studio-ready` event immediately after injection. Code that runs very early should use the bridge lazily or listen for that event; a tool must not predefine or replace `window.studio`.

```js
studio.toast('Saved', 'success');
await studio.confirm('Continue?');
studio.dirty(true);
studio.title('game.iso - My Tool');
```

These helpers are presentation-only. A tool must not import shell internals.

## Isolation and trust

Each tab is a separate same-origin iframe. Therefore two tabs of the same tool naturally have separate DOM, JavaScript globals and state. No `mount()`, `unmount()`, instance IDs or lifecycle framework is required.

Same-origin iframe isolation is **not a security sandbox for hostile code**. Tools shipped in the static catalog are trusted code. A future untrusted/remote tool ecosystem must not reuse this trust model; it would need sandbox/cross-origin isolation and a message-based API.

The wrapper bounds page loading and host calls so an accidentally broken tool cannot make tab creation wait forever. Closing a tool also cancels transfer resolvers owned by that host. These are failure-containment guarantees, not a promise that arbitrary hostile same-origin JavaScript can be contained.

## Design rule

Do not add a method to Tool API v1 for a theoretical use case. A new standardized method should be introduced only after multiple real tools need the same cross-tool behavior.


## Keyboard shortcuts and tool isolation

Tool API v1 does not define or reserve tool keyboard shortcuts. A tool is a standalone page in its own iframe and handles normal `keydown` events itself.

Project Explorer shortcuts are active only while the Project Explorer has focus. Studio shell shortcuts are handled in the parent document and are not forwarded into a focused tool iframe. Consequently a tool may implement combinations such as `Ctrl/Cmd+S`, `Ctrl/Cmd+C`, `Delete` or `F2` without colliding with the Project Explorer.

Tools must not import or register with the Studio's internal `bindShortcuts()` helper; it is a shell implementation detail, not part of Tool API v1.

## Catalog search metadata

A tool can optionally add `keywords` to improve Tool Library search:

```json
{
  "keywords": ["tactics ogre", "script", "dialogue", "translation"]
}
```

`keywords` is metadata only. It is not exposed to `window.tool` and does not affect runtime behavior.

Tool authors do **not** declare whether a tool is core, pinned, installed, recommended or associated with a workspace. Those are Studio concerns.

## `accepts` and Open With

`accepts` may contain extensions, exact filenames, or `*`:

```json
{
  "accepts": [".sfo", "EBOOT.BIN", "*"]
}
```

The Studio uses this only to discover compatible tools for file opening. The chooser ranks Pinned, then Suggested, then remaining Core/Other compatible tools. Pinning or suggestion never changes whether a compatible tool is available.

A saved default association belongs to the `.pspstudio` workspace. The tool is not notified that it is pinned or selected as a default; it simply receives the normal `open(file)` call.
