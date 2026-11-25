// How much each pixel changes from frame to frame over a run of frames, on luminance in 0..255:
//  noise    the per-pixel standard deviation over the run. On a still camera that is all noise
//           (shadow-ray noise left in the history, jitter crawling); on a moving one it includes the
//           motion, so it only means something next to another run of the same frames.
//  flicker  % of pixel-frames where a pixel brightens then darkens (or the reverse), each step by
//           more than FLICKER_STEP. Steady motion changes a pixel one way at a time; flicker doesn't.
// Only pixels the cube covers in some frame count, so the background doesn't dilute the numbers.

const FLICKER_STEP = 8;
const BINS_PER_LEVEL = 100; // histogram resolution for the p99

export interface TemporalResult {
  frames: number;
  pixels: number; // covered pixels the numbers are over
  noiseMean: number;
  noiseP99: number;
  flickerPct: number;
}

export class TemporalStats {
  private frames = 0;
  private readonly sum: Float64Array;
  private readonly sumSq: Float64Array;
  private readonly prev: Float32Array;
  private readonly prevStep: Float32Array;
  private readonly flips: Uint16Array;
  private readonly covered: Uint8Array;

  constructor(pixels: number) {
    this.sum = new Float64Array(pixels);
    this.sumSq = new Float64Array(pixels);
    this.prev = new Float32Array(pixels);
    this.prevStep = new Float32Array(pixels);
    this.flips = new Uint16Array(pixels);
    this.covered = new Uint8Array(pixels);
  }

  /** Adds a frame: RGB over the background, and the cube's coverage (alpha) per pixel. */
  add(rgb: Uint8Array, alpha: Uint8Array): void {
    const { sum, sumSq, prev, prevStep, flips, covered } = this;
    for (let i = 0; i < sum.length; i++) {
      const l = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
      sum[i] += l;
      sumSq[i] += l * l;
      if (alpha[i] > 0) covered[i] = 1;
      if (this.frames > 0) {
        const step = l - prev[i];
        if (this.frames > 1 && step * prevStep[i] < 0 && Math.abs(step) > FLICKER_STEP && Math.abs(prevStep[i]) > FLICKER_STEP) flips[i]++;
        prevStep[i] = step;
      }
      prev[i] = l;
    }
    this.frames++;
  }

  result(): TemporalResult {
    const { frames, sum, sumSq, flips, covered } = this;
    const histogram = new Uint32Array(256 * BINS_PER_LEVEL);
    let pixels = 0, stdSum = 0, flipSum = 0;
    for (let i = 0; i < sum.length; i++) {
      if (!covered[i]) continue;
      const mean = sum[i] / frames;
      const std = Math.sqrt(Math.max(0, sumSq[i] / frames - mean * mean));
      pixels++;
      stdSum += std;
      flipSum += flips[i];
      histogram[Math.min(histogram.length - 1, Math.floor(std * BINS_PER_LEVEL))]++;
    }
    return {
      frames, pixels,
      noiseMean: pixels ? stdSum / pixels : 0,
      noiseP99: percentile(histogram, pixels, 0.99) / BINS_PER_LEVEL,
      flickerPct: pixels && frames > 2 ? (100 * flipSum) / (pixels * (frames - 2)) : 0,
    };
  }
}

/** The bin index below which a fraction q of `count` values fall. */
function percentile(histogram: Uint32Array, count: number, q: number): number {
  let seen = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    seen += histogram[bin];
    if (seen >= q * count) return bin;
  }
  return histogram.length;
}
