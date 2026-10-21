# Discord AutoCompress

Discord AutoCompress processes picture and GIF attachments locally in the browser, and can optionally compress videos before they are added to a Discord message. It supports Discord web in Zen, Firefox, and Chrome; it does not work in the Discord desktop app. It never sends a message for you: review the attachment in Discord and send it yourself. The same compression features are available in all three browsers.

The default target is 20 decimal MB, with a 1% safety margin, so the output target is 19.8 MB. You can choose a target from 1 to 20 MB. Discord's current [File Attachments FAQ](https://support.discord.com/hc/en-us/articles/25444343291031-File-Attachments-FAQ) describes the 20 MB free upload limit and notes that limits can vary by account or experiment.

## Install in Chrome

Download and extract the [Chrome ZIP from the latest release](https://github.com/sambhavvk/discord-autocompress/releases/latest). In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. Refresh Discord after loading the extension.

To build from source instead:

Use Node.js 22.19 or newer. From the project directory, install dependencies and build both browser versions:

```sh
npm install
npm run build
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the `dist-chrome/` directory. Open Discord and refresh the page so its content script loads. This is a local developer installation; this project does not currently publish through the Chrome Web Store.

## Install in Zen or Firefox

Download and extract the [Firefox/Zen ZIP from the latest release](https://github.com/sambhavvk/discord-autocompress/releases/latest). Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the extracted `manifest.json`. Refresh Discord after loading the extension.

To build from source instead:

Use Node.js 22.19 or newer. From the project directory, install dependencies and build the extension:

```sh
npm install
npm run build
```

In Zen or Firefox, open `about:debugging#/runtime/this-firefox`, choose **This Firefox**, then **Load Temporary Add-on**. Select `dist/manifest.json`. Open Discord and refresh the page so its content script loads.

This is a temporary developer installation. Firefox removes it when the browser restarts. For a lasting Firefox install, the extension needs to be packaged and signed by Mozilla; see Mozilla's [temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) and [publishing guide](https://extensionworkshop.com/documentation/publish/). This project does not currently publish through Mozilla Add-ons.

## Use

On Discord web, attach, drop, or paste a picture, GIF, or video. Supported pictures and GIFs are prepared when they are above the chosen target. Video compression is off by default; enable **Compress videos** in the popup to convert eligible videos to MP4. Optionally enable **Short videos → GIF** to convert MP4, MKV, and WebM clips strictly under 30 seconds to silent animated GIFs. These GIFs are reduced in resolution, frame rate, and color count as needed to fit the selected target size. With this option enabled, other video formats and MP4/MKV/WebM clips of 30 seconds or longer follow the normal MP4 conversion path. Check the attachment preview and send it when ready. Already-small pictures and GIFs are left unchanged.

Supported static image types are PNG, JPEG, WebP, BMP, and AVIF. Oversized static pictures are converted to WebP as needed to reach the target, which can reduce image quality or dimensions. Animated GIFs remain GIFs and keep their animation; compression may reduce quality or palette detail. Oversized animated WebP, APNG, and AVIF files are unsupported and report an error rather than being flattened into a still image.

With video compression enabled, input videos must be no longer than 2 minutes and no larger than 200 decimal MB. These hard limits also apply to small videos, including short-video GIF conversion. Eligible videos are converted to H.264/AAC MP4; the first audio stream is retained when present. Common containers include MP4, MOV, and WebM, but actual input support depends on the codecs in the bundled FFmpeg build. Unsupported codecs, invalid files, HDR video, and sources above 4K (about 8 megapixels) are rejected instead of silently producing a potentially unsuitable output. Conversion uses local CPU and may take several minutes. The original file on disk is not changed.

Video processing also limits frame rate to 60 fps and bounds the total decoded pixel workload. MP4 output starts at up to 720p/30 fps with stereo AAC audio; difficult clips may use lower dimensions or frame rates to fit. One video can run at a time across Discord tabs, with cancellation and a 10-minute processing timeout. Video files already below the target are returned unchanged after validation, except eligible clips are converted when **Short videos → GIF** is enabled.

The video toggle and **Short videos → GIF** option default off. The GIF option is available when video compression is enabled, and its preference is retained if video compression is turned off. The main **Automatic compression** switch controls all attachment handling: turning it off restores normal attachment behavior and bypasses the video size and duration caps.

The popup lets you turn automatic compression on or off and set the target size. Refresh Discord after installing or changing extension code. The extension only runs on Discord web at `discord.com`, `canary.discord.com`, and `ptb.discord.com`; it does not access the Discord desktop client.

## Development

Run the available project commands from the project directory:

```sh
npm run dev
npm test
npm run test:video
npm run test:browser
npm run test:chrome
npm run lint
npm run package
```

`npm run build` creates the Firefox/Zen extension in `dist/` and the Chrome extension in `dist-chrome/`. `npm run dev` builds both versions and launches the Firefox/Zen extension through `web-ext`. `npm run package` creates browser-specific ZIP files under `artifacts/`.
`npm run test:video` exercises the bundled video conversion path with local fixtures. This developer check needs native `ffmpeg` and `ffprobe` to generate fixtures and independently inspect output; the installed extension uses its packaged WASM and requires neither program.

The browser checks use fresh, isolated profiles and local attachment harnesses. Set `BROWSER_BINARY=/absolute/path/to/browser` to choose a Firefox-compatible executable. `npm run test:chrome` runs both attachment and video suites with Chrome for Testing or Chromium, because current regular Chrome builds restrict the command-line extension loading used by these tests. Set `CHROME_BINARY` and `CHROMEDRIVER_BINARY` to matching browser/driver executables. The helper also detects pairs under `~/.cache/discord-autocompress-cft/<version>/chrome-linux64/chrome` and `chromedriver-linux64/chromedriver`. The tests temporarily add localhost to a test copy of the manifest; the shipped extensions only run on Discord. An authenticated Discord send still needs a manual check.

## Implementation

The content script captures attachment events before Discord handles them. In Firefox and Zen it sends files over an extension port to a background page; Chrome uses its service worker and a local offscreen extension page to run packaged workers. Still images use browser codecs, GIF processing uses bundled `gifuct-js` / `gifenc`, and video conversion uses a bundled single-threaded FFmpeg/WASM build. All codecs and WASM assets ship with the extension; there is no CDN dependency, separate app, conversion server, or private Discord API call. Active jobs keep their browser processing connection available; cancel closes the connection and terminates processing.

Picture and GIF inputs above 128 MiB, still images above 32 million pixels, and GIFs above 600 frames or the decoded pixel budgets are rejected to limit memory use. GIF dimensions and frame counts are checked before decompression. Difficult GIFs can lose resolution, color detail, and frames while retaining playback duration. Video inputs use the separate 200 MB limit described above. Failures cancel the whole attachment batch, and changing channel during compression prevents it from attaching into another conversation.

The video setting is stored with the other extension settings. Video contents and temporary WASM processing data remain in memory and are not persisted. The bundled FFmpeg core is GPL-licensed; the package preserves its license and notices.
