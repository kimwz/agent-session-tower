# Tower icon

`tower-rainbow-source.png` is the user-selected rainbow canvas frame (concept 2). Preserve the original artwork and export directly from it; never upscale an earlier small export.

PWA icons in `client/public` are 192px, 512px, and 1024px PNGs with their actual dimensions declared in the manifest. The Apple touch icon is also 1024px for high-density installed-app surfaces. Export using macOS `sips -z SIZE SIZE tower-rainbow-source.png --out OUTPUT`.

`favicon.svg` embeds a 64px bitmap and is only for browser tabs. **It is not a scalable vector and must never appear as `sizes: any` in the PWA manifest.** Installed apps must use the explicit PNG entries. The transparent artwork uses `purpose: any`, not `maskable`, to avoid cropping the frame.

Increment the `rainbow-2` URL revision in the HTML, manifest, header mark and service worker when replacing artwork. Installed apps may retain an OS-managed icon cache beyond page reloads.
