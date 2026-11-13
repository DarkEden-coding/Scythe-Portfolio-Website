// Where the threshold has been over the last moments. The renderer compares a voxel's level with
// these to tell how long ago it appeared, so each voxel's glow fades on its own clock instead of the
// whole front going out at once.

/** How many points the renderer gets: now, then evenly spaced back to `span` seconds ago. */
export const TRAIL_SAMPLES = 16;

export class ThresholdTrail {
  private clock = 0;
  private times: number[] = [0];
  private levels: number[];

  constructor(readonly span: number, level: number) {
    this.levels = [level];
  }

  /** Forgets the past, as if the threshold had always been here: nothing showing counts as new. */
  reset(level: number): void {
    this.times = [this.clock];
    this.levels = [level];
  }

  /** Notes where the threshold is after `dt` more seconds. */
  record(level: number, dt: number): void {
    this.clock += dt;
    this.times.push(this.clock);
    this.levels.push(level);
    // Keep one point older than the span, to interpolate the oldest sample from.
    while (this.times.length > 2 && this.times[1] <= this.clock - this.span) {
      this.times.shift();
      this.levels.shift();
    }
  }

  /** Fills `out` with the threshold now and at each earlier sample time. */
  sample(out: Float32Array): void {
    let j = this.times.length - 1;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const t = this.clock - (this.span * i) / (TRAIL_SAMPLES - 1);
      while (j > 0 && this.times[j - 1] > t) j--;
      if (j === 0 || this.times[j] <= t) {
        out[i] = this.levels[j];
        continue;
      }
      const k = (t - this.times[j - 1]) / (this.times[j] - this.times[j - 1]);
      out[i] = this.levels[j - 1] + (this.levels[j] - this.levels[j - 1]) * k;
    }
  }
}
