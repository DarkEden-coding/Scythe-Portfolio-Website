// The cubes the site plays, and how they were baked. Changing any of this needs `npm run bake`.

type Vec3 = [number, number, number];

// Each preset is a triple pendulum; its starting angles cover ±π on every axis.
export interface Preset {
  lengths: Vec3;
  masses: Vec3;
}

export const PRESETS: Preset[] = [
  { lengths: [1, 1, 1], masses: [1, 1, 1] },
  { lengths: [0.6, 1, 1.4], masses: [1, 1, 1] },
  { lengths: [1.2, 0.8, 1], masses: [2, 1, 1] },
  { lengths: [0.8, 1.2, 1], masses: [1, 1, 1] },
  { lengths: [1, 1, 1], masses: [0.5, 1, 3] },
];

export const GRAVITY = 9.81;

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const GRID: Record<Quality, number> = { low: 64, medium: 112, high: 160, ultra: 320 };

// What the site's cube files hold: each voxel's Lyapunov exponent (e-folds per second) over the
// first `horizon` seconds, as a level: round(λ / max · (levels - 1)), clamped. A short horizon
// keeps the folded, fractal structure that longer runs average away. 64 levels keep the files
// about a third smaller than 256 with no visible difference.
export const CHAOS = { horizon: 5, max: 5, levels: 64 };

export const cubeUrl = (preset: number, n: number) => `/cubes/${preset}-${n}.cube`;
