// Accumulating a picture that holds still, after FREEZE_AFTER frames its history is as good as it
// gets: each later frame only trades some shadow noise for new noise. From then on the view casts no
// rays and shows the history as it is, until anything that goes into the picture changes. Parked at
// a project, where rays are longest, that is most of the time.
//
// What goes into the picture is summed up as a key, compared frame to frame. Anything left out of it
// would leave a stale picture up, so it holds every input of the ray-cast but the per-frame jitter.

import type { CameraBasis } from './orbitCamera.ts';

export const FREEZE_AFTER = 32;

export interface Picture {
  camera: CameraBasis;
  width: number;
  height: number;
  shift: [number, number];
  focal: number;
  offset: readonly number[];
  threshold: number;
  trail: ArrayLike<number>; // the glow's threshold trail, which keeps moving for a while after the threshold stops
  samples: number;
  carve: readonly number[];
  filterK: number;
  options: object; // colouring, palette, lighting, glow
  volume: number; // counts changes to the volume's textures (a load, a new filter), which the rest can't see
  program: string; // which ray-cast program draws: the generic one, or a variant once it has compiled
}

export function pictureKey(p: Picture): string {
  return JSON.stringify({ ...p, trail: Array.from(p.trail) });
}

/** Counts frames in a row with the same picture. */
export class Stillness {
  private lastKey = '';
  private frames = 0;

  /** Notes this frame's key ('' when it isn't accumulating a still picture); whether the history is
   * finished, so this frame can show it as it is. */
  frozen(key: string): boolean {
    this.frames = key !== '' && key === this.lastKey ? this.frames + 1 : 0;
    this.lastKey = key;
    return this.frames >= FREEZE_AFTER;
  }

  /** Frames in a row with the same picture, as of the last frozen(). */
  get unchanged(): number {
    return this.frames;
  }

  reset(): void {
    this.lastKey = '';
    this.frames = 0;
  }
}
