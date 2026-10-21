import { api, DEFAULT_SETTINGS, normalizeSettings, getTargetBytes, formatBytes, isCompressible, isVideo } from './settings.js';
import { MAX_VIDEO_BYTES, VIDEO_TIMEOUT_MS } from './video-policy.js';
import { compressInChrome } from './chrome-client.js';

// Capture before Discord/React handles the attachment. No Discord internals or tokens.
let settings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
let activeJob = null;
let toast;
let toastTimer;
const replayEvents = new WeakSet();
const ready = api.storage.local.get('settings').then((result) => {
  settings = normalizeSettings(result.settings);
  settingsLoaded = true;
}).catch(() => { settingsLoaded = true; });

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settings = normalizeSettings(changes.settings.newValue);
});

function showToast(message, { busy = false, error = false } = {}) {
  clearTimeout(toastTimer);
  if (!toast?.host.isConnected) {
    const host = document.createElement('div');
    host.id = 'discord-autocompress-status';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; right: 20px; bottom: 24px; z-index: 2147483647; }
      .panel { box-sizing: border-box; display: flex; align-items: center; gap: 16px; width: min(390px, calc(100vw - 40px)); padding: 16px 18px; border: 1px solid #645099; border-radius: 14px; background: #201d2a; color: #f2eefc; box-shadow: 0 8px 32px #0006; font: 13px/1.5 system-ui, sans-serif; }
      strong { display: block; color: #c9b8ff; font-size: 12px; margin-bottom: 3px; }
      .panel > div { flex: 1; min-width: 0; }
      p { margin: 0; overflow-wrap: anywhere; }
      button { flex-shrink: 0; border: 1px solid #716483; border-radius: 7px; background: transparent; color: #eee5ff; padding: 6px 10px; cursor: pointer; font: inherit; }
      button:focus-visible { outline: 2px solid #c9b8ff; outline-offset: 3px; }
      .panel[data-error=true] { border-color: #d68686; }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Discord AutoCompress';
    const text = document.createElement('p');
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (activeJob) activeJob.abort(new DOMException('Compression cancelled. Attach the files again to retry.', 'AbortError'));
      else host.remove();
    });
    copy.append(title, text);
    panel.append(copy, button);
    shadow.append(style, panel);
    (document.body ?? document.documentElement).append(host);
    toast = { host, panel, text, button };
  }
  toast.text.textContent = message;
  toast.host.setAttribute('aria-label', message);
  toast.panel.dataset.error = String(error);
  toast.button.textContent = busy ? 'Cancel' : 'Dismiss';
  if (!busy && !error) toastTimer = setTimeout(() => toast.host.remove(), 8000);
}

function compressInWorker(file, targetBytes, signal, onProgress, mode = 'image') {
  if (api.runtime.getManifest().background?.service_worker) {
    return compressInChrome(file, targetBytes, signal, onProgress, mode);
  }
  return new Promise((resolve, reject) => {
    let port;
    let timer;
    let heartbeat;
    let settled = false;
    const done = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal.removeEventListener('abort', abort);
      port?.disconnect();
      if (error) reject(error);
      else resolve(output);
    };
    const abort = () => done(signal.reason instanceof Error ? signal.reason : new DOMException('Compression cancelled. Attach the file again to retry.', 'AbortError'));
    if (signal.aborted) return abort();
    try {
      port = api.runtime.connect({ name: 'discord-autocompress' });
      port.onMessage.addListener((data) => {
        if (data?.id !== 1) return;
        if (data.type === 'progress') onProgress(data.message);
        if (data.type === 'error') done(new Error(data.message));
        if (data.type === 'result') {
          if (!(data.file instanceof Blob) || data.file.size > targetBytes || !data.file.size) {
            done(new Error('Compression did not produce a file below your target.'));
          } else {
            done(null, data.file);
          }
        }
      });
      port.onDisconnect.addListener(() => done(new Error(port.error?.message || 'The compression connection closed. Refresh Discord and try again.')));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => done(new Error(mode === 'video' ? 'Video processing took too long. Try a shorter or lower-resolution clip.' : 'Compression took too long. Try a smaller picture or shorter GIF.')), mode === 'video' ? VIDEO_TIMEOUT_MS + 5_000 : 180_000);
      port.postMessage({ id: 1, file, targetBytes, mode });
      // Firefox can suspend an event page despite an idle open port. Incoming
      // messages keep it active only while this bounded compression job runs.
      heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'keepalive' }); }
        catch { done(new Error('Compression was interrupted. Refresh Discord and try again.')); }
      }, 1000);
    } catch (error) { done(error); }
  });
}

function copyTransfer(files, strings, transfer = new window.DataTransfer()) {
  if (!transfer) throw new Error('This browser cannot prepare a replacement clipboard attachment.');
  // Populate through the page's native object as well: Firefox otherwise tags
  // DataTransfer items with the extension principal and hides them from the page.
  const pageTransfer = transfer.wrappedJSObject ?? transfer;
  // Firefox isolates content-script objects from page scripts. Native Files
  // returned through extension messaging must be cloned into the page's realm.
  for (const file of files) pageTransfer.items.add(typeof cloneInto === 'function' ? cloneInto(file, window) : file);
  for (const [type, value] of strings) {
    try { pageTransfer.setData(type, value); } catch { /* Unsupported clipboard flavor. */ }
  }
  return transfer;
}

function replay(target, type, files, strings, dragPosition) {
  let event;
  if (type === 'paste') {
    const transfer = copyTransfer(files, strings);
    event = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer });
    // Chrome uses the supplied transfer; Firefox creates its own instead.
    const actualTransfer = (event.wrappedJSObject ?? event).clipboardData;
    if (actualTransfer !== transfer) copyTransfer(files, strings, actualTransfer);
  } else if (type === 'change') {
    const transfer = copyTransfer(files, strings);
    target.files = transfer.files;
    const inputEvent = new window.Event('input', { bubbles: true, composed: true });
    replayEvents.add(inputEvent);
    target.dispatchEvent(inputEvent);
    event = new window.Event('change', { bubbles: true, composed: true });
  } else if (type === 'drop') {
    const transfer = copyTransfer(files, strings);
    event = new window.DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...dragPosition });
  }
  replayEvents.add(event);
  target.dispatchEvent(event);
}

async function processAttachment({ files, target, type, strings, dragPosition, route, input }) {
  const controller = new AbortController();
  activeJob = controller;
  const routeTimer = setInterval(() => {
    if (location.href !== route || !target.isConnected) {
      controller.abort(new Error('The channel or attachment control changed. Attach the files again in the intended channel.'));
    }
  }, 250);
  try {
    await ready;
    if (!api.runtime?.id) throw new Error('The extension was reloaded. Refresh Discord and attach again.');
    const targetBytes = getTargetBytes(settings);
    const output = [];
    let compressed = 0;
    let convertedGifs = 0;
    let originalSize = 0;
    let outputSize = 0;
    const enabled = settings.enabled;
    const videoEnabled = enabled && settings.videoEnabled;
    if (videoEnabled && files.some(file => isVideo(file) && file.size > MAX_VIDEO_BYTES)) {
      throw new Error('Videos larger than 200 MB are not supported. Choose a smaller file.');
    }
    for (const [index, file] of files.entries()) {
      if (controller.signal.aborted) throw new DOMException('Compression cancelled. Attach again to retry.', 'AbortError');
      const video = videoEnabled && isVideo(file);
      if (!enabled || (!video && (!isCompressible(file) || file.size <= targetBytes))) {
        output.push(file);
        continue;
      }
      showToast(`${video ? 'Checking video' : 'Compressing'} ${index + 1}/${files.length}: ${file.name}`, { busy: true });
      const result = await compressInWorker(file, targetBytes, controller.signal, (message) => {
        showToast(`${index + 1}/${files.length} · ${file.name} · ${message || 'Compressing…'}`, { busy: true });
      }, video ? 'video' : 'image');
      output.push(result);
      if (video && result.type === 'image/gif') convertedGifs++;
      if (file.size > targetBytes) {
        compressed++;
        originalSize += file.size;
        outputSize += result.size;
      }
    }
    if (controller.signal.aborted) throw new DOMException('Compression cancelled. Attach again to retry.', 'AbortError');
    if (location.href !== route || !target.isConnected) {
      throw new Error('The channel or attachment control changed during compression. Attach the files again in the intended channel.');
    }
    replay(target, type, output, strings, dragPosition);
    if (convertedGifs) showToast(`${convertedGifs} GIF${convertedGifs === 1 ? '' : 's'} ready, without sound. Review the attachment before sending.`);
    else if (compressed) showToast(`${compressed} file${compressed === 1 ? '' : 's'} ready: ${formatBytes(originalSize)} → ${formatBytes(outputSize)}. Review the attachment before sending.`);
    else if (videoEnabled && files.some(isVideo)) showToast('Video checked and ready. Review the attachment before sending.');
  } catch (error) {
    // Cancel the whole batch rather than attaching an oversized original by mistake.
    if (input?.isConnected) input.value = '';
    showToast(`${error.message || 'Could not compress this file.'} This batch was not attached.`, { error: true });
  } finally { clearInterval(routeTimer); activeJob = null; }
}

function intercept(event) {
  if (replayEvents.has(event) || (settingsLoaded && !settings.enabled)) return;
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target || target.closest('#discord-autocompress-status')) return;
  let transfer;
  let files;
  let input;
  if (event.type === 'change' || event.type === 'input') {
    if (!(target instanceof HTMLInputElement) || target.type !== 'file') return;
    // Discord's chat attachment picker allows multiple files; avoid profile/avatar controls.
    if (!target.multiple) return;
    input = target;
    files = Array.from(input.files ?? []);
  } else {
    if (event.type === 'paste' && !target.closest('[contenteditable="true"], textarea')) return;
    transfer = event.type === 'drop' ? event.dataTransfer : event.clipboardData;
    files = Array.from(transfer?.files ?? []);
  }
  const threshold = settingsLoaded ? getTargetBytes(settings) : getTargetBytes({ targetMB: 1 });
  if (!files.some((file) => (isCompressible(file) && file.size > threshold) || (isVideo(file) && (!settingsLoaded || settings.videoEnabled)))) return;
  // DataTransfer is only readable synchronously during the trusted browser event.
  const strings = [];
  if (transfer) for (const type of transfer.types) {
    if (type !== 'Files') {
      try { strings.push([type, transfer.getData(type)]); } catch { /* Skip unreadable flavors. */ }
    }
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  // Native pickers emit input before change. Hide the oversized originals from
  // both events, and start the single compression job from change.
  if (event.type === 'input') return;
  if (activeJob) {
    if (input) input.value = '';
    showToast('An attachment is already being compressed. Wait for it to finish, then attach these files again.', { busy: true });
    return;
  }
  void processAttachment({ files, target, type: event.type, strings, input,
    dragPosition: { clientX: event.clientX, clientY: event.clientY }, route: location.href });
}

for (const name of ['input', 'change', 'drop', 'paste']) window.addEventListener(name, intercept, true);
window.addEventListener('pagehide', () => { activeJob?.abort(); clearTimeout(toastTimer); }, { once: true });
