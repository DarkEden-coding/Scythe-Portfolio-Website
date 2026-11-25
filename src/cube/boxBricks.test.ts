import { describe, expect, it } from 'vitest';
import { BRICK } from './shaders.ts';
import { boxBricks } from './view.ts';

describe('boxBricks', () => {
  it('covers every cell in the box and its neighbours, wherever the box starts', () => {
    const n = 320;
    for (const o of [0, 0.5, 0.999, 1, 3, 3.5, 4, 7.25, 159.5, 316, 319.9]) {
      const { size, base } = boxBricks(n, [o, o, o]);
      const first = base[0] * BRICK, last = first + size * BRICK - 1;
      expect(first).toBeLessThanOrEqual(Math.floor(o) - 1);
      expect(last).toBeGreaterThanOrEqual(Math.ceil(o + n));
    }
  });
});
