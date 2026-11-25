// The A/B page: times two versions of the renderer against each other in one page, driven by
// bench/ab.mjs. Each version is a snapshot of src/ that ab.mjs puts in bench/.ab/a and bench/.ab/b,
// drawing to a canvas (and WebGL context) of its own. A round times a block of frames from each, in
// alternating order, so whatever else slows the GPU meanwhile weighs on both alike; ab.mjs compares
// them round by round. Separate full runs can differ by far more than the changes being measured.

import { chaosToLevel, loadCube } from '../src/cube/cubeFile.ts';
import { orbitBasis } from '../src/cube/orbitCamera.ts';
import type { CubeView } from '../src/cube/view.ts';
import { cubeUrl } from '../src/presets.ts';
import { BORE, layout, viewOptions } from '../src/scene.ts';
import { GpuTimer } from './gpuTimer.ts';
import { type Scene, SCENES, SWEEP } from './scenes.ts';

const FILTER_K = 6; // as main.ts
const WARMUP = 4; // frames before each block, after a fresh history
const SETTLE = 16; // still frames before a moving block starts turning (as run.mjs)
const ALL = [...SCENES, SWEEP];

interface Contestant {
  name: 'a' | 'b';
  canvas: HTMLCanvasElement;
  view: CubeView;
  timer: GpuTimer;
  loaded: string;
}

/** The two snapshots' CubeView, each with its own canvas. Their API may differ a little from this
 * checkout's; only what every version has is used, and newer switches are set only where they exist. */
async function contestant(name: 'a' | 'b'): Promise<Contestant> {
  const module: typeof import('../src/cube/view.ts') = await import(/* @vite-ignore */ `/bench/.ab/${name}/src/cube/view.ts`);
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const view = module.CubeView.create(canvas, viewOptions('both', 'glacier', true));
  if (!view) throw new Error('No WebGL2');
  const switches = view as unknown as Record<string, unknown>;
  if ('waitForShaders' in switches) switches.waitForShaders = true; // every frame from the final programs
  if ('freezeWhenStill' in switches) switches.freezeWhenStill = false; // time the rays, not a frozen picture
  view.setFilter(FILTER_K);
  const timer = GpuTimer.create(view.gl);
  if (!timer) throw new Error('No GPU timer queries');
  return { name, canvas, view, timer, loaded: '' };
}

const contestants = [await contestant('a'), await contestant('b')];
const cubes = new Map<string, Promise<Uint8Array>>();
let scene: Scene = SCENES[0];

function draw(c: Contestant, yaw: number): void {
  const { pose } = scene;
  const { width, height } = c.canvas;
  const { shift, focal } = layout(width, height, false, pose.tour);
  c.view.draw(orbitBasis(yaw, pose.pitch, pose.distance), width, height, shift, focal);
}

function sync(c: Contestant): void {
  const { gl } = c.view;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** One block: a fresh history, the warm-up, then `frames` timed frames. Their median GPU ms. */
async function block(c: Contestant, frames: number): Promise<number> {
  const { view } = c;
  const { motion, pose } = scene;
  view.accumulate = true;
  view.samples = scene.samples;
  view.settled = true;
  view.resetHistory();
  // A sweep starts a few levels above the scene's threshold, which it reaches at the block's end.
  const sweep = motion?.levelsPerFrame ?? 0;
  view.threshold = chaosToLevel(scene.lambda) + sweep * frames;
  view.trail.reset(view.threshold);
  view.opts.glow = sweep > 0;
  let yaw = pose.yaw;
  for (let i = 0; i < (motion ? SETTLE : WARMUP); i++) draw(c, yaw);
  if (motion) {
    view.samples = motion.samples;
    view.settled = motion.settled;
  }
  sync(c);
  for (let i = 0; i < frames; i++) {
    if (motion) yaw += motion.yawPerFrame;
    if (sweep) {
      view.threshold -= sweep;
      view.trail.record(view.threshold, 1 / 60);
    }
    c.timer.timeFrame(() => draw(c, yaw));
    sync(c); // as run.mjs: on ANGLE's Metal backend a query covers its whole command buffer, so frames go one at a time
  }
  const times = await c.timer.collect();
  if (!times) throw new Error('GPU timer was disjoint');
  return [...times].sort((x, y) => x - y)[Math.floor(times.length / 2)];
}

const ab = {
  scenes: () => ALL.map(s => s.id),

  async setScene(id: string): Promise<void> {
    const next = ALL.find(s => s.id === id);
    if (!next) throw new Error(`No scene ${id}`);
    scene = next;
    const { resolution, pose, n, preset } = scene;
    const key = `${preset}-${n}`;
    if (!cubes.has(key)) cubes.set(key, loadCube(cubeUrl(preset, n), n));
    for (const c of contestants) {
      const { view, canvas } = c;
      canvas.width = Math.round(resolution.width * resolution.dpr);
      canvas.height = Math.round(resolution.height * resolution.dpr);
      view.opts.sun = scene.sun;
      view.threshold = chaosToLevel(scene.lambda);
      view.offset = pose.move.map(m => m * n) as [number, number, number];
      view.carve = [...pose.axis, BORE * pose.tour];
      if (c.loaded !== key) {
        let done = false;
        view.load(await cubes.get(key)!, n).then(() => { done = true; });
        while (!done) {
          draw(c, pose.yaw);
          await new Promise(r => setTimeout(r));
        }
        c.loaded = key;
      }
      draw(c, pose.yaw); // builds whatever the threshold needs, so no timed frame does
      sync(c);
    }
  },

  /** Per round, each contestant's median GPU ms over a block of `frames`; the order alternates. */
  async run(rounds: number, frames: number): Promise<{ a: number[]; b: number[] }> {
    const out = { a: [] as number[], b: [] as number[] };
    for (let r = 0; r < rounds; r++) {
      for (const c of r % 2 ? [...contestants].reverse() : contestants) out[c.name].push(await block(c, frames));
    }
    return out;
  },
};

declare global {
  interface Window {
    ab: typeof ab;
  }
}
window.ab = ab;
