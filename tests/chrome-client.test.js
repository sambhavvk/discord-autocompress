import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_BYTES, encodeChunk } from '../src/chrome-transfer.js';

class Event {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}
let port;
globalThis.chrome = { runtime: { connect() {
  port = { onMessage: new Event(), onDisconnect: new Event(), messages: [], disconnected: false,
    postMessage(message) { this.messages.push(message); this.respond?.(message); },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
  };
  return port;
} } };
const { compressInChrome } = await import('../src/chrome-client.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const image = () => new File([new Uint8Array(CHUNK_BYTES + 1)], 'original.gif', { type: 'image/gif', lastModified: 123 });

test('Chrome client transfers sequential chunks and reconstructs a native File result', async () => {
  const progress = [];
  const promise = compressInChrome(image(), 100, new AbortController().signal, (message) => progress.push(message));
  port.respond = (message) => {
    if (message.type === 'input-chunk') queueMicrotask(() => port.onMessage.emit({ type: 'input-ack', index: message.index }));
    if (message.type === 'input-end') queueMicrotask(() => {
      port.onMessage.emit({ type: 'progress', message: 'GIF ready.' });
      port.onMessage.emit({ type: 'output-start', file: { name: 'original.gif', type: 'image/gif', size: 2, lastModified: 123 } });
    });
    if (message.type === 'output-ready') queueMicrotask(() => port.onMessage.emit({ type: 'output-chunk', index: 0, bytes: 2, data: encodeChunk(Uint8Array.of(1, 2)) }));
    if (message.type === 'output-ack') queueMicrotask(() => port.onMessage.emit({ type: 'output-end' }));
  };
  port.onMessage.emit({ type: 'ready' });
  const result = await promise;
  assert.ok(result instanceof File);
  assert.equal(result.name, 'original.gif');
  assert.equal(result.type, 'image/gif');
  assert.equal(result.lastModified, 123);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), Uint8Array.of(1, 2));
  assert.deepEqual(progress, ['GIF ready.']);
  assert.equal(port.disconnected, true);
  assert.deepEqual(port.messages.filter((message) => message.type === 'input-chunk').map(({ index, bytes }) => ({ index, bytes })), [{ index: 0, bytes: CHUNK_BYTES }, { index: 1, bytes: 1 }]);
});

test('Chrome client cancellation while awaiting readiness closes its captured connection', async () => {
  const controller = new AbortController();
  const promise = compressInChrome(image(), 100, controller.signal, () => {});
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(port.disconnected, true);
  port.onMessage.emit({ type: 'ready' });
  await tick();
  assert.equal(port.messages.length, 1);
});

test('Chrome client cancellation while reading a Blob never sends the unfinished chunk', async () => {
  let finishRead;
  const controller = new AbortController();
  const file = { name: 'image.png', type: 'image/png', size: 2, lastModified: 123,
    slice() { return { arrayBuffer: () => new Promise((resolve) => { finishRead = resolve; }) }; },
  };
  const promise = compressInChrome(file, 100, controller.signal, () => {});
  port.onMessage.emit({ type: 'ready' });
  await tick();
  controller.abort();
  finishRead(new Uint8Array([1, 2]).buffer);
  await assert.rejects(promise, { name: 'AbortError' });
  await tick();
  assert.equal(port.messages.some((message) => message.type === 'input-chunk'), false);
});

test('Chrome client rejects oversized or incomplete output and closes the job', async () => {
  let promise = compressInChrome(image(), 100, new AbortController().signal, () => {});
  port.onMessage.emit({ type: 'output-start', file: { name: 'bad.gif', type: 'image/gif', size: 101, lastModified: 123 } });
  await assert.rejects(promise, /Invalid file metadata/);
  assert.equal(port.disconnected, true);
  promise = compressInChrome(image(), 100, new AbortController().signal, () => {});
  port.onMessage.emit({ type: 'output-start', file: { name: 'bad.gif', type: 'image/gif', size: 2, lastModified: 123 } });
  port.onMessage.emit({ type: 'output-end' });
  await assert.rejects(promise, /incomplete/);
});

test('Chrome client reports connection failures and rejects already aborted jobs without connecting', async () => {
  let promise = compressInChrome(image(), 100, new AbortController().signal, () => {});
  globalThis.chrome.runtime.lastError = { message: 'Service worker stopped.' };
  port.onDisconnect.emit();
  await assert.rejects(promise, /Service worker stopped/);
  delete globalThis.chrome.runtime.lastError;
  const previous = port;
  const controller = new AbortController();
  controller.abort();
  promise = compressInChrome(image(), 100, controller.signal, () => {});
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(port, previous);
});
