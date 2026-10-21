import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_PORT, OFFSCREEN_PORT, encodeChunk } from '../src/chrome-transfer.js';

class Event {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}
function fakePort(name, sender) {
  return { name, sender, onMessage: new Event(), onDisconnect: new Event(), messages: [], disconnected: false,
    postMessage(message) { this.messages.push(message); this.respond?.(message); },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
  };
}
const extensionId = 'test-extension';
const sender = { id: extensionId, tab: { id: 1 }, url: 'https://discord.com/channels/@me' };
let contexts = [], offscreen, creates = 0, closes = 0;
const runtime = {
  id: extensionId, onConnect: new Event(), getURL: (path) => `chrome-extension://${extensionId}/${path}`,
  getManifest: () => ({ content_scripts: [{ matches: ['https://discord.com/*', 'https://canary.discord.com/*', 'http://127.0.0.1/*'] }] }),
  getContexts: async () => contexts,
};
globalThis.chrome = {
  runtime, storage: { local: { get: async () => ({ settings: { enabled: true, videoEnabled: true, videoGifEnabled: true } }) } },
  offscreen: {
    async createDocument(options) {
      creates++;
      assert.deepEqual(options.reasons, ['WORKERS', 'BLOBS']);
      contexts = [{}];
      offscreen = fakePort(OFFSCREEN_PORT, { id: extensionId, url: runtime.getURL('chrome-offscreen.html') });
      offscreen.respond = (message) => {
        if (message.type === 'start') queueMicrotask(() => offscreen.onMessage.emit({ type: 'ready', job: message.job }));
      };
      runtime.onConnect.emit(offscreen);
    },
    async closeDocument() {
      closes++;
      contexts = [];
      offscreen?.disconnect();
    },
  },
};
const { allowedPage } = await import('../src/chrome-background.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const start = (mode = 'image') => ({ type: 'start', mode, targetBytes: 100, file: { name: mode === 'video' ? 'clip.mp4' : 'picture.png', type: mode === 'video' ? 'video/mp4' : 'image/png', size: 2, lastModified: 10 } });
function client() { const port = fakePort(CLIENT_PORT, sender); runtime.onConnect.emit(port); return port; }
function acknowledgeCancellation() {
  const cancel = offscreen.messages.findLast((message) => message.type === 'cancel');
  assert.ok(cancel);
  offscreen.onMessage.emit({ type: 'cancelled', job: cancel.job });
}

test('Chrome broker authorizes only extension content scripts on manifest origins', () => {
  assert.equal(allowedPage(sender), true);
  assert.equal(allowedPage({ ...sender, url: 'https://canary.discord.com/channels/123' }), true);
  assert.equal(allowedPage({ ...sender, url: 'http://127.0.0.1:12345/test' }), true);
  for (const bad of [undefined, { ...sender, id: 'another-extension' }, { ...sender, tab: undefined }, { ...sender, url: 'https://discord.com.attacker.test/' }, { ...sender, url: 'http://discord.com/' }, { ...sender, url: 'https://discord.com@attacker.test/' }]) assert.equal(allowedPage(bad), false);
  const attacker = fakePort(CLIENT_PORT, { ...sender, url: 'https://attacker.test/' });
  runtime.onConnect.emit(attacker);
  assert.equal(attacker.disconnected, true);
  const fakeBridge = fakePort(OFFSCREEN_PORT, { id: extensionId, url: runtime.getURL('popup.html') });
  runtime.onConnect.emit(fakeBridge);
  assert.equal(fakeBridge.disconnected, true);
});

test('Chrome broker serializes offscreen creation and requires downstream input ACKs', async () => {
  const before = creates;
  const a = client(), b = client();
  a.onMessage.emit(start());
  b.onMessage.emit(start());
  await tick();
  assert.equal(creates - before, 1);
  assert.equal(a.messages[0].type, 'ready');
  assert.equal(b.messages[0].type, 'ready');
  const job = offscreen.messages.find((message) => message.type === 'start').job;
  const chunk = { type: 'input-chunk', index: 0, bytes: 2, data: encodeChunk(Uint8Array.of(1, 2)), job: 999 };
  a.onMessage.emit(chunk);
  const relayed = offscreen.messages.at(-1);
  assert.equal(relayed.job, job, 'caller cannot select another client job');
  assert.equal(a.messages.some((message) => message.type === 'input-ack'), false);
  offscreen.onMessage.emit({ type: 'input-ack', job, index: 0 });
  assert.equal(a.messages.at(-1).type, 'input-ack');
  a.onMessage.emit({ type: 'input-end' });
  assert.equal(offscreen.messages.at(-1).type, 'input-end');
  a.disconnect();
  acknowledgeCancellation();
  b.disconnect();
  acknowledgeCancellation();
  await tick();
  assert.equal(contexts.length, 0);
});

test('Chrome broker holds global video slot until abort is acknowledged', async () => {
  const a = client();
  a.onMessage.emit(start('video'));
  await tick();
  assert.equal(a.messages[0].type, 'ready');
  const metadata = offscreen.messages.find((message) => message.type === 'start');
  assert.equal(metadata.gifEnabled, true, 'settings are forwarded by the service worker');
  a.disconnect();
  const b = client();
  b.onMessage.emit(start('video'));
  assert.match(b.messages[0].message, /Another video/);
  acknowledgeCancellation();
  const c = client();
  c.onMessage.emit(start('video'));
  await tick();
  assert.equal(c.messages[0].type, 'ready');
  c.disconnect();
  acknowledgeCancellation();
  await tick();
});

test('Chrome broker rejects transfer ordering errors and cancels the offscreen job', async () => {
  const a = client();
  a.onMessage.emit(start());
  await tick();
  a.onMessage.emit({ type: 'input-chunk', index: 1, bytes: 2, data: 'AQI=' });
  assert.match(a.messages.at(-1).message, /out-of-order/);
  assert.equal(offscreen.messages.at(-1).type, 'cancel');
  acknowledgeCancellation();
  await tick();
  assert.ok(closes > 0);
});

test('Chrome broker validates output bytes and acknowledgements before reporting completion', async () => {
  const a = client();
  a.onMessage.emit(start());
  await tick();
  const job = offscreen.messages.findLast((message) => message.type === 'start').job;
  a.onMessage.emit({ type: 'input-chunk', index: 0, bytes: 2, data: 'AQI=' });
  offscreen.onMessage.emit({ type: 'input-ack', job, index: 0 });
  a.onMessage.emit({ type: 'input-end' });
  offscreen.onMessage.emit({ type: 'output-start', job, file: { name: 'picture.webp', type: 'image/webp', size: 2, lastModified: 10 } });
  assert.equal(a.messages.at(-1).type, 'output-start');
  a.onMessage.emit({ type: 'output-ready' });
  offscreen.onMessage.emit({ type: 'output-chunk', job, index: 0, bytes: 2, data: 'AQI=' });
  assert.equal(a.messages.at(-1).type, 'output-chunk');
  a.onMessage.emit({ type: 'output-ack', index: 0 });
  offscreen.onMessage.emit({ type: 'output-end', job });
  assert.equal(a.messages.at(-1).type, 'output-end');
  offscreen.onMessage.emit({ type: 'completed', job });
  a.disconnect();
  await tick();
});
