// plan.js — pure planning math for Shrinkray. No browser APIs, no dependencies.
// Given what we know about a video and a target file size, decide the encode settings.

export const MB = 1_000_000; // decimal megabytes: what Discord, Gmail & Finder/Explorer display

export const PRESETS = [
  { id: 'discord', label: 'Discord', bytes: 10 * MB, note: 'Free-tier upload limit is 10 MB.' },
  { id: 'email', label: 'Email', bytes: 18 * MB, note: 'Email providers accept 25 MB, but attachments grow by a third in transit. 18 MB is safe.' },
  { id: 'nitro', label: '50 MB', bytes: 50 * MB, note: 'Discord Nitro Basic and most chat apps.' },
  { id: 'big', label: '100 MB', bytes: 100 * MB, note: 'iMessage, Slack, and most upload forms.' },
];

// Standard heights we are willing to scale down to (largest first).
const LADDER = [2160, 1440, 1080, 720, 540, 480, 360, 240];

// Bits per pixel per frame that H.264 hardware encoders need for "fine for sharing" quality.
// Below this we would rather drop resolution than smear the whole frame. (1080p30 keeps its resolution down to ~3.1 Mbps.)
export const MIN_BPP = 0.05;
// Encoders miss their bitrate target; MP4 boxes cost bytes. Leave headroom.
export const SAFETY = 0.93;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * @param {object} src
 * @param {number} src.width       display width in px (after rotation)
 * @param {number} src.height      display height in px (after rotation)
 * @param {number} src.fps         average frame rate
 * @param {number} src.duration    seconds (already trimmed)
 * @param {boolean} src.hasAudio
 * @param {number} src.bytes       source file size (for "already small enough" detection)
 * @param {number} [src.srcBps]    source file's overall bitrate; we never re-encode above ~90% of it
 * @param {object} target
 * @param {number} target.bytes    desired max output size
 * @param {object} [opts]
 * @param {number} [opts.maxHeight]   cap on output height (e.g. 720). 0/undefined = auto
 * @param {boolean} [opts.keepFps]    never halve the frame rate
 * @param {boolean} [opts.mute]       drop the audio track
 */
export function planEncode(src, target, opts = {}) {
  const duration = Math.max(0.1, src.duration);
  const budgetBits = target.bytes * 8 * SAFETY;
  const totalBps = budgetBits / duration;

  // --- audio ---------------------------------------------------------------
  let audioBps = 0;
  let audioChannels = 2;
  if (src.hasAudio && !opts.mute) {
    if (totalBps > 3_000_000) audioBps = 128_000;
    else if (totalBps > 1_200_000) audioBps = 96_000;
    else if (totalBps > 500_000) audioBps = 64_000;
    else { audioBps = 48_000; audioChannels = 1; }
  }

  // --- video bitrate -------------------------------------------------------
  // MP4 sample tables cost ~ 20 bytes per sample; account for them so we don't overshoot on long clips.
  const fpsIn = src.fps > 0 ? src.fps : 30;
  const halveFps = !opts.keepFps && fpsIn > 40;
  let fps = halveFps ? fpsIn / 2 : fpsIn;
  const sampleOverheadBps = (fps + (audioBps ? 43 : 0)) * 20 * 8;
  let videoBps = Math.floor(totalBps - audioBps - sampleOverheadBps);
  const impossible = videoBps < 120_000;
  videoBps = Math.max(videoBps, 120_000);

  // --- resolution ----------------------------------------------------------
  const aspect = src.width / src.height;
  const capH = opts.maxHeight && opts.maxHeight > 0 ? Math.min(src.height, opts.maxHeight) : src.height;
  const candidates = [capH, ...LADDER.filter((h) => h < capH)];
  let height = candidates[candidates.length - 1];
  let bpp = 0;
  for (const h of candidates) {
    const w = even(h * aspect);
    bpp = videoBps / (w * h * fps);
    if (bpp >= MIN_BPP) { height = h; break; }
  }
  // If even the smallest rung is starved and we still have 60fps, halve fps as a last resort.
  if (bpp < MIN_BPP && !halveFps && !opts.keepFps && fpsIn > 40) fps = fpsIn / 2;
  height = even(height);
  const width = even(height * aspect);
  bpp = videoBps / (width * height * fps);

  // Don't spend more bits than the source could possibly have needed: cap at a generous ceiling
  // so a 10 s clip with a 100 MB target doesn't produce a 100 MB file for no reason.
  // Also never exceed the source's own bitrate: re-encoding above it only adds bytes, not quality.
  const srcCeiling = src.srcBps > 0 ? Math.floor(src.srcBps * 0.9 - audioBps) : Infinity;
  const ceilingBps = Math.max(120_000, Math.min(Math.round(width * height * fps * 0.25), srcCeiling));
  const capped = videoBps > ceilingBps;
  if (capped) videoBps = ceilingBps;

  const estimatedBytes = Math.round(((videoBps + audioBps + sampleOverheadBps) * duration) / 8);
  const alreadySmall = src.bytes > 0 && src.bytes <= target.bytes;

  return {
    videoBps, audioBps, audioChannels,
    width, height, fps: Math.round(fps * 1000) / 1000,
    halvedFps: fps < fpsIn - 0.5,
    downscaled: height < src.height,
    bpp: Math.round(bpp * 1000) / 1000,
    estimatedBytes,
    impossible,      // target is so small the result will look bad
    capped,          // target so generous we didn't need it all
    alreadySmall,    // source already under target
    mute: !!opts.mute || !src.hasAudio,
  };
}

/** After a real encode came out at `actualBytes`, produce a corrected plan for another attempt. */
export function replan(plan, actualBytes, targetBytes) {
  const ratio = targetBytes / actualBytes;
  // Undershoot the correction slightly: encoders drift, and we'd rather land at 96% than 101%.
  const scale = Math.min(0.97, ratio * 0.95);
  const videoBps = Math.max(80_000, Math.floor(plan.videoBps * scale));
  return { ...plan, videoBps, retried: (plan.retried || 0) + 1 };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${n} B`;
  if (n < MB) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)} KB`;
  if (n < 1000 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 2 : 1)} MB`;
  return `${(n / (1000 * MB)).toFixed(2)} GB`;
}

export function formatBps(bps) {
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

export function formatDuration(s) {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m ? `${m}:${sec.toFixed(0).padStart(2, '0')}` : `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
}
