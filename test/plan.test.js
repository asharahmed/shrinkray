import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEncode, replan, formatBytes, MB, MIN_BPP, PRESETS } from '../plan.js';

const clip1080 = { width: 1920, height: 1080, fps: 30, duration: 20, hasAudio: true, bytes: 40 * MB };

test('10 MB target for a 20 s 1080p clip stays 1080p-ish but under budget', () => {
  const p = planEncode(clip1080, { bytes: 10 * MB });
  assert.ok(p.estimatedBytes <= 10 * MB, `estimate ${p.estimatedBytes} over target`);
  assert.ok(p.videoBps > 3_000_000 && p.videoBps < 3_800_000, `videoBps ${p.videoBps}`);
  assert.equal(p.audioBps, 128_000);
  assert.equal(p.height, 1080);
  assert.equal(p.impossible, false);
});

test('starved budgets step down the resolution ladder instead of smearing', () => {
  const long = { ...clip1080, duration: 600, bytes: 900 * MB }; // 10 minutes into 10 MB
  const p = planEncode(long, { bytes: 10 * MB });
  assert.ok(p.height <= 360, `height ${p.height}`);
  assert.ok(p.width % 2 === 0 && p.height % 2 === 0);
  assert.equal(p.audioChannels, 1);
  assert.equal(p.impossible, true); // 10 minutes into 10 MB is below our quality floor; we still try
});

test('60 fps sources are halved to 30 when bits are tight, kept when asked', () => {
  const game = { width: 1920, height: 1080, fps: 60, duration: 60, hasAudio: true, bytes: 300 * MB };
  const p = planEncode(game, { bytes: 10 * MB });
  assert.equal(p.fps, 30);
  assert.equal(p.halvedFps, true);
  const keep = planEncode(game, { bytes: 10 * MB }, { keepFps: true });
  assert.equal(keep.fps, 60);
});

test('maxHeight caps output; mute drops audio bits into video', () => {
  const p = planEncode(clip1080, { bytes: 10 * MB }, { maxHeight: 720 });
  assert.equal(p.height, 720);
  assert.equal(p.width, 1280);
  const m = planEncode(clip1080, { bytes: 10 * MB }, { mute: true });
  assert.equal(m.audioBps, 0);
  assert.equal(m.mute, true);
  assert.ok(m.videoBps > p.videoBps);
});

test('generous targets are capped rather than wasting bytes', () => {
  const p = planEncode({ ...clip1080, duration: 5 }, { bytes: 100 * MB });
  assert.equal(p.capped, true);
  assert.ok(p.estimatedBytes < 100 * MB);
});

test('impossible targets are flagged, not crashed', () => {
  const p = planEncode({ ...clip1080, duration: 7200 }, { bytes: 10 * MB });
  assert.equal(p.impossible, true);
  assert.ok(p.videoBps >= 120_000);
});

test('bits-per-pixel floor holds whenever a ladder rung was available', () => {
  for (const bytes of [5 * MB, 10 * MB, 18 * MB, 50 * MB]) {
    for (const duration of [10, 60, 180]) {
      const p = planEncode({ ...clip1080, duration }, { bytes });
      if (p.height > 240) assert.ok(p.bpp >= MIN_BPP - 0.001, `bpp ${p.bpp} at ${bytes}/${duration}`);
    }
  }
});

test('replan shrinks bitrate proportionally after an overshoot', () => {
  const p = planEncode(clip1080, { bytes: 10 * MB });
  const r = replan(p, 11 * MB, 10 * MB);
  assert.ok(r.videoBps < p.videoBps * 0.9);
  assert.equal(r.retried, 1);
});

test('presets are sane and formatBytes matches what people see in Finder', () => {
  assert.equal(PRESETS.find((x) => x.id === 'discord').bytes, 10_000_000);
  assert.equal(formatBytes(10_000_000), '10.0 MB');
  assert.equal(formatBytes(9_640_000), '9.64 MB');
  assert.equal(formatBytes(512_000), '512 KB');
});

test('never re-encodes above the source bitrate ("shrink anyway" must not grow the file)', () => {
  const small = { width: 1280, height: 720, fps: 60, duration: 10, hasAudio: true, bytes: 8.39 * MB, srcBps: (8.39 * MB * 8) / 10 };
  const p = planEncode(small, { bytes: 10 * MB });
  assert.equal(p.capped, true);
  assert.ok(p.estimatedBytes < 8.39 * MB, `estimate ${p.estimatedBytes}`);
});
