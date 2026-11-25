// The benchmark's scenes: fixed cubes, camera poses and thresholds, each at two canvas sizes. They
// copy what the site shows (see src/main.ts draw() and src/scene.ts), minus anything that moves on
// its own: no drift, auto-rotate, glow or camera lean.

import type { Pose } from '../src/cube/flight.ts';
import type { Samples } from '../src/cube/view.ts';
import { GRID, type Quality } from '../src/presets.ts';
import { STATIONS } from '../src/projects/stations.ts';
import { CENTER, FLOOR, HOME, stationPose } from '../src/scene.ts';

export interface Resolution {
  id: string;
  width: number; // CSS pixels
  height: number;
  dpr: number;
}

export const RESOLUTIONS: Resolution[] = [
  { id: 'hi', width: 1440, height: 900, dpr: 1.75 }, // a desktop at the site's DPR cap
  { id: 'lo', width: 1280, height: 720, dpr: 1 },
];

/** A camera orbiting the cube, as while it's dragged or flying. */
export interface Motion {
  frames: number;
  yawPerFrame: number; // radians
  samples: Samples;
  settled: boolean; // see CubeView.settled
}

export interface Scene {
  id: string; // `<name>-<resolution>`
  preset: number;
  n: number;
  pose: Pose;
  lambda: number; // threshold, e-folds per second
  sun: boolean;
  samples: Samples; // rays per pixel once still: the site's Auto with temporal AA
  resolution: Resolution;
  motion?: Motion;
}

const home: Pose = { yaw: HOME.yaw, pitch: HOME.pitch, distance: HOME.distance, move: CENTER, axis: [0, 0, 1], tour: 0 };
const station = STATIONS['spaghetti-detection'];

type Base = Omit<Scene, 'id' | 'n' | 'resolution'> & { name: string; quality: Quality };
const BASES: Base[] = [
  { name: 'home-ultra', preset: 0, quality: 'ultra', pose: home, lambda: FLOOR, sun: true, samples: 2 },
  { name: 'home-high', preset: 0, quality: 'high', pose: home, lambda: FLOOR, sun: true, samples: 2 },
  { name: 'studio-ultra', preset: 0, quality: 'ultra', pose: home, lambda: FLOOR, sun: false, samples: 2 },
  // Parked at a project: the bore is cut and the threshold is the station's.
  { name: 'station-ultra', preset: station.preset, quality: 'ultra', pose: stationPose(station), lambda: station.lambda, sun: true, samples: 2 },
  // As close as the camera goes, on a coarse grid: voxels are about 11 px wide at 'hi' (5 at 'lo'),
  // so the probe-and-refine path runs (PROBE_FROM_PX in view.ts).
  { name: 'closeup-medium', preset: 0, quality: 'medium', pose: { ...home, pitch: 0.2, distance: 2 }, lambda: FLOOR, sun: true, samples: 2 },
  // Orbiting at about 0.6 rad/s at 60 fps. Like a flight to a station: one ray, short history.
  {
    name: 'orbit-ultra', preset: 0, quality: 'ultra', pose: home, lambda: FLOOR, sun: true, samples: 2,
    motion: { frames: 60, yawPerFrame: 0.01, samples: 1, settled: false },
  },
  // Dragging the finished cube: main.ts keeps it in its hold phase, so it stays "still" (two rays,
  // long history) while the camera turns.
  {
    name: 'drag-ultra', preset: 0, quality: 'ultra', pose: home, lambda: FLOOR, sun: true, samples: 2,
    motion: { frames: 60, yawPerFrame: 0.01, samples: 2, settled: true },
  },
];

export const SCENES: Scene[] = BASES.flatMap(({ name, quality, ...base }) => RESOLUTIONS.map(resolution => ({
  ...base, id: `${name}-${resolution.id}`, n: GRID[quality], resolution,
})));

/** The scenes --quick runs. */
export const QUICK = ['home-ultra-hi', 'station-ultra-hi', 'orbit-ultra-hi'];
