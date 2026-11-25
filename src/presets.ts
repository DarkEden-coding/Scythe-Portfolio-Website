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

// Bump when the cube files change without anything above changing (a fix to the bake itself).
const BAKE_REVISION = 1;

// Names the baked set. It's in every cube URL, so the files can be cached for a year
// (public/_headers) and a re-bake still reaches everyone, and it names the Cache Storage copy.
export const CUBE_VERSION = fnv1a(JSON.stringify({ CHAOS, GRAVITY, PRESETS, BAKE_REVISION }));

/** Where a cube file sits under public/. */
export const cubePath = (preset: number, n: number) => `/cubes/${preset}-${n}.cube`;
/** The URL the site fetches it from. */
export const cubeUrl = (preset: number, n: number) => `${cubePath(preset, n)}?v=${CUBE_VERSION}`;

/** 32-bit FNV-1a of a string, as 8 hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
