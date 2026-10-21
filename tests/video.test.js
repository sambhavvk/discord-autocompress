import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_BYTES, VIDEO_TIMEOUT_MS, inputMetadata, createVideoPlan,
  videoCommand, validateVideoOutput,
  shouldConvertVideoToGif, createVideoGifPlan, videoGifCommand, validateVideoGifOutput,
} from '../src/video-policy.js';
import { createVideoCompressor, VIDEO_LOAD_TIMEOUT_MS } from '../src/video.js';

function metadata({ duration = 10, audio = true, video = {}, audioStream = {} } = {}) {
  return {
    format: { duration: String(duration) },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: String(duration), avg_frame_rate: '30/1', sample_aspect_ratio: '1:1', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', ...video },
      ...(audio ? [{ codec_type: 'audio', codec_name: 'aac', channels: 2, duration: String(duration), ...audioStream }] : []),
    ],
  };
}

function mockCore(config = {}) {
  const calls = { constructed: 0, loads: [], probes: [], encodes: [], writes: [], deletes: [], terminations: 0 };
  class Core {
    loaded = false;
    files = new Map();
    constructor() { calls.constructed++; }
    on() {}
    off() {}
    async load(options) {
      calls.loads.push(options);
      if (config.loading) return config.loading();
      this.loaded = true;
    }
    async writeFile(path, data) { calls.writes.push(path); this.files.set(path, data); }
    async ffprobe(args) {
      calls.probes.push(args);
      const input = args.at(-3);
      const value = input === 'input.bin' ? (config.source ?? metadata()) : (typeof config.output === 'function' ? config.output(calls.encodes.at(-1)) : config.output ?? metadata());
      this.files.set(args.at(-1), JSON.stringify(value));
      return config.probeCode ?? 0;
    }
    async exec(args) {
      calls.encodes.push(args);
      if (config.encoding) return config.encoding();
      const size = config.sizes?.[calls.encodes.length - 1] ?? 500_000;
      this.files.set(args.at(-1), new Uint8Array(size));
      return 0;
    }
    async readFile(path) { return this.files.get(path); }
    async deleteFile(path) {
      calls.deletes.push(path);
      if (config.deleting) return config.deleting(path);
      this.files.delete(path);
    }
    terminate() { calls.terminations++; this.loaded = false; this.files.clear(); }
  }
  return { calls, compress: createVideoCompressor(Core) };
}

const options = { targetBytes: 1_000_000, baseURL: 'moz-extension://test/ffmpeg/' };
const videoFile = (size = 2_000_000) => new File([new Uint8Array(size)], 'SPOILER_clip.webm', { type: 'video/webm', lastModified: 1234 });
const mp4File = (size = 2_000_000, name = 'SPOILER_clip.mp4', type = 'video/mp4') => new File([new Uint8Array(size)], name, { type, lastModified: 1234 });
const gifMetadata = (args, { duration = 10, frames = 120, audio = false, video = {} } = {}) => {
  const filter = args[args.indexOf('-filter_complex') + 1];
  const [, width, height] = filter.match(/scale=(\d+):(\d+)/);
  return metadata({ duration, audio, video: { codec_name: 'gif', width: Number(width), height: Number(height), nb_read_frames: String(frames), ...video } });
};

test('GIF opt-in is strict below 30 seconds and limited to MP4/Matroska/WebM extension or MIME', () => {
  for (const [name, type] of [
    ['clip.mp4', ''], ['SPOILER_clip.MKV', 'application/octet-stream'],
    ['clip', 'video/mp4'], ['clip', 'video/x-matroska'], ['clip', 'application/x-matroska'],
    ['clip.WEBM', ''], ['clip', 'video/webm'],
  ]) {
    const file = { name, type };
    assert.equal(shouldConvertVideoToGif(file, { duration: 29.999 }, true), true);
    assert.equal(shouldConvertVideoToGif(file, { duration: 30 }, true), false);
    assert.equal(shouldConvertVideoToGif(file, { duration: 31 }, true), false);
    assert.equal(shouldConvertVideoToGif(file, { duration: 10 }), false);
  }
  assert.equal(shouldConvertVideoToGif({ name: 'clip.mov', type: 'video/quicktime' }, { duration: 10 }, true), false);
});

test('GIF plans bound portrait dimensions, fps and palette and commands retain all video while dropping audio', () => {
  const source = inputMetadata(metadata({ video: { side_data_list: [{ rotation: -90 }] } }));
  const plans = [0, 1, 2].map((attempt) => createVideoGifPlan(source, attempt));
  assert.deepEqual(plans.map((plan) => Math.max(plan.width, plan.height)), [480, 360, 240]);
  assert.deepEqual(plans.map((plan) => plan.fps), [12, 9, 6]);
  assert.deepEqual(plans.map((plan) => plan.colors), [128, 96, 64]);
  for (const plan of plans) {
    assert.ok(Math.abs(plan.width / plan.height - 9 / 16) < 0.01);
    const args = videoGifCommand(plan);
    assert.ok(args.includes('-an'));
    assert.equal(args[args.indexOf('-loop') + 1], '0');
    assert.ok(args[args.indexOf('-filter_complex') + 1].includes('stats_mode=single'));
    assert.ok(args[args.indexOf('-filter_complex') + 1].includes('paletteuse=new=1'));
    for (const flag of ['-fs', '-t', '-shortest']) assert.equal(args.includes(flag), false);
  }
});

test('GIF conversion includes under-limit MP4, returns silent animated GIF MIME and preserves spoiler basename', async () => {
  const { compress, calls } = mockCore({ output: gifMetadata, probeCode: -1 });
  const result = await compress(mp4File(100), { ...options, gifEnabled: true });
  assert.equal(result.name, 'SPOILER_clip.gif');
  assert.equal(result.type, 'image/gif');
  assert.equal(result.lastModified, 1234);
  assert.equal(result.size, 500_000);
  assert.equal(calls.encodes.length, 1);
  assert.ok(calls.probes.find((args) => args.at(-3) === 'output.gif').includes('-count_frames'));
  assert.ok(calls.deletes.includes('output.gif'));
  assert.equal(calls.terminations, 1);
});

test('GIF opt-in keeps exactly 30 seconds, long MKVs, other formats and default MP4 on existing paths', async () => {
  for (const [file, duration, gifEnabled] of [
    [mp4File(100), 30, true], [mp4File(100, 'clip.mkv', ''), 31, true],
    [mp4File(100, 'clip.mov', 'video/quicktime'), 10, true], [mp4File(100), 10, false],
  ]) {
    const { compress, calls } = mockCore({ source: metadata({ duration }) });
    assert.equal(await compress(file, { ...options, gifEnabled }), file);
    assert.equal(calls.encodes.length, 0);
  }
  const { compress, calls } = mockCore({ source: metadata({ duration: 30 }), output: metadata({ duration: 30 }) });
  assert.equal((await compress(mp4File(), { ...options, gifEnabled: true })).type, 'video/mp4');
  assert.equal(calls.encodes[0].at(-1), 'output.mp4');
});

test('GIF oversize output retries decreasing dimensions/fps/palette with a strict byte cap', async () => {
  const { compress, calls } = mockCore({ sizes: [1_300_000, 1_100_000, 1_000_000], output: gifMetadata });
  assert.equal((await compress(mp4File(), { ...options, gifEnabled: true })).size, 1_000_000);
  assert.equal(calls.encodes.length, 3);
  const filters = calls.encodes.map((args) => args[args.indexOf('-filter_complex') + 1]);
  assert.ok(filters[0].includes('scale=480:270') && filters[0].includes('fps=12') && filters[0].includes('max_colors=128'));
  assert.ok(filters[2].includes('scale=240:135') && filters[2].includes('fps=6') && filters[2].includes('max_colors=64'));
  assert.equal(calls.deletes.filter((path) => path === 'output.gif').length, 3);
  const failed = mockCore({ sizes: [1_000_001, 1_000_001, 1_000_001], output: gifMetadata });
  await assert.rejects(failed.compress(mp4File(), { ...options, gifEnabled: true }), /GIF could not fit/);
  assert.equal(failed.calls.encodes.length, 3);
});

test('GIF validation requires correct codec, no audio, complete visual duration, dimensions and animation', () => {
  const source = inputMetadata(metadata());
  const plan = createVideoGifPlan(source);
  const args = videoGifCommand(plan);
  assert.equal(validateVideoGifOutput(source, gifMetadata(args), plan).videoCodec, 'gif');
  assert.throws(() => validateVideoGifOutput(source, gifMetadata(args, { audio: true }), plan), /silent GIF/);
  assert.throws(() => validateVideoGifOutput(source, gifMetadata(args, { video: { codec_name: 'h264' } }), plan), /silent GIF/);
  assert.throws(() => validateVideoGifOutput(source, gifMetadata(args, { duration: 9 }), plan), /full playback duration/);
  assert.throws(() => validateVideoGifOutput(source, gifMetadata(args, { frames: 1 }), plan), /animation/);
  assert.throws(() => validateVideoGifOutput(source, gifMetadata(args, { video: { width: 640 } }), plan), /dimensions/);
  const withLongerAudio = inputMetadata(metadata({ duration: 12, video: { duration: '10' } }));
  assert.equal(validateVideoGifOutput(withLongerAudio, gifMetadata(args), plan).duration, 10);
});

test('GIF cancellation terminates the same worker before output validation', async () => {
  const controller = new AbortController();
  const { compress, calls } = mockCore({ encoding() {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(compress(mp4File(100), { ...options, gifEnabled: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.encodes[0].at(-1), 'output.gif');
  assert.equal(calls.probes.length, 1);
  assert.ok(calls.terminations > 0);
});

test('video limits use exact decimal bytes and reject before reading or loading a core', async () => {
  assert.equal(MAX_VIDEO_BYTES, 200_000_000);
  assert.equal(VIDEO_TIMEOUT_MS, 600_000);
  const { compress, calls } = mockCore();
  let read = false;
  await assert.rejects(compress({ size: MAX_VIDEO_BYTES + 1, arrayBuffer() { read = true; } }, options), /200 MB/);
  assert.equal(read, false);
  assert.equal(calls.constructed, 0);
});

test('over-duration metadata is rejected even when the original fits the target', async () => {
  const { compress, calls } = mockCore({ source: metadata({ duration: 120.001 }) });
  await assert.rejects(compress(videoFile(100), options), /120 seconds/);
  assert.equal(calls.encodes.length, 0);
  assert.ok(calls.deletes.includes('input.bin'));
  assert.ok(calls.terminations > 0);
});

test('metadata at exactly 120s is valid, but invalid duration, missing video and unsafe frames fail', () => {
  assert.equal(inputMetadata(metadata({ duration: 120 })).duration, 120);
  assert.throws(() => inputMetadata(metadata({ duration: 'N/A' })), /duration/);
  assert.throws(() => inputMetadata({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }), /video track/);
  assert.throws(() => inputMetadata(metadata({ video: { width: 7680, height: 4320 } })), /4K/);
  assert.throws(() => inputMetadata(metadata({ video: { avg_frame_rate: '120/1' } })), /too many frames/);
  assert.throws(() => inputMetadata(metadata({ duration: 120, video: { width: 3840, height: 2160, avg_frame_rate: '60/1' } })), /decoded pixels/);
});

test('HDR, Dolby Vision and ambiguous high-bit-depth inputs fail before color damage', () => {
  for (const video of [
    { color_transfer: 'smpte2084' }, { color_transfer: 'arib-std-b67' },
    { color_primaries: 'bt2020' }, { side_data_list: [{ side_data_type: 'DOVI configuration record' }] },
    { pix_fmt: 'yuv420p10le', color_transfer: 'unknown' },
  ]) assert.throws(() => inputMetadata(metadata({ video })), /HDR|SDR|gamut/);
  assert.equal(inputMetadata(metadata({ video: { pix_fmt: 'yuv420p10le', color_transfer: 'bt709' } })).pixelFormat, 'yuv420p10le');
});

test('budget keeps audio, stays below 720p/30fps and preserves rotated display aspect', () => {
  const source = inputMetadata(metadata({ video: { side_data_list: [{ rotation: -90 }], avg_frame_rate: '60000/1001' } }));
  const plan = createVideoPlan(source, 2_000_000);
  assert.ok(plan.audioBitrate >= 96_000);
  assert.ok(plan.fps <= 30 && plan.width <= 720 && plan.height <= 1280);
  assert.equal(plan.width % 2, 0); assert.equal(plan.height % 2, 0);
  assert.ok(Math.abs(plan.width / plan.height - 9 / 16) < 0.01);
  const estimatedBytes = (plan.videoBitrate + plan.audioBitrate) * source.duration / 8;
  assert.ok(estimatedBytes < 2_000_000 * 0.94);
  assert.throws(() => createVideoPlan(source, 10_000), /too small.*audio/);
});

test('encoding maps first audio explicitly, excludes network inputs and never truncates to target', () => {
  const plan = createVideoPlan(inputMetadata(metadata()), 1_000_000);
  const args = videoCommand(plan);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.ok(args.includes('0:v:0') && args.includes('0:a:0?'));
  assert.ok(args.includes('libx264') && args.includes('aac') && args.includes('+faststart'));
  assert.equal(args.includes('-fs'), false);
  assert.equal(args.includes('-t'), false);
  assert.equal(args.includes('-shortest'), false);
});

test('valid under-limit videos retain the exact original after metadata validation and release core files', async () => {
  const { compress, calls } = mockCore();
  const original = videoFile(100);
  assert.equal(await compress(original, options), original);
  assert.equal(calls.encodes.length, 0);
  assert.deepEqual(calls.loads[0], {
    classWorkerURL: 'moz-extension://test/ffmpeg/worker.js',
    coreURL: 'moz-extension://test/ffmpeg/ffmpeg-core.js',
    wasmURL: 'moz-extension://test/ffmpeg/ffmpeg-core.wasm',
  });
  assert.ok(calls.deletes.includes('input.bin') && calls.deletes.includes('probe-input.json'));
  assert.equal(calls.terminations, 1);
});

test('packaged core ffprobe -1 sentinel is accepted only with valid metadata', async () => {
  const valid = mockCore({ probeCode: -1 });
  const original = videoFile(100);
  assert.equal(await valid.compress(original, options), original);
  const invalid = mockCore({ probeCode: -1, source: {} });
  await assert.rejects(invalid.compress(original, options), /metadata could not be read/);
  const failed = mockCore({ probeCode: 1 });
  await assert.rejects(failed.compress(original, options), /probe code 1/);
});

test('oversize candidates cause a lower-bitrate retry and strict checked MP4 output', async () => {
  const { compress, calls } = mockCore({ sizes: [1_300_000, 700_000] });
  const result = await compress(videoFile(), options);
  assert.equal(result.name, 'SPOILER_clip.mp4');
  assert.equal(result.type, 'video/mp4');
  assert.equal(result.lastModified, 1234);
  assert.equal(result.size, 700_000);
  assert.equal(calls.encodes.length, 2);
  const rate = (args) => Number(args[args.indexOf('-b:v') + 1]);
  assert.ok(rate(calls.encodes[1]) < rate(calls.encodes[0]));
  assert.ok(calls.probes.some((args) => args.at(-3) === 'output.mp4'));
  assert.ok(calls.deletes.includes('output.mp4'));
  assert.equal(calls.terminations, 1);
});

test('output validation rejects dropped audio and truncated duration, without repeated encodes', async () => {
  const source = inputMetadata(metadata());
  assert.throws(() => validateVideoOutput(source, metadata({ audio: false })), /audio track/);
  assert.throws(() => validateVideoOutput(source, metadata({ duration: 3 })), /full playback duration/);
  const { compress, calls } = mockCore({ output: metadata({ duration: 3 }) });
  await assert.rejects(compress(videoFile(), options), /full playback duration/);
  assert.equal(calls.encodes.length, 1);
  assert.equal(calls.terminations, 1);
});

test('empty output cannot be reported as a successful compression', async () => {
  const { compress, calls } = mockCore({ sizes: [0] });
  await assert.rejects(compress(videoFile(), options), /empty output/);
  assert.equal(calls.terminations, 1);
});

test('abort before load starts cannot create or restart a worker', async () => {
  const controller = new AbortController();
  const { compress, calls } = mockCore();
  await assert.rejects(compress(videoFile(), {
    ...options, signal: controller.signal, onProgress() { controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(calls.loads.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.ok(calls.terminations > 0);
});

test('abort during cold load immediately terminates rather than waiting for a pending core', async () => {
  const controller = new AbortController();
  const { compress, calls } = mockCore({ loading() { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  await assert.rejects(compress(videoFile(), { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.writes.length, 0);
  assert.ok(calls.terminations > 0);
});

test('abort during an active encode terminates its CPU worker before rejecting', async () => {
  const controller = new AbortController();
  const { compress, calls } = mockCore({ encoding() {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(compress(videoFile(), { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.encodes.length, 1);
  assert.ok(calls.terminations > 0);
  assert.equal(calls.probes.length, 1, 'a canceled encoder must never start output verification');
});

test('a stuck class worker load fails within the separate 30-second cold-load deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { compress, calls } = mockCore({ loading: () => new Promise(() => {}) });
  const pending = compress(videoFile(), options);
  t.mock.timers.tick(VIDEO_LOAD_TIMEOUT_MS);
  await assert.rejects(pending, /30 seconds/);
  assert.ok(calls.terminations > 0);
});

test('abort during filesystem cleanup terminates immediately and cancels the pending result', async () => {
  const controller = new AbortController();
  let enteredCleanup;
  const cleanupStarted = new Promise((resolve) => { enteredCleanup = resolve; });
  const { compress, calls } = mockCore({ deleting() {
    enteredCleanup();
    return new Promise(() => {});
  } });
  const pending = compress(videoFile(100), { ...options, signal: controller.signal });
  await cleanupStarted;
  assert.equal(calls.terminations, 0);
  controller.abort();
  assert.equal(calls.terminations, 1, 'terminate before the caller can release the global video slot');
  await assert.rejects(pending, { name: 'AbortError' });
});
