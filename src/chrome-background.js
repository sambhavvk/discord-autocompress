import { api, isVideo, normalizeSettings } from './settings.js';
import { CLIENT_PORT, OFFSCREEN_PORT, OFFSCREEN_PATH, MAX_OUTPUT_BYTES, validateStart, validateMetadata, validateChunk } from './chrome-transfer.js';

const jobs = new Map();
let nextId = 0;
let activeVideo = null;
let bridge = null;
let awaitingBridge = null;
let documentOperation = Promise.resolve();
let closingDocument = false;
const offscreenURL = api.runtime.getURL(OFFSCREEN_PATH);

export function allowedPage(sender) {
  if (sender?.id !== api.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  // Use the declared content-script origins, including the local browser test
  // fixture. Path matching prevents a future narrower manifest widening here.
  return (api.runtime.getManifest().content_scripts || []).some(({ matches = [] }) => matches.some((pattern) => {
    const match = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!match || url.protocol !== `${match[1]}:`) return false;
    const host = match[2];
    if (host.startsWith('*.') ? !(url.hostname === host.slice(2) || url.hostname.endsWith(`.${host.slice(2)}`)) : url.hostname !== host) return false;
    const path = new RegExp(`^${match[3].split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return path.test(url.pathname + url.search);
  }));
}

function disconnect(port) { try { port.disconnect(); } catch { /* Already closed. */ } }
function post(port, message) { port.postMessage(message); }
function serializeDocument(operation) {
  const promise = documentOperation.catch(() => {}).then(operation);
  documentOperation = promise;
  return promise;
}

async function ensureDocument() {
  await serializeDocument(async () => {
    if (bridge) return;
    const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] });
    // A document left behind by a terminated service worker has no trustworthy
    // job ownership. Replace it before accepting another compression job.
    if (contexts.length) {
      closingDocument = true;
      try { await api.offscreen.closeDocument(); }
      finally { closingDocument = false; }
    }
    let readyTimer;
    const ready = new Promise((resolve, reject) => {
      awaitingBridge = { resolve, reject };
      // This is only a bounded document-start failure guard, never a job timer.
      readyTimer = setTimeout(() => reject(new Error('The local compression document did not start.')), 5000);
    });
    ready.catch(() => {});
    try {
      await api.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Run bundled local image and video workers and transfer file Blobs without exposing them to websites.',
      });
      await ready;
    } finally {
      clearTimeout(readyTimer);
      awaitingBridge = null;
    }
  });
}

function closeWhenIdle() {
  void serializeDocument(async () => {
    if (jobs.size) return;
    const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] });
    if (jobs.size || !contexts.length) return;
    closingDocument = true;
    try { await api.offscreen.closeDocument(); }
    finally { bridge = null; closingDocument = false; }
  }).catch(() => {});
}

function release(job) {
  if (job.ended) return;
  job.ended = true;
  jobs.delete(job.id);
  if (activeVideo === job) activeVideo = null;
  closeWhenIdle();
}

function fail(job, message, notify = true) {
  if (job.ended || job.cancelled) return;
  job.cancelled = true;
  if (notify) {
    try { post(job.port, { type: 'error', message }); } catch { /* Caller left. */ }
  }
  // Keep the video slot reserved until offscreen confirms worker termination.
  if (job.sent && bridge) {
    try { post(bridge, { type: 'cancel', job: job.id }); return; } catch { /* Bridge has died. */ }
  }
  release(job);
}

function offscreenMessage(message) {
  const job = jobs.get(message?.job);
  if (!job || job.ended) return;
  try {
    if (message.type === 'cancelled' || message.type === 'completed') return release(job);
    if (job.cancelled) return;
    if (message.type === 'error') return fail(job, typeof message.message === 'string' ? message.message : 'Compression failed.');
    if (message.type === 'ready') {
      if (job.phase !== 'starting') throw new Error('Invalid compression readiness.');
      job.phase = 'input';
    } else if (message.type === 'input-ack') {
      if (job.phase !== 'input' || !job.inputPending || message.index !== job.inputPending.index) throw new Error('Invalid input acknowledgment.');
      job.received += job.inputPending.bytes;
      job.index++;
      job.inputPending = null;
    } else if (message.type === 'progress') {
      if (typeof message.message !== 'string' || message.message.length > 2048) throw new Error('Invalid compression progress.');
    } else if (message.type === 'output-start') {
      if (job.phase !== 'encoding') throw new Error('Unexpected compression output.');
      job.output = validateMetadata(message.file, Math.min(job.targetBytes, MAX_OUTPUT_BYTES));
      job.phase = 'output-start';
      job.outputReceived = 0;
      job.outputIndex = 0;
    } else if (message.type === 'output-chunk') {
      if (job.phase !== 'output' || job.outputPending) throw new Error('Unexpected output chunk.');
      const bytes = validateChunk(message, job.outputIndex, job.output.size - job.outputReceived);
      job.outputPending = { index: message.index, bytes };
    } else if (message.type === 'output-end') {
      if (job.phase !== 'output' || job.outputPending || job.outputReceived !== job.output.size) throw new Error('Incomplete compression output.');
      job.phase = 'finished';
    } else throw new Error('Unknown compression message.');
    const { job: ignored, ...payload } = message;
    post(job.port, payload);
  } catch (error) { fail(job, error.message); }
}

// Register synchronously: no event listener depends on asynchronous startup.
api.runtime.onConnect.addListener((port) => {
  if (port.name === OFFSCREEN_PORT) {
    if (port.sender?.id !== api.runtime.id || port.sender?.url !== offscreenURL || port.sender?.tab || bridge || !awaitingBridge) {
      disconnect(port);
      return;
    }
    bridge = port;
    port.onMessage.addListener(offscreenMessage);
    port.onDisconnect.addListener(() => {
      if (bridge !== port) return;
      bridge = null;
      if (!closingDocument) {
        for (const job of jobs.values()) {
          try { post(job.port, { type: 'error', message: 'The local encoder closed. Attach the file again to retry.' }); } catch { /* Caller left. */ }
          release(job);
        }
      }
    });
    awaitingBridge.resolve();
    return;
  }
  if (port.name !== CLIENT_PORT || !allowedPage(port.sender)) return disconnect(port);
  let job;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (job) fail(job, 'Compression cancelled.', false);
  });
  port.onMessage.addListener((request) => {
    if (request?.type === 'keepalive') return;
    if (disconnected) return;
    try {
      if (!job) {
        if (request?.type !== 'start') throw new Error('Invalid compression request.');
        const metadata = validateStart(request);
        if (request.mode === 'video' && !isVideo(metadata)) throw new Error('Choose a supported video file.');
        if (request.mode === 'video' && activeVideo) throw new Error('Another video is already being processed. Wait for it to finish or cancel it, then try again.');
        job = { id: ++nextId, port, mode: request.mode, targetBytes: request.targetBytes, metadata, phase: 'starting', received: 0, index: 0 };
        jobs.set(job.id, job);
        if (job.mode === 'video') activeVideo = job;
        void (async () => {
          const stored = await api.storage.local.get('settings');
          if (job.cancelled || job.ended) return;
          const settings = normalizeSettings(stored.settings);
          if (!settings.enabled || (job.mode === 'video' && !settings.videoEnabled)) throw new Error('Compression is disabled. Attach the file again after choosing your settings.');
          await ensureDocument();
          if (job.cancelled || job.ended) { closeWhenIdle(); return; }
          job.sent = true;
          post(bridge, { type: 'start', job: job.id, mode: job.mode, file: metadata, targetBytes: job.targetBytes, gifEnabled: settings.videoGifEnabled });
        })().catch((error) => fail(job, error.message));
        return;
      }
      if (job.ended || job.cancelled) return;
      if (request.type === 'input-chunk') {
        if (job.phase !== 'input' || job.inputPending) throw new Error('Unexpected input chunk.');
        const bytes = validateChunk(request, job.index, job.metadata.size - job.received);
        job.inputPending = { index: request.index, bytes };
      } else if (request.type === 'input-end') {
        if (job.phase !== 'input' || job.inputPending || job.received !== job.metadata.size) throw new Error('The file transfer was incomplete.');
        job.phase = 'encoding';
      } else if (request.type === 'output-ready') {
        if (job.phase !== 'output-start') throw new Error('Unexpected output acknowledgment.');
        job.phase = 'output';
      } else if (request.type === 'output-ack') {
        if (job.phase !== 'output' || !job.outputPending || request.index !== job.outputPending.index) throw new Error('Invalid output acknowledgment.');
        job.outputReceived += job.outputPending.bytes;
        job.outputIndex++;
        job.outputPending = null;
      } else throw new Error('Invalid compression transfer message.');
      // Explicit fields only: a content-script message cannot choose another job
      // or provide encoder settings, paths, URLs, or worker options.
      const payload = request.type === 'input-chunk'
        ? { type: request.type, index: request.index, bytes: request.bytes, data: request.data }
        : { type: request.type, ...(request.type === 'output-ack' ? { index: request.index } : {}) };
      post(bridge, { ...payload, job: job.id });
    } catch (error) {
      if (job) fail(job, error.message);
      else { try { post(port, { type: 'error', message: error.message }); } catch { /* Caller left. */ } }
    }
  });
});
