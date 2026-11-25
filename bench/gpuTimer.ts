// GPU time per frame, from EXT_disjoint_timer_query_webgl2. WebGL only hands back a query's result
// after control returns to the browser, so results are collected afterwards.
//
// Only whole frames: on ANGLE's Metal backend a query seems to cover its whole command buffer, so
// queries around single passes came out as the frame's time so far, not the pass's (passClock.ts
// splits frames instead).

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  private pending: WebGLQuery[] = [];

  /** Null without the extension. */
  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    return ext ? new GpuTimer(gl, ext) : null;
  }

  private constructor(gl: WebGL2RenderingContext, ext: GpuTimer['ext']) {
    this.gl = gl;
    this.ext = ext;
  }

  /** Times the GPU work `run` queues as one query. */
  timeFrame(run: () => void): void {
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    run();
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(query);
  }

  /** Waits for every query so far and returns their times in ms. Null if the GPU timer was
   * disjoint (clock change or context loss), so the times can't be trusted. */
  async collect(): Promise<number[] | null> {
    const { gl } = this;
    const pending = this.pending;
    this.pending = [];
    const last = pending.at(-1);
    while (last && !gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) await new Promise(r => setTimeout(r, 1));
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    const times = pending.map(query => (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
    for (const query of pending) gl.deleteQuery(query);
    return disjoint ? null : times;
  }
}

/** For GPUs without timer queries (SwiftShader has none): the wall time of the draw plus a
 * 1-pixel read, which waits for the frame to finish. Includes the CPU's share of the frame. */
export class WallTimer {
  private readonly gl: WebGL2RenderingContext;
  private times: number[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  timeFrame(run: () => void): void {
    const start = performance.now();
    run();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.times.push(performance.now() - start);
  }

  async collect(): Promise<number[]> {
    const times = this.times;
    this.times = [];
    return times;
  }
}
