// Reuse the complete attachment and video suites against the Chrome build.
import { spawn } from 'node:child_process';

for (const script of ['scripts/browser-check.mjs', 'scripts/video-browser-check.mjs']) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, TEST_BROWSER: 'chrome' } });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
