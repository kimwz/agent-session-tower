# Tower icon

`tower-rainbow-source.png` is the user-selected rainbow canvas frame (concept 2), generated with the built-in image generation tool. Preserve this original when exporting application icons.

Exports in `client/public`: 192px and 512px PNG app icons, a 180px Apple touch icon, and a self-contained SVG favicon embedding the 64px PNG export. PNG exports use macOS `sips -z SIZE SIZE tower-rainbow-source.png --out OUTPUT`. The transparent artwork uses manifest purpose `any`, not `maskable`, so the OS does not crop its frame. Increment the `rainbow-1` URL revision in the HTML, manifest, header mark and service worker when replacing the artwork.
