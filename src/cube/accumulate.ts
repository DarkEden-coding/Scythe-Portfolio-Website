// Temporal accumulation: each frame casts one ray per pixel at a different point
// in the pixel, and RESOLVE_FS blends it into a reprojected history, so a few frames add up to many
// rays per pixel for the cost of one. Needs float render targets (EXT_color_buffer_float).

import { createProgram, type Program } from './gl.ts';
import type { CameraBasis } from './orbitCamera.ts';
import { FULLSCREEN_VS, PRESENT_FS, RESOLVE_FS } from './shaders.ts';

// Frames a still pixel's history averages over at most (see RESOLVE_FS for moving ones).
const HISTORY_FRAMES = 16;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface Camera {
  basis: CameraBasis;
  shift: [number, number];
  focal: number;
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
  private readonly gl: WebGL2RenderingContext;
  private readonly resolveProgram: Program;
  private readonly presentProgram: Program;
  private width = 0;
  private height = 0;
  private frame: { framebuffer: WebGLFramebuffer; color: WebGLTexture; depth: WebGLTexture; stencil: WebGLRenderbuffer } | null = null;
  private history: [Target, Target] | null = null;
  private frames = 0; // frames blended since the last reset
  private previous: Camera | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.supported = gl.getExtension('EXT_color_buffer_float') !== null;
    this.resolveProgram = createProgram(gl, FULLSCREEN_VS, RESOLVE_FS);
    this.presentProgram = createProgram(gl, FULLSCREEN_VS, PRESENT_FS);
  }

  /** Drops the history; the next frame starts a new one. */
  reset(): void {
    this.frames = 0;
    this.previous = null;
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

  /** Binds the target for this frame's rays (colour and first-surface distance, plus a stencil for
   * drawing only some pixels), sized w × h. */
  begin(w: number, h: number): void {
    const { gl } = this;
    if (w !== this.width || h !== this.height || !this.frame) this.allocate(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame!.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, w, h);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [-1, 0, 0, 0]);
  }

  /** Blends this frame into the history, then draws the result into the default framebuffer
   * (premultiplied, over whatever is there). `motion` is how far the voxels moved since the last
   * frame, in world units. `settled`: the cube isn't changing, so still pixels can keep a long history. */
  finish(camera: CameraBasis, shift: [number, number], focal: number, motion: [number, number, number], settled: boolean): void {
    const { gl } = this;
    const [from, to] = this.history!;
    const u = this.resolveProgram.uniforms;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.resolveProgram.program);
    this.bindTexture(0, this.frame!.color, u.uCurrent);
    this.bindTexture(1, this.frame!.depth, u.uDepth);
    this.bindTexture(2, from.texture, u.uHistory);
    gl.uniform1f(u.uBlend, this.previous ? 1 / Math.min(this.frames + 1, HISTORY_FRAMES) : 1);
    gl.uniform1i(u.uSettled, settled ? 1 : 0);
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform3fv(u.uMotion, motion);
    setCamera(gl, u, '', { basis: camera, shift, focal });
    setCamera(gl, u, 'Prev', this.previous ?? { basis: camera, shift, focal });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.history = [to, from];
    this.previous = { basis: camera, shift: [...shift], focal };
    this.frames++;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.presentProgram.program);
    this.bindTexture(0, to.texture, this.presentProgram.uniforms.uImage);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTexture(unit: number, texture: WebGLTexture, location: WebGLUniformLocation): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  private allocate(w: number, h: number): void {
    const { gl } = this;
    this.release();
    this.width = w;
    this.height = h;
    const color = texture2d(gl, gl.RGBA8, w, h, gl.NEAREST);
    const depth = texture2d(gl, gl.R32F, w, h, gl.NEAREST);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
    const stencil = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
    this.frame = { framebuffer, color, depth, stencil };
    const target = (): Target => {
      const texture = texture2d(gl, gl.RGBA16F, w, h, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer: fb };
    };
    this.history = [target(), target()];
    this.reset();
  }

  private release(): void {
    const { gl } = this;
    if (this.frame) {
      gl.deleteFramebuffer(this.frame.framebuffer);
      gl.deleteTexture(this.frame.color);
      gl.deleteTexture(this.frame.depth);
      gl.deleteRenderbuffer(this.frame.stencil);
    }
    for (const t of this.history ?? []) {
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.texture);
    }
    this.frame = null;
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
