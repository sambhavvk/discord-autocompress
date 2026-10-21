import test from 'node:test';
import assert from 'node:assert/strict';
import gifenc from 'gifenc';
import { compressFile, inspectImage, preflightGif, MAX_INPUT_BYTES } from '../src/compression.js';
import { createGifCompositor, gifDelayMs, gifDelayParts, gifTimeline } from '../src/gif.js';

const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
const frame = (index, left, disposalType = 1, extra = {}) => ({
  dims: { left, top: 0, width: 1, height: 1 },
  pixels: [index], colorTable: palette, disposalType, ...extra,
});

test('GIF restore-to-background clears only the disposed frame rectangle', () => {
  const compositor = createGifCompositor(3, 1);
  compositor.draw(frame(0, 0));
  compositor.draw(frame(1, 1, 2));
  compositor.draw(frame(2, 2));
  assert.deepEqual([...compositor.pixels], [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
});

test('GIF restore-to-previous restores the canvas before drawing a disposal-3 frame', () => {
  const compositor = createGifCompositor(3, 1);
  compositor.draw(frame(0, 0));
  compositor.draw(frame(1, 0, 3));
  compositor.draw(frame(2, 2));
  assert.deepEqual([...compositor.pixels], [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
});

test('GIF transparent indices leave earlier pixels visible', () => {
  const compositor = createGifCompositor(1, 1);
  compositor.draw(frame(0, 0));
  compositor.draw(frame(1, 0, 1, { transparentIndex: 1 }));
  assert.deepEqual([...compositor.pixels], [255, 0, 0, 255]);
});

test('GIF opaque disposal background and consecutive restore-previous frames work', () => {
  const background = [255, 255, 255, 255];
  const compositor = createGifCompositor(2, 1, background);
  compositor.draw(frame(0, 0, 2), background);
  compositor.draw(frame(1, 1, 3));
  compositor.draw(frame(2, 0, 3));
  compositor.draw(frame(0, 1));
  assert.deepEqual([...compositor.pixels], [255, 255, 255, 255, 255, 0, 0, 255]);
});

test('GIF delays match browser zero/one-centisecond handling', () => {
  assert.deepEqual([0, 1, 2, 10, 65535].map(gifDelayMs), [100, 100, 20, 100, 655350]);
});

test('merged long GIF delays split without overflow or browser-clamped 10 ms tails', () => {
  assert.deepEqual(gifDelayParts(655_360), [655_340, 20]);
  const parts = gifDelayParts(1_310_710);
  assert.equal(parts.reduce((sum, delay) => sum + delay, 0), 1_310_710);
  assert.ok(parts.every((delay) => delay >= 20 && delay <= 655_350));
});

test('GIF frame dropping retains the complete duration and at least two frames', () => {
  const delays = [20, 30, 40, 50, 60];
  const timeline = gifTimeline(delays, 3);
  assert.deepEqual(timeline, [{ index: 0, delayMs: 90 }, { index: 3, delayMs: 110 }]);
  assert.equal(timeline.reduce((sum, item) => sum + item.delayMs, 0), 200);
  assert.deepEqual(gifTimeline(delays, 100), [{ index: 0, delayMs: 140 }, { index: 4, delayMs: 60 }]);
  assert.deepEqual(gifTimeline([100]), [{ index: 0, delayMs: 100 }]);
});

test('under-limit files retain the exact original object without browser APIs', async () => {
  const file = new File(['original image bytes'], 'SPOILER_picture.png', { type: 'image/png' });
  assert.equal(await compressFile(file, { targetBytes: file.size }), file);
});

test('invalid limits and inputs fail with useful errors', async () => {
  const file = new File(['x'], 'x.png');
  await assert.rejects(compressFile(file, { targetBytes: 0 }), /valid upload limit/);
  await assert.rejects(compressFile(file, { targetBytes: 1.1 }), /valid upload limit/);
  await assert.rejects(compressFile(new File([], 'empty.png'), { targetBytes: 1 }), /nonempty/);
  await assert.rejects(compressFile({ size: MAX_INPUT_BYTES + 1, arrayBuffer() { throw new Error('must not read'); } }, { targetBytes: 1 }), /128 MiB/);
});

function gifFixture(width = 2, height = 1) {
  const encoder = gifenc.GIFEncoder();
  encoder.writeFrame(new Uint8Array(width * height), width, height, { palette, delay: 50, repeat: 3 });
  encoder.writeFrame(new Uint8Array(width * height).fill(1), width, height, { palette, delay: 200, repeat: 3 });
  encoder.finish();
  return encoder.bytes();
}

test('GIF preflight counts real frames and rejects truncation before decoding', () => {
  const bytes = gifFixture();
  assert.equal(preflightGif(bytes), 2);
  assert.equal(inspectImage(bytes).format, 'gif');
  assert.throws(() => preflightGif(bytes.subarray(0, bytes.length - 1)), /damaged/);
});

test('GIF preflight rejects unknown extension labels that stall gifuct-js', () => {
  const original = gifFixture();
  const malicious = new Uint8Array(original.length + 3);
  malicious.set(original.subarray(0, 13));
  // Insert after the global color table (the palette is padded to four colors).
  const offset = 13 + 12;
  malicious.set(original.subarray(13, offset), 13);
  malicious.set([0x21, 0xee, 0], offset);
  malicious.set(original.subarray(offset), offset + 3);
  assert.throws(() => preflightGif(malicious), /unsupported extension/);
});

test('GIF preflight rejects huge logical screens and frames outside their screen', () => {
  const bytes = gifFixture();
  const oversized = bytes.slice();
  oversized[6] = 0xff; oversized[7] = 0xff;
  assert.throws(() => preflightGif(oversized), /too large/);
  const offscreen = bytes.slice();
  const imageOffset = offscreen.indexOf(0x2c);
  offscreen[imageOffset + 1] = 2;
  assert.throws(() => preflightGif(offscreen), /damaged/);
});

test('animated WebP is recognized before decoding', () => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true); view.setUint32(16, 10, true);
  bytes[20] = 2; bytes[24] = 9; bytes[27] = 4;
  assert.deepEqual(inspectImage(bytes), { format: 'webp', width: 10, height: 5, animated: true });
});

test('APNG animation control chunks are recognized', () => {
  const bytes = new Uint8Array(65);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, 8); view.setUint32(20, 9);
  view.setUint32(33, 8); bytes.set(new TextEncoder().encode('acTL'), 37);
  view.setUint32(53, 0); bytes.set(new TextEncoder().encode('IEND'), 57);
  assert.deepEqual(inspectImage(bytes), { format: 'png', width: 8, height: 9, animated: true });
});

test('AVIF sequence brand is recognized without flattening', () => {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, 20);
  bytes.set(new TextEncoder().encode('ftypavis'), 4);
  bytes.set(new TextEncoder().encode('avif'), 16);
  assert.equal(inspectImage(bytes).animated, true);
});
