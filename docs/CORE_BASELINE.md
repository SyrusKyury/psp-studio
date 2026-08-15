# Studio Core Baseline - v0.14.5

The Studio core is a small IDE-style wrapper around independent same-origin tools. Its job is project persistence, navigation, lifecycle, transfer mediation and failure containment. Tool-specific behavior belongs to tools.

## Core rule

A failing tool should become a clearly attributable tool problem, not a wrapper-state problem. Core changes should therefore be justified by a reproducible wrapper defect or a capability proven necessary across multiple tools.

## Frozen Tool API v1

```js
window.tool = {
  open(file) {},
  get(id) {},
  replace(id, file) {},
  add(id, files) {},
};
```

Methods are optional, except that a tool opened with a project file must implement `open(file)`. The wrapper validates declared methods and bounds asynchronous calls.

The optional presentation bridge remains limited to `toast`, `confirm`, `dirty` and `title`. After injection the iframe receives `studio-ready`.

## Wrapper invariants

### ProjectStore

- canonical project paths only;
- O(1) ID and canonical-path indexes;
- foreign/stale nodes cannot mutate a store;
- batch imports are prevalidated and atomic;
- accepted payloads are genuine detached Blob content;
- node/depth/file/aggregate/ZIP-field limits are enforced at runtime;
- dirty state is revision-derived and save is revision-safe;
- accepted runtime state must be writable and reopenable by the same `.pspstudio` implementation;
- saved tab descriptors are canonical and advisory metadata cannot destroy workspace files.

### Archive layer

- ZIP32 bounds are explicit;
- ZIP64, encrypted and multi-disk archives are rejected;
- local and central records are cross-checked;
- record overlap / malformed offsets are rejected;
- every project entry is CRC32 checked;
- Deflate output is streamed with runtime bounds rather than trusting declared sizes;
- generated central directory and manifest sizes are bounded.

### Registry

- one canonical `{ core: [], tools: [] }` catalog shape;
- malformed tools are isolated;
- required `index.html` is availability-checked;
- manifest strings/lists/file rules are strictly typed and bounded;
- redirects and invalid UTF-8/JSON are rejected;
- discovery is bounded by concurrency, per-request timeout and global deadline;
- refresh is transactional and concurrent-load generation-safe;
- normalized manifests and error collections are immutable snapshots.

### ModuleHost / transfer boundary

- iframe lifecycle handlers are installed before attach;
- event-listener teardown is AbortSignal-owned where the platform supports it;
- wrapper-created cancellation is distinguishable from a tool-thrown `AbortError`;
- the reserved `window.studio` bridge is frozen and cannot be replaced by a hosted tool;
- iframe page load and Tool API calls are bounded;
- `window.tool` is normalized once and malformed methods fail fast;
- cross-realm File/Blob conversion rejects structural impostors;
- semantic resources must declare exactly one of `data-file` / `data-folder`;
- `data-file` accepts exactly one incoming file;
- transfer consumption spans the full lazy-resource lifetime;
- source, destination and project lifecycle cancellation are linked;
- folder-transfer step timeout is capped by the total transfer deadline.


### Shell surface

- dark-only wrapper; no theme toggle or light-theme state;
- direct project-action top bar + activity rail + Project Explorer/Search + document tabs/tool host;
- pinned tools live in the activity rail; new projects start with UMD Forge pinned, and every pin can still be added or removed per workspace;
- no wrapper Inspector, toolbar, status bar, Tools sidebar or special Welcome tab;
- Help is a separate static `help.html`, outside project/tab/tool lifecycle;
- project file/folder mutation controls live in Project Explorer rather than a duplicate Project menu.
- workspace Search is wrapper-owned, exact Text/Hex only, worker-backed and chunked; automatic content scanning is bounded per file and in aggregate, with the remainder explicitly deferred.
- file opening prefers the lightweight Image Viewer for supported images, uses Hex Viewer only as a wildcard fallback when no format-specific handler exists, and always gives saved workspace associations precedence.

### Shell / tabs

- required shell DOM is fail-fast;
- the main Studio document applies a same-origin CSP for scripts, frames and connections, with no object/embed or form submission surface;
- core/shared JavaScript uses a statically analyzable, acyclic module graph;
- project-changing operations are busy/inert and non-overlapping;
- incoming projects are validated before replacement is committed;
- tab opening and closing are teardown-safe;
- presentation updates can mutate only tab title/dirty state;
- failed tool auto-restore is contained per tool without deleting pending saved descriptors;
- shell-level uncaught errors are normalized and visibly attributed to the Studio.

## Simplicity policy

Prefer fewer owners, fewer mutable states and one implementation of each invariant. Do not reduce line count by introducing opaque one-liners, generic abstraction layers or hidden coupling. Dormant future functionality does not belong in the core; add dependencies when a real tool needs them.

## Trust boundary

Bundled tools are same-origin trusted code. The iframe provides UI/global-state isolation and lifecycle containment, not a security sandbox against intentionally malicious JavaScript. A future untrusted marketplace would require a separate sandboxed/cross-origin protocol.
