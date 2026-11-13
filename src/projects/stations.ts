// Where each project sits in the cube: which baked cube, which part of its volume, how far the
// cube has grown, and where the camera looks from. Keyed by project id (see content.ts).

export interface Station {
  preset: number; // index into PRESETS
  move: [number, number, number]; // the part of the volume in the box, as a fraction per axis
  lambda: number; // chaos threshold the cube grows to here, e-folds per second
  yaw: number;
  pitch: number;
  distance: number;
}

// Each looks at a different face of the box, a little off square, from close enough that the
// voxels fill the screen around the bore.
export const STATIONS: Record<string, Station> = {
  'spaghetti-detection': { preset: 0, move: [0.5, 0.5, 0.5], lambda: 1.3, yaw: 0.14, pitch: 0.1, distance: 2.3 },
  'cone-perception': { preset: 0, move: [0.82, 0.3, 0.64], lambda: 2.3, yaw: 1.68, pitch: 0.16, distance: 2.3 },
  'factorio-self-drive': { preset: 2, move: [0.2, 0.62, 0.4], lambda: 1.2, yaw: 3.26, pitch: -0.08, distance: 2.3 },
  mutual: { preset: 2, move: [0.6, 0.12, 0.85], lambda: 2.0, yaw: -1.44, pitch: 0.14, distance: 2.3 },
  'slop-block': { preset: 4, move: [0.38, 0.44, 0.1], lambda: 1.5, yaw: 0.5, pitch: 1.15, distance: 2.4 },
  swath: { preset: 4, move: [0.7, 0.8, 0.55], lambda: 2.2, yaw: -2.5, pitch: 0.6, distance: 2.4 },
};
