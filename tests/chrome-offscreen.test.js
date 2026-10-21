import test from 'node:test';
import assert from 'node:assert/strict';

class Event {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}
const workers = [];
const messages = [];
let respond;
const port = {
  onMessage: new Event(), onDisconnect: new Event(),
  postMessage(message) { messages.push(message); respond?.(message); },
};
globalThis.chrome = { runtime: { connect: () => port, getURL: (path) => `chrome-extension://test/${path}` } };
globalThis.Worker = class {
  constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
  postMessage(message) { this.input = message; }
  terminate() { this.terminated = true; }
};
await import('../src/chrome-offscreen.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const start = (job) => ({ type: 'start', job, mode: 'image', targetBytes: 100, file: { name: 'x.png', type: 'image/png', size: 2, lastModified: 123 } });
const chunk = (job) => ({ type: 'input-chunk', job, index: 0, bytes: 2, data: 'AQI=' });

test('Offscreen runner creates image workers only after complete validated input', async () => {
  port.onMessage.emit(start(1));
  assert.equal(workers.length, 0);
  port.onMessage.emit(chunk(1));
  port.onMessage.emit({ type: 'input-end', job: 1 });
  const worker = workers.at(-1);
  assert.ok(worker.input.file instanceof File);
  assert.equal(worker.input.file.lastModified, 123);
  assert.deepEqual(new Uint8Array(await worker.input.file.arrayBuffer()), Uint8Array.of(1, 2));
  respond = (message) => {
    if (message.type === 'output-start') queueMicrotask(() => port.onMessage.emit({ type: 'output-ready', job: 1 }));
    if (message.type === 'output-chunk') queueMicrotask(() => port.onMessage.emit({ type: 'output-ack', job: 1, index: message.index }));
  };
  worker.onmessage({ data: { type: 'result', file: new File([Uint8Array.of(3, 4)], 'x.webp', { type: 'image/webp', lastModified: 123 }) } });
  await tick();
  assert.equal(worker.terminated, true);
  assert.equal(messages.find((message) => message.type === 'output-start').file.type, 'image/webp');
  assert.deepEqual(messages.filter((message) => message.job === 1).slice(-2).map(({ type }) => type), ['output-end', 'completed']);
  respond = undefined;
});

test('Offscreen abort acknowledges only after terminating the worker', async () => {
  port.onMessage.emit(start(2));
  port.onMessage.emit(chunk(2));
  port.onMessage.emit({ type: 'input-end', job: 2 });
  const worker = workers.at(-1);
  respond = (message) => {
    if (message.type === 'cancelled') assert.equal(worker.terminated, true);
  };
  port.onMessage.emit({ type: 'cancel', job: 2 });
  await tick();
  assert.equal(worker.terminated, true);
  const count = messages.length;
  worker.onmessage({ data: { type: 'result', file: new File(['late'], 'late.webp', { type: 'image/webp' }) } });
  port.onMessage.emit(chunk(2));
  await tick();
  assert.equal(messages.length, count, 'cancelled job cannot send late results or acknowledge more input');
  respond = undefined;
});

test('Offscreen cancellation during transfer and disconnect never leaves a worker running', async () => {
  const previous = workers.length;
  port.onMessage.emit(start(3));
  port.onMessage.emit({ type: 'cancel', job: 3 });
  port.onMessage.emit(chunk(3));
  port.onMessage.emit({ type: 'input-end', job: 3 });
  assert.equal(workers.length, previous);
  port.onMessage.emit(start(4));
  port.onMessage.emit(chunk(4));
  port.onMessage.emit({ type: 'input-end', job: 4 });
  const worker = workers.at(-1);
  port.onDisconnect.emit();
  await tick();
  assert.equal(worker.terminated, true);
});
