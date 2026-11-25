// RGB images for the benchmark: PNG in and out, and how far one is from another.

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

// A difference above this many levels (of 255) in any channel counts a pixel as changed.
export const CHANGED_ABOVE = 8;
const PSNR_IDENTICAL = 100; // reported for identical images (the real value is infinite)

/** @typedef {{ width: number, height: number, rgb: Uint8Array }} Image */

/** @param {string} path @param {Image} image */
export function writePng(path, { width, height, rgb }) {
  // Fast settings: these files are big and written often; size matters less than time.
  const png = PNG.sync.write({ width, height, data: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length) },
    { colorType: 2, inputColorType: 2, inputHasAlpha: false, deflateLevel: 1 });
  writeFileSync(path, png);
}

/** @param {string} path @returns {Image} */
export function readPng(path) {
  const { width, height, data } = PNG.sync.read(readFileSync(path));
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    rgb[o] = data[i];
    rgb[o + 1] = data[i + 1];
    rgb[o + 2] = data[i + 2];
  }
  return { width, height, rgb };
}

/**
 * How far `candidate` is from `baseline`, over every channel of every pixel, plus a heatmap of the
 * largest channel difference per pixel: black where they match, through red to yellow.
 * @param {Image} candidate @param {Image} baseline
 */
export function compareImages(candidate, baseline) {
  if (candidate.width !== baseline.width || candidate.height !== baseline.height) throw new Error('Image sizes differ');
  const a = candidate.rgb, b = baseline.rgb;
  const pixels = candidate.width * candidate.height;
  const heat = new Uint8Array(pixels * 3);
  let squared = 0, absolute = 0, max = 0, changed = 0;
  for (let p = 0; p < pixels; p++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[3 * p + c] - b[3 * p + c]);
      squared += d * d;
      absolute += d;
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > CHANGED_ABOVE) changed++;
    heat[3 * p] = Math.min(255, worst * 16);
    heat[3 * p + 1] = Math.min(255, Math.max(0, worst * 4 - 32));
  }
  const mse = squared / (pixels * 3);
  return {
    psnr: mse === 0 ? PSNR_IDENTICAL : Math.min(PSNR_IDENTICAL, 10 * Math.log10((255 * 255) / mse)),
    mae: absolute / (pixels * 3),
    max,
    changedPct: (100 * changed) / pixels,
    heatmap: { width: candidate.width, height: candidate.height, rgb: heat },
  };
}
