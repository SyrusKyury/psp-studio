# 7-CIP patch for PSP Modding Studio

This patch is intended to be copied over the current `main` branch of PSP Modding Studio.

## UI naming and GIM Studio scope cleanup

- Renamed the archive tool's visible product name from `7CIP` to `7-CIP`. The technical tool id/path remains `7cip` for project and catalog compatibility.
- Removed Yu-Gi-Oh!/Tag Force-specific presets, keywords and messages from GIM Studio. GIM Studio now presents only generic PSP GIM concepts; game-specific archive knowledge remains in 7-CIP or game-specific tools.
- GIM Studio is now version 1.2.1; 7-CIP is now version 1.7.1.


## Added

- `tools/7cip/` - standalone Tool API v1 archive editor
- `tests/7cip.mjs` - codec regression tests

## Updated

- `tools/catalog.json` - registers `7cip` under normal tools (not core/pinned)
- `THIRD_PARTY.md` - records the CIPTool MIT attribution

## Implemented formats

- CIP: read, extract, create, add, replace, delete, rebuild
- CPM: read, extract, create, add, replace, delete, rebuild
- CPJ: read, extract, create, add, replace, delete, rebuild
- CPJ Tag Force Special profile: read/extract/build via explicit profile selector
- CPL: read, extract, create, add, replace, delete, rebuild
- Alternate card art tables (`ID_0`, `ID_1`, ...)
- Sparse card ID ranges
- Tool API v1 drag-out, folder drag-out, drop-to-replace and drop-to-add
- Multi-selection with Ctrl/Cmd+click, Shift+click, header checkbox, Ctrl/Cmd+A and Escape
- Drag-selected export to the Project Explorer via a dedicated folder resource
- Drag-all export to the Project Explorer via an explicit All entries resource
- Archive-based export folder names such as `cardimg_extracted` and `cardimg_selected`

## UX note

The previous `Download all` action has been replaced by workspace-native folder resources. This avoids triggering hundreds of browser downloads and keeps bulk extraction inside PSP Modding Studio. Single-entry downloads remain available.

## Validation notes

The codec test suite uses synthetic fixtures and verifies rebuild/extract/rebuild round trips for every implemented variant. Run:

```bash
node tests/7cip.mjs
```

A final compatibility claim against every Tag Force title still requires real archives from the games, especially one CPJ from TF3-6 and one CPJ from Tag Force Special. The implementation intentionally reports malformed structures instead of silently producing corrupt output.

## Archive-manager pass

- Added sortable Card ID, Art, File and Size columns.
- Added Rename / re-ID for entries, with alternate-art layout validation.
- Added multi-delete and Delete-key support.
- Added Undo/Redo history for add, replace, rename, delete and CPJ profile changes.
- Added archive Test. In v1.4 this is a streaming structural/payload test so large archives do not require multiple complete RAM copies.
- Added Archive Info with archive metadata. SHA-256 is calculated automatically for small archives and deferred for large archives to avoid a full RAM copy.
- Added Ctrl/Cmd+F, Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z, F2 and Delete shortcuts.
- Retained the CIPTool-compatible behavior where on-disk Offset fields are reconstructed from slot IDs rather than serialized as final byte offsets.

### Original-project TODO review

The two explicit CIPTool TODOs relevant to its archive codec are already covered by the browser port:

- multiplatform support: 7-CIP is platform-independent browser JavaScript;
- slot/bitshift sizing based on the largest entry: 7-CIP computes the required slot size from the largest prepared payload.

The related TFCardEditGUI project also listed multi-selection, undo/redo, single-card import/export and card-art CIP integration as future work. 7-CIP now covers the archive-side pieces (multi-selection, history, single-entry add/extract and CIP editing). Image conversion/drawing remains intentionally outside 7-CIP and belongs in Image Studio.



## v1.3 real-archive compatibility pass

Validated against the user-supplied PSP Studio project containing two real Tag Force CIP archives.

- `cardh_e.cip`: 2,527 entries, including 85 alternate-art entries; parse/rebuild is byte-identical.
- `cardh_j.cip`: 7,254 entries; revealed that valid CIP files may store payload slots in a physical order unrelated to numeric card ID.
- The parser now records each entry's original physical slot index.
- The builder preserves original physical slot order for existing entries and appends newly added entries after the preserved source layout.
- This makes unchanged real archives rebuild byte-identically even when their physical data ordering is non-canonical.
- Replacements and re-ID operations keep the original physical placement whenever possible, reducing unnecessary binary churn in modded archives and patches.

No user-supplied game data is included in this patch or its tests.


## v1.4 large-archive / lazy-loading pass

Large CPJ archives (including Tag Force Special archives in the 100+ MiB range) no longer decode every payload on open.

- Opening a CIP-family archive now reads only the fixed header plus the archive's offset-table/header region.
- Entries keep lazy source metadata (`sourceSlotOffset`, `sourceSlotSize`, slot ID/index) instead of eagerly storing decoded payload and raw-slot copies.
- CPJ payloads are decoded only when an entry is extracted, replaced/re-ID needs re-encoding, or a full Test explicitly validates it.
- Decoded source entries use a bounded 24 MiB LRU cache; bulk/test paths can bypass the cache.
- CIP/CPL extraction uses zero-copy `Blob.slice()` resources; CPM prepends its fixed GIM header without copying the source slot.
- Rebuilding reuses untouched source slots directly as Blob parts. New/modified entries are encoded individually.
- If a CPJ modification grows the global slot size, old CPJ entries are decoded/re-encoded one at a time, keeping peak payload memory bounded instead of materializing the whole archive.
- Clean archives are returned directly from the original source Blob when rebuilt/exported.
- Test is now streaming: it validates header/tables and, for CPJ, decodes one slot at a time with UI yields instead of build -> parse -> build copies in RAM.
- Archive Info no longer hashes very large archives automatically; SHA-256 is deferred above 32 MiB to avoid creating a complete in-memory copy just to display metadata.
- The entry table renders in batches of 300 rows and extends on demand / near-bottom scroll, preventing thousands of DOM nodes from being created during Open.
- Lazy codec regression tests cover metadata-only CPJ indexing, on-demand decode and zero-copy source-slot rebuild.
- The lazy rebuild path was revalidated against the two supplied real CIP files (`cardh_e.cip` and `cardh_j.cip`) and remains byte-identical.

## v1.5 standalone GIM extraction fix

Real `cardh_e.cip` / `cardh_j.cip` entries revealed that Tag Force can store compact GIM slots whose physical CIP slot is shorter than the GIM root block size declared in the embedded header.

- 7-CIP now keeps the compact/raw slot untouched internally for exact archive rebuilds.
- Extraction is a separate boundary: CIP/CPL/CPM GIM resources are normalized to the standalone size declared by the GIM root block.
- Oversized archive slot padding is trimmed from exported GIMs.
- Compact GIMs are extended with a zero-filled synthetic tail when bytes are absent from the archive. The original bytes are never modified; only the missing tail is synthesized.
- The lazy path remains zero-copy for the source payload: only the small GIM header and, when necessary, the missing tail are allocated.
- Safety limits reject absurd/corrupt declared GIM sizes instead of allocating unbounded memory.
- Added regression tests for the real Tag Force pattern `0x1000` physical slot -> `0x1080` declared standalone GIM.

Important: zero-filling makes the standalone file structurally match its own GIM header, but cannot recover pixel bytes that are genuinely absent from the source CIP slot. Archive rebuilds continue to preserve the original compact representation byte-for-byte.

## v1.6 CPM import/profile fix

A real Tag Force archive named `cardm_i.cip` revealed an important extension-vs-magic detail: the file is internally a CPM archive (`CPM\x1A`) even though its filename ends in `.cip`.

- CPM extraction still reconstructs CIPTool's fixed 0x80-byte GIM header, but now treats only the first 0x800 bytes after that header as the actual 64x64 DXT1 image payload.
- The zero-filled tail used to make the extracted GIM structurally match the fixed header is now treated as standalone GIM padding and is stripped again on re-import. It no longer doubles the CPM slot from 0x800 to 0x1000.
- CPM replacement now validates the actual GIM structure and reports a precise compatibility error instead of a generic/header-prefix error. The supported profile is 64x64 DXT1, normal pixel order, one frame and one mip level, matching Tag Force/CIPTool's documented card-image pipeline.
- DXT3/DXT5 or otherwise incompatible GIMs are rejected rather than silently packed into a CPM whose runtime profile expects DXT1. Image transcoding remains the responsibility of GIM Studio.
- Regression tests cover standalone CPM GIM re-import, zero-padding stripping and explicit DXT3 rejection.
- Real regression: replacing card 5066 in the supplied `cardm_i.cip` with its untouched 7-CIP-extracted DXT1 GIM rebuilds the complete 0x4F5800-byte archive byte-for-byte identically with the original 0x800-byte CPM slot size.

No user-supplied game data is included in this patch or its tests.


## v1.7 warning-based CPM replacement

- CPM GIM replacement no longer hard-blocks DXT3/DXT5 solely because stock Tag Force CPM entries are DXT1.
- A DXT1 -> DXT3/DXT5 mismatch now shows an explicit Continue/Cancel warning.
- Continuing performs a raw replacement and automatically grows the archive slot size when required.
- The warning explains that CPM strips the GIM header, so the texture format is not retained as metadata in the packed archive.
- Stock DXT1 re-import remains lossless and keeps the original 0x800 slot size.
- Unsupported layouts (wrong dimensions, swizzled/pixel order, indexed formats, malformed headers) are still rejected rather than packed blindly.

## GIM Studio v1.2 verified codec audit

The earlier v1.1 audit was preliminary and is superseded by this section. This pass cross-checked runtime texture semantics against PPSSPP/PSPSDK, compared generated container fields with documented GimConv output, inspected real PSP translation/modding workflows, and scanned every card GIM in the supplied Tag Force fixtures.

Verified/corrected:

- PSP direct-color 5650 / 5551 / 4444 packing keeps red in the low bits; DXT RGB565 endpoints deliberately use a separate S3TC endpoint layout. The two encodings must not share one helper.
- PSP DXT1/3/5 byte layout follows PPSSPP: color-index data precedes the RGB565 endpoints; DXT3 follows the color block with 4-bit alpha rows; DXT5 follows it with 48-bit alpha indices and then alpha1/alpha2.
- DXT3/DXT5 color interpolation keeps the PSP/PPSSPP endpoint-order semantics rather than silently switching to a generic PC-DXT decoder.
- PSP `faster`/swizzled storage uses 16-byte by 8-row tiles. New swizzled GIM creation is therefore restricted to the verified 16/8 profile.
- There is no universal GIM PitchAlign/HeightAlign pair. New normal uncompressed/indexed GIMs use a conservative 16/1 profile; new normal DXT1/3/5 GIMs use the verified 4/4 profile. Existing-file replacement preserves the original GIM profile instead of rewriting it to a default.
- The supplied Tag Force fixtures contain 9,781 parsed card GIMs across `cardh_e.cip` and `cardh_j.cip`; all 9,781 use DXT1, normal order, 128x64, PitchAlign 4 and HeightAlign 4. The supplied CPM card 5066 is likewise DXT1/normal/64x64/4/4. No user game data is included in the repository.
- New indexed GIMs now match the observed GimConv hierarchy: Palette block (0x05) before Image block (0x04), a 256x1 palette surface, and palette level type MIPMAP2. The earlier Image-before-Palette writer was a real structural mismatch.
- INDEX16/INDEX32 conversion remains disabled. Extended DXT format IDs are recognized for inspection where possible but are deliberately rejected by the writer until their creation semantics are independently verified.
- `Replace image` previews the rebuilt GIM by decoding it again, so the UI shows the actual compressed/indexed result rather than the uncompressed source bitmap.

Added/strengthened tests:

- independent golden PSP byte-layout tests for 5650, 5551, 4444, DXT1, DXT3 and DXT5;
- DXT5 alpha-index/endpoint placement checks;
- indexed Palette-before-Image, 256x1 and MIPMAP2 structural checks;
- explicit alignment-profile tests (normal 16/1, DXT 4/4, faster 16/8 and Tag Force 4/4);
- structural header comparisons against documented GimConv output for normal RGBA8888 and normal DXT;
- explicit rejection tests for unverified writer profiles;
- the GIM Studio -> 7-CIP -> CPM -> reopen integration test.

The real card-5066 workflow was rerun after these changes: `cardm_i.cip` -> 7-CIP -> stock DXT1 GIM -> GIM Studio `Replace image` -> 7-CIP -> rebuilt CPM preserves DXT1, the original 0x800 CPM slot size and the original archive size.
