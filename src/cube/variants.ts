// Specialised variants of a large shader. Settings that hold for a whole draw (the lighting, the
// colouring, how many rays) are uniforms in the shader, and the GPU compiler has to keep every
// branch they choose between. Given as #defines instead, they become constants: the compiler drops
// the branches not taken, the code left needs fewer registers, and more pixels run at once. The
// shader declares each such uniform inside `#ifndef <name>`, so a define replaces it.
//
// A variant compiles in the background (KHR_parallel_shader_compile) while the generic program,
// with every setting a uniform, draws; switching lighting or turning glow on doesn't hold a frame up
// for a compile. Without the extension the generic program draws throughout.

import { finishProgram, startProgram, type Program } from './gl.ts';

export class ProgramVariants {
  /** Compile variants as they're first asked for, holding that frame up, instead of in the
   * background. For the benchmark, whose frames must all come from the same programs. */
  waitForCompile = false;
  readonly generic: Program;
  private readonly gl: WebGL2RenderingContext;
  private readonly vs: string;
  private readonly fs: string;
  private readonly parallel: KHR_parallel_shader_compile | null;
  private readonly variants = new Map<string, WebGLProgram | Program>();

  constructor(gl: WebGL2RenderingContext, vs: string, fs: string) {
    this.gl = gl;
    this.vs = vs;
    this.fs = fs;
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.generic = finishProgram(gl, startProgram(gl, vs, fs));
  }

  /** The variant for these settings if it's ready, otherwise the generic program. */
  get(defines: Defines): Program {
    if (!this.parallel && !this.waitForCompile) return this.generic;
    const variant = this.start(defines);
    if (!(variant instanceof WebGLProgram)) return variant;
    // Unlike LINK_STATUS, this answers without waiting for the compile.
    if (!this.waitForCompile && !this.gl.getProgramParameter(variant, this.parallel!.COMPLETION_STATUS_KHR)) return this.generic;
    const program = finishProgram(this.gl, variant);
    this.variants.set(key(defines), program);
    return program;
  }

  /** Starts compiling the variant for these settings in the background, if it isn't already, so
   * it's ready by the time it's asked for. Does nothing where variants aren't compiled in the
   * background. */
  prepare(defines: Defines): void {
    if (this.parallel && !this.waitForCompile) this.start(defines);
  }

  private start(defines: Defines): WebGLProgram | Program {
    const k = key(defines);
    let variant = this.variants.get(k);
    if (!variant) {
      // The defines go straight after the #version line, which has to come first.
      variant = startProgram(this.gl, this.vs, this.fs.replace('\n', `\n${k}`));
      this.variants.set(k, variant);
    }
    return variant;
  }
}

type Defines = Record<string, string | number | boolean>;

const key = (defines: Defines): string => Object.entries(defines).map(([name, value]) => `#define ${name} ${value}\n`).join('');
