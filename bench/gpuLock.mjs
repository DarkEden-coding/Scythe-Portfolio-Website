// One benchmark on the GPU at a time, across every checkout on this machine: two runs at once skew
// each other's timings. A directory is the lock (mkdir is atomic); it holds the owner's pid, so a
// lock left by a run that died is taken over.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A fixed path, not os.tmpdir(): each agent or terminal session can have its own TMPDIR, and then
// every run would get a lock of its own.
const LOCK = '/tmp/cube-bench-gpu.lock';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Waits until this process holds the lock. Returns a function that releases it. */
export async function acquireGpuLock() {
  let waiting = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'pid'), String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(readFileSafe(join(LOCK, 'pid')));
      if (owner && !alive(owner)) { rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (!waiting) { console.log(`Waiting for another benchmark to finish (pid ${owner || '?'})…`); waiting = true; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  const release = () => rmSync(LOCK, { recursive: true, force: true });
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
  return release;
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
