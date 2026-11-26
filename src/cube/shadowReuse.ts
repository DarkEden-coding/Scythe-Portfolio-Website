// Reused shadows (CubeView.shadowReuse): shadow rays at a quarter of the pixels, shared out to the
// rest (see SHADOW_COMBINE_FS). The ray-cast draws into the accumulator's frame as usual, but leaves
// the direct sun out, writing it apart with where each pixel's shadow ray starts; the shadow pass
// casts one shadow ray per 2×2 block into a half-size texture; the combine pass adds the sun back
// into the frame, shadowed, for the temporal AA to blend.
//
// The passes this adds cost about as much as one shadow ray per pixel saves (at home, the camera
// moving), so the extra targets are kept small (12 bytes a pixel) and nothing is cleared: the passes
// only read what this frame drew.

import { createProgram, type Program, SCRATCH_UNIT } from './gl.ts';
import type { Rect } from './screenRect.ts';
import { FULLSCREEN_VS, SHADOW_COMBINE_FS } from './shaders.ts';

// The texture units these passes read from, clear of the ray-cast's.
const UNIT = 8;

interface Frame {
  color: WebGLTexture;
  depth: WebGLTexture;
}

export class ShadowReuse {
  private readonly gl: WebGL2RenderingContext;
  private readonly combineProgram: Program;
  private width = 0;
  private height = 0;
  private frame: Frame | null = null; // the accumulator's
  private target: { framebuffer: WebGLFramebuffer; sunlit: WebGLTexture; from: WebGLTexture } | null = null;
  private shadow: { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null = null;
  private combineFramebuffer: WebGLFramebuffer | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.combineProgram = createProgram(gl, FULLSCREEN_VS, SHADOW_COMBINE_FS);
  }

  /** Binds the ray-cast's target, sized w × h: the accumulator's frame (colour without the direct
   * sun, and first-surface distance), then the unshadowed sun and where shadow rays start (RENDER_FS
   * with SHADOW_REUSE). Call after the accumulator's begin(), which clears the frame. */
  begin(w: number, h: number, frame: Frame): void {
    const { gl } = this;
    if (w !== this.width || h !== this.height || frame.color !== this.frame?.color || frame.depth !== this.frame.depth) this.allocate(w, h, frame);
    this.unbind();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target!.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    gl.viewport(0, 0, w, h);
  }

  /** Casts the shadow rays for the pixels in `rect`, which the ray-cast drew: `useShadowPass` puts
   * RENDER_FS with SHADOW_PASS in use, with its uniforms set. */
  cast(useShadowPass: () => Program, rect: Rect): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow!.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, Math.ceil(this.width / 2), Math.ceil(this.height / 2));
    const u = useShadowPass().uniforms;
    this.bind(0, this.target!.from, u.uSunFrom);
    const [x, y, w, h] = rect;
    gl.uniform4i(u.uDrawn, x, y, x + w, y + h);
    const blocks = halve(rect);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(blocks[0], blocks[1], blocks[2] - blocks[0], blocks[3] - blocks[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Adds the shadowed sun into the accumulator's frame, over `rect`. */
  combine(rect: Rect): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.combineFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    const u = this.combineProgram.uniforms;
    gl.useProgram(this.combineProgram.program);
    this.bind(1, this.target!.sunlit, u.uSunlit);
    this.bind(2, this.target!.from, u.uSunFrom);
    this.bind(3, this.shadow!.texture, u.uShadow);
    gl.uniform4i(u.uBlocks, ...halve(rect));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...rect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  private bind(i: number, texture: WebGLTexture, location: WebGLUniformLocation): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + UNIT + i);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, UNIT + i);
  }

  // WebGL refuses to draw into a texture that is bound for reading.
  private unbind(): void {
    const { gl } = this;
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + UNIT + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  private allocate(w: number, h: number, frame: Frame): void {
    const { gl } = this;
    this.release();
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    this.width = w;
    this.height = h;
    this.frame = frame;
    const sunlit = texture2d(gl, gl.RGB10_A2, w, h);
    const from = texture2d(gl, gl.RG32UI, w, h);
    this.target = { framebuffer: framebuffer(gl, [frame.color, frame.depth, sunlit, from]), sunlit, from };
    const texture = texture2d(gl, gl.RGBA32F, Math.ceil(w / 2), Math.ceil(h / 2));
    this.shadow = { framebuffer: framebuffer(gl, [texture]), texture };
    this.combineFramebuffer = framebuffer(gl, [frame.color]);
  }

  private release(): void {
    const { gl } = this;
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.sunlit);
      gl.deleteTexture(this.target.from);
    }
    if (this.shadow) {
      gl.deleteFramebuffer(this.shadow.framebuffer);
      gl.deleteTexture(this.shadow.texture);
    }
    if (this.combineFramebuffer) gl.deleteFramebuffer(this.combineFramebuffer);
    this.target = null;
    this.shadow = null;
    this.combineFramebuffer = null;
  }
}

/** The 2×2 blocks a rect of pixels touches, from xy to zw (exclusive). */
function halve([x, y, w, h]: Rect): [number, number, number, number] {
  return [Math.floor(x / 2), Math.floor(y / 2), Math.ceil((x + w) / 2), Math.ceil((y + h) / 2)];
}

function framebuffer(gl: WebGL2RenderingContext, textures: WebGLTexture[]): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  return fb;
}

function texture2d(gl: WebGL2RenderingContext, format: number, w: number, h: number): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}
