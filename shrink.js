// shrink.js — the engine. Reads a video with mediabunny, re-encodes it with the browser's
// own WebCodecs encoders (hardware accelerated where available), and retries until it fits.
// Nothing here touches the network.

import * as MB from './vendor/mediabunny.min.mjs';
import { planEncode, replan } from './plan.js';

export class ShrinkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function isSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
}

const openInput = (file) => new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });

/** Read the metadata we need to plan an encode. Fast: touches only headers and a few hundred packets. */
export async function probe(file) {
  const input = openInput(file);
  try {
    let format;
    try { format = await input.getFormat(); } catch { throw new ShrinkError('unreadable', "This doesn't look like a video file we can read."); }
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new ShrinkError('novideo', 'No video track found in this file.');
    const audio = await input.getPrimaryAudioTrack();
    const [duration, fr, canDecode, codec, width, height, rotation, audioCodec, audioCanDecode] = await Promise.all([
      input.computeDuration(),
      video.computeFrameRateMetrics({ targetPacketCount: 240 }),
      video.canDecode(),
      video.getCodec(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.getRotation(),
      audio ? audio.getCodec() : Promise.resolve(null),
      audio ? audio.canDecode() : Promise.resolve(false),
    ]);
    const fps = fr.bestGuessFrameRate || fr.averageFrameRate || 30;
    return {
      file, format: format?.name ?? 'video', duration, fps, width, height, rotation,
      codec, canDecode, hasAudio: !!audio && audioCanDecode, audioCodec,
      audioUndecodable: !!audio && !audioCanDecode,
    };
  } finally {
    input.dispose?.();
  }
}

async function pickVideoCodec(pref, plan) {
  const order = pref === 'hevc' ? ['hevc', 'avc'] : pref === 'av1' ? ['av1', 'avc'] : ['avc', 'hevc'];
  const codec = await MB.getFirstEncodableVideoCodec(order, { width: plan.width, height: plan.height, bitrate: plan.videoBps });
  if (!codec) throw new ShrinkError('noencoder', `This browser can't encode ${plan.width}×${plan.height} video. Try a smaller "Max resolution" in Options.`);
  return codec;
}

async function pickAudioCodec() {
  if (await MB.canEncodeAudio('aac')) return 'aac';
  if (await MB.canEncodeAudio('opus')) return 'opus';
  return null;
}

/** One encode attempt. Resolves with the output Blob. */
export async function encodeOnce(info, plan, { trim, codecPref = 'avc', onProgress, signal, hardware = 'no-preference' } = {}) {
  const t0 = performance.now();
  const input = openInput(info.file);
  const target = new MB.BufferTarget();
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const codec = await pickVideoCodec(codecPref, plan);

  const video = {
    codec,
    bitrate: plan.videoBps,
    width: plan.width,
    height: plan.height,
    fit: 'fill',
    keyFrameInterval: 4,
    forceTranscode: true,
    allowRotationMetadata: false, // bake rotation into pixels: some players ignore rotation matrices
    hardwareAcceleration: hardware,
  };
  if (plan.halvedFps) video.frameRate = plan.fps;

  let audio;
  let audioCodec = null;
  if (plan.mute) {
    audio = { discard: true };
  } else {
    audioCodec = await pickAudioCodec();
    audio = audioCodec
      ? { codec: audioCodec, bitrate: plan.audioBps, numberOfChannels: plan.audioChannels, forceTranscode: true }
      : { discard: true };
  }

  let conversion;
  try {
    conversion = await MB.Conversion.init({ input, output, video, audio, trim, showWarnings: false });
  } catch (e) {
    input.dispose?.();
    throw new ShrinkError('init', `Couldn't set up the encoder: ${e?.message ?? e}`);
  }
  const dropped = conversion.discardedTracks.find((d) => d.track.type === 'video');
  if (dropped) {
    input.dispose?.();
    const why = {
      undecodable_source_codec: `This browser can't decode ${info.codec ?? 'this'} video.`,
      unknown_source_codec: 'Unknown video codec.',
      no_encodable_target_codec: 'No usable video encoder in this browser.',
    }[dropped.reason] ?? dropped.reason;
    throw new ShrinkError('discarded', why);
  }

  conversion.onProgress = (p) => onProgress?.(p);
  const abort = () => conversion.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (signal?.aborted || e instanceof MB.ConversionCanceledError) throw new ShrinkError('cancelled', 'Cancelled.');
    throw new ShrinkError('encode', `Encoding failed: ${e?.message ?? e}`);
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose?.();
  }
  if (!target.buffer) throw new ShrinkError('empty', 'Encoder produced no output.');
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    codec, audioCodec: plan.mute ? null : audioCodec,
    ms: performance.now() - t0,
  };
}

/**
 * Shrink `file` to fit under `targetBytes`. Re-encodes up to 3 times, tightening the
 * bitrate whenever the encoder overshoots.
 *
 * onStatus receives { phase: 'probing'|'encoding'|'retrying'|'done', attempt, progress, plan }
 */
export async function shrink(file, { targetBytes, options = {}, trim, force = false, onStatus, signal } = {}) {
  onStatus?.({ phase: 'probing' });
  const info = await probe(file);
  if (!info.canDecode) throw new ShrinkError('undecodable', `This browser can't decode ${info.codec ?? 'this'} video. Try Chrome or Edge.`);

  let duration = info.duration;
  let trimOpt;
  if (trim && (trim.start > 0 || (trim.end != null && trim.end < info.duration))) {
    const start = Math.max(0, trim.start || 0);
    const end = Math.min(info.duration, trim.end ?? info.duration);
    if (end - start < 0.2) throw new ShrinkError('trim', 'Trim range is too short.');
    trimOpt = { start, end };
    duration = end - start;
  }

  let plan = planEncode(
    { width: info.width, height: info.height, fps: info.fps, duration, hasAudio: info.hasAudio, bytes: file.size, srcBps: (file.size * 8) / Math.max(0.1, info.duration) },
    { bytes: targetBytes },
    options,
  );
  if (plan.alreadySmall && !force && !trimOpt) {
    return { info, plan, skipped: true };
  }

  const maxAttempts = 3;
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onStatus?.({ phase: attempt === 1 ? 'encoding' : 'retrying', attempt, progress: 0, plan });
    const run = (hardware) => encodeOnce(info, plan, {
      trim: trimOpt, codecPref: options.codec, hardware,
      onProgress: (p) => onStatus?.({ phase: attempt === 1 ? 'encoding' : 'retrying', attempt, progress: p, plan }),
      signal,
    });
    try {
      result = await run('no-preference');
    } catch (e) {
      // Hardware encoders occasionally reject a frame ("Can't readback frame textures", odd sizes…).
      // The software encoder is slower but far more forgiving. One retry, then give up honestly.
      if (e?.code !== 'encode' || signal?.aborted) throw e;
      result = await run('prefer-software');
      result.software = true;
    }
    result.attempt = attempt;
    if (result.blob.size <= targetBytes || attempt === maxAttempts) break;
    plan = replan(plan, result.blob.size, targetBytes);
  }
  onStatus?.({ phase: 'done', attempt: result.attempt, progress: 1, plan });
  return { info, plan, trim: trimOpt, ...result, fits: result.blob.size <= targetBytes };
}
