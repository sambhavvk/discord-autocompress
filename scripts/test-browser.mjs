// Isolated extension browser sessions shared by the attachment harnesses.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import chrome from 'selenium-webdriver/chrome.js';
import { download } from 'geckodriver';

export const browserFamily = process.env.TEST_BROWSER === 'chrome' ? 'chrome' : 'firefox';

async function testingChrome() {
  const root = join(homedir(), '.cache/discord-autocompress-cft');
  const versions = await readdir(root).catch(() => []);
  for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const binary = join(root, version, 'chrome-linux64/chrome');
    const driver = join(root, version, 'chromedriver-linux64/chromedriver');
    if (existsSync(binary) && existsSync(driver)) return { binary, driver };
  }
  return {};
}

export async function launchExtensionBrowser(work, uuid) {
  const extension = join(work, 'extension');
  await cp(browserFamily === 'chrome' ? 'dist-chrome' : 'dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  let id = uuid;
  let driver;
  let binary;
  if (browserFamily === 'chrome') {
    // A test-only public key gives this temporary extension a known ID.
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicKeyEncoding: { type: 'spki', format: 'der' } });
    manifest.key = publicKey.toString('base64');
    id = createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    const cached = await testingChrome();
    binary = process.env.CHROME_BINARY || cached.binary;
    const options = new chrome.Options().addArguments(
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    );
    if (binary) options.setChromeBinaryPath(binary);
    const driverPath = process.env.CHROMEDRIVER_BINARY || cached.driver;
    let builder = new Builder().forBrowser('chrome').setChromeOptions(options);
    if (driverPath) builder = builder.setChromeService(new chrome.ServiceBuilder(driverPath));
    driver = await builder.build();
  } else {
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    binary = process.env.BROWSER_BINARY || [
      '/opt/zen-browser-bin/zen-bin', '/usr/lib/zen-browser/zen-bin', '/opt/zen/zen', '/usr/bin/firefox',
    ].find(existsSync);
    const options = new firefox.Options().addArguments('-headless')
      .setPreference('extensions.webextensions.uuids', JSON.stringify({ [manifest.browser_specific_settings.gecko.id]: uuid }))
      .setPreference('browser.shell.checkDefaultBrowser', false);
    if (binary) options.setBinary(binary);
    const service = new firefox.ServiceBuilder(await download(process.env.GECKODRIVER_VERSION || '0.37.1')).addArguments('--allow-system-access');
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
    await driver.installAddon(extension, true);
  }
  return { driver, binary, id };
}

export async function openExtensionPopup(driver, id) {
  if (browserFamily === 'chrome') {
    await driver.get(`chrome-extension://${id}/popup.html`);
  } else {
    // Firefox 156+ restricts direct WebDriver navigation to extension pages.
    const handlesBefore = new Set(await driver.getAllWindowHandles());
    await driver.setContext('chrome');
    await driver.executeScript('gBrowser.selectedTab=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});', `moz-extension://${id}/popup.html`);
    await driver.setContext('content');
    const handlesAfter = await driver.getAllWindowHandles();
    await driver.switchTo().window(handlesAfter.find(handle => !handlesBefore.has(handle)));
  }
}

export async function browserDiagnostics(driver) {
  if (browserFamily === 'chrome') {
    return driver.manage().logs().get('browser');
  }
  await driver.setContext('chrome');
  try {
    return await driver.executeScript('return Services.console.getMessageArray().map(m=>m.message).filter(m=>/AutoCompress|compression|background\\.js|DataClone|Permission denied/i.test(m)).slice(-25)');
  } finally { await driver.setContext('content'); }
}
