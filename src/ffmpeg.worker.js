// Protocol adapter for @ffmpeg/ffmpeg 0.12.x, based on its MIT-licensed worker.
// Copyright (c) 2019 Jerome Wu. See licenses/ffmpeg-wasm-MIT.txt.
// A static, packaged import avoids the upstream worker's dynamic code loader.
import createFFmpegCore from './ffmpeg-core.js';

let core;
const send = (type, data) => self.postMessage({ type, data });

async function load(options = {}) {
  const coreURL = new URL('./ffmpeg-core.js', import.meta.url).href;
  const wasmURL = new URL('./ffmpeg-core.wasm', import.meta.url).href;
  if ((options.coreURL && options.coreURL !== coreURL) || (options.wasmURL && options.wasmURL !== wasmURL)) {
    throw new Error('Only the packaged FFmpeg core can be loaded.');
  }
  const first = !core;
  core = await createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}`,
  });
  core.setLogger(data => send('LOG', data));
  core.setProgress(data => send('PROGRESS', data));
  return first;
}

function execute(type, { args, timeout = -1 }) {
  core.setTimeout(timeout);
  try {
    if (type === 'EXEC') core.exec(...args);
    else core.ffprobe(...args);
    return core.ret;
  } finally { core.reset(); }
}

self.onmessage = async ({ data: { id, type, data: request } }) => {
  try {
    if (type !== 'LOAD' && !core) throw new Error('The video encoder has not loaded.');
    let data;
    switch (type) {
      case 'LOAD': data = await load(request); break;
      case 'EXEC':
      case 'FFPROBE': data = execute(type, request); break;
      case 'WRITE_FILE': core.FS.writeFile(request.path, request.data); data = true; break;
      case 'READ_FILE': data = core.FS.readFile(request.path, { encoding: request.encoding }); break;
      case 'DELETE_FILE': core.FS.unlink(request.path); data = true; break;
      default: throw new Error('Unsupported video encoder operation.');
    }
    const transfers = data instanceof Uint8Array ? [data.buffer] : [];
    self.postMessage({ id, type, data }, transfers);
  } catch (error) {
    self.postMessage({ id, type: 'ERROR', data: String(error) });
  }
};
