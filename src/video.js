import { FFmpeg } from '@ffmpeg/ffmpeg';
import {
  VIDEO_TIMEOUT_MS, VIDEO_ATTEMPTS, validateVideoFile, inputMetadata,
  createVideoPlan, videoCommand, validateVideoOutput,
  shouldConvertVideoToGif, createVideoGifPlan, videoGifCommand, validateVideoGifOutput,
} from './video-policy.js';

const probeEntries = 'format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,color_space,color_transfer,color_primaries,avg_frame_rate,r_frame_rate,sample_aspect_ratio,duration,channels,nb_frames,nb_read_frames:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=side_data_type,rotation';
export const VIDEO_LOAD_TIMEOUT_MS = 30_000;
const abortError = () => new DOMException('Video compression cancelled. The original file has been kept.', 'AbortError');
const timeoutError = () => new Error('Video compression exceeded the 10-minute time limit. Try a shorter or smaller video.');

function resultName(file, extension = 'mp4') {
  return `${(file.name || 'video').replace(/\.[^.]+$/, '') || 'video'}.${extension}`;
}

function errorDetail(logs) {
  const relevant = logs.filter((message) => /error|invalid|not found|unsupported|failed|could not|unrecognized|option|argument|protocol|unable|no match/i.test(message));
  return (relevant.length ? relevant : logs).slice(-3).join(' ').slice(0, 400);
}

function encodingError(logs) {
  const detail = errorDetail(logs);
  return new Error(`This video could not be encoded locally. It may be damaged or use an unsupported codec.${detail ? ` ${detail}` : ''}`);
}

// A factory keeps lifecycle behavior testable without running WASM in Node.
// Each job owns a fresh FFmpeg worker and its complete temporary filesystem.
export function createVideoCompressor(FFmpegClass) {
  return async function compressVideoWithCore(file, { targetBytes, baseURL, onProgress = () => {}, signal, gifEnabled = false } = {}) {
    validateVideoFile(file); // Must run before arrayBuffer(), worker allocation, or loading WASM.
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) throw new Error('Choose a valid upload limit in bytes.');
    if (signal?.aborted) throw abortError();
    let urls;
    try {
      urls = {
        classWorkerURL: new URL('worker.js', baseURL).href,
        coreURL: new URL('ffmpeg-core.js', baseURL).href,
        wasmURL: new URL('ffmpeg-core.wasm', baseURL).href,
      };
    } catch { throw new Error('The bundled video encoder could not be located. Reload the extension and try again.'); }

    const ffmpeg = new FFmpegClass();
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    const controller = new AbortController();
    const temporaryFiles = new Set();
    const logs = [];
    let interrupted;
    let rejectInterrupted;
    const interruption = new Promise((_, reject) => { rejectInterrupted = reject; });
    // An abort between operations must not produce an unhandled rejection.
    interruption.catch(() => {});
    const stop = (error) => {
      if (interrupted) return;
      interrupted = error;
      controller.abort();
      ffmpeg.terminate(); // Aborting the Promise alone does not stop an FFmpeg encode.
      rejectInterrupted(error);
    };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(timeoutError()), VIDEO_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    let lastProgress = 0;
    let currentAttempt = -1;
    let convertingGif = false;
    const report = (message, progress) => {
      if (interrupted) return;
      lastProgress = Math.max(lastProgress, Math.min(1, progress));
      onProgress({ message, progress: lastProgress });
    };
    const log = ({ message }) => {
      if (typeof message !== 'string') return;
      logs.push(message.slice(0, 1000));
      if (logs.length > 30) logs.shift();
    };
    const progress = ({ progress: fraction }) => {
      if (currentAttempt < 0 || !Number.isFinite(fraction)) return;
      report(`${convertingGif ? 'Converting video to GIF' : 'Compressing video'}${currentAttempt ? ` (attempt ${currentAttempt + 1})` : ''}…`, 0.15 + currentAttempt * 0.24 + Math.max(0, Math.min(1, fraction)) * 0.21);
    };
    const remaining = () => Math.max(1, deadline - Date.now());
    const wait = async (operation) => {
      if (interrupted) throw interrupted;
      if (Date.now() >= deadline) { stop(timeoutError()); throw interrupted; }
      return Promise.race([operation(), interruption]);
    };
    const probe = async (input, output, countFrames = false) => {
      temporaryFiles.add(output);
      logs.length = 0;
      const code = await wait(() => ffmpeg.ffprobe([
        '-v', 'error', '-protocol_whitelist', 'file,pipe', ...(countFrames ? ['-count_frames'] : []), '-show_entries', probeEntries, '-of', 'json', input, '-o', output,
      ], remaining(), { signal: controller.signal }));
      // core 0.12.10's ffprobe wrapper leaves Module.ret at -1 instead of
      // forwarding the C entry point's return value. For this sentinel, success
      // requires a newly written JSON document and stream/duration validation.
      if (code !== 0 && code !== -1) {
        const detail = errorDetail(logs);
        throw new Error(`This video could not be inspected (probe code ${code}).${detail ? ` ${detail}` : ' It may be damaged or use an unsupported container.'}`);
      }
      const json = await wait(() => ffmpeg.readFile(output, 'utf8', { signal: controller.signal }));
      if (typeof json !== 'string' || json.length > 1_000_000) throw new Error('The video metadata is invalid or too large to process.');
      try { return JSON.parse(json); }
      catch { throw new Error('This video has unreadable metadata.'); }
    };

    ffmpeg.on('log', log);
    ffmpeg.on('progress', progress);
    try {
      // Handle cancellation that raced listener registration.
      if (signal?.aborted) abort();
      report('Loading the local video encoder…', 0.01);
      const loadTimer = setTimeout(() => stop(new Error('The bundled video encoder could not load within 30 seconds. Reload the extension and try again.')), VIDEO_LOAD_TIMEOUT_MS);
      try { await wait(() => ffmpeg.load(urls, { signal: controller.signal })); }
      finally { clearTimeout(loadTimer); }
      report('Reading video…', 0.05);
      const data = new Uint8Array(await wait(() => file.arrayBuffer()));
      temporaryFiles.add('input.bin');
      await wait(() => ffmpeg.writeFile('input.bin', data, { signal: controller.signal }));
      report('Checking video duration, dimensions and audio…', 0.1);
      const source = inputMetadata(await probe('input.bin', 'probe-input.json'));
      convertingGif = shouldConvertVideoToGif(file, source, gifEnabled);
      if (!convertingGif && file.size <= targetBytes) {
        report('Already within the upload limit.', 1);
        return file;
      }

      let previous;
      const outputPath = convertingGif ? 'output.gif' : 'output.mp4';
      for (let attempt = 0; attempt < VIDEO_ATTEMPTS; attempt++) {
        const plan = convertingGif ? createVideoGifPlan(source, attempt) : createVideoPlan(source, targetBytes, previous);
        currentAttempt = attempt;
        logs.length = 0;
        report(convertingGif ? `Converting video to a silent GIF at ${plan.width} × ${plan.height}…` : `Compressing video at ${plan.width} × ${plan.height} with${source.hasAudio ? '' : 'out'} audio…`, 0.15 + attempt * 0.24);
        temporaryFiles.add(outputPath);
        const code = await wait(() => ffmpeg.exec(convertingGif ? videoGifCommand(plan) : videoCommand(plan), remaining(), { signal: controller.signal }));
        currentAttempt = -1;
        if (code !== 0) {
          if (Date.now() >= deadline) throw timeoutError();
          throw encodingError(logs);
        }
        const output = await wait(() => ffmpeg.readFile(outputPath, 'binary', { signal: controller.signal }));
        if (!(output instanceof Uint8Array) || !output.byteLength) throw new Error('Video compression produced an empty output. The original file has been kept.');
        if (output.byteLength > targetBytes) {
          previous = { ...plan, actualBytes: output.byteLength };
          // Release a rejected candidate before another heavy encode.
          await wait(() => ffmpeg.deleteFile(outputPath, { signal: controller.signal }));
          continue;
        }
        report(convertingGif ? 'Verifying GIF animation and playback duration…' : 'Verifying video and audio playback duration…', 0.92);
        const outputMetadata = await probe(outputPath, 'probe-output.json', convertingGif);
        if (convertingGif) validateVideoGifOutput(source, outputMetadata, plan);
        else validateVideoOutput(source, outputMetadata);
        if (interrupted) throw interrupted;
        if (Date.now() >= deadline) throw timeoutError();
        const result = new File([output], resultName(file, convertingGif ? 'gif' : 'mp4'), { type: convertingGif ? 'image/gif' : 'video/mp4', lastModified: file.lastModified });
        if (!result.size || result.size > targetBytes) throw new Error('The compressed video exceeded the selected upload limit.');
        report(convertingGif ? 'GIF ready to upload.' : 'Video ready to upload.', 1);
        return result;
      }
      throw new Error(convertingGif ? 'This GIF could not fit the selected upload limit after compression. Choose a higher limit or disable short-video GIF conversion.' : 'This video could not fit the selected upload limit after compression. Choose a higher limit or shorten it.');
    } catch (error) {
      if (interrupted) throw interrupted;
      if (error instanceof Error) throw error;
      throw new Error('The local video encoder failed. Try another video or reload the extension.');
    } finally {
      currentAttempt = -1;
      ffmpeg.off('log', log);
      ffmpeg.off('progress', progress);
      // A terminated worker already released its filesystem. On ordinary exits,
      // explicitly unlink files, but never allow cleanup to extend the job deadline.
      let cleanupTimer;
      try {
        if (ffmpeg.loaded && !interrupted && Date.now() < deadline) {
          await Promise.race([
            Promise.allSettled([...temporaryFiles].map((path) => ffmpeg.deleteFile(path))),
            new Promise((resolve) => { cleanupTimer = setTimeout(resolve, Math.min(1000, remaining())); }),
            interruption,
          ]);
        }
      } finally {
        clearTimeout(cleanupTimer);
        clearTimeout(timer);
        ffmpeg.terminate();
        signal?.removeEventListener('abort', abort);
      }
    }
  };
}

export const compressVideo = createVideoCompressor(FFmpeg);
