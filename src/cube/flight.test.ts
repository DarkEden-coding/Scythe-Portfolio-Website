import { describe, expect, it } from 'vitest';
import { Flight, type Pose } from './flight.ts';

const pose = (over: Partial<Pose>): Pose => ({ yaw: 0, pitch: 0, distance: 4, move: [0.5, 0.5, 0.5], axis: [0, 0, 1], tour: 0, ...over });

describe('Flight', () => {
  it('ends exactly on its target', () => {
    const to = pose({ yaw: 1, pitch: 0.3, distance: 2.3, move: [0.2, 0.6, 0.4], axis: [1, 0, 0], tour: 1 });
    const flight = new Flight(pose({}), to, 1);
    flight.step(0.4);
    expect(flight.done).toBe(false);
    expect(flight.step(0.7)).toEqual(to);
    expect(flight.done).toBe(true);
  });

  it('turns and moves the short way round', () => {
    // From yaw 3 to -3 is 0.28 rad across ±π, and from 0.9 to 0.1 of the volume is 0.2 across the wrap.
    const flight = new Flight(pose({ yaw: 3, move: [0.9, 0.5, 0.5] }), pose({ yaw: -3, move: [0.1, 0.5, 0.5] }), 1);
    const half = flight.step(0.5);
    expect(half.yaw).toBeCloseTo(Math.PI, 1);
    expect(half.move[0]).toBeCloseTo(1, 5);
  });
});
