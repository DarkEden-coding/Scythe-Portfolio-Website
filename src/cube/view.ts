// Draws a baked cube: n³ voxels, each holding its pendulum's chaos level (see cubeFile.ts). Voxels at
// or above the threshold show. Thresholding, the neighbour filter, colouring and moving the volume
// all run on the GPU, so they stay live.

import { CHAOS } from '../presets.ts';
import { Accumulator } from './accumulate.ts';
import { pictureKey, Stillness } from './freeze.ts';
import { createProgram, hexToRgb, type Program } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { ProbeTarget } from './probe.ts';
import { cubeRect } from './screenRect.ts';
import { BRICK, BRICKS_FS, EDGES_FS, EDGES_VS, FILTER_FS, FULLSCREEN_VS, PROBE_EDGES_FS, RENDER_FS } from './shaders.ts';
import { ThresholdTrail, TRAIL_SAMPLES } from './thresholdTrail.ts';
import { ProgramVariants } from './variants.ts';

export type ColorBy = 'plain' | 'neighbours' | 'chaos' | 'both';
export type Samples = 1 | 2 | 4;
/** The GPU passes of a draw, for profiling (see CubeView.onPass). */
export type Pass = 'edges' | 'bricks' | 'probe' | 'refine' | 'render' | 'resolve' | 'present';

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

// RENDER_FS's uMode: 0 all rays, 1 the probe pass, 2 the refine pass.
type RenderMode = 0 | 1 | 2;

// Uploading and filtering a whole Ultra cube at once holds the GPU for about a tenth of a second, a
// visible hitch, so a new cube goes in this many voxels per frame.
const VOXELS_PER_FRAME = 1 << 22;

// With several rays, voxels at least this many pixels wide draw in passes, extra rays only at edges
// (see RENDER_FS). Smaller ones leave too few pixels inside a face for that to pay. Only when
// accumulating: the refine pass needs the accumulator's stencil buffer.
const PROBE_FROM_PX = 4;

// One cube's textures.
interface Volume {
  n: number;
  chaos: WebGLTexture; // chaos level per voxel
  filtered: WebGLTexture; // highest threshold each voxel passes the filter at, with its order (see FILTER_FS)
  bricks: WebGLTexture; // highest level per brick of the volume
  bricksStale: boolean;
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

  private passHook: ((pass: Pass | null) => void) | null = null;
  private filter: Program;
  private brickPass: Program;
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
      ?? { n, chaos: this.texture(n, 'R8UI'), filtered: this.texture(n, 'R16UI'), bricks: this.texture(n / BRICK, 'R8UI'), bricksStale: true };
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
    if (this.volume) this.volume.bricksStale = true;
  }

  draw(camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number): void {
    const { gl } = this;
    if (this.incoming) this.continueLoad(this.incoming);
    const temporal = this.accumulate && this.accumulator.supported;
    if (!temporal) this.accumulator.reset();
    this.trail.sample(this.trailPoints);
    // The pass stays a uniform: as a constant it saves little, and the compiler then treats the
    // probe and refine passes' floating point differently enough to move soft shadow edges.
    const render = this.render.get({
      uSamples: this.samples, uSun: this.opts.sun, uColorBy: COLOR_BY[this.opts.colorBy],
      uGlow: this.opts.glow, CARVING: this.carve[3] > 0,
    });
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
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.enable(gl.BLEND);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, volume.chaos);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, volume.filtered);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, volume.bricks);
      const useRender = (mode: RenderMode): void => this.useRender(render, mode, n, camera, pixelWidth, pixelHeight, shift, focal, temporal);

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
  private useRender(render: Program, mode: RenderMode, n: number, camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number, temporal: boolean): void {
    const { gl } = this;
    const u = render.uniforms;
    gl.useProgram(render.program);
    this.setCamera(render, camera, pixelWidth, pixelHeight, shift, focal);
    gl.uniform1i(u.uChaos, 0);
    gl.uniform1i(u.uPass, 1);
    gl.uniform1i(u.uBricks, 2);
    gl.uniform1i(u.uProbeColor, 3);
    gl.uniform1i(u.uProbeDepth, 4);
    gl.uniform1f(u.uLevels, CHAOS.levels - 1);
    gl.uniform1i(u.uN, n);
    gl.uniform3fv(u.uOffset, this.offset.map(o => ((o % n) + n) % n));
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
    // The sun keeps its place relative to the viewer (high, upper left, behind them), so orbiting
    // looks like the cube turning under a fixed sun.
    const sun = camera.right.map((r, i) => -0.5 * r + 0.85 * (i === 1 ? 1 : 0) - 0.45 * camera.forward[i]);
    const len = Math.hypot(...sun);
    gl.uniform3f(u.uSunDir, sun[0] / len, sun[1] / len, sun[2] / len);
    gl.uniform1i(u.uMode, mode);
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

  /** Rebuilds the highest level per brick of the box, one z-slice of bricks per draw. */
  private refreshBricks(volume: Volume): void {
    const { gl } = this;
    const { n } = volume;
    const u = this.brickPass.uniforms;
    const size = n / BRICK;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.viewport(0, 0, size, size);
    gl.useProgram(this.brickPass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.filtered);
    gl.uniform1i(u.uPass, 0);
    for (let z = 0; z < size; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume.bricks, 0, z);
      gl.uniform1i(u.uZ, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private deleteVolume(volume: Volume): void {
    this.gl.deleteTexture(volume.chaos);
    this.gl.deleteTexture(volume.filtered);
    this.gl.deleteTexture(volume.bricks);
  }

  private texture(n: number, format: 'R8UI' | 'R16UI'): WebGLTexture {
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
