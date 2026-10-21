// Chrome runtime messages are JSON. Keep each message far below its 64 MiB cap
// and acknowledge one binary chunk before reading/sending the next.
export const CHUNK_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200_000_000;
export const MAX_OUTPUT_BYTES = 19_800_000;
export const CLIENT_PORT = 'discord-autocompress-chrome';
export const OFFSCREEN_PORT = 'discord-autocompress-offscreen';
export const OFFSCREEN_PATH = 'chrome-offscreen.html';

export function fileMetadata(file) {
  return { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified };
}

export function validateMetadata(value, limit) {
  if (!value || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > limit ||
      typeof value.name !== 'string' || value.name.length > 1024 ||
      typeof value.type !== 'string' || value.type.length > 256 || /[\r\n]/.test(value.type) ||
      !Number.isSafeInteger(value.lastModified) || value.lastModified < 0) {
    throw new Error('Invalid file metadata or file size.');
  }
  return { name: value.name, type: value.type, size: value.size, lastModified: value.lastModified };
}

export function validateStart(request) {
  if (!request || !['image', 'video'].includes(request.mode) ||
      !Number.isSafeInteger(request.targetBytes) || request.targetBytes < 1 || request.targetBytes > MAX_OUTPUT_BYTES) {
    throw new Error('Choose a target between 1 byte and 19.8 MB.');
  }
  return validateMetadata(request.file, request.mode === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
}

export function encodeChunk(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_BYTES) throw new Error('Invalid transfer chunk.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function validateChunk(message, index, remaining) {
  const length = Math.min(CHUNK_BYTES, remaining);
  if (length < 1 || message?.index !== index || message.bytes !== length ||
      typeof message.data !== 'string' || message.data.length !== Math.ceil(length / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) {
    throw new Error('Invalid or out-of-order transfer chunk.');
  }
  return length;
}

export function decodeChunk(message, index, remaining) {
  const length = validateChunk(message, index, remaining);
  const binary = atob(message.data);
  if (binary.length !== length || btoa(binary) !== message.data) throw new Error('Invalid transfer bytes.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class ChunkReceiver {
  constructor(metadata, limit) {
    this.metadata = validateMetadata(metadata, limit);
    this.parts = [];
    this.received = 0;
    this.index = 0;
  }
  push(message) {
    const bytes = decodeChunk(message, this.index, this.metadata.size - this.received);
    this.parts.push(bytes);
    this.received += bytes.length;
    this.index++;
  }
  finish() {
    if (this.received !== this.metadata.size) throw new Error('The file transfer was incomplete.');
    const file = new File(this.parts, this.metadata.name, { type: this.metadata.type, lastModified: this.metadata.lastModified });
    this.clear();
    return file;
  }
  clear() { this.parts.length = 0; }
}

export function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Compression cancelled. Attach the file again to retry.', 'AbortError');
}

// The recipient controls backpressure. Cancellation is checked after every await,
// so cancelling an in-flight Blob read cannot send another chunk afterwards.
export async function streamFile(file, sendAndWait, signal) {
  for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index++) {
    if (signal?.aborted) throw abortError(signal);
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    if (signal?.aborted) throw abortError(signal);
    await sendAndWait({ index, bytes: bytes.length, data: encodeChunk(bytes) });
  }
  if (signal?.aborted) throw abortError(signal);
}
