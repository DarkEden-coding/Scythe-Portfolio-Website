// The benchmark page: draws the site's cube in fixed scenes (scenes.ts) and exposes `window.bench`
// for bench/run.mjs to drive. Everything is deterministic: the same calls draw the same pixels.
// A draw's pixels are only readable in the task that drew them, so render() reads its last frame
// back straight away and capture() hands that copy over.

import { chaosToLevel, loadCube } from '../src/cube/cubeFile.ts';
import { orbitBasis } from '../src/cube/orbitCamera.ts';
import { CubeView, type Pass, type Samples } from '../src/cube/view.ts';
import { cubeUrl } from '../src/presets.ts';
import { BORE, layout, viewOptions } from '../src/scene.ts';
import { GpuTimer } from './gpuTimer.ts';
import { PassClock } from './passClock.ts';
import { QUICK, type Scene, SCENES } from './scenes.ts';
import { type TemporalResult, TemporalStats } from './temporal.ts';

const BACKGROUND = [0x1c, 0x1c, 0x1f]; // the page's --bg, which the canvas is drawn over
const FILTER_K = 6; // the settings panel's default neighbour filter

interface Mode {
  accumulate: boolean;
  samples: Samples;
  settled: boolean;
}

// bench/steps.mjs opens the page with ?steps: the ray-cast then outputs how much traversal work
// each pixel did instead of its colour (STEP_COUNTS in RENDER_FS).
const STEPS = new URLSearchParams(location.search).has('steps');
if (STEPS) {
  const shaderSource = WebGL2RenderingContext.prototype.shaderSource;
  WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
    if (source.includes('findShowing')) source = source.replace('\n', '\n#define STEP_COUNTS\n');
    shaderSource.call(this, shader, source);
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#cube')!;
const view = CubeView.create(canvas, viewOptions('both', 'glacier', true));
if (!view) throw new Error('No WebGL2');
if (STEPS) view.opts.edgeColor = [0, 0, 0, 0];
const { gl } = view;
view.waitForShaders = true;
view.freezeWhenStill = false; // still scenes are timed, and their noise measured, while they accumulate
view.setFilter(FILTER_K);
// CUBE_BENCH_SHADOWS=reuse|off overrides the default of reused shadows while dragging.
const shadows = new URLSearchParams(location.search).get('shadows');
if (shadows) view.shadowReuse = shadows === 'reuse';
// ?scale=0.5 (CUBE_BENCH_SCALE): cast the rays at that fraction of the resolution and upscale.
view.renderScale = Number(new URLSearchParams(location.search).get('scale') ?? 1);
const timer = GpuTimer.create(gl);

const cubes = new Map<string, Promise<Uint8Array>>();
let loaded = ''; // the cube on the GPU, as `<preset>-<n>`
let scene: Scene = SCENES[0];
let yaw = 0;
let moving = false;
let stats: TemporalStats | null = null;
let lastFrame: { rgb: Uint8Array; alpha: Uint8Array } | null = null;

function drawFrame(): void {
  const { pose } = scene;
  if (moving) yaw += scene.motion!.yawPerFrame;
  const { width, height } = canvas;
  const { shift, focal } = layout(width, height, false, pose.tour);
  view!.draw(orbitBasis(yaw, pose.pitch, pose.distance), width, height, shift, focal);
}

/** Waits for a cube already on its way to the GPU: draws move its upload along. */
async function loadOnGpu(preset: number, n: number): Promise<void> {
  const key = `${preset}-${n}`;
  if (loaded === key) return;
  if (!cubes.has(key)) cubes.set(key, loadCube(cubeUrl(preset, n), n));
  let done = false;
  view!.load(await cubes.get(key)!, n).then(() => { done = true; });
  while (!done) {
    drawFrame();
    await new Promise(r => setTimeout(r));
  }
  loaded = key;
}

function setMode(mode: Mode): void {
  view!.accumulate = mode.accumulate;
  view!.samples = mode.samples;
  view!.settled = mode.settled;
}

/** The canvas as RGB over the page background, top row first, and its alpha. */
function readBack(): { rgb: Uint8Array; alpha: Uint8Array } {
  const { width, height } = canvas;
  const rgba = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width, to = y * width;
    for (let x = 0; x < width; x++) {
      const i = (from + x) * 4, o = to + x;
      const a = rgba[i + 3];
      alpha[o] = a;
      // Premultiplied, so over the background: c + bg · (1 - a). Clamped: a colour can come out a
      // little above its alpha, and a Uint8Array would wrap 256 round to 0.
      for (let c = 0; c < 3; c++) rgb[o * 3 + c] = Math.min(255, Math.round(rgba[i + c] + (BACKGROUND[c] * (255 - a)) / 255));
    }
  }
  return { rgb, alpha };
}

function syncGpu(): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

async function toBase64(bytes: Uint8Array): Promise<string> {
  const url = await new Promise<string>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
  return url.slice(url.indexOf(',') + 1);
}

const bench = {
  info() {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      timerQuery: timer !== null,
      canAccumulate: view.canAccumulate,
      scenes: SCENES.map(s => ({ id: s.id, samples: s.samples, moving: !!s.motion, frames: s.motion?.frames ?? 0 })),
      quick: QUICK,
    };
  },

  /** Shows a scene, still, at its settled mode (temporal AA on), with a fresh history. */
  async setScene(id: string): Promise<{ width: number; height: number }> {
    const next = SCENES.find(s => s.id === id);
    if (!next) throw new Error(`No scene ${id}`);
    scene = next;
    const { resolution, pose, n } = scene;
    canvas.width = Math.round(resolution.width * resolution.dpr);
    canvas.height = Math.round(resolution.height * resolution.dpr);
    yaw = pose.yaw;
    moving = false;
    view.opts.sun = scene.sun;
    view.threshold = chaosToLevel(scene.lambda);
    view.offset = pose.move.map(m => m * n) as [number, number, number];
    view.carve = [...pose.axis, BORE * pose.tour];
    setMode({ accumulate: true, samples: scene.samples, settled: true });
    await loadOnGpu(scene.preset, n);
    drawFrame(); // rebuilds the brick map if the cube is new, so no timed frame does
    syncGpu();
    view.resetHistory();
    return { width: canvas.width, height: canvas.height };
  },

  /** Single frames with no history: temporal AA off, `samples` rays per pixel. */
  setSingle(samples: Samples): void {
    setMode({ accumulate: false, samples, settled: true });
  },

  /** Back to the scene's settled mode with a fresh history (the camera stays where it is). */
  setSettled(): void {
    setMode({ accumulate: true, samples: scene.samples, settled: true });
    view.resetHistory();
  },

  /** Starts the scene's motion: each frame from now on turns the camera, drawn as the site does then. */
  startMotion(): void {
    const { motion } = scene;
    if (!motion) throw new Error(`${scene.id} doesn't move`);
    moving = true;
    setMode({ accumulate: true, samples: motion.samples, settled: motion.settled });
  },

  /** Draws frames, feeding each to the temporal stats if they're running, and keeps the last. */
  render(frames: number): void {
    for (let i = 0; i < frames; i++) {
      drawFrame();
      if (stats) {
        const frame = readBack();
        stats.add(frame.rgb, frame.alpha);
      }
    }
    lastFrame = readBack();
  },

  beginStats(): void {
    stats = new TemporalStats(canvas.width * canvas.height);
  },

  endStats(): TemporalResult {
    const result = stats!.result();
    stats = null;
    return result;
  },

  /** The last rendered frame as base64 RGB, top row first. */
  capture(): Promise<string> {
    return toBase64(lastFrame!.rgb);
  },

  /** Draws and times frames, each finished before the next starts, in ms: GPU time from the timer
   * query (null without it, or if its clock was disjoint), and wall time for the draw plus a sync. */
  async time(frames: number): Promise<{ wall: number[]; gpu: number[] | null }> {
    const wall: number[] = [];
    for (let i = 0; i < frames; i++) {
      const start = performance.now();
      if (timer) timer.timeFrame(drawFrame);
      else drawFrame();
      syncGpu();
      wall.push(performance.now() - start);
    }
    return { wall, gpu: timer ? await timer.collect() : null };
  },

  /** With ?steps: one frame of the scene's rays, no temporal AA, as raw RGBA bytes, bottom row first
   * (see STEP_COUNTS in RENDER_FS). */
  async steps(): Promise<string> {
    setMode({ accumulate: false, samples: scene.samples, settled: true });
    drawFrame();
    const { width, height } = canvas;
    const rgba = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return toBase64(rgba);
  },

  /** Draws frames split by pass (see passClock.ts); the median ms of each pass. */
  timePasses(frames: number): Partial<Record<Pass, number>> {
    const clock = new PassClock(gl);
    view.onPass = clock.hook;
    for (let i = 0; i < frames; i++) drawFrame();
    view.onPass = null;
    return clock.medians();
  },
};

declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;
