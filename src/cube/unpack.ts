// Loads cube files on a worker. An Ultra cube is 32 MB unpacked: gunzipping it and finding its most
// chaotic voxel on the main thread stalled the page for a couple of hundred milliseconds.

import type { UnpackReply, UnpackRequest } from './unpack.worker.ts';

export interface Cube {
  bytes: Uint8Array; // n³ chaos levels, as in cubeFile.ts
  top: number; // the highest level in it
}

let worker: Worker | null = null;
let nextId = 0;
type Progress = (loaded: number, total: number) => void;
const waiting = new Map<number, { resolve: (cube: Cube) => void; reject: (err: Error) => void; onProgress?: Progress }>();

/** Fetches and unpacks a cube on the worker. `onProgress` hears the download's bytes so far and the
 * file's size (0 if unknown). */
export function unpackCube(url: string, n: number, onProgress?: Progress): Promise<Cube> {
  if (!worker) {
    worker = new Worker(new URL('./unpack.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<UnpackReply>) => {
      const job = waiting.get(data.id);
      if ('loaded' in data) { job?.onProgress?.(data.loaded, data.total); return; }
      waiting.delete(data.id);
      if ('error' in data) job?.reject(new Error(data.error));
      else job?.resolve({ bytes: data.bytes, top: data.top });
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ id, url, n } satisfies UnpackRequest);
  });
}
