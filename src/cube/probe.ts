// The probe pass's target (see RENDER_FS): one ray per pixel's colour, first-surface distance and
// the id of the faces it shaded, from which PROBE_EDGES_FS finds the edges.

export class ProbeTarget {
  private readonly gl: WebGL2RenderingContext;
  private width = 0;
  private height = 0;
  private framebuffer: WebGLFramebuffer | null = null;
  private textures: WebGLTexture[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Binds the target, sized w × h, for the probe pass to draw into. Its textures, bound to units
   * from `unit` on for the passes after it, are unbound: WebGL refuses to draw into a bound texture. */
  begin(w: number, h: number, unit: number): void {
    const { gl } = this;
    if (w !== this.width || h !== this.height || !this.framebuffer) this.allocate(w, h);
    for (let i = 0; i < this.textures.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + unit + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, w, h);
  }

  /** Binds the probe's colour, distance and faces to texture units from `unit` on, for the passes after it. */
  bindTextures(unit: number): void {
    const { gl } = this;
    this.textures.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE0 + unit + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
  }

  private allocate(w: number, h: number): void {
    const { gl } = this;
    for (const texture of this.textures) gl.deleteTexture(texture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    this.width = w;
    this.height = h;
    this.textures = [gl.RGBA8, gl.R32F, gl.R32UI].map(format => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return texture;
    });
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.textures.forEach((texture, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0));
  }
}
