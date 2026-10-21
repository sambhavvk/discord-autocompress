// GIF delays of 0 and 1 hundredths are displayed as 100 ms by browsers.
export function gifDelayMs(hundredths) {
  return hundredths < 2 ? 100 : hundredths * 10;
}

export function gifDelayParts(delayMs) {
  const parts = [];
  let remaining = delayMs;
  while (remaining > 655_350) {
    // A final 10 ms part would be clamped to 100 ms by browser GIF players.
    const part = remaining - 655_350 === 10 ? 655_340 : 655_350;
    parts.push(part);
    remaining -= part;
  }
  if (remaining > 0) parts.push(remaining);
  return parts;
}

// Keep complete display durations when dropping frames, including the final one.
export function gifTimeline(delays, stride = 1) {
  if (!delays.length) return [];
  const step = Math.max(1, Math.floor(stride));
  const selected = [];
  for (let index = 0; index < delays.length; index += step) selected.push(index);
  if (delays.length > 1 && selected.length === 1) selected.push(delays.length - 1);
  return selected.map((index, position) => ({
    index,
    delayMs: delays.slice(index, selected[position + 1] ?? delays.length)
      .reduce((total, delay) => total + delay, 0),
  }));
}

function fillRect(pixels, width, height, rect, color) {
  const right = Math.min(width, rect.left + rect.width);
  const bottom = Math.min(height, rect.top + rect.height);
  for (let y = Math.max(0, rect.top); y < bottom; y++) {
    for (let x = Math.max(0, rect.left); x < right; x++) {
      pixels.set(color, (y * width + x) * 4);
    }
  }
}

// A single persistent display buffer and (only for disposal 3) one saved buffer.
// The frame is the indexed result from gifuct-js's decompressFrame(..., false).
export function createGifCompositor(width, height, background = [0, 0, 0, 0]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  fillRect(pixels, width, height, { left: 0, top: 0, width, height }, background);
  let previous;
  let saved;
  return {
    pixels,
    draw(frame, disposalBackground = background) {
      if (previous?.disposalType === 2) {
        fillRect(pixels, width, height, previous.dims, previous.background);
      } else if (previous?.disposalType === 3 && saved) {
        pixels.set(saved);
      }
      saved = frame.disposalType === 3 ? pixels.slice() : undefined;
      const { dims, colorTable, transparentIndex } = frame;
      for (let y = 0; y < dims.height; y++) {
        if (y + dims.top >= height) break;
        for (let x = 0; x < dims.width; x++) {
          if (x + dims.left >= width) break;
          const index = frame.pixels[y * dims.width + x];
          if (index === transparentIndex) continue;
          const color = colorTable[index];
          if (!color) throw new Error('The GIF contains an invalid palette index.');
          const offset = ((y + dims.top) * width + x + dims.left) * 4;
          pixels[offset] = color[0];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[2];
          pixels[offset + 3] = 255;
        }
      }
      previous = { dims, disposalType: frame.disposalType, background: disposalBackground };
      return pixels;
    },
  };
}
