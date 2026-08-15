# `.pspstudio` project format v1

A `.pspstudio` file is a standard ZIP archive.

Required entry:

```text
project.json
```

User files live under:

```text
workspace/
```

Example:

```text
project.json
workspace/Original/EBOOT.BIN
workspace/Modified/EBOOT.BIN
workspace/Graphics/menu.png
workspace/Notes/
```

`project.json`:

```json
{
  "format": "psp-modding-studio-project",
  "version": 1,
  "name": "My PSP Project",
  "savedAt": "2026-08-13T09:00:00.000Z",
  "workspace": {
    "pinnedTools": [
      "some-game-script-editor"
    ],
    "suggestedTools": [
      "image-studio"
    ],
    "fileAssociations": {
      "ext:.bin": "some-game-script-editor",
      "name:eboot.bin": "eboot-studio"
    }
  },
  "tabs": [
    {
      "editorId": "umd-forge",
      "filePath": "/ISO/test.iso",
      "title": "test.iso - UMD Forge"
    }
  ]
}
```

`workspace` is optional additive UI state. Older v1 projects without it open with no pinned/suggested tools and no saved file associations.

`pinnedTools` controls which catalog tools are shown in the workspace activity rail. Core tools may also be pinned.

`suggestedTools` is a bounded, recency-ordered Open With ranking derived from explicit chooser selections; it does not pin or auto-open a tool.

`fileAssociations` maps filename/extension keys to tool IDs. Missing tools or stale associations do not invalidate the project; the Studio ignores an association when the referenced tool is no longer a compatible catalog handler.

`tabs` is advisory UI state. Project contents remain valid if an editor is missing or a saved tab can no longer be restored.
## Validation and safety rules

The v1 logical format is unchanged, but the wrapper reads it strictly:

- archive top level is limited to `project.json`, optional `workspace/`, and descendants of `workspace/`;
- workspace paths must be canonical UTF-8 paths with no traversal, empty components, backslashes or file/folder role collisions;
- saved tab file paths must be canonical absolute Project paths; malformed file-linked tab descriptors are discarded rather than reinterpreted as fileless tabs;
- unknown/missing tool IDs in tabs, pins or associations do not invalidate Project file contents; unavailable tab descriptors are retained so a temporary tool failure is non-destructive;
- the Project has explicit entry/depth/name/pin/association/tab and logical ZIP-size limits;
- all non-directory ZIP entries are CRC32-verified;
- Deflate streams are decompressed with a runtime output bound equal to their declared uncompressed size;
- ZIP64, multi-disk, encrypted and unsupported compression structures are rejected explicitly;
- local headers, central-directory metadata, data descriptors and local-record ranges must agree and not overlap.

Within a live Project, nodes have stable IDs. Tabs linked to files are serialized using the file's current path, so rename/move does not leave a stale saved-tab path.

A save captures the Project revision at its start. If the Project changes while ZIP generation or filesystem writing is in progress, the produced file is a valid earlier snapshot but the live Project remains marked dirty.

