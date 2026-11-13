import { describe, expect, it } from 'vitest';
import { ThresholdTrail, TRAIL_SAMPLES } from './thresholdTrail.ts';

const sample = (trail: ThresholdTrail) => {
  const out = new Float32Array(TRAIL_SAMPLES);
  trail.sample(out);
  return [...out];
};

describe('ThresholdTrail', () => {
  it('gives the threshold at evenly spaced times back over its span', () => {
    // Falls one level per frame of 0.1 s, from 30 to 10.
    const trail = new ThresholdTrail(1.5, 30);
    for (let level = 29; level >= 10; level--) trail.record(level, 0.1);
    const points = sample(trail);
    expect(points[0]).toBeCloseTo(10);
    expect(points[TRAIL_SAMPLES - 1]).toBeCloseTo(25); // 1.5 s ago
    expect(points[5]).toBeCloseTo(15); // 0.5 s ago
  });

  it('holds still levels and forgets the past on reset', () => {
    const trail = new ThresholdTrail(1, 40);
    trail.record(20, 0.5);
    trail.reset(12);
    trail.record(12, 0.2);
    expect(sample(trail).every(level => level === 12)).toBe(true);
  });
});
