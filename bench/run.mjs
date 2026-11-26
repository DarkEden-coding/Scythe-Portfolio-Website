#!/usr/bin/env node
// Runs the cube benchmark in headless Brave on the real GPU and writes
// bench/results/<label>/{results.json,*.png}. See bench/README.md.
//
//   node bench/run.mjs --label <name> [--quick] [--scenes a,b] [--port 5199 | --url http://...]
//                      [--compare <label or results dir>]

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { BROWSER_ARGS, launchBrowser, openPage } from './browser.mjs';
import { compareRuns, printComparison, resultsDir } from './compare.mjs';
import { acquireGpuLock } from './gpuLock.mjs';
import { writePng } from './images.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const WARMUP = 10; // frames before timing
const TIMED = 60; // timed frames per scene
const PASS_FRAMES = 20; // frames timed pass by pass
const HISTORY = 16; // frames the accumulator averages over (HISTORY_FRAMES in accumulate.ts)

const { values: args } = parseArgs({
  options: {
    label: { type: 'string' },
    quick: { type: 'boolean', default: false },
    scenes: { type: 'string' },
    port: { type: 'string', default: '5199' },
    url: { type: 'string' },
    compare: { type: 'string' },
  },
});

const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse --short HEAD');
const dirty = git('status --porcelain --untracked-files=no') !== '';
const label = args.label ?? `${commit}${dirty ? '-dirty' : ''}`;
const outDir = resultsDir(label);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Vite moves on to the next free port if --port is taken (by another run, say).
const server = args.url ? null : await createServer({ root: ROOT, logLevel: 'warn', server: { port: Number(args.port) } });
await server?.listen();
const baseUrl = (args.url ?? server.resolvedUrls.local[0]).replace(/\/$/, '');
const releaseGpu = await acquireGpuLock();
const browser = await launchBrowser();

const started = Date.now();
try {
  const params = [process.env.CUBE_BENCH_SHADOWS && `shadows=${process.env.CUBE_BENCH_SHADOWS}`, process.env.CUBE_BENCH_SCALE && `scale=${process.env.CUBE_BENCH_SCALE}`].filter(Boolean);
  const page = await openPage(browser, `${baseUrl}/bench/index.html${params.length ? `?${params.join('&')}` : ''}`);
  await page.waitForFunction(() => 'bench' in window);
  const info = await page.evaluate(() => window.bench.info());
  console.log(`${info.renderer}; GPU timer queries ${info.timerQuery ? 'on' : 'off'}`);
  if (!info.canAccumulate) throw new Error('No float render targets, so no temporal AA: not the site\'s renderer');

  const wanted = args.scenes?.split(',') ?? (args.quick ? info.quick : null);
  const scenes = wanted ? info.scenes.filter(s => wanted.includes(s.id)) : info.scenes;
  const results = {
    label, commit, dirty, date: new Date().toISOString(), renderer: info.renderer, timerQuery: info.timerQuery,
    browserArgs: BROWSER_ARGS, scenes: {},
  };
  for (const scene of scenes) {
    const sceneStarted = Date.now();
    const result = scene.moving ? await runMoving(page, scene) : await runStill(page, scene);
    results.scenes[scene.id] = result;
    const t = result.timing;
    console.log(`${scene.id.padEnd(22)} gpu ${fmt(t.gpu?.median)} / p90 ${fmt(t.gpu?.p90)} ms  wall ${fmt(t.wall.median)} ms  ` +
      `noise ${result.temporal.noiseMean.toFixed(3)}  (${((Date.now() - sceneStarted) / 1000).toFixed(1)} s)`);
  }
  results.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Wrote ${outDir} in ${results.seconds} s`);

  if (args.compare) printComparison(compareRuns(label, args.compare));
} finally {
  await browser.close();
  await server?.close();
  releaseGpu();
}

/** Single frames, timing, then the converged image and its noise over the last HISTORY frames. */
async function runStill(page, scene) {
  const size = await page.evaluate(id => window.bench.setScene(id), scene.id);
  const images = [];
  for (const rays of [1, scene.samples]) {
    await page.evaluate(r => { window.bench.setSingle(r); window.bench.render(1); }, rays);
    images.push(await save(page, scene.id, `single-s${rays}`, size));
  }
  await page.evaluate(n => { window.bench.setSettled(); window.bench.render(n); }, WARMUP);
  const timing = await time(page);
  await page.evaluate(n => {
    window.bench.setSettled();
    window.bench.render(n);
    window.bench.beginStats();
    window.bench.render(n);
  }, HISTORY);
  const temporal = await page.evaluate(() => window.bench.endStats());
  images.push(await save(page, scene.id, 'converged', size));
  return { kind: 'still', size, timing, temporal, images };
}

/** Settles at the start pose, then turns the camera frame by frame: timed once, then drawn again
 * from the start with every frame captured. */
async function runMoving(page, scene) {
  const start = () => page.evaluate(async (id, n) => {
    const size = await window.bench.setScene(id);
    window.bench.render(n);
    window.bench.startMotion();
    return size;
  }, scene.id, HISTORY);
  const size = await start();
  const timing = await time(page, scene.frames);
  await start();
  await page.evaluate(() => window.bench.beginStats());
  const images = [];
  for (let i = 0; i < scene.frames; i++) {
    await page.evaluate(() => window.bench.render(1));
    images.push(await save(page, scene.id, `frame-${String(i).padStart(2, '0')}`, size));
  }
  const temporal = await page.evaluate(() => window.bench.endStats());
  return { kind: 'moving', size, timing, temporal, images };
}

/** Whole-frame times over `frames`, then a split by pass. */
async function time(page, frames = TIMED) {
  const { wall, gpu } = await page.evaluate(n => window.bench.time(n), frames);
  const passes = await page.evaluate(n => window.bench.timePasses(n), PASS_FRAMES);
  return { frames, gpu: gpu && summary(gpu), wall: summary(wall), passes };
}

async function save(page, sceneId, name, { width, height }) {
  const base64 = await page.evaluate(() => window.bench.capture());
  const file = `${sceneId}.${name}.png`;
  writePng(join(outDir, file), { width, height, rgb: new Uint8Array(Buffer.from(base64, 'base64')) });
  return file;
}

function summary(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = v => Math.round(v * 1000) / 1000;
  return { median: round(at(0.5)), p90: round(at(0.9)), mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length), min: round(sorted[0]) };
}

function fmt(v) {
  return v === undefined ? '  -  ' : v.toFixed(2).padStart(6);
}
