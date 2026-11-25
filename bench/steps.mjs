#!/usr/bin/env node
// Where the ray-cast spends its steps: renders scenes with STEP_COUNTS (see RENDER_FS) and prints,
// per scene, the mean and p99 per ray of camera cells, camera bricks, shadow steps and carved()
// calls, and writes a heatmap per scene to bench/results/steps/ (red: camera cells, green: camera
// bricks, blue: shadow steps; brighter is more).
//
//   node bench/steps.mjs [--scenes a,b]

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { launchBrowser, openPage } from './browser.mjs';
import { acquireGpuLock } from './gpuLock.mjs';
import { writePng } from './images.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCALE = 1020 / 255; // STEP_COUNTS writes count / 1020 per channel
const HEAT_FULL = 160; // steps per ray shown at full brightness

const { values: args } = parseArgs({ options: { scenes: { type: 'string' }, port: { type: 'string', default: '5198' } } });
const outDir = join(ROOT, 'bench/results/steps');
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'warn', server: { port: Number(args.port) } });
await server.listen();
const releaseGpu = await acquireGpuLock();
const browser = await launchBrowser();
try {
  const page = await openPage(browser, `${server.resolvedUrls.local[0].replace(/\/$/, '')}/bench/index.html?steps`);
  await page.waitForFunction(() => 'bench' in window);
  const info = await page.evaluate(() => window.bench.info());
  const ids = args.scenes?.split(',') ?? info.scenes.filter(s => !s.moving).map(s => s.id);
  console.log('per ray, over covered pixels: mean / p99   cam cells | cam bricks | shadow steps | carved()');
  for (const id of ids) {
    const { width, height } = await page.evaluate(i => window.bench.setScene(i), id);
    const rgba = Buffer.from(await page.evaluate(() => window.bench.steps()), 'base64');
    const channels = [[], [], [], []];
    const heat = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = ((height - 1 - y) * width + x) * 4, o = (y * width + x) * 3;
        if (rgba[i] + rgba[i + 1] + rgba[i + 2] + rgba[i + 3] === 0) continue;
        for (let c = 0; c < 4; c++) channels[c].push(rgba[i + c] * SCALE);
        for (let c = 0; c < 3; c++) heat[o + c] = Math.min(255, Math.round((rgba[i + c] * SCALE * 255) / HEAT_FULL));
      }
    }
    const stat = list => {
      const sorted = list.sort((a, b) => a - b);
      const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
      return `${mean.toFixed(1).padStart(6)} / ${String(Math.round(sorted[Math.floor(0.99 * sorted.length)] ?? 0)).padStart(4)}`;
    };
    console.log(`${id.padEnd(20)} ${channels.map(stat).join(' | ')}  (${channels[0].length} px)`);
    writePng(join(outDir, `${id}.png`), { width, height, rgb: heat });
  }
} finally {
  await browser.close();
  await server.close();
  releaseGpu();
}
