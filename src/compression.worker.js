import { compressFile } from './compression.js';

self.addEventListener('message', async ({ data }) => {
  const { id, file, targetBytes } = data || {};
  try {
    const result = await compressFile(file, {
      targetBytes,
      onProgress: ({ message, progress }) => self.postMessage({ id, type: 'progress', message, progress }),
    });
    self.postMessage({ id, type: 'result', file: result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : 'Image compression failed.' });
  }
});
