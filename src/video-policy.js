// Shared with the content/background bridge; this module has no browser dependencies.
export const MAX_VIDEO_BYTES = 200_000_000;
export const MAX_VIDEO_SECONDS = 120;
export const VIDEO_TIMEOUT_MS = 600_000;
export const MAX_VIDEO_PIXELS = 3840 * 2160;
export const MAX_VIDEO_FPS = 60;
export const MAX_VIDEO_FRAME_PIXELS = 30_000_000_000;
export const VIDEO_ATTEMPTS = 3;
export const MIN_VIDEO_BITRATE = 32_000;
export const MIN_AUDIO_BITRATE = 96_000;
export const MAX_GIF_VIDEO_SECONDS = 30;

export function positiveNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function parseRate(value) {
  if (typeof value === 'number') return positiveNumber(value);
  if (typeof value !== 'string') return undefined;
  const parts = value.split(/[/:]/);
  if (parts.length === 1) return positiveNumber(parts[0]);
  if (parts.length !== 2) return undefined;
  const numerator = positiveNumber(parts[0]), denominator = positiveNumber(parts[1]);
  return numerator && denominator ? positiveNumber(numerator / denominator) : undefined;
}

export function validateVideoFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || typeof file.arrayBuffer !== 'function') {
    throw new Error('Choose a nonempty video file.');
  }
  if (file.size > MAX_VIDEO_BYTES) throw new Error('Videos must be 200 MB (200,000,000 bytes) or smaller.');
}

function durationOf(stream, fallback) {
  return positiveNumber(stream?.duration) ?? fallback;
}

export function readVideoMetadata(probe) {
  if (!probe || !Array.isArray(probe.streams)) throw new Error('The video metadata could not be read.');
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!video || Number(video.disposition?.attached_pic) === 1) {
    throw new Error('This file does not contain a supported video track.');
  }
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  const videoDuration = positiveNumber(video.duration);
  const formatDuration = positiveNumber(probe.format?.duration);
  const audioDuration = positiveNumber(audio?.duration);
  const duration = Math.max(videoDuration ?? 0, formatDuration ?? 0, audioDuration ?? 0);
  if (!duration || !Number.isFinite(duration)) throw new Error('This video has an unknown or invalid duration.');
  const width = Number(video.width), height = Number(video.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) {
    throw new Error('This video has invalid dimensions.');
  }
  const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
  if (!fps) throw new Error('This video has an unknown or invalid frame rate.');
  const sampleAspect = parseRate(video.sample_aspect_ratio) ?? 1;
  if (sampleAspect < 1 / 16 || sampleAspect > 16) throw new Error('This video has an unsupported pixel aspect ratio.');
  const rotation = Number(video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation ?? video.tags?.rotate ?? 0);
  if (!Number.isFinite(rotation) || Math.abs(rotation / 90 - Math.round(rotation / 90)) > 0.001) {
    throw new Error('Videos with an arbitrary rotation need to be rotated before compression.');
  }
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const displayWidth = rotated ? height : width * sampleAspect;
  const displayHeight = rotated ? width * sampleAspect : height;
  return {
    duration, videoDuration: durationOf(video, duration), audioDuration: durationOf(audio),
    width, height, fps, displayWidth, displayHeight,
    hasAudio: Boolean(audio), videoCodec: video.codec_name, audioCodec: audio?.codec_name,
    audioChannels: Number(audio?.channels || 0),
    pixelFormat: video.pix_fmt,
    colorTransfer: video.color_transfer || '', colorPrimaries: video.color_primaries || '',
    colorSpace: video.color_space || '', sideData: video.side_data_list || [],
  };
}

export function validateVideoMetadata(metadata) {
  if (metadata.duration > MAX_VIDEO_SECONDS) throw new Error('Videos must be 120 seconds (2 minutes) or shorter.');
  if (metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > MAX_VIDEO_PIXELS) {
    throw new Error('This video exceeds the 4K input safety limit. Resize it first.');
  }
  if (metadata.fps > MAX_VIDEO_FPS + 0.001 || metadata.width * metadata.height * metadata.fps * metadata.duration > MAX_VIDEO_FRAME_PIXELS) {
    throw new Error('This video has too many frames or decoded pixels for local compression. Lower its resolution or frame rate first.');
  }
  if (metadata.audioChannels > 8) throw new Error('Videos with more than 8 audio channels are not supported.');
  const hdrSideData = metadata.sideData.some((item) => /mastering display|content light|dovi|dolby vision/i.test(item.side_data_type || ''));
  if (/smpte2084|arib-std-b67|linear/i.test(metadata.colorTransfer) || /2020/i.test(metadata.colorPrimaries + metadata.colorSpace) || hdrSideData) {
    throw new Error('HDR and wide-gamut videos need tone mapping before compression. Export an SDR video first.');
  }
  // Untagged high-bit-depth input may be HDR; do not silently wash out its colors.
  if (/(?:p|gbr|gray|rgb|bgr)(?:9|10|12|14|16)|(?:p010|p012|p016)/i.test(metadata.pixelFormat || '') && !/bt709|smpte170m|smpte240m|iec61966|gamma22|gamma28/i.test(metadata.colorTransfer)) {
    throw new Error('This high-bit-depth video has no supported SDR color metadata. Export an SDR video first.');
  }
  return metadata;
}

export function inputMetadata(probe) {
  return validateVideoMetadata(readVideoMetadata(probe));
}

export function shouldConvertVideoToGif(file, metadata, gifEnabled = false) {
  const eligibleType = /\.(?:mp4|mkv|webm)$/i.test(file.name || '') ||
    /^(?:video\/(?:mp4|webm)|(?:video|application)\/x-matroska)(?:;|$)/i.test(file.type || '');
  return gifEnabled === true && eligibleType && metadata.duration < MAX_GIF_VIDEO_SECONDS;
}

export function createVideoGifPlan(metadata, attempt = 0) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= VIDEO_ATTEMPTS) throw new Error('Invalid GIF compression attempt.');
  const maxDimension = [480, 360, 240][attempt];
  const factor = Math.min(1, maxDimension / Math.max(metadata.displayWidth, metadata.displayHeight));
  return {
    attempt, width: Math.max(2, Math.floor(metadata.displayWidth * factor)),
    height: Math.max(2, Math.floor(metadata.displayHeight * factor)),
    fps: Math.min(metadata.fps, [12, 9, 6][attempt]), colors: [128, 96, 64][attempt],
  };
}

export function videoGifCommand(plan, input = 'input.bin', output = 'output.gif') {
  // A palette per frame keeps the split graph from retaining the entire decoded
  // clip while palettegen waits for EOF. Both branches only handle bounded frames.
  const filter = `[0:v:0]scale=${plan.width}:${plan.height}:flags=fast_bilinear,setsar=1,fps=${plan.fps},split[frames][colors];` +
    `[colors]palettegen=max_colors=${plan.colors}:reserve_transparent=0:stats_mode=single[palette];` +
    '[frames][palette]paletteuse=new=1:dither=bayer:bayer_scale=3[out]';
  return [
    '-hide_banner', '-loglevel', 'warning', '-threads', '1', '-filter_complex_threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', input, '-filter_complex', filter, '-map', '[out]',
    '-an', '-sn', '-dn', '-c:v', 'gif', '-loop', '0', '-map_metadata', '-1', '-f', 'gif', '-y', output,
  ];
}

export function validateVideoGifOutput(source, probe, plan) {
  const output = readVideoMetadata(probe);
  if (output.videoCodec !== 'gif' || output.hasAudio) throw new Error('The converted GIF is not a valid silent GIF. The original file has been kept.');
  const tolerance = Math.max(0.06, 1 / plan.fps + 0.02);
  if (Math.abs(output.videoDuration - source.videoDuration) > tolerance || Math.abs(output.duration - source.videoDuration) > tolerance) {
    throw new Error('The converted GIF did not retain the full playback duration. The original file has been kept.');
  }
  const stream = probe.streams.find((item) => item.codec_type === 'video');
  const frames = positiveNumber(stream.nb_read_frames) ?? positiveNumber(stream.nb_frames);
  if (!Number.isSafeInteger(frames) || (source.videoDuration >= 2 / plan.fps && frames < 2)) {
    throw new Error('The converted GIF animation could not be verified. The original file has been kept.');
  }
  if (output.width !== plan.width || output.height !== plan.height) throw new Error('The converted GIF has unexpected dimensions. The original file has been kept.');
  return output;
}

export function videoOverheadBytes(targetBytes) {
  return Math.max(2048, Math.min(65_536, Math.ceil(targetBytes * 0.02)));
}

function fitVideoSize(metadata, videoBitrate, fps, attempt) {
  const landscape = metadata.displayWidth >= metadata.displayHeight;
  let width = Math.min(metadata.displayWidth, landscape ? 1280 : 720);
  let height = Math.min(metadata.displayHeight, landscape ? 720 : 1280);
  const aspect = metadata.displayWidth / metadata.displayHeight;
  if (width / height > aspect) width = height * aspect;
  else height = width / aspect;
  // Low bitrate candidates spend their bits on fewer pixels. Retry only after an oversize result.
  const pixelBudget = videoBitrate / (fps * 0.055) * (attempt ? 0.85 : 1);
  const factor = Math.min(1, Math.sqrt(pixelBudget / (width * height)));
  return { width: Math.max(2, Math.floor(width * factor / 2) * 2), height: Math.max(2, Math.floor(height * factor / 2) * 2) };
}

export function createVideoPlan(metadata, targetBytes, previous) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) throw new Error('Choose a valid upload limit in bytes.');
  const availableRate = ((targetBytes - videoOverheadBytes(targetBytes)) * 8 * 0.92) / metadata.duration;
  const attempt = previous ? previous.attempt + 1 : 0;
  const audioBitrate = metadata.hasAudio ? (availableRate >= 900_000 && !previous ? 128_000 : MIN_AUDIO_BITRATE) : 0;
  let videoBitrate = Math.min(8_000_000, Math.floor(availableRate - audioBitrate));
  if (previous) {
    const estimatedAudioBytes = previous.audioBitrate * metadata.duration / 8;
    const actualVideoBytes = Math.max(1, previous.actualBytes - estimatedAudioBytes - videoOverheadBytes(targetBytes));
    const allowedVideoBytes = targetBytes * 0.87 - audioBitrate * metadata.duration / 8 - videoOverheadBytes(targetBytes);
    const factor = Math.max(0.2, Math.min(0.8, allowedVideoBytes / actualVideoBytes));
    videoBitrate = Math.min(videoBitrate, Math.floor(previous.videoBitrate * factor));
  }
  if (videoBitrate < MIN_VIDEO_BITRATE) {
    throw new Error(metadata.hasAudio
      ? 'The selected upload limit is too small to keep this video and its audio. Choose a higher limit or shorten the video.'
      : 'The selected upload limit is too small for this video. Choose a higher limit or shorten it.');
  }
  const fps = Math.min(metadata.fps, attempt === 0 ? 30 : attempt === 1 ? 24 : 20);
  return { attempt, videoBitrate, audioBitrate, fps, ...fitVideoSize(metadata, videoBitrate, fps, attempt) };
}

export function videoCommand(plan, input = 'input.bin', output = 'output.mp4') {
  return [
    '-hide_banner', '-loglevel', 'warning', '-threads', '1', '-filter_threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', `scale=${plan.width}:${plan.height}:flags=fast_bilinear,setsar=1,fps=${plan.fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-b:v', String(plan.videoBitrate), '-maxrate', String(plan.videoBitrate), '-bufsize', String(plan.videoBitrate),
    '-c:a', 'aac', '-b:a', String(plan.audioBitrate || MIN_AUDIO_BITRATE), '-ac', '2', '-ar', '48000',
    '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', '-y', output,
  ];
}

export function validateVideoOutput(source, probe) {
  const output = readVideoMetadata(probe);
  if (output.videoCodec !== 'h264' || (source.hasAudio && (!output.hasAudio || output.audioCodec !== 'aac'))) {
    throw new Error('The compressed video is missing a required H.264 video or AAC audio track.');
  }
  const tolerance = Math.max(0.35, 2 / Math.min(30, source.fps));
  if (Math.abs(output.videoDuration - source.videoDuration) > tolerance || Math.abs(output.duration - source.duration) > tolerance) {
    throw new Error('The compressed video did not retain the full playback duration. The original file has been kept.');
  }
  if (source.hasAudio && source.audioDuration && (!output.audioDuration || Math.abs(output.audioDuration - source.audioDuration) > 0.35)) {
    throw new Error('The compressed video did not retain the full audio duration. The original file has been kept.');
  }
  return output;
}
