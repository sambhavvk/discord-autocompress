export const api = globalThis.browser ?? globalThis.chrome;
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, videoEnabled: false, videoGifEnabled: false, targetMB: 20 });

export function normalizeSettings(value = {}) {
  const target = Number(value?.targetMB ?? DEFAULT_SETTINGS.targetMB);
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    videoEnabled: value?.videoEnabled === true,
    videoGifEnabled: value?.videoGifEnabled === true,
    targetMB: Number.isFinite(target) ? Math.min(20, Math.max(1, target)) : 20,
  };
}

// Decimal MB, with a small margin below the service's actual limit.
export function getTargetBytes(settings) {
  return Math.floor(normalizeSettings(settings).targetMB * 1_000_000 * 0.99);
}

export function formatBytes(bytes) {
  return bytes < 1_000_000 ? `${(bytes / 1_000).toFixed(0)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function isCompressible(file) {
  return /\.(gif|png|apng|jpe?g|webp|bmp|avif)$/i.test(file.name) ||
    /^image\/(gif|png|apng|jpeg|webp|bmp|avif)$/i.test(file.type);
}

export function isVideo(file) {
  return /^video\//i.test(file.type) || /^application\/x-matroska(?:;|$)/i.test(file.type) ||
    /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv|3gp|3g2)$/i.test(file.name);
}
