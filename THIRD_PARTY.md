# Third-party components and services
## Image Studio / Photopea

`tools/image-studio/` embeds the hosted Photopea application from `https://www.photopea.com/` as its graphics engine. Photopea code and assets are **not bundled** in this repository.

The integration uses Photopea's documented Live Messaging API: the tool sends an image to the embedded editor as an `ArrayBuffer` and requests the edited result with `Document.saveToOE()`. Image Studio therefore requires an Internet connection to load Photopea.

Relevant upstream documentation:
- Photopea API - Live Messaging
- Photopea Learn - Scripts / `Document.saveToOE()`

The Photopea integration belongs entirely to the Image Studio tool and does not extend PSP Modding Studio Tool API v1.
## EBOOT Decrypter / PSP KIRK WebAssembly

`tools/eboot-decrypter/` uses the GPLv3 `psp-encryption-webassembly` KIRK/PRX implementation maintained by euan-forrester and derived from PPSSPP. The browser build is loaded from the copy used by `save-file-converter`, pinned to commit `98a7203ecc507e584eafc21cd48a6ea2b2e791b4`.
The tool fetches only the JavaScript loader and WebAssembly engine. EBOOT/PRX file contents remain in the browser and are passed directly to the local WebAssembly instance. The dependency is loaded lazily only when an encrypted executable needs decryption.

Relevant upstream projects:

- `euan-forrester/psp-encryption-webassembly` - GPL-3.0
- `euan-forrester/save-file-converter` - source of the pinned browser build
- `hrydgard/PPSSPP` - upstream KIRK/PRX implementation used by the WebAssembly port

## 7-CIP / CIPTool format research

`tools/7cip/` contains a browser-native JavaScript reimplementation of the Yu-Gi-Oh! Tag Force CIP-family archive logic documented and implemented by Lovro Plese (Xan) in `CIPTool`.

CIPTool is MIT licensed. 7-CIP does not execute or bundle `CIPTool.exe`; the archive parser/rebuilder runs locally as JavaScript. The upstream copyright and MIT permission notice are retained in `tools/7cip/NOTICE.md`.

Relevant upstream project:

- `xan1242/CIPTool` - MIT

## Removed dormant prototypes

`docs/HISTORY.md` may mention experimental PSP executable crypto/signing helpers that once lived under `shared/psp/crypto/`. They had no runtime consumer and were removed from the v0.12.2 wrapper baseline. EBOOT Decrypter now owns its executable decryption dependency inside the tool boundary instead of reintroducing crypto code into the Studio core.
