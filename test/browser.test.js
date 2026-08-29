// End-to-end tests in a real (headless) Chrome: serve the site, push real video files through the UI,
// pull the output back out and verify it with ffprobe.
//
//   npm run test:browser
//
// Needs: Google Chrome (or CHROME env var), ffmpeg/ffprobe on PATH, and fixtures in test/fixtures
// (run `npm run fixtures` to generate them).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };

let server, port, browser, outDir;

before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrinkray-'));
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'shrinkray-profile-'))}`, '--autoplay-policy=no-user-gesture-required'],
  });
});
after(async () => { await browser?.close(); server?.close(); });

function ffprobe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames:format=duration,size', '-of', 'json', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { width: v?.width, height: v?.height, vcodec: v?.codec_name, acodec: a?.codec_name ?? null, duration: parseFloat(j.format.duration), size: parseInt(j.format.size, 10) };
}

/** Run one file through the page. Returns { status, ticket, sub, skipped, outFile } */
async function runFile(page, fixture, { targetMb, options = {}, trim } = {}) {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.evaluate(({ targetMb, options, trim }) => {
    const $ = (s) => document.querySelector(s);
    if (targetMb) { $('#customMb').value = String(targetMb); $('#targetCustomRadio').checked = true; $('#customMb').dispatchEvent(new Event('input', { bubbles: true })); }
    if (options.maxHeight) $('#optMaxHeight').value = String(options.maxHeight);
    if (options.keepFps) $('#optFps').value = 'keep';
    if (options.mute) $('#optAudio').value = 'mute';
    if (options.codec) $('#optCodec').value = options.codec;
    if (trim?.start != null) $('#optTrimStart').value = String(trim.start);
    if (trim?.end != null) $('#optTrimEnd').value = String(trim.end);
  }, { targetMb, options, trim });
  const mime = MIME[path.extname(fixture)] ?? 'video/mp4';
  await page.evaluate(async (name, mime) => {
    const blob = await (await fetch(`test/fixtures/${name}`)).blob();
    window.shrinkrayAddFiles([new File([blob], name, { type: mime })]);
  }, fixture, mime);
  const result = await page.waitForFunction(() => {
    const j = document.querySelector('.job');
    if (!j) return null;
    const status = j.querySelector('.job-status').textContent;
    const done = !j.querySelector('.job-result').hidden || j.querySelector('.job-status').classList.contains('error');
    if (!done) return null;
    const dl = j.querySelector('.dl');
    return { status, ticket: j.querySelector('.ticket').textContent, sub: j.querySelector('.ticket-sub').textContent,
      skipped: !j.querySelector('.again').hidden, href: dl.hidden ? null : dl.href, download: dl.download, error: status.includes('failed') || status.includes("can't") };
  }, { timeout: 180_000, polling: 500 }).then((h) => h.jsonValue());
  if (result.href) {
    const b64 = await page.evaluate(async (href) => {
      const buf = await (await fetch(href)).arrayBuffer();
      let s = ''; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, result.href);
    result.outFile = path.join(outDir, result.download);
    fs.writeFileSync(result.outFile, Buffer.from(b64, 'base64'));
    result.probe = ffprobe(result.outFile);
  }
  return result;
}

const fixturesPresent = fs.existsSync(path.join(FIX, 'landscape-1080p30.mp4'));
const skip = fixturesPresent ? false : 'fixtures missing — run `npm run fixtures`';

test('1080p30 landscape → 10 MB keeps 1080p and lands under target', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'landscape-1080p30.mp4', { targetMb: 10 });
  assert.ok(r.probe, `no output: ${r.status}`);
  assert.ok(r.probe.size <= 10_000_000, `size ${r.probe.size}`);
  assert.equal(r.probe.width, 1920); assert.equal(r.probe.height, 1080);
  assert.equal(r.probe.vcodec, 'h264'); assert.equal(r.probe.acodec, 'aac');
  assert.ok(Math.abs(r.probe.duration - 12) < 0.3, `duration ${r.probe.duration}`);
  await page.close();
});

test('rotated (90° metadata) MP4 without audio → upright 1080×1920, no audio track', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'rotated90-noaudio.mp4', { targetMb: 5 });
  assert.ok(r.probe, `no output: ${r.status}`);
  assert.equal(r.probe.width, 1080); assert.equal(r.probe.height, 1920);
  assert.equal(r.probe.acodec, null);
  assert.ok(r.probe.size <= 5_000_000);
  await page.close();
});

test('portrait MOV → 1 MB downscales to a ladder rung and still encodes', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'portrait-720x1280.mov', { targetMb: 1 });
  assert.ok(r.probe, `no output: ${r.status}`);
  assert.ok(r.probe.height < 1280 && r.probe.height % 2 === 0, `height ${r.probe.height}`);
  assert.ok(r.probe.size <= 1_000_000, `size ${r.probe.size}`);
  await page.close();
});

test('VP9/Opus WebM → H.264/AAC MP4', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'vp9-720p.webm', { targetMb: 1 });
  assert.ok(r.probe, `no output: ${r.status}`);
  assert.equal(r.probe.vcodec, 'h264'); assert.equal(r.probe.acodec, 'aac');
  assert.ok(r.probe.size <= 1_000_000, `size ${r.probe.size}`);
  await page.close();
});

test('options: trim 2–5 s, mute, cap 480p', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'landscape-1080p30.mp4', { targetMb: 10, options: { mute: true, maxHeight: 480 }, trim: { start: 2, end: 5 } });
  assert.ok(r.probe, `no output: ${r.status}`);
  assert.equal(r.probe.height, 480);
  assert.equal(r.probe.acodec, null);
  assert.ok(Math.abs(r.probe.duration - 3) < 0.3, `duration ${r.probe.duration}`);
  await page.close();
});

test('60 fps source is halved to 30 fps by default', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'gameplay-720p60.mp4', { targetMb: 2 });
  assert.ok(r.probe, `no output: ${r.status}`);
  const frames = parseInt(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', r.outFile]).toString(), 10);
  assert.ok(frames >= 140 && frames <= 160, `frames ${frames} (expected ~150 for 5 s @ 30)`);
  await page.close();
});

test('a file already under the target is not re-encoded', { skip }, async () => {
  const page = await browser.newPage();
  const r = await runFile(page, 'vp9-720p.webm', { targetMb: 50 });
  assert.equal(r.skipped, true);
  assert.match(r.status, /under your 50\.0 MB target/);
  await page.close();
});
