// The part of the canvas the cube can cover, so the full-screen passes can skip the rest (scissor).
// Outside it every pass writes exactly what is already there (no surface: transparent, distance -1),
// so leaving those pixels alone changes nothing.

import type { CameraBasis } from './orbitCamera.ts';

/** x, y, width, height in pixels, from the bottom left (as gl.scissor takes them). */
export type Rect = [number, number, number, number];

// Pixels of slack around the projected box: a pixel's rays land up to a pixel from its centre
// (jitter and sample offsets), and the temporal resolve reads one pixel around each.
const MARGIN = 4;

/** The pixels the [-1, 1]³ box covers on a w × h canvas, with the camera of RENDER_FS. The whole
 * canvas if the box reaches behind the camera. */
export function cubeRect(c: CameraBasis, w: number, h: number, shift: [number, number], focal: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const d = [i & 1, (i >> 1) & 1, (i >> 2) & 1].map((b, k) => b * 2 - 1 - c.eye[k]);
    const dot = (v: number[]) => d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
    const z = dot(c.forward);
    if (z <= 1e-3) return [0, 0, w, h];
    // As RENDER_FS's uv, from screen position back to pixels.
    const x = ((dot(c.right) * focal / z + shift[0]) * h + w) / 2;
    const y = ((dot(c.up) * focal / z + shift[1]) * h + h) / 2;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const left = Math.max(0, Math.floor(x0) - MARGIN), bottom = Math.max(0, Math.floor(y0) - MARGIN);
  const right = Math.min(w, Math.ceil(x1) + MARGIN), top = Math.min(h, Math.ceil(y1) + MARGIN);
  return [left, bottom, Math.max(0, right - left), Math.max(0, top - bottom)];
}

/** The smallest rect holding both. */
export function union(a: Rect, b: Rect): Rect {
  const left = Math.min(a[0], b[0]), bottom = Math.min(a[1], b[1]);
  return [left, bottom, Math.max(a[0] + a[2], b[0] + b[2]) - left, Math.max(a[1] + a[3], b[1] + b[3]) - bottom];
}

/** A rect on a canvas scaled by `scale` per axis, to whole pixels covering it, within w × h. */
export function scaleRect(r: Rect, scale: number, w: number, h: number): Rect {
  const left = Math.floor(r[0] * scale), bottom = Math.floor(r[1] * scale);
  const right = Math.min(w, Math.ceil((r[0] + r[2]) * scale)), top = Math.min(h, Math.ceil((r[1] + r[3]) * scale));
  return [left, bottom, Math.max(0, right - left), Math.max(0, top - bottom)];
}
