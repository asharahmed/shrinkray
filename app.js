// app.js — UI wiring. Everything media-related lives in shrink.js / plan.js.
import { PRESETS, MB, formatBytes, formatBps, formatDuration } from './plan.js';
import { shrink, isSupported, probe } from './shrink.js';

const $ = (sel, root = document) => root.querySelector(sel);
const ABACUS = 'https://abacus.jasoncameron.dev';
const NS = 'shrinkray-app';
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// ---------------------------------------------------------------- telemetry
// One anonymous counter. No file names, sizes, IPs stored by us; see README.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function tick(key, { once = false } = {}) {
  if (isLocal && !location.search.includes('telemetry=1')) return; // dev: off unless ?telemetry=1
  if (once) {
    if (store.get(`sr:${key}`)) return;
    store.set(`sr:${key}`, '1');
  }
  fetch(`${ABACUS}/hit/${NS}/${key}`, { mode: 'cors', keepalive: true }).catch(() => {});
}
async function loadTally() {
  try {
    const r = await fetch(`${ABACUS}/get/${NS}/shrunk`, { mode: 'cors' });
    const { value } = await r.json();
    if (value > 0) {
      $('#tallyNum').textContent = value.toLocaleString();
      $('#tally').hidden = false;
    }
  } catch {}
}

// ---------------------------------------------------------------- target dial
const state = { targetBytes: PRESETS[0].bytes, queue: [], running: false };
const dial = $('#dial');
const customLabel = $('.dial-custom');
for (const p of PRESETS) {
  const label = document.createElement('label');
  label.innerHTML = `<input type="radio" name="target" value="${p.id}"><span class="dial-btn">${p.label}<small>${p.bytes / MB} MB</small></span>`;
  dial.insertBefore(label, customLabel);
}
const customMb = $('#customMb');
function applyTarget() {
  const checked = dial.querySelector('input[name=target]:checked');
  const id = checked?.value ?? PRESETS[0].id;
  if (id === 'custom') {
    const mb = Math.max(0.5, parseFloat(customMb.value) || 8);
    state.targetBytes = Math.round(mb * MB);
    $('#targetNote').textContent = `Anything under ${formatBytes(state.targetBytes)}.`;
  } else {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    state.targetBytes = p.bytes;
    $('#targetNote').textContent = p.note;
  }
  store.set('sr:target', id === 'custom' ? `custom:${customMb.value}` : id);
}
dial.addEventListener('change', applyTarget);
customMb.addEventListener('input', () => { $('#targetCustomRadio').checked = true; applyTarget(); });
customMb.addEventListener('focus', () => { $('#targetCustomRadio').checked = true; applyTarget(); });
{
  const saved = store.get('sr:target') ?? PRESETS[0].id;
  if (saved.startsWith('custom:')) { customMb.value = saved.slice(7); $('#targetCustomRadio').checked = true; }
  else (dial.querySelector(`input[value="${saved}"]`) ?? dial.querySelector('input')).checked = true;
  applyTarget();
}

// ---------------------------------------------------------------- options
function readOptions() {
  return {
    maxHeight: parseInt($('#optMaxHeight').value, 10) || 0,
    keepFps: $('#optFps').value === 'keep',
    mute: $('#optAudio').value === 'mute',
    codec: $('#optCodec').value,
  };
}
function takeTrim() {
  const start = parseFloat($('#optTrimStart').value);
  const end = parseFloat($('#optTrimEnd').value);
  if (!(start > 0) && !(end > 0)) return null;
  $('#optTrimStart').value = '';
  $('#optTrimEnd').value = '';
  return { start: start > 0 ? start : 0, end: end > 0 ? end : undefined };
}

// ---------------------------------------------------------------- file intake
const drop = $('#drop');
const fileInput = $('#fileInput');
$('#chooseBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', (e) => { if (!e.target.closest('button')) fileInput.click(); });
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

let dragDepth = 0;
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (ev === 'dragenter') dragDepth++;
    drop.classList.add('over');
  });
}
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  addFiles(e.dataTransfer.files);
});

const supported = isSupported();
if (!supported) {
  $('#unsupported').hidden = false;
  drop.classList.add('disabled');
}

// ---------------------------------------------------------------- jobs
const jobsEl = $('#jobs');
const tpl = $('#jobTpl');
const baseName = (name) => name.replace(/\.[^.]+$/, '');

export function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts)$/i.test(f.name));
  if (!list.length) return;
  const trim = takeTrim();
  for (const file of list) {
    const job = makeJob(file, trim);
    state.queue.push(job);
  }
  runQueue();
}
window.shrinkrayAddFiles = addFiles; // used by tests
window.shrinkrayProbe = probe;

function makeJob(file, trim) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const job = { file, trim, el, controller: null, urls: [], done: false, force: false };
  $('.job-name', el).textContent = file.name;
  $('.job-meta', el).textContent = `${formatBytes(file.size)} · queued`;
  $('.job-remove', el).addEventListener('click', () => removeJob(job));
  $('.again', el).addEventListener('click', () => { job.force = true; job.done = false; resetJobUi(job); state.queue.push(job); runQueue(); });
  $('.preview', el).addEventListener('click', () => {
    const v = $('.job-video', el);
    v.hidden = !v.hidden;
    $('.preview', el).textContent = v.hidden ? 'Preview' : 'Hide preview';
    if (!v.hidden) v.play().catch(() => {});
  });
  jobsEl.prepend(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return job;
}

function resetJobUi(job) {
  const { el } = job;
  $('.job-result', el).hidden = true;
  $('.job-progress', el).className = 'job-progress';
  $('.job-progress span', el).style.width = '0';
  $('.job-status', el).className = 'job-status';
  $('.job-status', el).textContent = '';
}

function removeJob(job) {
  job.controller?.abort();
  state.queue = state.queue.filter((j) => j !== job);
  job.urls.forEach((u) => URL.revokeObjectURL(u));
  job.el.remove();
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  while (state.queue.length) {
    const job = state.queue.shift();
    if (!job.el.isConnected) continue;
    await runJob(job);
  }
  state.running = false;
}

function setProgress(job, value, cls) {
  const bar = $('.job-progress', job.el);
  bar.className = `job-progress ${cls ?? ''}`.trim();
  if (value == null) { bar.removeAttribute('aria-valuenow'); return; }
  const pct = Math.round(value * 100);
  bar.setAttribute('aria-valuenow', pct);
  $('span', bar).style.width = `${pct}%`;
}
function setStatus(job, text, isError = false) {
  const s = $('.job-status', job.el);
  s.textContent = text;
  s.className = `job-status${isError ? ' error' : ''}`;
}

async function runJob(job) {
  const { file, el } = job;
  const targetBytes = state.targetBytes;
  const options = readOptions();
  job.controller = new AbortController();
  let t0 = performance.now();
  let lastProgress = 0;
  let lastAttempt = 0;

  const onStatus = ({ phase, attempt, progress, plan }) => {
    if (phase === 'probing') { setProgress(job, null, 'indeterminate'); setStatus(job, 'Reading the file'); return; }
    if (phase === 'done') return;
    if (attempt !== lastAttempt) { lastAttempt = attempt; t0 = performance.now(); }
    lastProgress = progress ?? 0;
    setProgress(job, lastProgress);
    const elapsed = (performance.now() - t0) / 1000;
    const eta = lastProgress > 0.03 ? Math.max(0, (elapsed / lastProgress) * (1 - lastProgress)) : null;
    const desc = `${plan.width}×${plan.height} · ${Math.round(plan.fps)} fps · ${formatBps(plan.videoBps)}`;
    const pct = `${Math.round(lastProgress * 100)}%`;
    const left = eta != null ? ` · ~${formatDuration(eta)} left` : '';
    setStatus(job, phase === 'retrying'
      ? `Over the limit; pass ${attempt} of 3 at ${formatBps(plan.videoBps)} · ${pct}${left}`
      : `Encoding ${desc} · ${pct}${left}`);
  };

  try {
    window.addEventListener('beforeunload', warnUnload);
    const res = await shrink(file, { targetBytes, options, trim: job.trim, force: job.force, onStatus, signal: job.controller.signal });
    const { info } = res;
    $('.job-meta', el).textContent = [
      `${info.width}×${info.height}`, `${Math.round(info.fps)} fps`, formatDuration(info.duration),
      info.codec ? info.codec.toUpperCase().replace('AVC', 'H.264') : null, formatBytes(file.size),
    ].filter(Boolean).join(' · ');

    if (res.skipped) {
      setProgress(job, 1, 'done');
      setStatus(job, `This file is ${formatBytes(file.size)}, under the ${formatBytes(targetBytes)} limit. No compression needed.`);
      $('.job-result', el).hidden = false;
      $('.ticket', el).hidden = true;
      $('.ticket-sub', el).textContent = '';
      $('.dl', el).hidden = true;
      $('.preview', el).hidden = true;
      $('.again', el).hidden = false;
      job.done = true;
      return;
    }

    const { blob, plan, codec, ms, attempt, fits, software } = res;
    const url = URL.createObjectURL(blob);
    job.urls.push(url);
    setProgress(job, 1, fits ? 'done' : 'failed');
    setStatus(job, '');

    const result = $('.job-result', el);
    result.hidden = false;
    $('.ticket', el).hidden = false;
    $('.from', el).textContent = formatBytes(file.size);
    $('.to', el).textContent = formatBytes(blob.size);
    const pctSmaller = Math.round((1 - blob.size / file.size) * 100);
    const bits = [
      pctSmaller > 0 ? `${pctSmaller}% smaller` : null,
      `${plan.width}×${plan.height}`,
      `${Math.round(plan.fps)} fps`,
      formatBps(plan.videoBps),
      codec === 'avc' ? 'H.264' : codec.toUpperCase(),
      plan.mute ? 'no audio' : null,
      formatDuration(ms / 1000),
      attempt > 1 ? `${attempt} passes` : null,
      software ? 'software encoder' : null,
    ].filter(Boolean);
    const sub = $('.ticket-sub', el);
    sub.textContent = bits.join(' · ');
    if (!fits) {
      sub.insertAdjacentHTML('beforeend', ` <span class="warn">Still over ${formatBytes(targetBytes)} after 3 passes. Trim the video or set a lower max resolution in Options.</span>`);
    } else if (plan.impossible) {
      sub.insertAdjacentHTML('beforeend', ` <span class="warn">${formatDuration(info.duration)} of video at this size will look soft. Trimming helps.</span>`);
    }
    const dl = $('.dl', el);
    dl.hidden = false;
    dl.href = url;
    dl.download = `${baseName(file.name)}-shrunk.mp4`;
    $('.preview', el).hidden = false;
    $('.again', el).hidden = true;
    const video = $('.job-video', el);
    video.src = url;
    job.done = true;

    if (fits) {
      tick('shrunk');
      tick('users', { once: true });
      const t = $('#tallyNum');
      if (!$('#tally').hidden) t.textContent = (parseInt(t.textContent.replace(/\D/g, ''), 10) + 1).toLocaleString();
    }
  } catch (e) {
    const cancelled = e?.code === 'cancelled';
    setProgress(job, cancelled ? 0 : 1, cancelled ? '' : 'failed');
    setStatus(job, cancelled ? 'Cancelled.' : (e?.message || 'Something went wrong.'), !cancelled);
    if (!cancelled) console.error('[shrinkray]', e);
  } finally {
    window.removeEventListener('beforeunload', warnUnload);
    job.controller = null;
  }
}
function warnUnload(e) { e.preventDefault(); e.returnValue = ''; }

// ---------------------------------------------------------------- boot
if (supported) {
  tick('visits');
  tick('visitors', { once: true });
}
loadTally();
if ('serviceWorker' in navigator && !isLocal) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
