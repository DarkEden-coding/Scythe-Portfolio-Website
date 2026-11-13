// Baked cube files: one chaos level per voxel, x fastest, then y, then z, gzipped.
// Level v stands for a Lyapunov exponent of v / (levels - 1) · max e-folds per second (CHAOS in
// presets.ts). scripts/bake.mjs writes them.

import { CHAOS, GRAVITY, PRESETS } from '../presets.ts';

// Cube files are kept in Cache Storage after their first download, so a later visit, or the
// slideshow coming back round to a preset, doesn't fetch 20 MB again, whatever the host's cache
// headers say. The cache is named after what the cubes were baked from: change that (and re-bake)
// and the old files are dropped.
const CACHE_PREFIX = 'cubes:';
const CACHE = CACHE_PREFIX + JSON.stringify({ CHAOS, GRAVITY, PRESETS });
let cubeCache: Promise<Cache | null> | null = null;

function openCache(): Promise<Cache | null> {
  // Cache Storage is missing outside secure contexts (plain http on a LAN address).
  if (typeof caches === 'undefined') return Promise.resolve(null);
  return cubeCache ??= (async () => {
    for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
    return caches.open(CACHE);
  })().catch(() => null);
}

/** The cube file from Cache Storage, else from the network, saved for next time. */
async function fetchCubeFile(url: string): Promise<Response> {
  const cache = await openCache();
  const hit = await cache?.match(url);
  if (hit) return hit;
  const res = await fetch(url);
  // A full disk or quota only costs the saving; the download still goes on.
  if (res.ok && cache) cache.put(url, res.clone()).catch(() => {});
  return res;
}

/** Chaos level to e-folds per second. */
export const levelToChaos = (level: number) => (level / (CHAOS.levels - 1)) * CHAOS.max;
export const chaosToLevel = (lambda: number) => (lambda / CHAOS.max) * (CHAOS.levels - 1);

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

/** Fetches and unpacks an n³ cube file. `onProgress` hears bytes received so far and the file's
 * size (0 if the server doesn't say) as they arrive. */
export async function loadCube(url: string, n: number, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetchCubeFile(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body!.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    chunks.push(read.value);
    loaded += read.value.length;
    onProgress?.(loaded, total);
  }
  const packed = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) { packed.set(chunk, at); at += chunk.length; }
  const bytes = await pipe(packed, new DecompressionStream('gzip'));
  if (bytes.length !== n ** 3) throw new Error(`${url}: expected ${n ** 3} voxels, got ${bytes.length}`);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
