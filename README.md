# PSP Modding Studio

PSP Modding Studio is a browser-based workspace for PSP modding tools. It runs entirely on the client and can be hosted as a static website, including on GitHub Pages.

The project uses plain HTML, CSS and JavaScript. There is no package manager, server component or build step.

## Included tools

- Hex Viewer: fast read-only hexadecimal inspection for generic files and binary formats without a dedicated handler.
- Image Viewer: lightweight local preview for common browser-supported image formats; it is the default image opener.
- UMD Forge: ISO, CSO and DAX image workspace with file replacement, extraction, rebuild, LBA tools and patch support.
- EBOOT Decrypter: decrypt PSP EBOOT/PRX executables into verified ELF files that can be dragged back into the workspace.
- SFO Studio: PARAM.SFO editor.
- Image Studio: image editing through an embedded Photopea session.

Each tool is isolated in its own iframe and integrates with the Studio through Tool API v1.

## Run locally

From the repository root:

```bash
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080/
```

Do not open `index.html` directly with `file://`. The project uses ES modules, workers and same-origin iframes.

## GitHub Pages

A GitHub Actions workflow is included in `.github/workflows/pages.yml`.

After pushing the repository to GitHub:

1. Open the repository settings.
2. Open **Pages** under **Code and automation**.
3. Set **Source** to **GitHub Actions**.
4. Push to the `main` branch, or run the Pages workflow manually from the Actions tab.

No path changes are required for project pages such as `https://username.github.io/repository-name/`; application assets and tool URLs are relative to the repository root.

## Tests

Node.js 22 or newer is recommended.

```bash
node tests/smoke.mjs
node tests/wrapper.mjs
node tests/deep-wrapper.mjs
node tests/dnd-bridge.mjs
node tests/project-fuzz.mjs
node tests/core-hygiene.mjs
node tests/search.mjs
node tests/eboot-decrypter.mjs
node tests/file-open-policy.mjs
node tests/assets.mjs
```

The Pages workflow runs the same test suite before deployment.

## Project structure

```text
assets/       Shared UI assets and styles
js/           Studio wrapper and project workspace
shared/       Shared runtime helpers used by current tools
tools/        Bundled tools and tool template
 docs/        Architecture and format documentation
 tests/       Regression tests and synthetic fixtures
index.html    Application entry point
help.html     User and developer documentation
```

## Adding a tool

Create a directory under `tools/`, add its ID to `tools/catalog.json`, and provide a valid `tool.json` plus the tool page and assets.

The integration contract is documented in `docs/TOOL_CONTRACT.md`. Tools should remain independent from Studio core modules and expose only the Tool API methods they actually use.

## License

GPL-3.0. See `LICENSE` and `THIRD_PARTY.md`.
