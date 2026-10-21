import { api } from './settings.js';
import { CLIENT_PORT, MAX_OUTPUT_BYTES, ChunkReceiver, abortError, fileMetadata, streamFile, validateStart } from './chrome-transfer.js';

export function compressInChrome(file, targetBytes, signal, onProgress, mode = 'image') {
  return new Promise((resolve, reject) => {
    let port, timer, heartbeat, receiver, pending;
    let settled = false;
    const controller = new AbortController();
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      controller.abort(error);
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      receiver?.clear();
      pending?.reject(error || new Error('Transfer finished.'));
      pending = null;
      try { port?.disconnect(); } catch { /* Already disconnected. */ }
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => done(abortError(signal));
    const waitFor = (message, type, index) => new Promise((accept, fail) => {
      if (settled) return fail(abortError(controller.signal));
      if (pending) return fail(new Error('A transfer acknowledgment is already pending.'));
      pending = { type, index, resolve: accept, reject: fail };
      try { port.postMessage(message); }
      catch (error) { pending = null; fail(error); }
    });
    if (signal?.aborted) return abort();
    try {
      const request = { type: 'start', file: fileMetadata(file), targetBytes, mode };
      validateStart(request);
      port = api.runtime.connect({ name: CLIENT_PORT });
      port.onMessage.addListener((message) => {
        if (settled) return;
        try {
          if (message?.type === 'error') return done(new Error(message.message || 'Compression failed.'));
          if (message?.type === 'progress') {
            if (typeof message.message === 'string') onProgress?.(message.message);
            return;
          }
          if (message?.type === 'output-start') {
            if (receiver) throw new Error('Duplicate compression output.');
            receiver = new ChunkReceiver(message.file, Math.min(targetBytes, MAX_OUTPUT_BYTES));
            port.postMessage({ type: 'output-ready' });
            return;
          }
          if (message?.type === 'output-chunk') {
            if (!receiver) throw new Error('Unexpected compression output.');
            receiver.push(message);
            port.postMessage({ type: 'output-ack', index: message.index });
            return;
          }
          if (message?.type === 'output-end') {
            if (!receiver) throw new Error('Missing compression output.');
            return done(null, receiver.finish());
          }
          if (pending && message?.type === pending.type && message.index === pending.index) {
            const current = pending;
            pending = null;
            current.resolve();
            return;
          }
          throw new Error('Unexpected compression transfer acknowledgment.');
        } catch (error) { done(error); }
      });
      port.onDisconnect.addListener(() => {
        // Reading lastError inside this listener also acknowledges Chrome errors.
        const error = api.runtime.lastError;
        done(new Error(error?.message || 'The compression connection closed. Refresh Discord and try again.'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => done(new Error(mode === 'video'
        ? 'Video processing took too long. Try a shorter or lower-resolution clip.'
        : 'Compression took too long. Try a smaller picture or shorter GIF.')), mode === 'video' ? 605_000 : 180_000);
      heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'keepalive' }); }
        catch (error) { done(error); }
      }, 1000);
      void (async () => {
        await waitFor(request, 'ready');
        await streamFile(file, (chunk) => waitFor({ type: 'input-chunk', ...chunk }, 'input-ack', chunk.index), controller.signal);
        if (!settled) port.postMessage({ type: 'input-end' });
      })().catch(done);
      if (signal?.aborted) abort();
    } catch (error) { done(error); }
  });
}
