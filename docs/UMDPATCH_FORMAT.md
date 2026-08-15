# `.umdpatch` format v1

A `.umdpatch` is a ZIP-based UMD Forge operation patch.

```text
patch.json
files/0001-...
files/0002-...
```

`patch.json` records:

- format/version;
- patch name/date;
- source ISO fingerprint (size, volume ID and SHA-256 over selected immutable source slices/metadata);
- sequential UMD operations;
- final disc file order.

Supported operations in v1:

```text
replace
add-file
add-directory
rename
delete
```

The payload of Replace/Add operations is stored once as a file entry referenced by the operation.

This format is intentionally not xdelta/VCDIFF. UMD Forge already knows the semantic edit operations, so it can package only modified/added files without first materializing two full ISO images. xdelta and PPF can later be implemented as additional import/export adapters behind the same Patch menu.
