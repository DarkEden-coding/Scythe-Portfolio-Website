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
    return this.finished(defines) ?? this.generic;
  }

  /** Starts compiling the variant for these settings in the background, if it isn't already, so
   * it's ready by the time it's asked for; the variant once it is. Does nothing where variants
   * aren't compiled in the background. */
  prepare(defines: Defines): Program | null {
    return this.parallel && !this.waitForCompile ? this.finished(defines) : null;
  }

  /** The variant once it's ready, starting its compile if it hasn't started; null until then, and
   * always where variants aren't compiled in the background (for a program only a variant can be,
   * so there's no generic one to draw meanwhile). The benchmark's compile now instead. */
  ready(defines: Defines): Program | null {
    if (this.waitForCompile) return this.now(defines);
    return this.parallel ? this.finished(defines) : null;
  }

  /** The variant for these settings, compiled now if it isn't ready, holding the frame up. For the
   * debug views, which only the generic program's settings can't draw. */
  now(defines: Defines): Program {
    return this.finished(defines, true)!;
  }

  /** The variant, started if it isn't yet, once its compile has finished. */
  private finished(defines: Defines, wait = this.waitForCompile): Program | null {
    const variant = this.start(defines);
    if (!(variant instanceof WebGLProgram)) return variant;
    // Unlike LINK_STATUS, this answers without waiting for the compile.
    if (!wait && !this.gl.getProgramParameter(variant, this.parallel!.COMPLETION_STATUS_KHR)) return null;
    const program = finishProgram(this.gl, variant);
    this.variants.set(key(defines), program);
    return program;
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
