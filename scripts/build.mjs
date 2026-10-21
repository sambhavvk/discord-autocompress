import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const licenseFiles = ['gifenc/LICENSE.md', 'gifuct-js/LICENSE', 'js-binary-schema-parser/LICENSE'];
const licenses = await Promise.all(licenseFiles.map(async (path) => {
  return `\n## ${path.split('/')[0]}\n\n${await readFile(`node_modules/${path}`, 'utf8')}`;
}));

async function buildCommon(output, target) {
  await mkdir(output, { recursive: true });
  await mkdir(`${output}/ffmpeg`, { recursive: true });
  await build({
    entryPoints: ['src/content.js', 'src/popup.js', 'src/compression.worker.js'],
    outdir: output, bundle: true, format: 'iife', target: [target],
    legalComments: 'eof', logLevel: 'info',
  });
  await build({
    entryPoints: ['src/ffmpeg.worker.js'],
    outfile: `${output}/ffmpeg/worker.js`, bundle: true, format: 'esm',
    platform: 'browser', target: [target], legalComments: 'eof', logLevel: 'info',
    external: ['./ffmpeg-core.js'],
  });
  for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    await cp(`node_modules/@ffmpeg/core/dist/esm/${file}`, `${output}/ffmpeg/${file}`);
  }
  for (const file of ['popup.html', 'popup.css', 'icons']) {
    await cp(`src/${file}`, `${output}/${file}`, { recursive: true });
  }
  await writeFile(`${output}/THIRD_PARTY_LICENSES.txt`, licenses.join('\n'));
  await cp('licenses', `${output}/licenses`, { recursive: true });
}

await rm('dist', { recursive: true, force: true });
await buildCommon('dist', 'firefox140');
await build({
  entryPoints: ['src/background.js'], outdir: 'dist', bundle: true,
  format: 'esm', platform: 'browser', target: ['firefox140'],
  legalComments: 'eof', logLevel: 'info',
});
await cp('manifest.json', 'dist/manifest.json');

await rm('dist-chrome', { recursive: true, force: true });
await buildCommon('dist-chrome', 'chrome116');
await build({
  entryPoints: ['src/chrome-background.js', 'src/chrome-offscreen.js'],
  outdir: 'dist-chrome', bundle: true, format: 'esm', platform: 'browser',
  target: ['chrome116'], legalComments: 'eof', logLevel: 'info',
});
await cp('src/chrome-offscreen.html', 'dist-chrome/chrome-offscreen.html');
await cp('manifest.chrome.json', 'dist-chrome/manifest.json');

console.log('Zen/Firefox extension built in dist/');
console.log('Chrome extension built in dist-chrome/');
