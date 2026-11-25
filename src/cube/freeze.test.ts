import { describe, expect, it } from 'vitest';
import { FREEZE_AFTER, type Picture, pictureKey, Stillness } from './freeze.ts';
import { orbitBasis } from './orbitCamera.ts';

const picture: Picture = {
  camera: orbitBasis(0.72, 0.42, 4.1), width: 2520, height: 1575, shift: [0, 0.12], focal: 1.6,
  offset: [160, 160, 160], threshold: 20, trail: new Float32Array(16).fill(20), samples: 2,
  carve: [0, 0, 1, 0], filterK: 6, options: { sun: true, colorBy: 'both', glow: false }, volume: 3, program: 'variant',
};

describe('pictureKey', () => {
  it('changes with every input', () => {
    const changed: Partial<Picture>[] = [
      { camera: orbitBasis(0.7201, 0.42, 4.1) }, { width: 2519 }, { shift: [0, 0.13] }, { focal: 1.61 },
      { offset: [160.5, 160, 160] }, { threshold: 20.01 }, { trail: new Float32Array(16).fill(20).fill(21, 15) },
      { samples: 4 }, { carve: [0, 0, 1, 0.6] }, { filterK: 5 }, { options: { sun: false, colorBy: 'both', glow: false } },
      { volume: 4 }, { program: 'generic' },
    ];
    const keys = new Set([pictureKey(picture), ...changed.map(c => pictureKey({ ...picture, ...c }))]);
    expect(keys.size).toBe(changed.length + 1);
  });
});

describe('Stillness', () => {
  it('freezes after FREEZE_AFTER frames of the same picture, and thaws on any change', () => {
    const s = new Stillness();
    const key = pictureKey(picture);
    for (let i = 0; i <= FREEZE_AFTER - 1; i++) expect(s.frozen(key)).toBe(false);
    expect(s.frozen(key)).toBe(true);
    expect(s.frozen(pictureKey({ ...picture, threshold: 21 }))).toBe(false);
    expect(s.frozen('')).toBe(false); // not accumulating
  });

  it('never freezes without a key', () => {
    const s = new Stillness();
    for (let i = 0; i < 2 * FREEZE_AFTER; i++) expect(s.frozen('')).toBe(false);
  });
});
