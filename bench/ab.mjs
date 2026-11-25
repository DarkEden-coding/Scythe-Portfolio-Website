#!/usr/bin/env node
// Times two versions of the renderer against each other in one page (bench/ab.ts), in alternating
// blocks of frames, and prints B's GPU time over A's per scene. See bench/README.md.
//
//   node bench/ab.mjs --a <rev> [--b <rev>] [--scenes a,b | --quick] [--rounds 8] [--frames 20] [--label name]
//
// A and B are git revisions; B defaults to the working tree (uncommitted changes included). Only
// src/ is taken from them: the scenes and the page come from this checkout.

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { launchBrowser, openPage } from './browser.mjs';
import { resultsDir } from './compare.mjs';
import { acquireGpuLock } from './gpuLock.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOTS = join(ROOT, 'bench', '.ab');
const QUICK = ['home-ultra-hi', 'station-ultra-hi', 'orbit-ultra-hi'];

const { values: args } = parseArgs({
  options: {
    a: { type: 'string', default: 'HEAD' },
    b: { type: 'string', default: '.' },
    scenes: { type: 'string' },
    quick: { type: 'boolean', default: false },
    rounds: { type: 'string', default: '8' },
    frames: { type: 'string', default: '20' },
    label: { type: 'string' },
    port: { type: 'string', default: '5199' },
  },
});

const git = cmd => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();
const describe = rev => (rev === '.' ? 'working tree' : `${rev} (${git(`rev-parse --short ${rev}`)})`);

/** src/ at a revision ('.' for the working tree) into bench/.ab/<name>/src. */
function snapshot(rev, name) {
  const dir = join(SNAPSHOTS, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (rev === '.') cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  else execSync(`git archive ${rev} src | tar -x -C "${dir}"`, { cwd: ROOT });
}

snapshot(args.a, 'a');
snapshot(args.b, 'b');
const server = await createServer({ root: ROOT, logLevel: 'warn', server: { port: Number(args.port) } });
await server.listen();
const releaseGpu = await acquireGpuLock();
const browser = await launchBrowser();

const median = list => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
const scenes = args.scenes?.split(',') ?? (args.quick ? QUICK : null);
const results = { a: describe(args.a), b: describe(args.b), date: new Date().toISOString(), rounds: Number(args.rounds), frames: Number(args.frames), scenes: {} };
try {
  const page = await openPage(browser, `${server.resolvedUrls.local[0].replace(/\/$/, '')}/bench/ab.html`);
  await page.waitForFunction(() => 'ab' in window, { timeout: 60_000 });
  const ids = scenes ?? await page.evaluate(() => window.ab.scenes());
  console.log(`A: ${results.a}\nB: ${results.b}\n${'scene'.padEnd(22)}     A ms     B ms   B/A   (rounds' B/A from..to)`);
  for (const id of ids) {
    await page.evaluate(id => window.ab.setScene(id), id);
    const { a, b } = await page.evaluate((r, f) => window.ab.run(r, f), results.rounds, results.frames);
    // Round by round, so a slow stretch, which hits both of a round's blocks, cancels out.
    const ratios = a.map((t, i) => b[i] / t);
    const scene = { a: median(a), b: median(b), ratio: median(ratios), from: Math.min(...ratios), to: Math.max(...ratios), rounds: { a, b } };
    results.scenes[id] = scene;
    console.log(`${id.padEnd(22)} ${scene.a.toFixed(2).padStart(8)} ${scene.b.toFixed(2).padStart(8)}  ${scene.ratio.toFixed(3)}  (${scene.from.toFixed(2)}..${scene.to.toFixed(2)})`);
  }
  if (args.label) {
    const dir = resultsDir(args.label);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ab.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`Wrote ${join(dir, 'ab.json')}`);
  }
} finally {
  await browser.close();
  await server.close();
  releaseGpu();
}
