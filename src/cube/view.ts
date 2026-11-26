// Draws a baked cube: n³ voxels, each holding its pendulum's chaos level (see cubeFile.ts). Voxels at
// or above the threshold show. Thresholding, the neighbour filter, colouring and moving the volume
// all run on the GPU, so they stay live.

import { CHAOS } from '../presets.ts';
import { Accumulator } from './accumulate.ts';
import { pictureKey, Stillness } from './freeze.ts';
import { createProgram, hexToRgb, type Program } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { ProbeTarget } from './probe.ts';
import { cubeRect, type Rect } from './screenRect.ts';
import { BRICK, BRICKS_FS, EDGES_FS, EDGES_VS, FILTER_FS, FULLSCREEN_VS, OCCUPANCY_FS, PROBE_EDGES_FS, REACH_FS, REACH_PLANE_FS, RENDER_FS } from './shaders.ts';
import { ThresholdTrail, TRAIL_SAMPLES } from './thresholdTrail.ts';
import { ProgramVariants } from './variants.ts';

export type ColorBy = 'plain' | 'neighbours' | 'chaos' | 'both';
export type Samples = 1 | 2 | 4;
/** The GPU passes of a draw, for profiling (see CubeView.onPass). */
export type Pass = 'edges' | 'bricks' | 'occupancy' | 'probe' | 'refine' | 'render' | 'resolve' | 'present';

export interface ViewOptions {
  glow: boolean; // whether new voxels glow
  glowFor: number; // seconds a new voxel glows for after it appears
  base: string;
  accent: string; // glow colour
  colorBy: ColorBy; // neighbours: by how many of the 26 show; chaos: by level, where all 26 show; both: each where it applies
  ramp: [string, string, string, string]; // low → high
  sun: boolean; // sunlight with cast shadows instead of the studio light
  edgeColor: [number, number, number, number];
}

const COLOR_BY: Record<ColorBy, number> = { plain: 0, neighbours: 1, chaos: 2, both: 3 };

// RENDER_FS's DEBUG_VIEW for each debug view (see debugColor there).
export type DebugView = 'off' | 'steps' | 'shadow' | 'skips' | 'bricks' | 'normals' | 'depth' | 'ao' | 'empty';
const DEBUG_VIEWS: Record<DebugView, number> = { off: 0, steps: 1, shadow: 2, skips: 3, bricks: 4, normals: 5, depth: 6, ao: 7, empty: 8 };

// RENDER_FS's uMode: 0 all rays, 1 the probe pass, 2 the refine pass.
type RenderMode = 0 | 1 | 2;

// Uploading and filtering a whole Ultra cube at once holds the GPU for about a tenth of a second, a
// visible hitch, so a new cube goes in this many voxels per frame.
const VOXELS_PER_FRAME = 1 << 22;

// With several rays, voxels at least this many pixels wide draw in passes, extra rays only at edges
// (see RENDER_FS). Smaller ones leave too few pixels inside a face for that to pay. Only when
// accumulating: the refine pass needs the accumulator's stencil buffer.
const PROBE_FROM_PX = 4;

// The layout of the textures with a texel per brick (ATLAS in shaders.ts): `size` z-slices of size²
// bricks side by side, a power of two to a row (so the ray-cast finds a slice with a mask and a
// shift), as square as that allows. The brick levels cover the volume, n / BRICK bricks per axis:
// for Ultra 16 × 5 slices of 80², 1280 × 400 texels. So does the occupancy without the bore; with
// it, the box's bricks (see boxBricks).
interface Occupancy {
  size: number; // bricks per axis
  base: [number, number, number]; // the first, in bricks of the tiled volume
}
function atlasShift(size: number): number {
  return Math.ceil(Math.log2(Math.sqrt(size)));
}
function atlasSize(size: number): [number, number] {
  const perRow = 1 << atlasShift(size);
  return [size * perRow, size * Math.ceil(size / perRow)];
}

/** The bricks of the tiled volume that hold the box at `offset` (0..n) and the cells around it:
 * cells floor(offset) - 1 to ceil(offset + n) per axis, n + 3 at most, which span n / BRICK + 2
 * bricks however they fall. 82³ bricks for Ultra, 5.2 MB. */
export function boxBricks(n: number, offset: readonly number[]): Occupancy {
  return { size: n / BRICK + 2, base: offset.map(o => Math.floor((Math.floor(o) - 1) / BRICK)) as Occupancy['base'] };
}

/** How far from the bore's axis no cell shows, in cells, for RENDER_FS's jump across the hollow.
 * carved() takes 1 - smoothstep(0.85 r, r, distance) of a cell, and a voxel's margin is below
 * levels - threshold, so a cell carved by at least 1 - threshold / levels can't show. That is where
 * the smoothstep is at most threshold / levels: further out than 0.85 r as the threshold rises. */
export function boreHollowRadius(radius: number, threshold: number, n: number): number {
  const k = Math.min(1, Math.max(0, threshold / CHAOS.levels));
  const t = 0.5 - Math.sin(Math.asin(1 - 2 * k) / 3); // where smoothstep(0, 1, t) = k
  return (0.85 + 0.15 * t) * radius * 0.5 * n;
}

// One cube's textures.
interface Volume {
  n: number;
  chaos: WebGLTexture; // chaos level per voxel
  filtered: WebGLTexture; // highest threshold each voxel passes the filter at, with its order (see FILTER_FS)
  bricks: WebGLTexture; // highest level per brick of the volume, an atlas
  reachPlanes: WebGLTexture; // that over squares of bricks in each slice, an atlas (see REACH_PLANE_FS)
  reach: WebGLTexture; // and over cubes of bricks, for the ray-cast (see REACH_FS)
  bricksStale: boolean;
  occupancy: WebGLTexture; // which voxels show, a bit each, per brick of the volume (see OCCUPANCY_FS)
  occupancyFor: string | null; // what it was built for (see occupancyKey); null when stale
}

// A cube on its way in: slices uploaded and filtered so far.
interface Incoming {
  volume: Volume;
  bytes: Uint8Array;
  uploaded: number;
  filtered: number;
  done: () => void;
}

export class CubeView {
  readonly gl: WebGL2RenderingContext;
  readonly opts: ViewOptions;
  /** Voxels below this chaos level are hidden; fractions are fine. */
  threshold = 0;
  /** Where the threshold has been, so voxels it lets in glow for a while. Record each frame's. */
  readonly trail: ThresholdTrail;
  /** Moves the volume through the cube, in voxels per axis (fractions are fine); wraps around. */
  offset: [number, number, number] = [0, 0, 0];
  /** Rays per pixel: 4 keeps pixel-sized voxels from flashing as they move; each ray costs a trace. */
  samples: Samples = 4;
  /** A bore cut into the voxels from the centre out: its axis (a unit vector) and radius, where the
   * box spans -1..1. Radius 0 is no bore. */
  carve: [number, number, number, number] = [0, 0, 1, 0];
  /** 0 = no filter; otherwise the number of showing neighbours (of 26) a voxel needs. */
  filterK = 0;
  /** Accumulate rays over frames (see accumulate.ts): each frame's `samples` rays per pixel go to
   * different points in the pixel, and add up with earlier frames'. Only for a still cube: the
   * history follows the camera and the volume's drift, but anything else that changes the image
   * takes a few frames to come through. Ignored where float render targets aren't there. */
  accumulate = false;
  /** Whether the cube holds still (no threshold change), so accumulating can average over longer. */
  settled = true;
  /** Once a still picture has converged, stop casting rays and show it as it is (see freeze.ts).
   * The benchmark turns this off to time the rays. */
  freezeWhenStill = true;
  /** Draws what the ray-cast does instead of the picture (see debugColor in RENDER_FS). Each frame
   * is drawn as it is, without accumulating, so the counts are this frame's. */
  debugView: DebugView = 'off';

  private passHook: ((pass: Pass | null) => void) | null = null;
  private warmed = new WeakSet<Program>(); // variants drawn once already (see warmUp)
  private filter: Program;
  private brickPass: Program;
  private reachPlanePass: Program;
  private reachPass: Program;
  private occupancyPass: Program;
  private render: ProgramVariants;
  private edges: Program;
  private probeEdges: Program;
  private volume: Volume | null = null; // the cube on screen
  private incoming: Incoming | null = null;
  private filterTarget: WebGLFramebuffer;
  private accumulator: Accumulator;
  private probe: ProbeTarget;
  private lastOffset: [number, number, number] | null = null; // for the voxels' motion between frames
  private trailPoints = new Float32Array(TRAIL_SAMPLES);
  private stillness = new Stillness();
  private volumeVersion = 0; // counts changes to the volume's textures, for the picture's key

  /** Returns null without WebGL2. */
  static create(canvas: HTMLCanvasElement, opts: ViewOptions): CubeView | null {
    // No multisampling: the ray-cast gains nothing from it, and clearing and resolving a multisampled
    // screen costs about a millisecond a frame at 2520×1575. The outline antialiases itself (EDGES_FS).
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return null;
    try {
      return new CubeView(gl, opts);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, opts: ViewOptions) {
    this.gl = gl;
    this.opts = opts;
    this.trail = new ThresholdTrail(opts.glowFor, this.threshold);
    this.filter = createProgram(gl, FULLSCREEN_VS, FILTER_FS);
    this.brickPass = createProgram(gl, FULLSCREEN_VS, BRICKS_FS);
    this.reachPlanePass = createProgram(gl, FULLSCREEN_VS, REACH_PLANE_FS);
    this.reachPass = createProgram(gl, FULLSCREEN_VS, REACH_FS);
    this.occupancyPass = createProgram(gl, FULLSCREEN_VS, OCCUPANCY_FS);
    this.render = new ProgramVariants(gl, FULLSCREEN_VS, RENDER_FS);
    this.edges = createProgram(gl, EDGES_VS, EDGES_FS);
    this.probeEdges = createProgram(gl, FULLSCREEN_VS, PROBE_EDGES_FS);
    this.filterTarget = gl.createFramebuffer();
    this.accumulator = new Accumulator(gl);
    this.probe = new ProbeTarget(gl);
    gl.bindVertexArray(gl.createVertexArray());
  }

  /** Compile the ray-cast's variants when first needed, holding that frame up (see variants.ts).
   * For the benchmark, whose frames must all come out the same. */
  set waitForShaders(wait: boolean) {
    this.render.waitForCompile = wait;
  }

  /** For profiling (bench/): called as each pass of a draw starts, and with null after the last. */
  set onPass(hook: ((pass: Pass | null) => void) | null) {
    this.passHook = hook;
    this.accumulator.onPass = hook;
  }

  /** Drops the accumulated history, so the next frame starts a new one (as after a resize). */
  resetHistory(): void {
    this.accumulator.reset();
    this.lastOffset = null;
    this.stillness.reset();
  }

  /** Whether `accumulate` works here (it needs float render targets). */
  get canAccumulate(): boolean {
    return this.accumulator.supported;
  }

  /** How far the cube on its way in has got onto the GPU, 0..1; null when none is. */
  get loadProgress(): number | null {
    const job = this.incoming;
    return job ? (job.uploaded + job.filtered) / (2 * job.volume.n) : null;
  }

  /** Grid size of the cube on screen (0 before the first). */
  get size(): number {
    return this.volume?.n ?? 0;
  }

  /** Shows a new cube: n³ chaos levels, x fastest (see cubeFile.ts). Draws load it a few slices at a
   * time; resolves once it's on screen. Until then a cube of another size stays up, and one of the
   * same size, being overwritten, is hidden. */
  load(bytes: Uint8Array, n: number): Promise<void> {
    const volume = (this.incoming?.volume.n === n ? this.incoming.volume : this.volume?.n === n ? this.volume : null)
      ?? { n, chaos: this.texture(n, 'R8UI'), filtered: this.texture(n, 'R16UI'), bricks: this.atlasTexture(n / BRICK, 'R8UI'),
        reachPlanes: this.atlasTexture(n / BRICK, 'RGBA8UI'), reach: this.texture(n / BRICK, 'RGBA8UI'), bricksStale: true,
        // Big enough for either occupancy layout (see Occupancy); the box's is the larger.
        occupancy: this.atlasTexture(boxBricks(n, [0, 0, 0]).size, 'RG32UI'), occupancyFor: null };
    if (this.incoming) {
      const old = this.incoming.volume;
      if (old !== volume && old !== this.volume) this.deleteVolume(old);
      this.incoming.done(); // superseded
    }
    return new Promise(done => { this.incoming = { volume, bytes, uploaded: 0, filtered: 0, done }; });
  }

  setFilter(k: number): void {
    this.filterK = k;
    this.volumeVersion++;
    if (this.incoming) this.incoming.filtered = 0;
    if (this.volume && this.volume !== this.incoming?.volume) this.refreshFilter(this.volume, 0, this.volume.n);
    if (this.volume) {
      this.volume.bricksStale = true;
      this.volume.occupancyFor = null;
    }
  }

  draw(camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number): void {
    const { gl } = this;
    if (this.incoming) this.continueLoad(this.incoming);
    const debug = DEBUG_VIEWS[this.debugView];
    const temporal = !debug && this.accumulate && this.accumulator.supported;
    if (!temporal) this.accumulator.reset();
    this.trail.sample(this.trailPoints);
    // The pass stays a uniform: as a constant it saves little, and the compiler then treats the
    // probe and refine passes' floating point differently enough to move soft shadow edges.
    const settings = {
      uSamples: this.samples, uSun: this.opts.sun, uColorBy: COLOR_BY[this.opts.colorBy],
      uGlow: this.opts.glow, CARVING: this.carve[3] > 0,
    };
    const render = debug ? this.render.now({ ...settings, DEBUG_VIEW: debug }) : this.render.get(settings);
    // Variants the site will soon want compile in the background beforehand. It draws one ray while
    // the cube moves and two once it's still; compiling the other count's variant only when the
    // cube first settled cost two frames of 80-130 ms on Apple M5 (the compile competes with
    // drawing). Flying to a project cuts the bore from the flight's first frame, and flying back
    // takes it away, so the other bore setting's variants compile too, once this frame's is ready
    // (not to hold that one up); left to the flight, the generic program drew its first quarter
    // second. Each is drawn once as soon as it is ready (see warmUp).
    const prepared = debug ? [] : [this.render.prepare({ ...settings, uSamples: this.samples === 1 ? 2 : 1 })];
    if (!debug && render !== this.render.generic) {
      for (const uSamples of [1, 2]) prepared.push(this.render.prepare({ ...settings, uSamples, CARVING: !settings.CARVING }));
    }
    // The passes below leave the pixels outside the cube alone (see screenRect.ts). The scissor
    // is off for the clears: the targets must be clear everywhere.
    const rect = cubeRect(camera, pixelWidth, pixelHeight, shift, focal);
    const still = temporal && this.settled && this.freezeWhenStill;
    const key = still ? pictureKey({
      camera, width: pixelWidth, height: pixelHeight, shift, focal, offset: this.offset, threshold: this.threshold,
      trail: this.trailPoints, samples: this.samples, carve: this.carve, filterK: this.filterK, options: this.opts,
      volume: this.volumeVersion, program: render === this.render.generic ? 'generic' : 'variant',
    }) : '';
    const frozen = this.stillness.frozen(key) && this.accumulator.holds(pixelWidth, pixelHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Outline first; the voxels cover it where they stand in front.
    this.passHook?.('edges');
    const [r, g, b, a] = this.opts.edgeColor;
    gl.useProgram(this.edges.program);
    this.setCamera(this.edges, camera, pixelWidth, pixelHeight, shift, focal);
    gl.uniform4f(this.edges.uniforms.uColor, r * a, g * a, b * a, a);
    gl.drawArrays(gl.TRIANGLES, 0, 72); // 12 edges, a quad each (see EDGES_VS)

    if (frozen) {
      this.accumulator.present(rect);
      gl.disable(gl.BLEND);
      this.passHook?.(null);
      return;
    }

    const volume = this.volume;
    if (volume && volume !== this.incoming?.volume) {
      const { n } = volume;
      if (volume.bricksStale) {
        this.passHook?.('bricks');
        this.refreshBricks(volume);
        volume.bricksStale = false;
      }
      const occupancy = this.occupancyLayout(n);
      const occupancyKey = this.carve[3] > 0 ? `${this.threshold} ${this.carve} ${this.boxOffset(n)}` : `${this.threshold}`;
      if (volume.occupancyFor !== occupancyKey) {
        this.passHook?.('occupancy');
        this.refreshOccupancy(volume, occupancy);
        volume.occupancyFor = occupancyKey;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.enable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, volume.chaos);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, volume.filtered);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, volume.reach);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, volume.occupancy);
      const useRender = (mode: RenderMode, program = render): void => this.useRender(program, mode, n, occupancy, camera, pixelWidth, pixelHeight, shift, focal, temporal);

      // How wide a voxel at the cube's centre is on screen, in pixels.
      const voxelPx = (pixelHeight * focal) / (n * Math.hypot(...camera.eye));
      const twoPass = temporal && this.samples > 1 && voxelPx >= PROBE_FROM_PX;
      gl.scissor(...rect);
      this.passHook?.(twoPass ? 'probe' : 'render');
      if (twoPass) {
        this.probe.begin(pixelWidth, pixelHeight, 3);
        gl.disable(gl.BLEND);
        useRender(1);
        gl.enable(gl.SCISSOR_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.SCISSOR_TEST);
      }
      if (temporal) {
        this.accumulator.begin(pixelWidth, pixelHeight);
        gl.disable(gl.BLEND);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.enable(gl.BLEND);
      }
      gl.enable(gl.SCISSOR_TEST);
      // The probe's textures are bound only now: the probe pass draws into them.
      if (twoPass) {
        this.passHook?.('refine');
        this.probe.bindTextures(3);
        this.refineEdges(() => useRender(2));
      }
      else {
        if (temporal) this.warmUp(prepared, rect, useRender);
        useRender(0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      if (temporal) this.accumulator.finish(camera, shift, focal, this.motion(n), this.settled, rect);
    }
    gl.disable(gl.BLEND);
    this.passHook?.(null);
  }

  // ---------- internals ----------

  /** Draws one pixel with each newly compiled variant, into the accumulator just before the frame's
   * own draw overwrites it. A shader cache that has never seen a variant (a first visit) builds
   * its GPU pipeline at the first draw, which held up the frame a variant was first used in by
   * 70-100 ms on Apple M5; drawn early, that happens while the variant isn't needed yet. */
  private warmUp(prepared: (Program | null)[], rect: Rect, useRender: (mode: RenderMode, program: Program) => void): void {
    const { gl } = this;
    for (const program of prepared) {
      if (!program || this.warmed.has(program)) continue;
      this.warmed.add(program);
      useRender(0, program);
      gl.scissor(rect[0], rect[1], 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.scissor(...rect);
      return; // one a frame, so their costs don't add up in one frame
    }
  }

  /** After the probe pass, into the bound target: marks the probe's edges in the stencil, copies its
   * colour everywhere else, and casts the refine pass's rays at the marks (see RENDER_FS main).
   * Leaves the render program in use. */
  private refineEdges(useRender: () => void): void {
    const { gl } = this;
    const e = this.probeEdges.uniforms;
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.useProgram(this.probeEdges.program);
    gl.uniform1i(e.uProbeColor, 3);
    gl.uniform1i(e.uProbeDepth, 4);
    gl.uniform1i(e.uProbeFaces, 5);

    gl.uniform1i(e.uMark, 1);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.colorMask(true, true, true, true);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    gl.uniform1i(e.uMark, 0);
    gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    useRender();
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.STENCIL_TEST);
  }

  /** Puts the ray-cast program in use for a pass, with every uniform set (see RENDER_FS). */
  private useRender(render: Program, mode: RenderMode, n: number, occupancy: Occupancy, camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number, temporal: boolean): void {
    const { gl } = this;
    const u = render.uniforms;
    gl.useProgram(render.program);
    this.setCamera(render, camera, pixelWidth, pixelHeight, shift, focal);
    gl.uniform1i(u.uChaos, 0);
    gl.uniform1i(u.uPass, 1);
    gl.uniform1i(u.uReach, 2);
    gl.uniform1i(u.uOccupancy, 7);
    gl.uniform1i(u.uAtlasShift, atlasShift(occupancy.size));
    gl.uniform3iv(u.uBoxBricks, occupancy.base);
    gl.uniform1i(u.uBoxSize, occupancy.size);
    gl.uniform1i(u.uProbeColor, 3);
    gl.uniform1i(u.uProbeDepth, 4);
    gl.uniform1f(u.uLevels, CHAOS.levels - 1);
    gl.uniform1i(u.uN, n);
    gl.uniform3fv(u.uOffset, this.boxOffset(n));
    gl.uniform1f(u.uThreshold, this.threshold);
    gl.uniform1fv(u['uTrail[0]'], this.trailPoints);
    gl.uniform1i(u.uGlow, this.opts.glow ? 1 : 0);
    gl.uniform1f(u.uPixelAngle, 2 / (pixelHeight * focal));
    gl.uniform3fv(u.uBase, hexToRgb(this.opts.base));
    gl.uniform3fv(u.uAccent, hexToRgb(this.opts.accent));
    gl.uniform1i(u.uColorBy, COLOR_BY[this.opts.colorBy]);
    gl.uniform3fv(u['uRamp[0]'], this.opts.ramp.flatMap(hexToRgb));
    gl.uniform1i(u.uSun, this.opts.sun ? 1 : 0);
    gl.uniform1i(u.uSamples, this.samples);
    // With several rays, each already has its own part of the pixel; the jitter moves them about
    // within it.
    const jitter = temporal ? this.accumulator.jitter.map(j => (this.samples > 1 ? j / 2 : j)) : [0, 0];
    gl.uniform2fv(u.uJitter, jitter);
    gl.uniform1i(u.uSunFrame, temporal ? this.accumulator.frameIndex : 0);
    gl.uniform4fv(u.uCarve, this.carve);
    gl.uniform1f(u.uHollow, boreHollowRadius(this.carve[3], this.threshold, n));
    // The sun keeps its place relative to the viewer (high, upper left, behind them), so orbiting
    // looks like the cube turning under a fixed sun.
    const sun = camera.right.map((r, i) => -0.5 * r + 0.85 * (i === 1 ? 1 : 0) - 0.45 * camera.forward[i]);
    const len = Math.hypot(...sun);
    gl.uniform3f(u.uSunDir, sun[0] / len, sun[1] / len, sun[2] / len);
    gl.uniform1i(u.uMode, mode);
  }

  /** Where the box starts in the tiled volume, 0..n per axis (RENDER_FS's uOffset). */
  private boxOffset(n: number): [number, number, number] {
    return this.offset.map(o => ((o % n) + n) % n) as [number, number, number];
  }

  /** What the occupancy texture covers this frame (see OCCUPANCY_FS). */
  private occupancyLayout(n: number): Occupancy {
    return this.carve[3] > 0 ? boxBricks(n, this.boxOffset(n)) : { size: n / BRICK, base: [0, 0, 0] };
  }

  /** How far the voxels moved since the last call, in world units: the volume moving through the
   * box shifts them the other way. Takes the short way round where the offset wraps. */
  private motion(n: number): [number, number, number] {
    const last = this.lastOffset ?? this.offset;
    this.lastOffset = [...this.offset];
    return this.offset.map((o, i) => {
      let d = o - last[i];
      d -= n * Math.round(d / n);
      return (-d * 2) / n;
    }) as [number, number, number];
  }

  private setCamera(p: Program, c: CameraBasis, w: number, h: number, shift: [number, number], focal: number): void {
    const { gl } = this;
    const u = p.uniforms;
    gl.uniform2f(u.uResolution, w, h);
    gl.uniform2fv(u.uShift, shift);
    gl.uniform1f(u.uFocal, focal);
    gl.uniform3fv(u.uEye, c.eye);
    gl.uniform3fv(u.uRight, c.right);
    gl.uniform3fv(u.uUp, c.up);
    gl.uniform3fv(u.uForward, c.forward);
  }

  /** One frame's share of loading a cube: uploading slices, then filtering them, then swapping it in. */
  private continueLoad(job: Incoming): void {
    const { gl } = this;
    this.volumeVersion++;
    const { n } = job.volume;
    const slices = Math.max(1, Math.floor(VOXELS_PER_FRAME / (n * n)));
    if (job.uploaded < n) {
      const count = Math.min(slices, n - job.uploaded);
      gl.bindTexture(gl.TEXTURE_3D, job.volume.chaos);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, job.uploaded, n, n, count, gl.RED_INTEGER, gl.UNSIGNED_BYTE,
        job.bytes.subarray(job.uploaded * n * n, (job.uploaded + count) * n * n));
      job.uploaded += count;
      return;
    }
    if (job.filtered < n) {
      const count = Math.min(slices, n - job.filtered);
      this.refreshFilter(job.volume, job.filtered, count);
      job.filtered += count;
      return;
    }
    if (this.volume && this.volume !== job.volume) this.deleteVolume(this.volume);
    this.volume = job.volume;
    this.volume.bricksStale = true;
    this.volume.occupancyFor = null;
    this.incoming = null;
    job.done();
  }

  /** Recomputes the highest threshold each voxel passes the filter at, for z-slices [from, from + count). */
  private refreshFilter(volume: Volume, from: number, count: number): void {
    const { gl } = this;
    const { n } = volume;
    const u = this.filter.uniforms;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.viewport(0, 0, n, n);
    gl.useProgram(this.filter.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.chaos);
    gl.uniform1i(u.uChaos, 0);
    gl.uniform1i(u.uN, n);
    gl.uniform1i(u.uK, this.filterK);
    for (let z = from; z < from + count; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume.filtered, 0, z);
      gl.uniform1i(u.uZ, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** Rebuilds the highest level per brick, then over squares and cubes of bricks around it (see
   * REACH_RADII): two draws into atlases, then one per z-slice of bricks into the ray-cast's 3D texture. */
  private refreshBricks(volume: Volume): void {
    const { gl } = this;
    const { n } = volume;
    const size = n / BRICK;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.activeTexture(gl.TEXTURE0);
    // Samplers read texture unit 0, their default.
    const atlasPass = (program: Program, target: WebGLTexture): void => {
      gl.useProgram(program.program);
      gl.uniform1i(program.uniforms.uSize, size);
      gl.uniform1i(program.uniforms.uAtlasShift, atlasShift(size));
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.viewport(0, 0, ...atlasSize(size));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.bindTexture(gl.TEXTURE_3D, volume.filtered);
    atlasPass(this.brickPass, volume.bricks);
    gl.bindTexture(gl.TEXTURE_2D, volume.bricks);
    atlasPass(this.reachPlanePass, volume.reachPlanes);

    const u = this.reachPass.uniforms;
    gl.useProgram(this.reachPass.program);
    gl.bindTexture(gl.TEXTURE_2D, volume.reachPlanes);
    gl.uniform1i(u.uSize, size);
    gl.uniform1i(u.uAtlasShift, atlasShift(size));
    gl.viewport(0, 0, size, size);
    for (let z = 0; z < size; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume.reach, 0, z);
      gl.uniform1i(u.uZ, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** Rebuilds which voxels show at the threshold, bore included (see OCCUPANCY_FS), in one draw.
   * The threshold sweeps during playback, so this runs most frames then. */
  private refreshOccupancy(volume: Volume, occupancy: Occupancy): void {
    const { gl } = this;
    const { n } = volume;
    const u = this.occupancyPass.uniforms;
    const [width, height] = atlasSize(occupancy.size);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, volume.occupancy, 0);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.occupancyPass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.filtered);
    gl.uniform1i(u.uPass, 0);
    gl.uniform1f(u.uThreshold, this.threshold);
    gl.uniform1i(u.uN, n);
    gl.uniform1i(u.uAtlasShift, atlasShift(occupancy.size));
    gl.uniform1i(u.uSize, occupancy.size);
    gl.uniform3iv(u.uBase, occupancy.base);
    gl.uniform3fv(u.uOffset, this.boxOffset(n));
    gl.uniform4fv(u.uCarve, this.carve);
    gl.uniform1f(u.uLevels, CHAOS.levels - 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** A texture with a texel per brick, `size` bricks per axis, laid out as an atlas (see atlasSize). */
  private atlasTexture(size: number, format: 'R8UI' | 'RGBA8UI' | 'RG32UI'): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl[format], ...atlasSize(size));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  private deleteVolume(volume: Volume): void {
    this.gl.deleteTexture(volume.occupancy);
    this.gl.deleteTexture(volume.chaos);
    this.gl.deleteTexture(volume.filtered);
    this.gl.deleteTexture(volume.bricks);
    this.gl.deleteTexture(volume.reachPlanes);
    this.gl.deleteTexture(volume.reach);
  }

  private texture(n: number, format: 'R8UI' | 'R16UI' | 'RGBA8UI'): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl[format], n, n, n);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // The default, set anyway: RENDER_FS relies on the sampler wrapping the periodic volume.
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, axis, gl.REPEAT);
    return texture;
  }
}
