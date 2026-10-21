import { zipSync } from 'fflate';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// JSZip uses local date fields for ZIP timestamps; UTC keeps them stable across hosts.
process.env.TZ = 'UTC';
const archiveDate = new Date('1980-01-01T00:00:00Z');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('artifacts', { recursive: true });

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

async function packageDirectory(source, filename) {
  const files = (await listFiles(source)).sort();
  const archiveFiles = {};
  for (const filePath of files) {
    const relativePath = path.relative(source, filePath).split(path.sep).join('/');
    archiveFiles[relativePath] = await readFile(filePath);
  }
  const bytes = zipSync(archiveFiles, { level: 9, mtime: archiveDate });
  await writeFile(path.join('artifacts', filename), bytes);
  console.log(`Created artifacts/${filename}`);
}

await packageDirectory('dist', `discord_autocompress-${version}.zip`);
await packageDirectory('dist-chrome', `discord_autocompress-chrome-${version}.zip`);
