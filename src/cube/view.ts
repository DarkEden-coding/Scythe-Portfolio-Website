// Draws a baked cube: n³ voxels, each holding its pendulum's chaos level (see cubeFile.ts). Voxels at
// or above the threshold show. Thresholding, the neighbour filter, colouring and moving the volume
// all run on the GPU, so they stay live.

import { CHAOS } from '../presets.ts';
import { createProgram, hexToRgb, type Program } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { BRICK, BRICKS_FS, EDGES_FS, EDGES_VS, FILTER_FS, FULLSCREEN_VS, RENDER_FS } from './shaders.ts';

export type ColorBy = 'plain' | 'neighbours' | 'chaos';

export interface ViewOptions {
  glow: number; // levels above the threshold that glow while it sweeps
  base: string;
  accent: string; // glow colour
  colorBy: ColorBy; // neighbours: by how many of the 26 show; chaos: by level, where all 26 show
  ramp: [string, string, string, string]; // low → high
  sun: boolean; // sunlight with cast shadows instead of the studio light
  edgeColor: [number, number, number, number];
}

const COLOR_BY: Record<ColorBy, number> = { plain: 0, neighbours: 1, chaos: 2 };

export class CubeView {
  readonly gl: WebGL2RenderingContext;
  readonly opts: ViewOptions;
  /** Voxels below this chaos level are hidden; fractions are fine. */
  threshold = 0;
  /** 0..1: how strongly voxels just above the threshold glow. */
  heat = 0;
  /** Moves the volume through the cube, in voxels per axis (fractions are fine); wraps around. */
  offset: [number, number, number] = [0, 0, 0];
  /** Rays per pixel: 4 keeps pixel-sized voxels from flashing as they move; 1 is a quarter the cost. */
  samples: 1 | 4 = 4;
  /** 0 = no filter; otherwise the number of showing neighbours (of 26) a voxel needs. */
  filterK = 0;

  private filter: Program;
  private brickPass: Program;
  private render: Program;
  private edges: Program;
  private n = 0;
  private chaos: WebGLTexture | null = null; // chaos level per voxel
  private filtered: WebGLTexture | null = null; // highest threshold each voxel passes the filter at
  private bricks: WebGLTexture | null = null; // highest level per brick of the volume
  private bricksStale = true;
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

  get size(): number {
    return this.n;
  }

  /** Shows a new cube: n³ chaos levels, x fastest (see cubeFile.ts). */
  load(bytes: Uint8Array, n: number): void {
    const { gl } = this;
    if (n !== this.n) {
      gl.deleteTexture(this.chaos);
      gl.deleteTexture(this.filtered);
      gl.deleteTexture(this.bricks);
      this.chaos = this.texture(n);
      this.filtered = this.texture(n);
      this.bricks = this.texture(n / BRICK);
      this.n = n;
    }
    this.bricksStale = true;
    gl.bindTexture(gl.TEXTURE_3D, this.chaos);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_BYTE, bytes);
    if (this.filterK > 0) this.refreshFilter();
  }

  setFilter(k: number): void {
    this.filterK = k;
    if (k > 0 && this.n > 0) this.refreshFilter();
    this.bricksStale = true;
  }

  draw(camera: CameraBasis, pixelWidth: number, pixelHeight: number, shift: [number, number], focal: number): void {
    const { gl } = this;
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

    if (this.n > 0) {
      const { n } = this;
      if (this.bricksStale) {
        this.refreshBricks();
        this.bricksStale = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.enable(gl.BLEND);
      }
      const u = this.render.uniforms;
      gl.useProgram(this.render.program);
      this.setCamera(this.render, camera, pixelWidth, pixelHeight, shift, focal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.chaos);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.filterK > 0 ? this.filtered : this.chaos);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, this.bricks);
      gl.uniform1i(u.uChaos, 0);
      gl.uniform1i(u.uPass, 1);
      gl.uniform1i(u.uBricks, 2);
      gl.uniform1f(u.uLevels, CHAOS.levels - 1);
      gl.uniform1i(u.uN, this.n);
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

  /** Recomputes the highest threshold each voxel passes the filter at, one z-slice per draw. */
  private refreshFilter(): void {
    const { gl, n } = this;
    const u = this.filter.uniforms;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.viewport(0, 0, n, n);
    gl.useProgram(this.filter.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.chaos);
    gl.uniform1i(u.uChaos, 0);
    gl.uniform1i(u.uN, n);
    gl.uniform1i(u.uK, this.filterK);
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.filtered, 0, z);
      gl.uniform1i(u.uZ, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** Rebuilds the highest level per brick of the box, one z-slice of bricks per draw. */
  private refreshBricks(): void {
    const { gl, n } = this;
    const u = this.brickPass.uniforms;
    const size = n / BRICK;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterTarget);
    gl.viewport(0, 0, size, size);
    gl.useProgram(this.brickPass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.filterK > 0 ? this.filtered : this.chaos);
    gl.uniform1i(u.uPass, 0);
    for (let z = 0; z < size; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.bricks, 0, z);
      gl.uniform1i(u.uZ, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
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
