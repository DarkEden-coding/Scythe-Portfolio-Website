import { describe, expect, it } from 'vitest';
import { CHAOS } from '../presets';
import { chaosToLevel, gzip, levelToChaos } from './cubeFile';

describe('cube files', () => {
  it('maps the level range onto 0..max e-folds per second', () => {
    expect(levelToChaos(0)).toBe(0);
    expect(levelToChaos(CHAOS.levels - 1)).toBe(CHAOS.max);
    expect(chaosToLevel(levelToChaos(17))).toBeCloseTo(17);
  });

  it('round-trips through gzip', async () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256);
    const packed = await gzip(bytes);
    const res = new Response(new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
