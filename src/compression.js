import { parseGIF, decompressFrame } from 'gifuct-js';
import * as gifenc from 'gifenc';
import { createGifCompositor, gifDelayMs, gifDelayParts, gifTimeline } from './gif.js';

export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
export const MAX_PIXELS = 32_000_000;
export const MAX_DIMENSION = 16_384;
export const MAX_GIF_CANVAS_PIXELS = 8_000_000;
export const MAX_GIF_FRAMES = 600;
export const MAX_GIF_FRAME_PIXELS = 120_000_000;
export const MAX_GIF_RENDER_PIXELS = 160_000_000;
const MAX_GIF_ATTEMPTS = 24;
// gifenc publishes different CommonJS and ESM entry points.
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;
const transparent = [0, 0, 0, 0];
const textAt = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
const invalid = () => new Error('This image is damaged or has an unsupported file structure.');

function guardDimensions(width, height, limit = MAX_PIXELS) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw invalid();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > limit) {
    throw new Error(`This image is too large to process safely (${width} × ${height} pixels). Resize it first.`);
  }
}

// Inspect animation flags before the browser decoder can silently select frame 1.
export function inspectImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset, little = false) => view.getUint16(offset, little);
  const u32 = (offset, little = false) => view.getUint32(offset, little);
  if (textAt(bytes, 0, 3) === 'GIF') {
    if (bytes.length < 13 || !['87a', '89a'].includes(textAt(bytes, 3, 3))) throw invalid();
    return { format: 'gif', width: u16(6, true), height: u16(8, true) };
  }
  if (bytes.length >= 24 && textAt(bytes, 1, 3) === 'PNG' && bytes[0] === 137) {
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = u32(offset);
      if (offset + length + 12 > bytes.length) throw invalid();
      const type = textAt(bytes, offset + 4, 4);
      if (type === 'acTL') animated = true;
      offset += length + 12;
      if (type === 'IEND') break;
    }
    return { format: 'png', width: u32(16), height: u32(20), animated };
  }
  if (bytes.length >= 30 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') {
    let width, height, animated = false;
    const uint24 = (offset) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = textAt(bytes, offset, 4), length = u32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) throw invalid();
      if (type === 'VP8X' && length >= 10) {
        width = uint24(data + 4) + 1; height = uint24(data + 7) + 1;
        animated ||= Boolean(bytes[data] & 2);
      } else if (type === 'VP8 ' && length >= 10 && width === undefined) {
        width = u16(data + 6, true) & 0x3fff; height = u16(data + 8, true) & 0x3fff;
      } else if (type === 'VP8L' && length >= 5 && width === undefined) {
        const bits = u32(data + 1, true);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (type === 'ANIM' || type === 'ANMF') animated = true;
      offset = data + length + (length & 1);
    }
    return { format: 'webp', width, height, animated };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = u16(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw invalid();
        return { format: 'jpeg', height: u16(offset + 3), width: u16(offset + 5) };
      }
      offset += length;
    }
    throw invalid();
  }
  if (bytes.length >= 26 && textAt(bytes, 0, 2) === 'BM') {
    const dib = u32(14, true);
    if (dib === 12) return { format: 'bmp', width: u16(18, true), height: u16(20, true) };
    if (dib >= 40) return { format: 'bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
    throw invalid();
  }
  if (bytes.length >= 16 && textAt(bytes, 4, 4) === 'ftyp') {
    const firstSize = u32(0);
    if (firstSize < 16 || firstSize > bytes.length) throw invalid();
    const brands = [];
    for (let offset = 8; offset + 4 <= firstSize; offset += 4) if (offset !== 12) brands.push(textAt(bytes, offset, 4));
    if (!brands.some((brand) => brand === 'avif' || brand === 'avis')) throw new Error('Only PNG, JPEG, WebP, BMP, AVIF and GIF images are supported.');
    let width = 0, height = 0, boxCount = 0;
    let animated = brands.includes('avis') || brands.includes('msf1');
    function boxes(start, end, depth = 0) {
      if (depth > 8) throw invalid();
      for (let offset = start; offset + 8 <= end;) {
        if (++boxCount > 10_000) throw invalid();
        let length = u32(offset), header = 8;
        if (length === 1) {
          if (offset + 16 > end) throw invalid();
          length = u32(offset + 8) * 2 ** 32 + u32(offset + 12); header = 16;
        } else if (length === 0) length = end - offset;
        if (length < header || offset + length > end) throw invalid();
        const type = textAt(bytes, offset + 4, 4), data = offset + header;
        if (type === 'ispe' && length >= header + 12) {
          width = Math.max(width, u32(data + 4)); height = Math.max(height, u32(data + 8));
        }
        if (type === 'moov') animated = true;
        if (['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
          boxes(data + (type === 'meta' ? 4 : 0), offset + length, depth + 1);
        }
        offset += length;
      }
    }
    boxes(0, bytes.length);
    return { format: 'avif', width, height, animated };
  }
  throw new Error('Only PNG, JPEG, WebP, BMP, AVIF and GIF images are supported.');
}

function fileName(file, extension) {
  const base = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  return `${base}.${extension}`;
}

function outputFile(file, blob, extension, targetBytes) {
  if (!blob.size || blob.size > targetBytes) throw new Error('The compressed image could not fit the selected upload limit.');
  return new File([blob], fileName(file, extension), { type: blob.type, lastModified: file.lastModified });
}

async function compressStatic(file, targetBytes, report) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('Your browser could not decode this image. It may be damaged or use an unsupported codec.'); }
  let canvas;
  try {
    guardDimensions(bitmap.width, bitmap.height);
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('This browser cannot create an image compression canvas.');
    let width = bitmap.width, height = bitmap.height;
    for (let attempt = 0; attempt < 24; attempt++) {
      canvas.width = width; canvas.height = height;
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      const encode = async (quality) => {
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        if (blob.type !== 'image/webp') throw new Error('This browser does not support WebP encoding. Update Zen or Firefox and try again.');
        return blob;
      };
      report(`Compressing image at ${width} × ${height}…`, Math.min(0.9, 0.1 + attempt * 0.045));
      let blob = await encode(0.92);
      if (blob.size <= targetBytes) return outputFile(file, blob, 'webp', targetBytes);
      blob = await encode(0.06);
      if (blob.size <= targetBytes) {
        let best = blob, low = 0.06, high = 0.92;
        for (let step = 0; step < 6; step++) {
          const quality = (low + high) / 2;
          blob = await encode(quality);
          if (blob.size <= targetBytes) { low = quality; best = blob; } else high = quality;
        }
        return outputFile(file, best, 'webp', targetBytes);
      }
      if (width === 1 && height === 1) break;
      const factor = Math.max(0.25, Math.min(0.8, Math.sqrt(targetBytes / blob.size) * 0.9));
      width = Math.max(1, Math.floor(width * factor)); height = Math.max(1, Math.floor(height * factor));
    }
    throw new Error('This image cannot fit the selected upload limit, even at minimum size. Choose a higher limit.');
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

// Preflight the block stream before gifuct-js: unknown extension labels otherwise
// cause that parser to loop without advancing. This also checks every size before allocation.
export function preflightGif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint16 = (offset) => view.getUint16(offset, true);
  guardDimensions(uint16(6), uint16(8), MAX_GIF_CANVAS_PIXELS);
  let offset = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let frames = 0, framePixels = 0, blocks = 0;
  const skipBlocks = () => {
    while (true) {
      if (offset >= bytes.length) throw invalid();
      const length = bytes[offset++];
      if (!length) return;
      if (offset + length > bytes.length) throw invalid();
      offset += length;
    }
  };
  while (offset < bytes.length) {
    if (++blocks > 10_000) throw new Error('This GIF contains too many data blocks to process safely.');
    const code = bytes[offset++];
    if (code === 0x3b) {
      if (!frames) throw new Error('This GIF does not contain any image frames.');
      return frames;
    }
    if (code === 0x21) {
      const label = bytes[offset++];
      if (label === 0x01) throw new Error('GIFs containing plain-text animation blocks are not supported.');
      if (![0xf9, 0xff, 0xfe].includes(label)) throw new Error('This GIF contains an unsupported extension block.');
      if (label === 0xf9 && (bytes[offset] !== 4 || bytes[offset + 5] !== 0)) throw invalid();
      skipBlocks();
    } else if (code === 0x2c) {
      if (offset + 9 > bytes.length) throw invalid();
      const width = uint16(offset + 4), height = uint16(offset + 6);
      guardDimensions(width, height, MAX_GIF_CANVAS_PIXELS);
      if (uint16(offset) + width > uint16(6) || uint16(offset + 2) + height > uint16(8)) throw invalid();
      if (++frames > MAX_GIF_FRAMES || (framePixels += width * height) > MAX_GIF_FRAME_PIXELS || frames * uint16(6) * uint16(8) > MAX_GIF_RENDER_PIXELS) {
        throw new Error('This GIF has too many frames or decoded pixels to process safely. Shorten or resize it first.');
      }
      const packed = bytes[offset + 8];
      offset += 9 + ((packed & 128) ? 3 * 2 ** ((packed & 7) + 1) : 0);
      const codeSize = bytes[offset++];
      if (codeSize < 2 || codeSize > 8) throw invalid();
      skipBlocks();
    } else throw invalid();
  }
  throw invalid();
}

function gifRepeat(parsed) {
  for (const frame of parsed.frames) {
    const app = frame.application;
    if (app && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(app.id) && app.blocks.length >= 3 && app.blocks[0] === 1) {
      return app.blocks[1] | app.blocks[2] << 8;
    }
  }
  return -1;
}

async function encodeGifAttempt(parsed, frames, timeline, width, height, colors, targetBytes, report) {
  const sourceWidth = parsed.lsd.width, sourceHeight = parsed.lsd.height;
  const firstTransparent = frames[0].gce?.extras.transparentColorGiven;
  const globalBackground = parsed.gct?.[parsed.lsd.backgroundColorIndex];
  const background = !firstTransparent && globalBackground ? [...globalBackground, 255] : transparent;
  const compositor = createGifCompositor(sourceWidth, sourceHeight, background);
  const source = new OffscreenCanvas(sourceWidth, sourceHeight);
  const sourceContext = source.getContext('2d');
  const target = new OffscreenCanvas(width, height);
  const targetContext = target.getContext('2d', { willReadFrequently: true });
  if (!sourceContext || !targetContext) throw new Error('This browser cannot create an animation compression canvas.');
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';
  const sourceImage = new ImageData(compositor.pixels, sourceWidth, sourceHeight);
  const encoder = GIFEncoder();
  const repeat = gifRepeat(parsed);
  let selected = 0;
  try {
    for (let index = 0; index < frames.length; index++) {
      const frame = decompressFrame(frames[index], parsed.gct, false);
      if (!frame.colorTable) throw invalid();
      compositor.draw(frame, frames[index].gce?.extras.transparentColorGiven ? transparent : (globalBackground ? [...globalBackground, 255] : transparent));
      if (timeline[selected]?.index !== index) continue;
      sourceContext.putImageData(sourceImage, 0, 0);
      targetContext.clearRect(0, 0, width, height);
      targetContext.drawImage(source, 0, 0, width, height);
      const rgba = targetContext.getImageData(0, 0, width, height).data;
      // Reserve index 0 exclusively for transparency. RGB quantization can never
      // accidentally turn an opaque black pixel into a transparent palette entry.
      const opaquePalette = quantize(rgba, colors - 1, { format: 'rgb565' });
      const palette = [[0, 0, 0], ...opaquePalette];
      const indices = applyPalette(rgba, opaquePalette, 'rgb565');
      for (let pixel = 0; pixel < indices.length; pixel++) indices[pixel] = rgba[pixel * 4 + 3] < 128 ? 0 : indices[pixel] + 1;
      // GIF stores delay in an unsigned 16-bit number of hundredths.
      for (const part of gifDelayParts(timeline[selected].delayMs)) {
        encoder.writeFrame(indices, width, height, { palette, delay: part, repeat, transparent: true, transparentIndex: 0, dispose: 2, colorDepth: Math.max(2, Math.ceil(Math.log2(palette.length))) });
      }
      selected++;
      if (selected % 10 === 0) report(`Encoding animation frame ${selected} of ${timeline.length}…`);
      // Abort expensive oversize candidates; estimate their final size for scaling.
      const size = encoder.bytesView().length;
      if (size > Math.max(targetBytes * 2, 4 * 1024 * 1024)) return { size: size * timeline.length / selected };
    }
    encoder.finish();
    const bytes = encoder.bytesView();
    return { size: bytes.length, blob: bytes.length <= targetBytes ? new Blob([bytes], { type: 'image/gif' }) : undefined };
  } finally {
    source.width = source.height = target.width = target.height = 1;
  }
}

async function compressGif(file, bytes, targetBytes, report) {
  preflightGif(bytes);
  let parsed;
  try { parsed = parseGIF(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer); }
  catch { throw invalid(); }
  const frames = parsed.frames.filter((frame) => frame.image);
  const delays = frames.map((frame) => gifDelayMs(frame.gce?.delay ?? 0));
  let scale = 1, stride = 1, colors = 256;
  for (let attempt = 0; attempt < MAX_GIF_ATTEMPTS; attempt++) {
    const width = Math.max(1, Math.floor(parsed.lsd.width * scale));
    const height = Math.max(1, Math.floor(parsed.lsd.height * scale));
    const progress = 0.08 + attempt / MAX_GIF_ATTEMPTS * 0.86;
    report(`Compressing GIF at ${width} × ${height}, ${colors} colors…`, progress);
    const timeline = gifTimeline(delays, stride);
    const result = await encodeGifAttempt(parsed, frames, timeline, width, height, colors, targetBytes, (message) => report(message, progress));
    if (result.blob) return outputFile(file, result.blob, 'gif', targetBytes);
    // Preserve every frame until the image is small, then merge frame durations.
    if (attempt === 0) { colors = 128; continue; }
    if (Math.max(width, height) > 32 && attempt < 11) {
      scale *= Math.max(0.25, Math.min(0.78, Math.sqrt(targetBytes / result.size) * 0.9));
      colors = Math.max(16, colors / 2);
    } else if (stride < frames.length - 1) {
      stride = Math.min(frames.length - 1, stride * 2);
      colors = Math.max(4, colors / 2);
    } else if (width > 1 || height > 1) {
      scale *= 0.4; colors = 4;
    } else break;
  }
  throw new Error('This GIF cannot fit the selected upload limit while retaining its animation. Choose a higher limit or shorten it.');
}

export async function compressFile(file, { targetBytes, onProgress = () => {} } = {}) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) throw new Error('Choose a valid upload limit in bytes.');
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size) || file.size < 1) throw new Error('Choose a nonempty image file.');
  const report = (message, progress = 0) => onProgress({ message, progress });
  if (file.size <= targetBytes) { report('Already within the upload limit.', 1); return file; }
  if (file.size > MAX_INPUT_BYTES) throw new Error('This file exceeds the 128 MiB safety limit. Resize or shorten it first.');
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('This browser does not support local image compression. Update Zen or Firefox and try again.');
  report('Reading image…', 0.02);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let info;
  try { info = inspectImage(bytes); }
  catch (error) { if (error instanceof RangeError) throw invalid(); throw error; }
  if (info.animated) throw new Error(`Animated ${info.format.toUpperCase()} compression is not supported. The original animation has been kept; use an animated GIF instead.`);
  guardDimensions(info.width, info.height);
  const result = info.format === 'gif' ? await compressGif(file, bytes, targetBytes, report) : await compressStatic(file, targetBytes, report);
  if (result.size > targetBytes) throw new Error('The output exceeded the selected upload limit.');
  report('Ready to upload.', 1);
  return result;
}
