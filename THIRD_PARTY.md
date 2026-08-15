# Third-party components and services

## Image Studio / Photopea

`tools/image-studio/` embeds the hosted Photopea application from `https://www.photopea.com/` as its graphics engine. Photopea code and assets are **not bundled** in this repository.

The integration uses Photopea's documented Live Messaging API: the tool sends an image to the embedded editor as an `ArrayBuffer` and requests the edited result with `Document.saveToOE()`. Image Studio therefore requires an Internet connection to load Photopea.

Relevant upstream documentation:

- Photopea API - Live Messaging
- Photopea Learn - Scripts / `Document.saveToOE()`

The Photopea integration belongs entirely to the Image Studio tool and does not extend PSP Modding Studio Tool API v1.

## Removed dormant prototypes

`docs/HISTORY.md` may mention experimental PSP executable crypto/signing helpers that once lived under `shared/psp/crypto/`. They had no runtime consumer in the current Studio or bundled tools and were removed from the v0.12.2 baseline. If a future executable tool needs that functionality, it should introduce a reviewed dependency as part of that concrete tool rather than keeping unused implementation in the wrapper baseline.
