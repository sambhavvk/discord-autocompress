import { api, isVideo, normalizeSettings } from "./settings.js";
import { compressVideo } from './video.js';
import { MAX_VIDEO_BYTES } from './video-policy.js';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MIN_TARGET_BYTES = 1;
const MAX_TARGET_BYTES = 19_800_000;
const activePorts = new Set();
let activeVideo = null;

function allowedPage(sender) {
  if (sender?.id !== api.runtime.id || !sender.tab) return false;

  let pageUrl;
  try {
    pageUrl = new URL(sender.url);
  } catch {
    return false;
  }

  const patterns = api.runtime.getManifest()?.content_scripts?.[0]?.matches ?? [];
  return patterns.some((pattern) => {
    try {
      const allowedUrl = new URL(pattern);
      // Match scheme and hostname. Content match patterns without an explicit
      // port cover any port, which is useful for the local browser test page.
      return pageUrl.protocol === allowedUrl.protocol && pageUrl.hostname === allowedUrl.hostname;
    } catch {
      return false;
    }
  });
}

function disconnect(port) {
  try {
    port.disconnect();
  } catch {
    // The caller may already have disconnected.
  }
}

function sendError(port, id, message) {
  try {
    port.postMessage({ id, type: "error", message });
  } catch {
    // The port may have closed while a worker was reporting an error.
  }
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "discord-autocompress" || !allowedPage(port.sender)) {
    disconnect(port);
    return;
  }

  let worker = null;
  let started = false;
  let closed = false;
  let videoController;
  activePorts.add(port);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activePorts.delete(port);
    videoController?.abort();
    if (activeVideo === port) activeVideo = null;
    if (worker) {
      worker.terminate();
      worker = null;
    }
  };

  port.onDisconnect.addListener(cleanup);
  port.onMessage.addListener((request) => {
    if (request?.type === 'keepalive') return;
    if (closed || started) return;
    started = true;

    const { id, file, targetBytes, mode = 'image' } = request ?? {};
    const isBlob = typeof Blob !== "undefined" && file instanceof Blob;
    if (id !== 1 || !isBlob || !['image', 'video'].includes(mode)) {
      sendError(port, id ?? 1, "Invalid compression request.");
      return;
    }
    if (!Number.isInteger(targetBytes) || targetBytes < MIN_TARGET_BYTES || targetBytes > MAX_TARGET_BYTES) {
      sendError(port, id, "Choose a target between 1 byte and 19.8 MB.");
      return;
    }
    if (!Number.isFinite(file.size) || file.size < 1 || file.size > (mode === 'video' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) {
      sendError(port, id, mode === 'video' ? 'Videos must be nonempty and no larger than 200 MB.' : 'This file must be nonempty and no larger than 128 MiB.');
      return;
    }

    if (mode === 'video') {
      if (!isVideo(file)) {
        sendError(port, id, 'Choose a supported video file.');
        return;
      }
      if (activeVideo) {
        sendError(port, id, 'Another video is already being processed. Wait for it to finish or cancel it, then try again.');
        return;
      }
      activeVideo = port;
      videoController = new AbortController();
      void (async () => {
        try {
          const stored = await api.storage.local.get('settings');
          if (closed) return;
          const latest = normalizeSettings(stored.settings);
          if (!latest.enabled || !latest.videoEnabled) {
            throw new Error('Video compression is disabled. Attach the file again after choosing your settings.');
          }
          const result = await compressVideo(file, {
            targetBytes,
            gifEnabled: latest.videoGifEnabled,
            baseURL: api.runtime.getURL('ffmpeg/'),
            signal: videoController.signal,
            onProgress: ({ message, progress }) => {
              if (!closed) port.postMessage({ id, type: 'progress', message, progress });
            },
          });
          if (!closed) port.postMessage({ id, type: 'result', file: result });
        } catch (error) {
          if (!closed) sendError(port, id, error instanceof Error ? error.message : 'Video compression failed.');
        } finally { cleanup(); }
      })();
      return;
    }

    try {
      worker = new Worker(api.runtime.getURL("compression.worker.js"), { type: "module" });
      worker.onmessage = ({ data }) => {
        try {
          port.postMessage(data);
        } catch {
          cleanup();
          return;
        }
        if (data?.type === "result" || data?.type === "error") cleanup();
      };
      worker.onerror = (event) => {
        console.error("Discord AutoCompress worker error:", event.message || "unknown worker error");
        sendError(port, id, "Compression failed unexpectedly. Try another image or refresh Discord.");
        cleanup();
      };
      worker.onmessageerror = () => {
        sendError(port, id, "Compression could not read the worker response. Try another image.");
        cleanup();
      };
      worker.postMessage({ id, file, targetBytes });
    } catch (error) {
      console.error("Discord AutoCompress could not start its worker:", error instanceof Error ? error.message : "unknown error");
      sendError(port, id, "Could not start image compression. Refresh Discord and try again.");
      cleanup();
    }
  });
});
