// Real bundled-WASM checks in an isolated Zen/Firefox profile and local page.
// Native ffmpeg/ffprobe only generate fixtures and independently inspect output.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { By } from 'selenium-webdriver';
import { launchExtensionBrowser, openExtensionPopup, browserDiagnostics, browserFamily } from './test-browser.mjs';
import { parseGIF, decompressFrame } from 'gifuct-js';

const run = promisify(execFile);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const uuid = '4bec0c2a-8a71-40f0-aa89-0db158766ae8';
const work = await mkdtemp(join(tmpdir(), 'discord-video-check-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Video attachment harness</title></head>
<body style="background:#202126;color:white;font:16px system-ui;padding:40px">
<h1>Video attachment harness</h1><input id="upload" type="file" multiple>
<input id="drop-source" type="file" hidden>
<div id="composer" contenteditable="true" role="textbox" style="border:1px solid #aaa;padding:24px">Drop here</div>
<script>
window.received=[];window.results=[];window.attachments=[];window.errors=[];
addEventListener('error',e=>window.errors.push(e.message));
addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
for(const type of ['change','drop','paste']) document.addEventListener(type,async e=>{
  if(type==='change'&&e.target.id!=='upload')return;
  const files=Array.from(e.target.files||e.dataTransfer?.files||e.clipboardData?.files||[]);
  if(!files.length)return;e.preventDefault();window.attachments=files;
  const entry={type,files:files.map(f=>({name:f.name,size:f.size,type:f.type})),text:e.dataTransfer?.getData('text/plain')||e.clipboardData?.getData('text/plain')||''};window.received.push(entry);
  const hashes=await Promise.all(files.map(async f=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')));
  window.results.push({entry,hashes});
});
</script></body></html>`;
const server = createServer((_, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:");
  response.end(html);
});
let driver;
let binary;
let settingsHandle;
let uploadHandle;
const settings = { enabled: true, videoEnabled: false, videoGifEnabled: false, targetMB: 1 };
let url;

async function fixture(name, args) {
  const path = join(work, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', ...args, '-threads', '1', path], { timeout: 60_000 });
  return path;
}
async function metadata(path) {
  return JSON.parse((await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path])).stdout);
}
async function setSettings(patch) {
  Object.assign(settings, patch);
  await driver.switchTo().window(settingsHandle);
  await driver.executeAsyncScript('(globalThis.browser??globalThis.chrome).storage.local.set({settings:arguments[0]}).then(arguments[arguments.length-1])', settings);
  await driver.switchTo().window(uploadHandle);
}
async function reset() {
  await driver.executeScript(`window.received=[];window.results=[];window.attachments=[];window.errors=[];document.querySelector('#upload').value='';document.querySelector('#discord-autocompress-status')?.remove();`);
}
async function upload(paths) {
  await driver.findElement(By.id('upload')).sendKeys([paths].flat().join('\n'));
}
async function state() {
  return driver.executeScript(`return {received:window.received,results:window.results,errors:window.errors,status:document.querySelector('#discord-autocompress-status')?.getAttribute('aria-label')}`);
}
async function waitForOutcome(expectError = false, timeout = 180_000) {
  let outcome;
  let lastStatus;
  await driver.wait(async () => {
    outcome = await state();
    if (outcome.errors.length) throw new Error(outcome.errors.join('; '));
    if (process.env.VERBOSE_BROWSER_CHECK && outcome.status !== lastStatus) {
      lastStatus = outcome.status;
      if (lastStatus) console.log('Video status:', lastStatus);
    }
    if (outcome.status?.includes('not attached')) {
      if (!expectError) throw new Error(outcome.status);
      return true;
    }
    if (outcome.results.length) {
      if (expectError) throw new Error('The rejected video was attached.');
      return true;
    }
    return false;
  }, timeout);
  return outcome;
}
async function cancel() {
  const host = await driver.findElement(By.id('discord-autocompress-status'));
  const bounds = await host.getRect();
  await driver.actions().move({ origin: host, x: Math.floor(bounds.width / 2) - 50, y: 0 }).click().perform();
}
async function saveResult(name = 'encoded.mp4') {
  const encoded = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];const r=new FileReader();r.onload=()=>done(r.result.split(',')[1]);r.readAsDataURL(window.attachments[0]);`);
  const path = join(work, name);
  await writeFile(path, Buffer.from(encoded, 'base64'));
  return path;
}

async function inspectGif(name, expectedDuration) {
  const path = await saveResult(name);
  const bytes = await readFile(path);
  assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/);
  assert.ok(bytes.length <= 990_000);
  const info = await metadata(path);
  assert.equal(info.streams[0].codec_name, 'gif');
  assert.equal(info.streams.some(stream => stream.codec_type === 'audio'), false);
  const parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const frames = parsed.frames.filter(frame => frame.image);
  assert.ok(frames.length > 1, 'converted GIF stays animated');
  assert.ok(new Set(decompressFrame(frames[0], parsed.gct).pixels).size > 8, 'GIF contains real image data');
  const duration = frames.reduce((sum, frame) => sum + frame.gce.delay / 100, 0);
  assert.ok(Math.abs(duration - expectedDuration) <= 0.25, `GIF duration ${duration}s retains ${expectedDuration}s clip`);
  assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), 'converted GIF loops');
  return { info, frames };
}

try {
  const clip = await fixture('SPOILER_clip.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-vf', 'noise=alls=50:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
  ]);
  const tiny = await fixture('small.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-an']);
  const long = await fixture('long.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1', '-t', '121', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-an']);
  const portrait = await fixture('portrait.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '4', '-vf', 'noise=alls=50:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-an']);
  const shortMkv = await fixture('SPOILER_short.mkv', [
    '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  ]);
  const shortWebm = await fixture('short-webm.webm', [
    '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=12', '-t', '2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-an',
  ]);
  const atBoundary = await fixture('thirty-seconds.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=1', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-an']);
  const note = join(work, 'note.txt');
  await writeFile(note, 'keep accompanying files unchanged');
  const huge = join(work, 'huge.mp4');
  const sparse = await open(huge, 'w');
  await sparse.truncate(200_000_001);
  await sparse.close();
  assert.ok((await stat(clip)).size > 990_000);
  assert.ok((await stat(portrait)).size > 990_000);
  assert.ok((await stat(long)).size < 990_000);
  assert.ok((await stat(shortMkv)).size < 990_000);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/channels/video-test`;
  const session = await launchExtensionBrowser(work, uuid);
  ({ driver, binary } = session);
  await openExtensionPopup(driver, session.id);
  settingsHandle = await driver.getWindowHandle();
  await driver.wait(async () => driver.executeScript('return document.querySelector("#video-enabled") && !document.querySelector("#video-enabled").disabled'), 5000);
  assert.equal(await driver.findElement(By.id('video-enabled')).isSelected(), false, 'video defaults off');
  assert.equal(await driver.findElement(By.id('video-gif-enabled')).isSelected(), false, 'GIF conversion defaults off');
  assert.equal(await driver.findElement(By.id('video-gif-enabled')).isEnabled(), false, 'GIF conversion requires videos enabled');
  await driver.switchTo().newWindow('tab');
  uploadHandle = await driver.getWindowHandle();
  await setSettings({});
  await driver.get(url);

  await upload([clip, note]);
  let outcome = await waitForOutcome();
  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.results[0].hashes[0], hash(await readFile(clip)));
  assert.equal(outcome.results[0].hashes[1], hash(await readFile(note)));
  console.log('PASS video opt-out preserves oversized MP4 and accompanying file');

  await setSettings({ enabled: false, videoEnabled: true });
  await reset();
  await upload(clip);
  assert.equal((await waitForOutcome()).results[0].hashes[0], hash(await readFile(clip)));
  console.log('PASS global disabled bypasses video processing');

  await setSettings({ enabled: true, videoEnabled: true });
  await reset();
  await upload([huge, note]);
  outcome = await waitForOutcome(true, 5000);
  assert.match(outcome.status, /200 MB/);
  assert.equal(outcome.received.length, 0);
  console.log('PASS >200 MB rejects entire batch before encoder load');

  // Cancel the first cold FFmpeg load, then verify a new job can load correctly.
  await reset();
  await upload(clip);
  await cancel();
  outcome = await waitForOutcome(true, 5000);
  assert.match(outcome.status, /cancelled/);
  assert.equal(outcome.received.length, 0);
  console.log('PASS cancellation during cold load attaches nothing');

  await reset();
  await upload(long);
  outcome = await waitForOutcome(true, 60_000);
  assert.match(outcome.status, /120|2 minute|2-minute|two minute/i);
  assert.equal(outcome.received.length, 0);
  console.log('PASS >120 seconds rejects even a file already under the target');

  await reset();
  await upload(tiny);
  outcome = await waitForOutcome(false, 60_000);
  assert.equal(outcome.results[0].hashes[0], hash(await readFile(tiny)));
  assert.equal(outcome.received[0].files[0].name, 'small.mp4');
  console.log('PASS valid small video stays byte-for-byte unchanged');

  await reset();
  await driver.findElement(By.id('drop-source')).sendKeys(clip);
  await driver.executeScript(`
    const dt=new DataTransfer();dt.items.add(document.querySelector('#drop-source').files[0]);
    dt.items.add(new File(['keep accompanying files unchanged'],'note.txt',{type:'text/plain'}));dt.setData('text/plain','video caption');
    document.querySelector('#composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
  `);
  outcome = await waitForOutcome();
  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.received[0].type, 'drop');
  assert.equal(outcome.received[0].text, 'video caption');
  assert.equal(outcome.received[0].files[0].type, 'video/mp4');
  assert.match(outcome.received[0].files[0].name, /^SPOILER_.*\.mp4$/);
  assert.ok(outcome.received[0].files[0].size <= 990_000);
  assert.equal(outcome.results[0].hashes[1], hash(await readFile(note)));
  const resultInfo = await metadata(await saveResult());
  const video = resultInfo.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(resultInfo.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  assert.ok(Math.abs(Number(resultInfo.format.duration) - 6) < 0.2);
  assert.ok(video.width <= 1280 && video.height <= 720);
  console.log('PASS actual bundled WASM: MP4 → smaller H.264/AAC MP4 with duration and spoiler name retained');

  await reset();
  await upload(portrait);
  outcome = await waitForOutcome();
  assert.ok(outcome.received[0].files[0].size <= 990_000);
  const portraitInfo = await metadata(await saveResult('portrait-result.mp4'));
  const portraitVideo = portraitInfo.streams.find(stream => stream.codec_type === 'video');
  assert.ok(portraitVideo.height > portraitVideo.width);
  assert.equal(portraitInfo.streams.some(stream => stream.codec_type === 'audio'), false);
  console.log('PASS portrait aspect retained and silent video gains no artificial audio');

  // Keep one job active while another tab requests the encoder.
  await reset();
  await upload(clip);
  const firstHandle = uploadHandle;
  await driver.switchTo().newWindow('tab');
  const secondHandle = await driver.getWindowHandle();
  await driver.get(url);
  await upload(clip);
  outcome = await waitForOutcome(true, 10_000);
  assert.match(outcome.status, /another video|already being processed/i);
  assert.equal(outcome.received.length, 0);
  await driver.switchTo().window(firstHandle);
  await cancel();
  assert.match((await waitForOutcome(true, 5000)).status, /cancelled/);
  await driver.switchTo().window(secondHandle);
  uploadHandle = secondHandle;
  await reset();
  await upload(tiny);
  assert.equal((await waitForOutcome(false, 60_000)).results[0].hashes[0], hash(await readFile(tiny)));
  console.log('PASS global video slot, cancellation and immediate retry across tabs');

  if (browserFamily === 'chrome') {
    for (const interruption of ['offscreen', 'service worker']) {
      await reset();
      await upload(clip);
      await driver.wait(async () => {
        const current = await state();
        if (current.status?.includes('not attached')) throw new Error(current.status);
        return current.status?.includes('Compressing video');
      }, 60_000, 'video encoding starts before interruption', 50);
      if (interruption === 'offscreen') {
        await driver.switchTo().window(settingsHandle);
        await driver.executeAsyncScript('chrome.offscreen.closeDocument().then(arguments[arguments.length-1])');
        await driver.switchTo().window(uploadHandle);
      } else {
        await driver.sendAndGetDevToolsCommand('ServiceWorker.enable', {});
        await driver.sendAndGetDevToolsCommand('ServiceWorker.stopAllWorkers', {});
      }
      outcome = await waitForOutcome(true, 15_000);
      assert.equal(outcome.received.length, 0);
      await reset();
      await upload(tiny);
      assert.equal((await waitForOutcome(false, 60_000)).results[0].hashes[0], hash(await readFile(tiny)));
      console.log(`PASS interrupted Chrome ${interruption} aborts safely and a fresh video job succeeds`);
    }
  }

  await setSettings({ videoGifEnabled: true });
  await reset();
  await upload([clip, note]);
  outcome = await waitForOutcome();
  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.received[0].files[0].name, 'SPOILER_clip.gif');
  assert.equal(outcome.received[0].files[0].type, 'image/gif');
  assert.equal(outcome.results[0].hashes[1], hash(await readFile(note)));
  const gifInfo = await inspectGif('converted-mp4.gif', 6);
  assert.ok(gifInfo.info.streams[0].width <= 480 && gifInfo.info.streams[0].height <= 480);
  console.log('PASS MP4 → silent looping animated GIF within target, full visual duration and spoiler/mixed batch retained');

  await reset();
  await driver.findElement(By.id('drop-source')).sendKeys(shortMkv);
  await driver.executeScript(`
    const dt=new DataTransfer();dt.items.add(document.querySelector('#drop-source').files[0]);dt.setData('text/plain','GIF caption');
    document.querySelector('#composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
  `);
  outcome = await waitForOutcome();
  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.received[0].type, 'drop');
  assert.equal(outcome.received[0].text, 'GIF caption');
  assert.equal(outcome.received[0].files[0].name, 'SPOILER_short.gif');
  assert.equal(outcome.received[0].files[0].type, 'image/gif');
  const mkvGif = await inspectGif('converted-mkv.gif', 2);
  assert.ok(mkvGif.info.streams[0].height > mkvGif.info.streams[0].width);
  console.log('PASS under-target MKV → portrait GIF via drop with caption retained');

  await reset();
  await driver.findElement(By.id('drop-source')).sendKeys(shortWebm);
  await driver.executeScript(`
    const dt=new DataTransfer();dt.items.add(document.querySelector('#drop-source').files[0]);dt.setData('text/plain','WebM GIF caption');
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});
    if(event.clipboardData!==dt){event.clipboardData.items.add(document.querySelector('#drop-source').files[0]);event.clipboardData.setData('text/plain','WebM GIF caption');}
    document.querySelector('#composer').dispatchEvent(event);
  `);
  outcome = await waitForOutcome();
  assert.equal(outcome.received.length, 1);
  assert.equal(outcome.received[0].type, 'paste');
  assert.equal(outcome.received[0].text, 'WebM GIF caption');
  assert.equal(outcome.received[0].files[0].name, 'short-webm.gif');
  assert.equal(outcome.received[0].files[0].type, 'image/gif');
  await inspectGif('converted-webm.gif', 2);
  console.log('PASS WebM → animated GIF through paste with caption retained');

  await reset();
  await upload(atBoundary);
  outcome = await waitForOutcome();
  assert.equal(outcome.received[0].files[0].type, 'video/mp4');
  assert.equal(outcome.results[0].hashes[0], hash(await readFile(atBoundary)));
  console.log('PASS exactly 30 seconds keeps normal video behavior, without truncation or GIF conversion');

  await reset();
  await upload(clip);
  await cancel();
  outcome = await waitForOutcome(true, 5000);
  assert.equal(outcome.received.length, 0);
  console.log('PASS GIF conversion cancellation attaches nothing');

  await setSettings({ videoGifEnabled: false });
  await reset();
  await upload(shortMkv);
  assert.equal((await waitForOutcome()).results[0].hashes[0], hash(await readFile(shortMkv)));
  console.log('PASS disabling GIF mode restores exact under-target MKV passthrough');

  await driver.switchTo().window(settingsHandle);
  await driver.navigate().refresh();
  await driver.wait(async () => driver.findElement(By.id('video-gif-enabled')).isEnabled(), 5000);
  await driver.findElement(By.css('label[for="video-gif-enabled"]')).click();
  await driver.wait(async () => driver.executeAsyncScript('(globalThis.browser??globalThis.chrome).storage.local.get("settings").then(r=>arguments[arguments.length-1](r.settings.videoGifEnabled===true))'), 5000);
  await driver.navigate().refresh();
  assert.equal(await driver.findElement(By.id('video-gif-enabled')).isSelected(), true, 'GIF preference persists across popup opens');
  await driver.manage().window().setRect({ width: 650, height: 750 });
  assert.ok(await driver.executeScript('return document.body.scrollHeight <= 600'), 'popup fits within the browser popup height limit');
  await mkdir('output/browser', { recursive: true });
  await writeFile('output/browser/video-popup.png', await driver.findElement(By.css('body')).takeScreenshot(), 'base64');
  console.log(`Video checks passed using ${binary || browserFamily}; encoder assets came from the extension package.`);
} catch (error) {
  if (driver) {
    console.error('Video harness state:', await state().catch(() => 'unavailable'));
    console.error('Browser diagnostic:', await browserDiagnostics(driver).catch(() => 'unavailable'));
  }
  throw error;
} finally {
  await driver?.quit();
  server.close();
  await rm(work, { recursive: true, force: true });
}
