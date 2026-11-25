// Bakes the cubes the site plays, on a CUDA machine over ssh (bake/lyapunov.cu does the work).
//
// For each preset and grid it keeps a master on the GPU host: float16 Lyapunov exponents at every
// horizon in HORIZONS. The site's files are packed from a master (one horizon, one byte per voxel),
// so changing CHAOS in src/presets.ts only needs a repack, not a re-bake.
//
//   npm run bake                          every preset, every grid; masters that are current are kept
//   npm run bake -- --grid 64,160         only these grid sizes
//   npm run bake -- --preset 0 --force    only preset 0, re-baking its masters
//   npm run bake -- --host other-box      GPU host (default scythe-desktop, or $BAKE_HOST)

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CHAOS, cubePath, GRAVITY, GRID, PRESETS } from '../src/presets.ts';

const HORIZONS = [5, 10, 20, 40, 60]; // pendulum seconds
const DT = 0.01; // pendulum seconds per RK4 step
const MASTER_ONLY = [512]; // grids kept for later, not shipped
const REMOTE = 'scythe-bake'; // under the host's home directory

const { values } = parseArgs({
  options: { grid: { type: 'string' }, preset: { type: 'string' }, force: { type: 'boolean' }, host: { type: 'string' } },
});
const host = values.host ?? process.env.BAKE_HOST ?? 'scythe-desktop';
const list = (s, all) => (s ? s.split(',').map(Number) : all);
const shipped = Object.values(GRID);
const grids = list(values.grid, [...shipped, ...MASTER_ONLY]);
const presets = list(values.preset, PRESETS.map((_, i) => i));
if (!HORIZONS.includes(CHAOS.horizon)) throw new Error(`CHAOS.horizon must be one of ${HORIZONS}`);

const ssh = (command, input) => execFileSync('ssh', [host, command], { input, encoding: 'utf8', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });

// Build on the host whenever the source changed.
execFileSync('ssh', [host, `mkdir -p ${REMOTE}/masters ${REMOTE}/packed`]);
execFileSync('scp', ['-pq', 'bake/lyapunov.cu', `${host}:${REMOTE}/`]);
ssh(`cd ${REMOTE} && { [ lyapunov -nt lyapunov.cu ] || /usr/local/cuda/bin/nvcc -O3 -arch=native -o lyapunov lyapunov.cu; }`);

mkdirSync('public/cubes', { recursive: true });
for (const n of grids) {
  for (const preset of presets) {
    const { lengths, masses } = PRESETS[preset];
    const recipe = JSON.stringify({ n, lengths, masses, gravity: GRAVITY, dt: DT, horizons: HORIZONS, angles: '±π' });
    const master = `${REMOTE}/masters/${preset}-${n}`;
    const current = ssh(`cat ${master}.json 2>/dev/null || true`).trim() === recipe;
    if (current && !values.force) {
      console.log(`${preset}-${n}: master is current`);
    } else {
      process.stdout.write(`${preset}-${n}: `);
      const timing = ssh(`cd ${REMOTE} && ./lyapunov bake --n ${n} --lengths ${lengths} --masses ${masses} --gravity ${GRAVITY} `
        + `--dt ${DT} --horizons ${HORIZONS} --out masters/${preset}-${n}.f16 2>&1 | tr '\\r' '\\n' | tail -1`);
      ssh(`cat > ${master}.json`, recipe); // written last, so an interrupted bake reruns
      process.stdout.write(timing);
    }
    if (!shipped.includes(n)) continue;
    const packed = `${REMOTE}/packed/${preset}-${n}.cube`;
    ssh(`cd ${REMOTE} && ./lyapunov pack --in masters/${preset}-${n}.f16 --n ${n} --plane ${HORIZONS.indexOf(CHAOS.horizon)} `
      + `--max ${CHAOS.max} --levels ${CHAOS.levels} --out /tmp/scythe-pack.raw && gzip -9 -n -c /tmp/scythe-pack.raw > packed/${preset}-${n}.cube && rm /tmp/scythe-pack.raw`);
    execFileSync('scp', ['-q', `${host}:${packed}`, `public${cubePath(preset, n)}`]);
    console.log(`  public${cubePath(preset, n)}  ${(Number(ssh(`stat -c %s ${packed}`)) / 1024).toFixed(0)} KB`);
  }
}
