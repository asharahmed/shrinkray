# Shrinkray

**Compress video in your browser. No upload, no account, no watermark, no size limit.**

**→ https://asharahmed.github.io/shrinkray/**

![Shrinkray: 96.2 MB → 9.22 MB, 1080p, 2.3 s on your device](docs/shot-result.png)

Pick a target — 10 MB for Discord, 18 MB for email, or any number — drop in a video, download the result.
The whole thing runs on your device using WebCodecs (your browser's hardware video encoder), so a
300 MB clip doesn't have to crawl up your connection to some server first, and nobody else ever holds your file.

## How it works

1. **Read.** The file is parsed in the browser with [mediabunny](https://mediabunny.dev) — container, tracks, frame rate, duration.
2. **Plan.** `plan.js` turns the target size into a bitrate budget, sizes the audio to it, and steps down the
   resolution ladder (or halves 60 fps) only when the bits-per-pixel would otherwise fall below a quality floor.
3. **Encode.** mediabunny drives `VideoDecoder` → `VideoEncoder` (H.264 by default, HEVC/AV1 optional) and
   muxes a fast-start MP4 with AAC audio. If the encoder overshoots the target, the bitrate is tightened and
   it goes again — up to three passes.

Everything is plain ES modules, no build step. `plan.js` is pure and unit-tested; `shrink.js` is the engine; `app.js` is the UI.

## Privacy

- Your video never leaves your computer. There is no server — this is a static page.
- The only network request after the page loads is a single anonymous counter tick when a compression
  finishes (`abacus.jasoncameron.dev`, a public hit counter), so the "videos shrunk" tally on the page can be honest.
  Nothing about you or your file is sent — not the name, size, duration, or contents. It's disabled when running locally.
- Fonts load from Google Fonts. The page is a PWA and keeps working offline once loaded.

## Browser support

Chrome, Edge, Brave, Arc, Opera, Safari 17+ (desktop and iOS), Firefox 130+. Requires WebCodecs with an
H.264 encoder; the page tells you if your browser can't.

## Run it locally

```sh
git clone https://github.com/asharahmed/shrinkray
cd shrinkray
python3 -m http.server 8123   # any static server works
open http://127.0.0.1:8123/
```

```sh
npm test   # unit tests for the planning math
```

The vendored `vendor/mediabunny.min.mjs` is [mediabunny](https://github.com/vanilagy/mediabunny) (MPL-2.0).

## Why this exists

"File too large" is a daily annoyance — Discord's 10 MB, Gmail's real ~18 MB, a school portal's 25 MB — and every
"free online video compressor" makes you upload the whole file to someone's server, wait, and trust them with it.
Modern browsers can encode H.264 in hardware. There's no reason the file should leave your machine.

Found a file that breaks it? [Open an issue](https://github.com/asharahmed/shrinkray/issues) with your browser and the file's format.

## License

MIT © Ashar Ahmed
