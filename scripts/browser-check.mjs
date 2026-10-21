// Runs a temporary test copy in an isolated profile; never touches your browser profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { By } from 'selenium-webdriver';
import { launchExtensionBrowser, openExtensionPopup, browserDiagnostics, browserFamily } from './test-browser.mjs';
import gifenc from 'gifenc';
import { parseGIF, decompressFrame } from 'gifuct-js';
const { GIFEncoder } = gifenc;
const uuid = 'd64db221-4b97-48dd-af9e-519786adcc30';
const work = await mkdtemp(join(tmpdir(), 'discord-autocompress-test-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Attachment harness</title></head>
<body style="background:#202126;color:white;font:16px system-ui;padding:40px">
<h1>Discord attachment harness</h1><input id="upload" type="file" multiple>
<div id="composer" role="textbox" contenteditable="true" style="border:1px solid #aaa;padding:20px;margin:20px 0">Paste or drop here</div>
<pre id="result"></pre><script>
window.received = []; window.readyResults = []; window.errors = []; window.inputSizes = []; window.traces = [];
addEventListener('error',e=>window.errors.push(e.message));
addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
document.addEventListener('input',e=>{if(e.target.files) window.inputSizes.push(Array.from(e.target.files,f=>f.size));});
for (const name of ['change', 'drop', 'paste']) document.addEventListener(name, async event => {
  const files = Array.from(event.target.files || event.dataTransfer?.files || event.clipboardData?.files || []);
  window.traces.push({type:name,fileCount:files.length,hasTransfer:!!(event.dataTransfer||event.clipboardData)});
  if (!files.length) return;
  event.preventDefault();
  const entry = { type: name, files: files.map(f=>({name:f.name,size:f.size,type:f.type})), text: event.clipboardData?.getData('text/plain') || event.dataTransfer?.getData('text/plain') || '' };
  window.received.push(entry);
  window.readyResults.push(await Promise.all(files.map(f=>new Promise((resolve,reject)=>{
    const reader = new FileReader(); reader.onload=()=>resolve({name:f.name,base64:reader.result.split(',')[1]}); reader.onerror=reject; reader.readAsDataURL(f);
  }))));
  document.querySelector('#result').textContent=JSON.stringify(entry,null,2);
});
</script></body></html>`;
const server = createServer((_, res) => {
  res.setHeader('Content-Type', 'text/html');
  // Exercise extension execution under a restrictive host page CSP.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:");
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/channels/test`;
let driver;
let binary;
async function waitResult() {
  let lastStatus = '';
  try {
    await driver.wait(async () => {
      const state = await driver.executeScript('return {ready:window.readyResults.length>0,error:document.querySelector("#discord-autocompress-status")?.getAttribute("aria-label"),pageErrors:window.errors,traces:window.traces}');
      if (state.traces.some(t=>t.fileCount===0 && !t.type.startsWith('before-'))) throw new Error('Page received an event with no visible files');
      if (process.env.VERBOSE_BROWSER_CHECK && state.error && lastStatus !== state.error) {
        lastStatus = state.error;
        console.log('Attachment status:', state.error);
      }
      if (state.pageErrors.length) throw new Error(`Page error: ${state.pageErrors.join('; ')}`);
      if (state.error?.includes('not attached')) throw new Error(state.error);
      return state.ready;
    }, 185_000);
  } catch (error) {
    const status = await driver.executeScript('return document.querySelector("#discord-autocompress-status")?.getAttribute("aria-label")');
    const traces = await driver.executeScript('return window.traces');
    throw new Error(`No attachment received: ${status || ''}; ${error.message}; traces=${JSON.stringify(traces)}`);
  }
  return driver.executeScript('return { entry: window.received.at(-1), outputs: window.readyResults.at(-1), count: window.received.length }');
}
async function reset() {
  await driver.executeScript('window.received=[]; window.readyResults=[]; window.traces=[]; document.querySelector("#upload").value="";');
}
try {
  const session = await launchExtensionBrowser(work, uuid);
  ({ driver, binary } = session);
  await openExtensionPopup(driver, session.id);
  await driver.wait(async () => {
    const controls = await driver.findElements(By.id('target-mb'));
    return controls.length > 0 && await controls[0].isEnabled();
  }, 5000);
  await driver.executeAsyncScript('(globalThis.browser??globalThis.chrome).storage.local.set({settings:{enabled:true,targetMB:1}}).then(arguments[arguments.length-1])');
  await driver.manage().window().setRect({ width: 600, height: 750 });
  await mkdir('output/browser', { recursive: true });
  await writeFile('output/browser/popup.png', await driver.takeScreenshot(), 'base64');
  await driver.get(url);

  const png = await driver.executeAsyncScript(`
    const done=arguments[arguments.length-1];
    const canvas=document.createElement('canvas'); canvas.width=1024; canvas.height=1024;
    const ctx=canvas.getContext('2d'), frame=ctx.createImageData(1024,1024);
    let seed=12345;
    for(let i=0;i<frame.data.length;i+=4){ seed=(Math.imul(seed,1664525)+1013904223)>>>0; frame.data[i]=seed&255; frame.data[i+1]=(seed>>>8)&255; frame.data[i+2]=(seed>>>16)&255; frame.data[i+3]=i%20===0?0:255; }
    ctx.putImageData(frame,0,0); done(canvas.toDataURL('image/png').split(',')[1]);
  `);
  const pngPath = join(work, 'SPOILER_noise.png');
  await writeFile(pngPath, Buffer.from(png, 'base64'));
  const notePath = join(work, 'note.txt');
  await writeFile(notePath, 'keep this file exactly');
  await driver.findElement(By.id('upload')).sendKeys(`${pngPath}\n${notePath}`);
  const picker = await waitResult();
  assert.equal(picker.count, 1, 'original event must not reach the page');
  assert.equal(picker.entry.files[0].type, 'image/webp');
  assert.match(picker.entry.files[0].name, /^SPOILER_.*\.webp$/);
  assert.ok(picker.entry.files[0].size <= 990_000);
  assert.equal(Buffer.from(picker.outputs[1].base64, 'base64').toString(), 'keep this file exactly');
  assert.deepEqual(await driver.executeScript('return window.inputSizes'), [picker.entry.files.map(f=>f.size)], 'input listeners only see the replaced files');
  const alpha = await driver.executeAsyncScript(`
    const done=arguments[arguments.length-1], bytes=Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0));
    createImageBitmap(new Blob([bytes],{type:'image/webp'})).then(bitmap=>{
      const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);
      const data=ctx.getImageData(0,0,2,1).data;bitmap.close();done([data[3],data[7]]);
    });
  `, picker.outputs[0].base64);
  assert.deepEqual(alpha, [0, 255], 'transparent and opaque pixels retained');
  console.log('PASS picker: oversized PNG → WebP, spoiler prefix and mixed batch preserved');

  const gif = GIFEncoder();
  let seed = 23;
  for (let frame = 0; frame < 36; frame++) {
    const pixels = new Uint8Array(240 * 240);
    const palette = Array.from({ length: 256 }, (_, i) => [i, (i * 97) % 256, (i * 53) % 256]);
    for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
    gif.writeFrame(pixels, 240, 240, { palette, delay: 50, repeat: 2 });
  }
  gif.finish();
  assert.ok(gif.bytes().length > 990_000, 'fixture must require compression');
  const gifPath = join(work, 'animation.gif');
  await writeFile(gifPath, gif.bytes());
  await reset();
  await driver.findElement(By.id('upload')).sendKeys(gifPath);
  const animated = await waitResult();
  assert.ok(animated.entry.files[0].size <= 990_000);
  assert.equal(animated.entry.files[0].type, 'image/gif');
  const animatedBytes = Uint8Array.from(Buffer.from(animated.outputs[0].base64, 'base64'));
  const parsed = parseGIF(animatedBytes.buffer);
  const frames = parsed.frames.filter(f => f.image);
  assert.ok(frames.length > 1, 'GIF stays animated');
  assert.ok(new Set(decompressFrame(frames[0], parsed.gct).pixels).size > 8, 'GIF image data is not blank');
  assert.equal(frames.reduce((total, f) => total + f.gce.delay * 10, 0), 1800, 'full duration retained');
  const loop = parsed.frames.find(f => f.application?.id === 'NETSCAPE2.0').application.blocks;
  assert.equal(loop[1] | loop[2] << 8, 2, 'loop count retained');
  console.log('PASS GIF: stays animated, below target, full playback duration retained');

  for (const type of ['drop', 'paste']) {
    await reset();
    await driver.executeScript(`
      const raw=atob(arguments[0]), bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([bytes],'clipboard.png',{type:'image/png'})); dt.setData('text/plain','caption');
      const event=arguments[1]==='drop' ? new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}) : new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});
      if(arguments[1]==='paste'&&event.clipboardData!==dt) { event.clipboardData.items.add(new File([bytes],'clipboard.png',{type:'image/png'})); event.clipboardData.setData('text/plain','caption'); }
      window.traces.push({type:'before-'+arguments[1],fileCount:(event.dataTransfer||event.clipboardData).files.length});
      document.querySelector('#composer').dispatchEvent(event);
    `, png, type);
    const result = await waitResult();
    assert.equal(result.count, 1);
    assert.equal(result.entry.type, type);
    assert.equal(result.entry.text, 'caption');
    assert.ok(result.entry.files[0].size <= 990_000);
    console.log(`PASS ${type}: compressed file and caption reach page once`);
  }

  await reset();
  await driver.findElement(By.id('upload')).sendKeys(notePath);
  assert.equal((await waitResult()).entry.files[0].name, 'note.txt');
  console.log('PASS unchanged small/unsupported files');

  await reset();
  await driver.findElement(By.id('upload')).sendKeys(gifPath);
  // Native pointer input also exercises the button inside its closed shadow root.
  const statusHost = await driver.findElement(By.id('discord-autocompress-status'));
  const statusBounds = await statusHost.getRect();
  await driver.actions().move({origin:statusHost,x:Math.floor(statusBounds.width/2)-50,y:0}).click().perform();
  await driver.wait(async () => driver.executeScript('return document.querySelector("#discord-autocompress-status")?.getAttribute("aria-label")?.includes("cancelled")'), 5000);
  assert.equal(await driver.executeScript('return window.received.length'), 0);
  console.log('PASS cancel stops the job without attaching originals');

  // Changing channels mid-compression must never replay into another destination.
  await reset();
  await driver.findElement(By.id('upload')).sendKeys(gifPath);
  await driver.executeScript(`location.hash='other-channel'`);
  await driver.wait(async () => driver.executeScript('return document.querySelector("#discord-autocompress-status")?.getAttribute("aria-label")?.includes("not attached")'), 45_000);
  assert.equal(await driver.executeScript('return window.received.length'), 0);
  console.log('PASS channel navigation cancels attachment delivery');
  console.log(`Browser checks passed using ${binary || browserFamily}. Popup screenshot: output/browser/popup.png`);
} catch (error) {
  if (driver) {
    console.error('Browser diagnostic:', await browserDiagnostics(driver));
  }
  throw error;
} finally {
  await driver?.quit();
  server.close();
  await rm(work, { recursive: true, force: true });
}
