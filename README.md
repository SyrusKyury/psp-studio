# PSP Modding Studio

A browser-based workspace for PSP modding.

PSP Modding Studio brings a collection of focused PSP tools into one place, with a shared project explorer, tabs, drag and drop, file associations and a common workflow. It runs as a static web application, so there is no installer, no backend to configure and no Windows-only runtime hiding underneath it.

The long-term idea is simple: instead of collecting a folder full of unrelated utilities, use one workspace and open each file with the tool that actually understands it.

## Why does this exist?

I switched to Linux, btw.

That quickly reminded me of a slightly awkward part of PSP modding: a lot of useful tools were written for Windows years ago, many of them are no longer maintained, and some survive today as random `.exe` files mirrored through old forum posts, file hosts or corners of the internet that do not exactly inspire confidence.

Running an unknown executable on your main computer just to edit a `PARAM.SFO`, inspect an EBOOT or replace a file inside an ISO is not a particularly nice workflow. Keeping a Windows VM around only for a few old utilities is not much better.

So PSP Modding Studio takes a different approach.

The Studio itself is plain HTML, CSS and JavaScript and runs inside the browser. Your project is handled client-side, tools run in their own iframes, and there is no PSP Modding Studio server receiving your workspace. The source is here in the repository, so the code you are running can actually be inspected.

That also gives the project a useful side effect: Linux, Windows and macOS can use the same application. If a modern browser can run it, the operating system matters a lot less.

This does not mean that a browser is magic or that every bundled third-party component is offline. Some tools may use external libraries or services, and those dependencies are documented separately. The important distinction is that the Studio is not asking you to install and trust an opaque desktop executable just to work on a file.

## The idea

PSP Modding Studio is not one giant PSP editor.

It is a workspace that hosts independent tools.

The **Studio** handles the generic things:

- projects and `.pspstudio` files
- Project Explorer
- tabs
- search
- Tool Library
- `Open With...`
- file associations
- pinned tools
- drag and drop between tools and the workspace

The **Tools** handle the PSP-specific things:

- parsing a format
- displaying it
- editing it
- validating it
- rebuilding or exporting the result

That separation is intentional. UMD Forge should understand disc images. SFO Studio should understand `PARAM.SFO`. The Studio itself should not need to know the internal structure of either format.

It also means new tools can be added without turning the core into a collection of format-specific special cases.

## What using it feels like

Create a project, import the files you want to work on and treat the left side of the Studio like a small project filesystem.

Double-clicking a file opens the most appropriate tool. Generic binary files fall back to the Hex Viewer. Images open in the Image Viewer. More specific formats can be routed directly to their dedicated tool, while `Open With...` is always available when you want a different one.

Tools can expose their results as draggable resources, so a typical workflow can be:

```text
ISO
  -> UMD Forge
  -> extract EBOOT.BIN
  -> EBOOT Decrypter
  -> ELF
  -> another tool
  -> drag the result back into the project
```

The point is that these steps happen inside one workspace instead of through a chain of unrelated applications and temporary folders.

## Included tools

| Tool | Purpose |
| --- | --- |
| **UMD Forge** | Work with ISO, CSO and DAX images. Browse files, extract, replace, rebuild, inspect LBA information and work with patches. It is pinned by default in new projects. |
| **EBOOT Decrypter** | Decrypt supported PSP EBOOT/PRX executables into verified ELF files that can be passed to other tools. |
| **SFO Studio** | Inspect and edit `PARAM.SFO` files. |
| **Hex Viewer** | Fast read-only hexadecimal view for generic files and binary formats without a more appropriate handler. |
| **Image Viewer** | Lightweight local preview for common browser-supported image formats. This is the default image opener. |
| **Image Studio** | Image editing through an embedded Photopea session when viewing is not enough. |

The catalog is designed to grow. Game-specific tools can live alongside generic tools without being built into the Studio wrapper itself.

## Why the browser?

There are a few practical reasons beyond Linux compatibility.

**No installation.** Open the Studio and use it. A static deployment is enough.

**A better trust model.** The application runs inside the browser environment instead of receiving arbitrary native execution privileges on your machine. The repository is also inspectable rather than being distributed only as a binary.

**One workspace.** Tools do not need to reinvent project management, file picking, tabs, drag and drop or file associations.

**Portable projects.** A project can be saved as a `.pspstudio` file and reopened later.

**Cross-platform by default.** The same codebase runs on Linux, Windows and macOS.

**Easy to host.** GitHub Pages is enough. There is no application server to maintain.

## Privacy and local files

The Studio wrapper is a static client-side application. It does not upload your project to a PSP Modding Studio backend because there is no PSP Modding Studio backend.

Files you import are stored in the browser workspace. When you open one in a tool, the Studio passes the file to that tool rather than uploading it to a central project server. A `.pspstudio` project contains the workspace files together with the small amount of metadata needed to restore the Studio state.

Individual tools can have their own dependencies or network requirements. For example, Image Studio embeds Photopea and passes the image to that embedded editor, while EBOOT Decrypter lazily downloads its pinned WebAssembly engine but keeps the EBOOT data in the browser. Third-party components and their boundaries are documented in [`THIRD_PARTY.md`](THIRD_PARTY.md) and, where relevant, inside the tool directory itself.

## Projects

A `.pspstudio` file is a ZIP-based project container. It stores your workspace tree and project preferences in a portable format.

Projects currently preserve things such as:

- files and folders
- project name
- pinned tools
- tool suggestions
- saved `Open With...` associations
- restorable tool tabs

The project format is intentionally independent from individual editors. Tools do not get to fill the project manifest with private internal state or depend on undocumented core implementation details.

More details are available in [`docs/PROJECT_FORMAT.md`](docs/PROJECT_FORMAT.md).

## Run locally

There is no package manager and no build step.

From the repository root, start any normal static HTTP server. For example:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

Do not open `index.html` directly with `file://`. The project uses ES modules, workers and same-origin iframes, so it needs to be served over HTTP.

## GitHub Pages

The repository includes a GitHub Actions workflow in `.github/workflows/pages.yml`.

After pushing it to GitHub:

1. Open the repository **Settings**.
2. Open **Pages** under **Code and automation**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main`, or manually run the Pages workflow from the **Actions** tab.

The project uses relative URLs, so repository pages such as:

```text
https://username.github.io/repository-name/
```

work without changing asset or tool paths.

## Architecture

The core rule is:

> The Studio owns the workspace. Tools own editing.

Each tool is an independent directory with its own metadata, UI and code. Tools are loaded in iframes and communicate with the Studio through **Tool API v1**.

A tool should not import private Studio modules or know how the Project Explorer is implemented. It asks the Studio for the capabilities it needs and exposes semantic resources that can be dragged back into the workspace.

This keeps the wrapper generic and makes tools much easier to develop, replace and test independently.

If you want the details, start here:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md)
- [`docs/PROJECT_FORMAT.md`](docs/PROJECT_FORMAT.md)
- [`help.html`](help.html) for the full user and tool developer guide

## Adding a tool

The shortest version is:

1. Create a directory under `tools/`.
2. Add a `tool.json` manifest.
3. Add the tool UI and JavaScript.
4. Register the tool ID in `tools/catalog.json`.
5. Use Tool API v1 only for the Studio capabilities the tool actually needs.

A starter lives in [`tools/_template/`](tools/_template/).

The complete integration contract is documented in [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md).

The goal is to keep tools genuinely independent. If a feature only makes sense for one file format, it probably belongs in that tool rather than in the Studio core.

## Project structure

```text
assets/       Shared UI assets and styles
js/           Studio wrapper and project workspace
shared/       Shared runtime helpers used by current tools
tools/        Bundled tools and tool template
docs/         Architecture and format documentation
tests/        Regression tests and synthetic fixtures
index.html    Application entry point
help.html     User and developer documentation
```

## Tests

Node.js 22 or newer is recommended for the regression suite.

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

The GitHub Pages workflow runs the same checks before deployment.

## What this project is not trying to do

PSP Modding Studio is not trying to hide every tool behind one enormous abstraction, and it is not trying to move PSP modding into a server-side cloud service.

It is also not a promise that every historical PSP utility will be recreated. Tools should be added when they provide a real, reliable workflow. A small tool that does one thing correctly is more useful than a large menu full of buttons that only partially work.

The browser has limits too. Very large files, uncommon codecs and format-specific operations can still require careful handling. Where the browser is a poor fit, the project should say so rather than pretend otherwise.

## Contributing

Bug reports, format research and new tools are welcome.

For a new tool, keeping it isolated from the wrapper is the most important architectural rule. If you find yourself changing core code just to teach the Studio the internals of a PSP format, there is probably a cleaner boundary available through the Tool API.

Before submitting a change, run the regression suite and check the relevant documentation under `docs/`.

## License

PSP Modding Studio is released under the **GPL-3.0** license. See [`LICENSE`](LICENSE).

Third-party components and their licenses are listed in [`THIRD_PARTY.md`](THIRD_PARTY.md) and in tool-specific notices where applicable.