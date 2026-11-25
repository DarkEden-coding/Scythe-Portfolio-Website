import { describe, expect, it } from 'vitest';
import { CHAOS } from '../presets.ts';
import { boreHollowRadius } from './view.ts';

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

describe('boreHollowRadius', () => {
  it('is where the bore carves away just enough that no voxel shows', () => {
    const r = 0.6, n = 320;
    for (const threshold of [0, 5, 20, 40, CHAOS.levels - 1]) {
      const d = boreHollowRadius(r, threshold, n) / (0.5 * n); // back to box units
      const carved = 1 - smoothstep(0.85 * r, r, d);
      // A voxel's margin is below levels - threshold, so this much carving hides any of them.
      expect(carved).toBeCloseTo(1 - threshold / CHAOS.levels, 6);
    }
    expect(boreHollowRadius(r, 0, n)).toBeCloseTo(0.85 * r * 0.5 * n, 6);
  });
});
