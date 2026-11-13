// Fetches and unpacks cube files off the main thread (see unpack.ts).

import { loadCube } from './cubeFile.ts';

export interface UnpackRequest { id: number; url: string; n: number }
export type UnpackReply = { id: number; bytes: Uint8Array; top: number } | { id: number; error: string };

self.onmessage = async ({ data: { id, url, n } }: MessageEvent<UnpackRequest>) => {
  let reply: UnpackReply;
  try {
    const bytes = await loadCube(url, n);
    let top = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > top) top = bytes[i];
    reply = { id, bytes, top };
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, { transfer: 'bytes' in reply ? [reply.bytes.buffer] : [] });
};
