// Temporal accumulation: each frame casts one ray per pixel at a different point
// in the pixel, and RESOLVE_FS blends it into a reprojected history, so a few frames add up to many
// rays per pixel for the cost of one. Needs float render targets (EXT_color_buffer_float).
//
// The rays can also be cast at a lower resolution than the history's (temporal upscaling, as in
// FSR 2 or Unreal's TSR): the jitter moves them about within their larger pixels, and the resolve
// puts each where it landed in the full-resolution history (see RESOLVE_FS's UPSCALE).

import { createProgram, type Program, SCRATCH_UNIT } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { type Rect, union } from './screenRect.ts';
import { FULLSCREEN_VS, PRESENT_FS, RESOLVE_FS } from './shaders.ts';

// Frames a still pixel's history averages over at most (see RESOLVE_FS for moving ones).
const HISTORY_FRAMES = 16;

interface Target {
  texture: WebGLTexture;
  weight: WebGLTexture; // when upscaling, how many rays' worth each pixel holds (see RESOLVE_FS)
  framebuffer: WebGLFramebuffer;
  drawn: Rect | null; // where it can hold anything; transparent everywhere else
}

interface Camera {
  basis: CameraBasis;
  shift: [number, number];
  focal: number;
}

/** The rays' target for an output of w × h at `scale` of its resolution per axis. Whole pixels,
 * with the scale made exactly height / h: the ray-cast's camera then takes the size as w·scale ×
 * h·scale (not rounded), so its pixels line up with the output's. */
export function raySize(w: number, h: number, scale: number): { width: number; height: number; scale: number } {
  if (scale >= 1) return { width: w, height: h, scale: 1 };
  const height = Math.max(1, Math.round(h * scale));
  const k = height / h;
  return { width: Math.ceil(w * k), height, scale: k };
}

/** The i-th point of the Halton sequence in a base, in 0..1. */
function halton(i: number, base: number): number {
  let f = 1, r = 0;
  for (let n = i + 1; n > 0; n = Math.floor(n / base)) {
    f /= base;
    r += f * (n % base);
  }
  return r;
}

export class Accumulator {
  readonly supported: boolean;
  /** For profiling: called as each of finish()'s passes starts (see CubeView.onPass). */
  onPass: ((pass: 'resolve' | 'present') => void) | null = null;
  private readonly gl: WebGL2RenderingContext;
  private readonly resolveProgram: Program;
  private readonly upscaleProgram: Program;
  private readonly presentProgram: Program;
  private width = 0;
  private height = 0;
  private rays = { width: 0, height: 0, scale: 1 }; // the frame target's size (see raySize)
  private frame: { framebuffer: WebGLFramebuffer; color: WebGLTexture; depth: WebGLTexture; stencil: WebGLRenderbuffer } | null = null;
  private history: [Target, Target] | null = null;
  private frames = 0; // frames blended since the last reset
  private weighed = false; // whether the last frame was upscaled, so the history's weights are up to date
  private previous: Camera | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.supported = gl.getExtension('EXT_color_buffer_float') !== null;
    this.resolveProgram = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.upscaleProgram = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS.replace('\n', '\n#define UPSCALE\n'));
    this.presentProgram = createProgram(gl, FULLSCREEN_VS, PRESENT_FS);
  }

  /** Drops the history; the next frame starts a new one. */
  reset(): void {
    this.frames = 0;
    this.previous = null;
    this.weighed = false;
  }

  /** Where in the pixel this frame's ray goes, from its centre. */
  get jitter(): [number, number] {
    const i = this.frames % 16;
    return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
  }

  /** Frames blended since the last reset; each one aims its shadow rays at new points on the sun disk. */
  get frameIndex(): number {
    return this.frames;
  }

  /** Whether there is a history at this size to present. */
  holds(w: number, h: number): boolean {
    return this.frames > 0 && w === this.width && h === this.height;
  }

  /** Binds the target for this frame's rays (colour and first-surface distance, plus a stencil for
   * drawing only some pixels), sized `rays` (see raySize), for an output of w × h. The history
   * carries on when only the rays' size changes, so the scale can change between moving and still. */
  begin(w: number, h: number, rays: { width: number; height: number; scale: number }): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT); // not a unit the volume's textures are bound to
    if (w !== this.width || h !== this.height || !this.history) this.allocateHistory(w, h);
    if (rays.width !== this.rays.width || rays.height !== this.rays.height || !this.frame) this.allocateFrame(rays);
    this.rays = { ...rays };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame!.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, rays.width, rays.height);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [-1, 0, 0, 0]);
  }

  /** This frame's colour and first-surface distance, after begin(): for drawing them in passes of
   * one's own (see shadowReuse.ts). */
  get frameTextures(): { color: WebGLTexture; depth: WebGLTexture } {
    return this.frame!;
  }

  /** Blends this frame into the history, then draws the result into the default framebuffer
   * (premultiplied, over whatever is there). `motion` is how far the voxels moved since the last
   * frame, in world units. `settled`: the cube isn't changing, so still pixels can keep a long history.
   * `rect`: the pixels the cube can cover (see screenRect.ts); the blend is transparent outside it.
   * `jitter`: where in their pixels this frame's rays went, from the centre. */
  finish(camera: CameraBasis, shift: [number, number], focal: number, motion: [number, number, number], settled: boolean, rect: Rect, jitter: [number, number]): void {
    const { gl } = this;
    const [from, to] = this.history!;
    const upscale = this.rays.scale < 1;
    const program = upscale ? this.upscaleProgram : this.resolveProgram;
    const u = program.uniforms;
    this.onPass?.('resolve');
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawBuffers(upscale ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    gl.useProgram(program.program);
    if (upscale) {
      this.bindTexture(3, from.weight, u.uHistoryWeight);
      gl.uniform1i(u.uWeighed, this.weighed ? 1 : 0);
      gl.uniform2f(u.uInternal, this.rays.width, this.rays.height);
      gl.uniform1f(u.uScale, this.rays.scale);
      gl.uniform2fv(u.uJitter, jitter);
    }
    this.bindTexture(0, this.frame!.color, u.uCurrent);
    this.bindTexture(1, this.frame!.depth, u.uDepth);
    this.bindTexture(2, from.texture, u.uHistory);
    gl.uniform1f(u.uBlend, this.previous ? 1 / Math.min(this.frames + 1, HISTORY_FRAMES) : 1);
    gl.uniform1i(u.uSettled, settled ? 1 : 0);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform3fv(u.uMotion, motion);
    setCamera(gl, u, '', { basis: camera, shift, focal });
    setCamera(gl, u, 'Prev', this.previous ?? { basis: camera, shift, focal });
    // Outside the cube the blend comes out transparent, so only the cube's pixels need it, plus
    // wherever this target held the cube before, which has to be cleared to transparent for the
    // frames that reproject into it.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...(to.drawn ? union(rect, to.drawn) : rect));
    to.drawn = rect;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.history = [to, from];
    this.previous = { basis: camera, shift: [...shift], focal };
    this.frames++;
    this.weighed = upscale;
    this.present(rect);
  }

  /** Draws the history as it stands into the default framebuffer (premultiplied, over whatever is
   * there), over `rect`. */
  present(rect: Rect): void {
    const { gl } = this;
    this.onPass?.('present');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.presentProgram.program);
    this.bindTexture(0, this.history![0].texture, this.presentProgram.uniforms.uImage);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...rect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  private bindTexture(unit: number, texture: WebGLTexture, location: WebGLUniformLocation): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  private allocateFrame(rays: { width: number; height: number }): void {
    const { gl } = this;
    this.releaseFrame();
    // Linear for upscaling where there's no history, which interpolates the rays (the rest reads texels).
    const color = texture2d(gl, gl.RGBA8, rays.width, rays.height, gl.LINEAR);
    const depth = texture2d(gl, gl.R32F, rays.width, rays.height, gl.NEAREST);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
    const stencil = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, rays.width, rays.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
    this.frame = { framebuffer, color, depth, stencil };
  }

  private allocateHistory(w: number, h: number): void {
    const { gl } = this;
    this.releaseHistory();
    this.width = w;
    this.height = h;
    const target = (): Target => {
      const texture = texture2d(gl, gl.RGBA16F, w, h, gl.LINEAR);
      const weight = texture2d(gl, gl.R16F, w, h, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, weight, 0);
      return { texture, weight, framebuffer: fb, drawn: null }; // new textures start out transparent
    };
    this.history = [target(), target()];
    this.reset();
  }

  private releaseFrame(): void {
    const { gl } = this;
    if (this.frame) {
      gl.deleteFramebuffer(this.frame.framebuffer);
      gl.deleteTexture(this.frame.color);
      gl.deleteTexture(this.frame.depth);
      gl.deleteRenderbuffer(this.frame.stencil);
    }
    this.frame = null;
  }

  private releaseHistory(): void {
    const { gl } = this;
    for (const t of this.history ?? []) {
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.texture);
      gl.deleteTexture(t.weight);
    }
    this.history = null;
  }
}
function texture2d(gl: WebGL2RenderingContext, format: number, w: number, h: number, filter: number): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function setCamera(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation>, prefix: string, c: Camera): void {
  gl.uniform2fv(u[`u${prefix}Shift`], c.shift);
  gl.uniform1f(u[`u${prefix}Focal`], c.focal);
  gl.uniform3fv(u[`u${prefix}Eye`], c.basis.eye);
  gl.uniform3fv(u[`u${prefix}Right`], c.basis.right);
  gl.uniform3fv(u[`u${prefix}Up`], c.basis.up);
  gl.uniform3fv(u[`u${prefix}Forward`], c.basis.forward);
}
