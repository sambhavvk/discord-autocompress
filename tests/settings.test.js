import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, getTargetBytes, isCompressible, isVideo } from '../src/settings.js';

test('defaults, invalid settings and limit boundary are safe', () => {
  assert.deepEqual(normalizeSettings(null), { enabled: true, videoEnabled: false, videoGifEnabled: false, targetMB: 20 });
  assert.deepEqual(normalizeSettings({ enabled: false, targetMB: '5' }), { enabled: false, videoEnabled: false, videoGifEnabled: false, targetMB: 5 });
  assert.equal(normalizeSettings({ videoEnabled: true }).videoEnabled, true);
  assert.equal(normalizeSettings({ videoEnabled: 'true' }).videoEnabled, false);
  assert.equal(normalizeSettings({ videoGifEnabled: true }).videoGifEnabled, true);
  assert.equal(normalizeSettings({ videoGifEnabled: 'true' }).videoGifEnabled, false);
  assert.equal(normalizeSettings({ videoGifEnabled: 1 }).videoGifEnabled, false);
  assert.equal(normalizeSettings({ videoGifEnabled: null }).videoGifEnabled, false);
  assert.equal(getTargetBytes({ targetMB: 20 }), 19_800_000);
  assert.equal(getTargetBytes({ targetMB: 100 }), 19_800_000);
  assert.equal(getTargetBytes({ targetMB: -1 }), 990_000);
  assert.equal(getTargetBytes({ targetMB: NaN }), 19_800_000);
});

test('recognizes clipboard images and images without MIME hints, excluding videos', () => {
  assert.equal(isCompressible({ name: 'SPOILER_photo.GIF', type: '' }), true);
  assert.equal(isCompressible({ name: 'image', type: 'image/png' }), true);
  assert.equal(isCompressible({ name: 'animation.apng', type: 'image/apng' }), true);
  assert.equal(isCompressible({ name: 'movie.mp4', type: 'video/mp4' }), false);
  assert.equal(isVideo({ name: 'SPOILER_clip.MP4', type: '' }), true);
  assert.equal(isVideo({ name: 'clipboard', type: 'video/webm' }), true);
  assert.equal(isVideo({ name: 'clipboard', type: 'application/x-matroska' }), true);
  assert.equal(isVideo({ name: 'photo.webp', type: 'image/webp' }), false);
});
