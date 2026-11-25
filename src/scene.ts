// How the homepage frames, colours and lights the cube. main.ts drives these; the benchmark page
// (bench/) uses the same ones, so its scenes look like the site's.

import type { Pose } from './cube/flight.ts';
import { orbitBasis } from './cube/orbitCamera.ts';
import type { ColorBy, ViewOptions } from './cube/view.ts';
import type { Station } from './projects/stations.ts';

export const FLOOR = 1.6; // default threshold the sweep stops at, e-folds per second
export const CENTER: [number, number, number] = [0.5, 0.5, 0.5]; // default move, as a fraction of the volume
export const BORE = 0.6; // the bore's radius at a station, where the box spans -1..1
export const HOME = { yaw: 0.72, pitch: 0.42, distance: 4.1, phoneDistance: 4.7, autoRotate: 0.14 };
export const MAX_DPR = 1.75; // device pixels per CSS pixel the canvas renders at, at most

export type Palette = 'ember' | 'glacier' | 'aurora';
export const PALETTES: Record<Palette, { ramp: [string, string, string, string]; glow: string }> = {
  ember: { ramp: ['#6a0e12', '#c8181c', '#ff7b2e', '#ffe9c6'], glow: '#e0181c' },
  glacier: { ramp: ['#1d3a72', '#2f72c8', '#6fd2f2', '#f0fbff'], glow: '#4fb4ff' },
  aurora: { ramp: ['#47207e', '#2b8590', '#86d35c', '#f6ee72'], glow: '#ff4fa8' },
};
export const PLAIN_GLOW = '#e0181c';

/** The viewer's options for a colouring, palette and lighting. Glow starts off. */
export function viewOptions(colorBy: ColorBy, palette: Palette, sun: boolean): ViewOptions {
  return {
    glow: false, glowFor: 0.45, base: '#ecebe6', accent: colorBy === 'plain' ? PLAIN_GLOW : PALETTES[palette].glow,
    colorBy, ramp: PALETTES[palette].ramp, sun, edgeColor: [1, 1, 1, 0.16],
  };
}

// Where the cube sits: centred across wide screens, a little high to clear the cards. Stacked, the
// canvas is a block of its own above the cards, so the cube is centred, a little low to clear the
// header; at a station it fills the screen, with the bore high, above the project's card.
const TOUR_SHIFT = -0.07; // at a station the cards are gone, so the cube sits in the middle of what the header leaves
const STACKED_TOUR_SHIFT = 0.24;

/** The cube's screen shift and focal length for a canvas w × h. `stacked`: the narrow layout;
 * `tour`: 0 at home, 1 at a station. */
export function layout(w: number, h: number, stacked: boolean, tour: number): { shift: [number, number]; focal: number } {
  const aspect = w / h;
  if (stacked) return { shift: [0, -0.1 + (STACKED_TOUR_SHIFT + 0.1) * tour], focal: 1.75 * Math.min(1, aspect / 0.9) };
  const home = aspect < 1.5 ? 0.2 : 0.12;
  return { shift: [0, home + (TOUR_SHIFT - home) * tour], focal: 1.6 * Math.min(1, aspect / 1.6) };
}

/** The pose parked at a station. The bore points at the camera. */
export function stationPose(at: Station): Pose {
  const { forward } = orbitBasis(at.yaw, at.pitch, at.distance);
  return { yaw: at.yaw, pitch: at.pitch, distance: at.distance, move: at.move, axis: [-forward[0], -forward[1], -forward[2]], tour: 1 };
}
