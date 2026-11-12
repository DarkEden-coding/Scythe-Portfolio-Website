// Baked cube files: one chaos level per voxel, x fastest, then y, then z, gzipped.
// Level v stands for a Lyapunov exponent of v / (levels - 1) · max e-folds per second (CHAOS in
// presets.ts). scripts/bake.mjs writes them.

import { CHAOS } from '../presets.ts';

/** Chaos level to e-folds per second. */
export const levelToChaos = (level: number) => (level / (CHAOS.levels - 1)) * CHAOS.max;
export const chaosToLevel = (lambda: number) => (lambda / CHAOS.max) * (CHAOS.levels - 1);

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

/** Fetches and unpacks an n³ cube file. */
export async function loadCube(url: string, n: number, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = await pipe(new Uint8Array(await res.arrayBuffer()), new DecompressionStream('gzip'));
  if (bytes.length !== n ** 3) throw new Error(`${url}: expected ${n ** 3} voxels, got ${bytes.length}`);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
