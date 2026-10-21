import { compressVideo } from './video.js';
import { isVideo } from './settings.js';
import { OFFSCREEN_PORT, MAX_OUTPUT_BYTES, ChunkReceiver, fileMetadata, streamFile, validateStart, validateMetadata } from './chrome-transfer.js';

// Only runtime is available here. Settings are read and normalized by the
// service worker, then forwarded with each authenticated request.
const runtime = globalThis.chrome.runtime;
const port = runtime.connect({ name: OFFSCREEN_PORT });
const jobs = new Map();
let activeVideo = null;
let disconnected = false;

function send(message) { if (!disconnected) port.postMessage(message); }
function dispose(job) {
  clearTimeout(job.timer);
  job.receiver?.clear();
  job.receiver = null;
  job.worker?.terminate();
  job.worker = null;
  if (activeVideo === job) activeVideo = null;
  jobs.delete(job.id);
}
function cancel(job, message = 'Compression cancelled.') {
  if (job.cancelled) return;
  job.cancelled = true;
  // FFmpeg's abort listener terminates its Worker synchronously. Images own a
  // dedicated Worker too. Acknowledge only after both have been stopped.
  job.controller.abort(new DOMException(message, 'AbortError'));
  job.worker?.terminate();
  job.rejectEncoding?.(new Error(message));
  job.pending?.reject(new Error(message));
  job.pending = null;
  dispose(job);
  send({ type: 'cancelled', job: job.id });
}
function fail(job, error) {
  if (job.cancelled || !jobs.has(job.id)) return;
  send({ type: 'error', job: job.id, message: error instanceof Error ? error.message : 'Compression failed.' });
  cancel(job);
}
function waitFor(job, message, type, index) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Compression cancelled.'));
    if (job.pending) return reject(new Error('A transfer acknowledgment is already pending.'));
    job.pending = { type, index, resolve, reject };
    try { send({ ...message, job: job.id }); }
    catch (error) { job.pending = null; reject(error); }
  });
}
function compressImage(job, file) {
  return new Promise((resolve, reject) => {
    job.rejectEncoding = reject;
    const worker = new Worker(runtime.getURL('compression.worker.js'), { type: 'module' });
    job.worker = worker;
    worker.onmessage = ({ data }) => {
      if (job.cancelled) return;
      if (data?.type === 'progress') send({ type: 'progress', job: job.id, message: data.message });
      else if (data?.type === 'result') resolve(data.file);
      else if (data?.type === 'error') reject(new Error(data.message || 'Image compression failed.'));
    };
    worker.onerror = () => reject(new Error('Compression failed unexpectedly. Try another image or refresh Discord.'));
    worker.onmessageerror = () => reject(new Error('Compression could not read the image worker response.'));
    worker.postMessage({ id: 1, file, targetBytes: job.targetBytes });
  }).finally(() => {
    job.worker?.terminate();
    job.worker = null;
    job.rejectEncoding = null;
  });
}
async function encode(job, file) {
  try {
    const result = job.mode === 'video' ? await compressVideo(file, {
      targetBytes: job.targetBytes,
      gifEnabled: job.gifEnabled,
      baseURL: runtime.getURL('ffmpeg/'),
      signal: job.controller.signal,
      onProgress: ({ message }) => {
        if (!job.cancelled) send({ type: 'progress', job: job.id, message });
      },
    }) : await compressImage(job, file);
    if (job.cancelled) return;
    if (!(result instanceof Blob)) throw new Error('Compression did not produce a file.');
    const metadata = validateMetadata(fileMetadata(result), Math.min(job.targetBytes, MAX_OUTPUT_BYTES));
    await waitFor(job, { type: 'output-start', file: metadata }, 'output-ready');
    await streamFile(result, (chunk) => waitFor(job, { type: 'output-chunk', ...chunk }, 'output-ack', chunk.index), job.controller.signal);
    if (job.cancelled) return;
    dispose(job);
    send({ type: 'output-end', job: job.id });
    send({ type: 'completed', job: job.id });
  } catch (error) { fail(job, error); }
}

port.onMessage.addListener((message) => {
  let job = jobs.get(message?.job);
  try {
    if (!Number.isSafeInteger(message?.job) || message.job < 1) throw new Error('Invalid compression job.');
    if (message.type === 'cancel') {
      if (job) cancel(job);
      else send({ type: 'cancelled', job: message.job });
      return;
    }
    if (message.type === 'start') {
      if (job) throw new Error('Duplicate compression job.');
      const metadata = validateStart(message);
      if (message.mode === 'video' && (!isVideo(metadata) || activeVideo)) throw new Error('Another video is already being processed or the file type is unsupported.');
      job = {
        id: message.job, mode: message.mode, targetBytes: message.targetBytes,
        gifEnabled: message.gifEnabled === true, controller: new AbortController(),
        receiver: new ChunkReceiver(metadata, message.mode === 'video' ? 200_000_000 : 128 * 1024 * 1024),
      };
      jobs.set(job.id, job);
      if (job.mode === 'video') activeVideo = job;
      job.timer = setTimeout(() => fail(job, new Error('Compression took too long. Try a smaller file.')), job.mode === 'video' ? 605_000 : 180_000);
      send({ type: 'ready', job: job.id });
      return;
    }
    if (!job || job.cancelled) return;
    if (message.type === 'input-chunk') {
      if (!job.receiver) throw new Error('Unexpected input chunk.');
      job.receiver.push(message);
      send({ type: 'input-ack', index: message.index, job: job.id });
    } else if (message.type === 'input-end') {
      if (!job.receiver) throw new Error('Duplicate file transfer.');
      const file = job.receiver.finish();
      job.receiver = null;
      void encode(job, file);
    } else if (job.pending && message.type === job.pending.type && message.index === job.pending.index) {
      const pending = job.pending;
      job.pending = null;
      pending.resolve();
    } else throw new Error('Unexpected compression transfer acknowledgment.');
  } catch (error) {
    if (job) fail(job, error);
    else send({ type: 'error', job: message?.job, message: error.message });
  }
});
port.onDisconnect.addListener(() => {
  // Consume lastError when Chrome reports an interrupted extension connection.
  void runtime.lastError;
  disconnected = true;
  for (const job of jobs.values()) cancel(job);
});
