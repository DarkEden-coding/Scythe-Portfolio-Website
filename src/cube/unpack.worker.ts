// Fetches and unpacks cube files off the main thread (see unpack.ts).

import { loadCube } from './cubeFile.ts';

export interface UnpackRequest { id: number; url: string; n: number }
export type UnpackReply =
  | { id: number; bytes: Uint8Array; top: number }
  | { id: number; error: string }
  | { id: number; loaded: number; total: number }; // download progress, at most every 50 ms

self.onmessage = async ({ data: { id, url, n } }: MessageEvent<UnpackRequest>) => {
  let reply: UnpackReply;
  let lastProgress = 0;
  try {
    const bytes = await loadCube(url, n, (loaded, total) => {
      const now = performance.now();
      if (now - lastProgress < 50 && loaded < total) return;
      lastProgress = now;
      self.postMessage({ id, loaded, total } satisfies UnpackReply);
    });
    let top = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > top) top = bytes[i];
    reply = { id, bytes, top };
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, { transfer: 'bytes' in reply ? [reply.bytes.buffer] : [] });
};
