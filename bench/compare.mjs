#!/usr/bin/env node
// Compares a benchmark run with a baseline run: speed, and whether the picture stayed the same.
// Writes <candidate>/compare-<baseline>.json and diff heatmaps under <candidate>/diff-<baseline>/.
//
//   node bench/compare.mjs <candidate label or dir> <baseline label or dir>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { compareImages, readPng, writePng } from './images.mjs';

// What counts as the same picture (see bench/README.md). Noise is in levels of 255.
export const THRESHOLDS = {
  convergedPsnr: 40, // dB, the accumulated still image
  convergedChangedPct: 1, // % of pixels off by more than 8/255
  // A still scene's noise, mean and p99, may rise by a tenth plus a little, so a baseline near zero
  // doesn't fail on dust.
  stillNoiseRatio: 1.1,
  stillNoiseMeanSlack: 0.05,
  stillNoiseP99Slack: 0.5,
  movingMinPsnr: 30, // dB, the worst frame of a moving sequence
  movingMeanPsnr: 35, // dB, averaged over its frames
  // Moving, most of the frame-to-frame change is the motion, the same in both runs, so a ratio
  // would hide added noise: these are absolute.
  movingNoiseMeanSlack: 0.5,
  movingNoiseP99Slack: 2,
  movingFlickerSlack: 0.5, // percentage points
  singlePsnrWarn: 35, // dB; single frames only warn, as a change of sampling may move their noise
};

const RESULTS = resolve(import.meta.dirname, 'results');

/** A run's directory: a path to one, or a label under bench/results. */
export function resultsDir(ref) {
  return ref.includes('/') || existsSync(join(ref, 'results.json')) ? resolve(ref) : join(RESULTS, ref);
}

const load = dir => JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
const pct = (a, b) => (a == null || b == null ? null : (100 * (a - b)) / b);

/** Where the candidate's noise or flicker went above what the baseline allows. */
function noiseFailures(kind, c, b) {
  const t = THRESHOLDS;
  const still = kind === 'still';
  const limit = (base, slack) => (still ? base * t.stillNoiseRatio : base) + slack;
  const checks = [
    ['noise mean', c.noiseMean, limit(b.noiseMean, still ? t.stillNoiseMeanSlack : t.movingNoiseMeanSlack), 3],
    ['noise p99', c.noiseP99, limit(b.noiseP99, still ? t.stillNoiseP99Slack : t.movingNoiseP99Slack), 2],
  ];
  if (!still) checks.push(['flicker %', c.flickerPct, b.flickerPct + t.movingFlickerSlack, 3]);
  return checks.filter(([, value, max]) => value > max).map(([name, value, max, digits]) => `${name} ${value.toFixed(digits)} > ${max.toFixed(digits)}`);
}

export function compareRuns(candidateRef, baselineRef) {
  const candidateDir = resultsDir(candidateRef), baselineDir = resultsDir(baselineRef);
  const candidate = load(candidateDir), baseline = load(baselineDir);
  const diffDir = join(candidateDir, `diff-${basename(baselineDir)}`);
  mkdirSync(diffDir, { recursive: true });
  const rows = [];
  for (const [id, cand] of Object.entries(candidate.scenes)) {
    const base = baseline.scenes[id];
    if (!base) continue;
    const time = cand.timing.gpu && base.timing.gpu ? 'gpu' : 'wall';
    const row = {
      id, kind: cand.kind, timer: time,
      ms: cand.timing[time].median, baseMs: base.timing[time].median,
      medianPct: pct(cand.timing[time].median, base.timing[time].median),
      p90Pct: pct(cand.timing[time].p90, base.timing[time].p90),
      temporal: { candidate: cand.temporal, baseline: base.temporal },
      images: {}, failures: [], warnings: [],
    };
    const compareImage = (name, keepHeatmap) => {
      const result = compareImages(readPng(join(candidateDir, name)), readPng(join(baselineDir, name)));
      const { heatmap, ...metrics } = result;
      if (keepHeatmap && metrics.max > 0) writePng(join(diffDir, name), heatmap);
      return { ...metrics, heatmap };
    };
    const t = THRESHOLDS;
    row.failures.push(...noiseFailures(cand.kind, cand.temporal, base.temporal));

    if (cand.kind === 'still') {
      for (const name of cand.images) {
        const { heatmap: _, ...m } = compareImage(name, true);
        row.images[name] = m;
        if (name.endsWith('converged.png')) {
          if (m.psnr < t.convergedPsnr) row.failures.push(`converged PSNR ${m.psnr.toFixed(1)} < ${t.convergedPsnr}`);
          if (m.changedPct > t.convergedChangedPct) row.failures.push(`converged ${m.changedPct.toFixed(2)}% changed > ${t.convergedChangedPct}%`);
          row.psnr = m.psnr;
          row.changedPct = m.changedPct;
        } else if (m.psnr < t.singlePsnrWarn) row.warnings.push(`${name} PSNR ${m.psnr.toFixed(1)}`);
      }
    } else {
      // Every frame against its twin; only the worst frame's heatmap is kept.
      let worst = null, sum = 0;
      for (const name of cand.images) {
        const m = compareImage(name, false);
        sum += m.psnr;
        if (!worst || m.psnr < worst.psnr) worst = { name, ...m };
        const { heatmap: _, ...metrics } = m;
        row.images[name] = metrics;
      }
      if (worst.max > 0) writePng(join(diffDir, worst.name), worst.heatmap);
      row.psnr = sum / cand.images.length;
      row.minPsnr = worst.psnr;
      row.changedPct = worst.changedPct;
      if (row.minPsnr < t.movingMinPsnr) row.failures.push(`worst frame PSNR ${row.minPsnr.toFixed(1)} < ${t.movingMinPsnr}`);
      if (row.psnr < t.movingMeanPsnr) row.failures.push(`mean frame PSNR ${row.psnr.toFixed(1)} < ${t.movingMeanPsnr}`);
    }
    row.pass = row.failures.length === 0;
    rows.push(row);
  }
  const report = { candidate: candidate.label, baseline: baseline.label, thresholds: THRESHOLDS, rows };
  writeFileSync(join(candidateDir, `compare-${basename(baselineDir)}.json`), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function printComparison({ candidate, baseline, rows }) {
  const num = (v, digits = 1, width = 7) => (v == null ? '-' : v.toFixed(digits)).padStart(width);
  const signed = v => (v == null ? '      -' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`.padStart(7));
  console.log(`\n${candidate} vs ${baseline}`);
  console.log(`${'scene'.padEnd(22)} ${'ms'.padStart(7)} ${'base'.padStart(7)} ${'median'.padStart(7)} ${'p90'.padStart(7)}  ${'PSNR'.padStart(6)} ${'>8/255'.padStart(7)} ${'noise'.padStart(13)} ${'flicker'.padStart(15)}  result`);
  for (const r of rows) {
    const { candidate: c, baseline: b } = r.temporal;
    const flicker = r.kind === 'moving' ? `${c.flickerPct.toFixed(3)}/${b.flickerPct.toFixed(3)}` : '';
    console.log(`${r.id.padEnd(22)} ${num(r.ms, 2)} ${num(r.baseMs, 2)} ${signed(r.medianPct)} ${signed(r.p90Pct)}  ${num(r.psnr, 1, 6)} ${num(r.changedPct, 2)}% ` +
      `${`${c.noiseMean.toFixed(2)}/${b.noiseMean.toFixed(2)}`.padStart(13)} ${flicker.padStart(15)}  ${r.pass ? 'PASS' : 'FAIL'}` +
      `${r.failures.length ? `  ${r.failures.join('; ')}` : ''}${r.warnings.length ? `  (warn: ${r.warnings.join('; ')})` : ''}`);
  }
  const failed = rows.filter(r => !r.pass).length;
  console.log(`\nms: GPU median per frame (wall time where the timer query is missing). PSNR: converged image, or mean over frames when moving.`);
  console.log(failed ? `${failed} of ${rows.length} scenes FAIL` : `All ${rows.length} scenes PASS`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [candidate, baseline] = process.argv.slice(2);
  if (!candidate || !baseline) {
    console.error('usage: node bench/compare.mjs <candidate> <baseline>');
    process.exit(1);
  }
  const report = compareRuns(candidate, baseline);
  printComparison(report);
  process.exitCode = report.rows.every(r => r.pass) ? 0 : 1;
}
