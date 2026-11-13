// Draws a baked cube: n³ voxels, each holding its pendulum's chaos level (see cubeFile.ts). Voxels at
// or above the threshold show. Thresholding, the neighbour filter, colouring and moving the volume
// all run on the GPU, so they stay live.

import { CHAOS } from '../presets.ts';
import { createProgram, hexToRgb, type Program } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { BRICK, BRICKS_FS, EDGES_FS, EDGES_VS, FILTER_FS, FULLSCREEN_VS, RENDER_FS } from './shaders.ts';

export type ColorBy = 'plain' | 'neighbours' | 'chaos' | 'both';
export type Samples = 1 | 2 | 4;

export interface ViewOptions {
  glow: number; // levels above the threshold that glow while it sweeps
  base: string;
  accent: string; // glow colour
  colorBy: ColorBy; // neighbours: by how many of the 26 show; chaos: by level, where all 26 show; both: each where it applies
  ramp: [string, string, string, string]; // low → high
  sun: boolean; // sunlight with cast shadows instead of the studio light
  edgeColor: [number, number, number, number];
}

const COLOR_BY: Record<ColorBy, number> = { plain: 0, neighbours: 1, chaos: 2, both: 3 };

// Uploading and filtering a whole Ultra cube at once holds the GPU for about a tenth of a second, a
// visible hitch, so a new cube goes in this many voxels per frame.
const VOXELS_PER_FRAME = 1 << 22;

// One cube's textures.
interface Volume {
  n: number;
  chaos: WebGLTexture; // chaos level per voxel
  filtered: WebGLTexture; // highest threshold each voxel passes the filter at
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
  /** 0..1: how strongly voxels just above the threshold glow. */
  heat = 0;
  /** Moves the volume through the cube, in voxels per axis (fractions are fine); wraps around. */
  offset: [number, number, number] = [0, 0, 0];
  /** Rays per pixel: 4 keeps pixel-sized voxels from flashing as they move; each ray costs a trace. */
  samples: Samples = 4;
  /** A bore cut into the voxels from the centre out: its axis (a unit vector) and radius, where the
   * box spans -1..1. Radius 0 is no bore. */
  carve: [number, number, number, number] = [0, 0, 1, 0];
  /** 0 = no filter; otherwise the number of showing neighbours (of 26) a voxel needs. */
  filterK = 0;

  private filter: Program;
  private brickPass: Program;
  private render: Program;
  private edges: Program;
  private volume: Volume | null = null; // the cube on screen
  private incoming: Incoming | null = null;
  private filterTarget: WebGLFramebuffer;

  /** Returns null without WebGL2. */
  static create(canvas: HTMLCanvasElement, opts: ViewOptions): CubeView | null {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
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
    this.filter = createProgram(gl, FULLSCREEN_VS, FILTER_FS);
    this.brickPass = createProgram(gl, FULLSCREEN_VS, BRICKS_FS);
    this.render = createProgram(gl, FULLSCREEN_VS, RENDER_FS);
    this.edges = createProgram(gl, EDGES_VS, EDGES_FS);
    this.filterTarget = gl.createFramebuffer();
    gl.bindVertexArray(gl.createVertexArray());
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
      ?? { n, chaos: this.texture(n), filtered: this.texture(n), bricks: this.texture(n / BRICK), bricksStale: true };
    if (this.incoming) {
      const old = this.incoming.volume;
      if (old !== volume && old !== this.volume) this.deleteVolume(old);
      this.incoming.done(); // superseded
    }
    return new Promise(done => { this.incoming = { volume, bytes, uploaded: 0, filtered: 0, done }; });
  }

  setFilter(k: number): void {
    this.filterK = k;
    if (this.incoming) this.incoming.filtered = 0;
    if (k > 0 && this.volume && this.volume !== this.incoming?.volume) this.refreshFilter(this.volume, 0, this.volume.n);
    if (this.volume) this.volume.bricksStale = true;
  }

  draw(camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number): void {
    const { gl } = this;
    if (this.incoming) this.continueLoad(this.incoming);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Outline first; the voxels cover it where they stand in front.
    const [r, g, b, a] = this.opts.edgeColor;
    gl.useProgram(this.edges.program);
    this.setCamera(this.edges, camera, pixelWidth, pixelHeight, shift, focal);
    gl.uniform4f(this.edges.uniforms.uColor, r * a, g * a, b * a, a);
    gl.drawArrays(gl.LINES, 0, 24);

    const volume = this.volume;
    if (volume && volume !== this.incoming?.volume) {
      const { n } = volume;
      if (volume.bricksStale) {
        this.refreshBricks(volume);
        volume.bricksStale = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.enable(gl.BLEND);
      }
      const u = this.render.uniforms;
      gl.useProgram(this.render.program);
      this.setCamera(this.render, camera, pixelWidth, pixelHeight, shift, focal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, volume.chaos);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.filterK > 0 ? volume.filtered : volume.chaos);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, volume.bricks);
      gl.uniform1i(u.uChaos, 0);
      gl.uniform1i(u.uPass, 1);
      gl.uniform1i(u.uBricks, 2);
      gl.uniform1f(u.uLevels, CHAOS.levels - 1);
      gl.uniform1i(u.uN, n);
      gl.uniform3fv(u.uOffset, this.offset.map(o => ((o % n) + n) % n));
      gl.uniform1f(u.uThreshold, this.threshold);
      gl.uniform1f(u.uHeat, this.heat);
      gl.uniform1f(u.uGlow, this.opts.glow);
      gl.uniform1f(u.uPixelAngle, 2 / (pixelHeight * focal));
      gl.uniform3fv(u.uBase, hexToRgb(this.opts.base));
      gl.uniform3fv(u.uAccent, hexToRgb(this.opts.accent));
      gl.uniform1i(u.uColorBy, COLOR_BY[this.opts.colorBy]);
      gl.uniform3fv(u['uRamp[0]'], this.opts.ramp.flatMap(hexToRgb));
      gl.uniform1i(u.uSun, this.opts.sun ? 1 : 0);
      gl.uniform1i(u.uSamples, this.samples);
      gl.uniform4fv(u.uCarve, this.carve);
      // The sun keeps its place relative to the viewer (high, upper left, behind them), so orbiting
      // looks like the cube turning under a fixed sun.
      const sun = camera.right.map((r, i) => -0.5 * r + 0.85 * (i === 1 ? 1 : 0) - 0.45 * camera.forward[i]);
      const len = Math.hypot(...sun);
      gl.uniform3f(u.uSunDir, sun[0] / len, sun[1] / len, sun[2] / len);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }

  // ---------- internals ----------

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
    if (this.filterK > 0 && job.filtered < n) {
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
    gl.bindTexture(gl.TEXTURE_3D, this.filterK > 0 ? volume.filtered : volume.chaos);
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

  private texture(n: number): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8UI, n, n, n);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }
}
