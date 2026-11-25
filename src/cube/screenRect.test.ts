import { describe, expect, it } from 'vitest';
import { orbitBasis } from './orbitCamera.ts';
import { cubeRect, union } from './screenRect.ts';

describe('cubeRect', () => {
  it('holds every projected corner of the box', () => {
    const c = orbitBasis(0.72, 0.42, 4.1);
    const [w, h, shift, focal] = [2520, 1575, [0, 0.12] as [number, number], 1.6];
    const [x, y, rw, rh] = cubeRect(c, w, h, shift, focal);
    for (let i = 0; i < 8; i++) {
      const d = [i & 1, (i >> 1) & 1, (i >> 2) & 1].map((b, k) => b * 2 - 1 - c.eye[k]);
      const dot = (v: number[]) => d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
      const z = dot(c.forward);
      const px = ((dot(c.right) * focal / z + shift[0]) * h + w) / 2;
      const py = ((dot(c.up) * focal / z + shift[1]) * h + h) / 2;
      expect(px).toBeGreaterThan(x);
      expect(px).toBeLessThan(x + rw);
      expect(py).toBeGreaterThan(y);
      expect(py).toBeLessThan(y + rh);
    }
    expect(rw * rh).toBeLessThan(w * h / 2); // and leaves most of the canvas out
  });

  it('is the whole canvas, clamped, when the camera is close', () => {
    expect(cubeRect(orbitBasis(0, 0, 0.5), 800, 600, [0, 0], 1.6)).toEqual([0, 0, 800, 600]);
    expect(union([10, 10, 5, 5], [0, 20, 2, 2])).toEqual([0, 10, 15, 12]);
  });
});
