// Splits a frame's time by pass (CubeView.onPass): at each pass boundary, waits for the GPU and reads
// the clock. gl.finish() doesn't wait in Chrome, and on ANGLE's Metal backend reading a pixel only
// waits for the work that draws it, so the wait reads one pixel of whatever the last pass drew into.
// The waits cost a little (more on the screen's multisampled buffer), so the passes add up to a bit
// more than an unsplit frame: use the split for where time goes, and whole-frame times for how much.

import type { Pass } from '../src/cube/view.ts';

export class PassClock {
  private readonly gl: WebGL2RenderingContext;
  private readonly times = new Map<Pass, number[]>();
  private current: Pass | null = null;
  private since = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** For CubeView.onPass. */
  hook = (pass: Pass | null): void => {
    this.wait();
    const now = performance.now();
    if (this.current) {
      const list = this.times.get(this.current) ?? [];
      list.push(now - this.since);
      this.times.set(this.current, list);
    }
    this.current = pass;
    this.since = now;
  };

  /** Reads a pixel of the bound draw framebuffer, in whatever format it can be read in. */
  private wait(): void {
    const { gl } = this;
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING));
    const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
    const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
    const pixel = type === gl.FLOAT ? new Float32Array(4)
      : type === gl.HALF_FLOAT ? new Uint16Array(4)
      : type === gl.UNSIGNED_INT ? new Uint32Array(4)
      : type === gl.INT ? new Int32Array(4)
      : type === gl.UNSIGNED_SHORT ? new Uint16Array(4)
      : new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, format, type, pixel);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
  }

  /** Median ms per pass, over the frames it ran in. */
  medians(): Partial<Record<Pass, number>> {
    const out: Partial<Record<Pass, number>> = {};
    for (const [pass, list] of this.times) out[pass] = [...list].sort((a, b) => a - b)[list.length >> 1];
    return out;
  }
}
