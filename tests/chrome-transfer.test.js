import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_BYTES, MAX_IMAGE_BYTES, MAX_OUTPUT_BYTES, ChunkReceiver, encodeChunk, decodeChunk, fileMetadata, streamFile, validateMetadata, validateStart } from '../src/chrome-transfer.js';

const metadata = (size) => ({ name: 'hello.gif', type: 'image/gif', size, lastModified: 1234567 });

test('Chrome transfer uses bounded canonical base64 and preserves native File metadata', async () => {
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 2 + 7 }, (_, i) => i % 256);
  const input = new File([bytes], 'hello.gif', { type: 'image/gif', lastModified: 1234567 });
  const receiver = new ChunkReceiver(fileMetadata(input), MAX_IMAGE_BYTES);
  let index = 0;
  await streamFile(input, async (chunk) => {
    assert.equal(chunk.index, index++);
    assert.ok(chunk.data.length <= Math.ceil(CHUNK_BYTES / 3) * 4);
    assert.equal(JSON.stringify(chunk).length < 400_000, true);
    receiver.push(JSON.parse(JSON.stringify(chunk)));
  });
  const output = receiver.finish();
  assert.ok(output instanceof File);
  assert.deepEqual(fileMetadata(output), fileMetadata(input));
  assert.deepEqual(new Uint8Array(await output.arrayBuffer()), bytes);
  assert.equal(receiver.parts.length, 0);
});

test('Chrome transfer rejects reordered, duplicate, truncated, oversized, and noncanonical chunks', () => {
  const receiver = new ChunkReceiver(metadata(2), MAX_IMAGE_BYTES);
  const chunk = { index: 0, bytes: 2, data: encodeChunk(Uint8Array.of(1, 2)) };
  assert.throws(() => receiver.push({ ...chunk, index: 1 }), /out-of-order/);
  assert.throws(() => receiver.push({ ...chunk, bytes: 3 }), /out-of-order/);
  assert.throws(() => receiver.push({ ...chunk, data: 'AQI' }), /out-of-order/);
  assert.throws(() => receiver.push({ ...chunk, data: 'AQI!' }), /out-of-order/);
  assert.throws(() => receiver.push({ ...chunk, data: 'AQJ=' }), /Invalid transfer bytes/);
  assert.throws(() => receiver.finish(), /incomplete/);
  receiver.push(chunk);
  assert.throws(() => receiver.push(chunk), /out-of-order/);
  assert.equal(receiver.finish().size, 2);
  assert.throws(() => encodeChunk(new Uint8Array(CHUNK_BYTES + 1)), /Invalid transfer chunk/);
  assert.deepEqual(decodeChunk({ index: 0, bytes: 1, data: '/w==' }, 0, 1), Uint8Array.of(255));
});

test('Chrome transfer validates exact per-mode and output size limits before allocating buffers', () => {
  assert.equal(validateStart({ mode: 'image', targetBytes: 1, file: metadata(MAX_IMAGE_BYTES) }).size, MAX_IMAGE_BYTES);
  assert.throws(() => validateStart({ mode: 'image', targetBytes: 1, file: metadata(MAX_IMAGE_BYTES + 1) }));
  assert.equal(validateStart({ mode: 'video', targetBytes: MAX_OUTPUT_BYTES, file: metadata(200_000_000) }).size, 200_000_000);
  assert.throws(() => validateStart({ mode: 'video', targetBytes: 1, file: metadata(200_000_001) }));
  for (const targetBytes of [0, -1, MAX_OUTPUT_BYTES + 1, 1.5, Infinity]) assert.throws(() => validateStart({ mode: 'image', targetBytes, file: metadata(1) }));
  for (const size of [0, -1, Infinity, 1.5]) assert.throws(() => validateMetadata(metadata(size), MAX_IMAGE_BYTES));
  assert.throws(() => validateMetadata({ ...metadata(1), name: 'x'.repeat(1025) }, MAX_IMAGE_BYTES));
  assert.throws(() => validateMetadata({ ...metadata(1), lastModified: -1 }, MAX_IMAGE_BYTES));
  assert.throws(() => validateMetadata({ ...metadata(1), type: 'image/gif\ntext/html' }, MAX_IMAGE_BYTES));
});

test('Chrome transfer waits for each acknowledgement before reading the next slice', async () => {
  let reads = 0, acknowledge;
  const fakeFile = {
    size: CHUNK_BYTES + 1,
    slice(start, end) {
      reads++;
      return new Blob([new Uint8Array(Math.min(end, this.size) - start)]);
    },
  };
  const streaming = streamFile(fakeFile, () => new Promise((resolve) => { acknowledge = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  acknowledge();
  await streaming;
});

test('Chrome transfer cancellation during an asynchronous Blob read sends no bytes', async () => {
  let finishRead, sends = 0;
  const controller = new AbortController();
  const file = { size: 1, slice: () => ({ arrayBuffer: () => new Promise((resolve) => { finishRead = resolve; }) }) };
  const streaming = streamFile(file, async () => { sends++; }, controller.signal);
  controller.abort();
  finishRead(new Uint8Array([1]).buffer);
  await assert.rejects(streaming, { name: 'AbortError' });
  assert.equal(sends, 0);
});

test('Chrome transfer cancellation after acknowledgement prevents another slice', async () => {
  const controller = new AbortController();
  let sends = 0;
  await assert.rejects(streamFile(new Blob([new Uint8Array(CHUNK_BYTES + 1)]), async () => {
    sends++;
    controller.abort();
  }, controller.signal), { name: 'AbortError' });
  assert.equal(sends, 1);
});
