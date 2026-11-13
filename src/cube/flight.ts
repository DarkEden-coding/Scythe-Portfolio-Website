// An eased move between two poses of the cube: where the camera sits, which part of the volume is
// in the box, and how far into a project station it is.

import type { V3 } from './orbitCamera.ts';

export interface Pose {
  yaw: number;
  pitch: number;
  distance: number;
  move: V3; // fraction of the volume per axis; wraps at 1
  axis: V3; // the bore's axis, towards the viewer at a station
  tour: number; // 0 at home, 1 parked at a station
}

export class Flight {
  private elapsed = 0;
  private readonly from: Pose;
  private readonly to: Pose;
  private readonly duration: number;

  constructor(from: Pose, to: Pose, duration: number) {
    this.from = from;
    this.to = to;
    this.duration = duration;
  }

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  /** Advances by dt seconds and returns the pose there. */
  step(dt: number): Pose {
    this.elapsed += dt;
    const { from, to } = this;
    if (this.done) return to;
    const t = ease(this.elapsed / this.duration);
    const mix = (a: number, b: number) => a + (b - a) * t;
    const axis = from.axis.map((a, i) => mix(a, to.axis[i])) as V3;
    const length = Math.hypot(...axis) || 1;
    return {
      yaw: from.yaw + nearest(to.yaw - from.yaw, 2 * Math.PI) * t, // turn the short way round
      pitch: mix(from.pitch, to.pitch),
      distance: mix(from.distance, to.distance),
      move: from.move.map((m, i) => m + nearest(to.move[i] - m, 1) * t) as V3, // the volume wraps, so go the short way
      axis: axis.map(a => a / length) as V3,
      tour: mix(from.tour, to.tour),
    };
  }
}

// Slow start and finish.
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A difference on a loop of the given period, as the shortest way there. */
function nearest(delta: number, period: number): number {
  return delta - period * Math.round(delta / period);
}
