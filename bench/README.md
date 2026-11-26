# Cube benchmark

Times the cube renderer and checks that a change leaves the picture alone. `run.mjs` starts a Vite
dev server, opens `bench/index.html` in headless Brave on the real GPU (ANGLE Metal, its own temp
profile), draws fixed scenes, and writes `bench/results/<label>/`. The page isn't part of the site
build.

## Running

Needs the cube files in `public/cubes/` (in a worktree, symlink the main checkout's) and Brave at
`/Applications/Brave Browser.app`.

```sh
npm run bench -- --label baseline                     # all scenes, about 95 s
npm run bench -- --label my-change --compare baseline # then compare, PASS/FAIL per scene
npm run bench -- --label try --quick                  # home, station and orbit at 2520×1575, about 40 s
node bench/compare.mjs my-change baseline             # compare two existing runs again
```

Other flags: `--scenes a,b` runs just those, and `--port` (default 5199) or `--url` (an existing dev
server). `--compare` takes a label under `bench/results/` or a path to a run's directory.

To compare a branch, run the baseline on its base commit and the candidate on the branch, on the
same machine, one run at a time (`bench/gpuLock.mjs` makes concurrent runs wait their turn). Other GPU work running at the same time skews the timings. Images
are only kept locally (`*.png` is git-ignored), so a baseline from another checkout has to be passed
as a path. Rendering is deterministic, so rerunning the base commit gives the same images.

## A/B timing (`ab.mjs`)

Two full runs, even back to back, can differ by more than a change is worth: other work on the
GPU slows a whole run, and under load runs have swung by 2×. For speed, compare two versions in one
page instead:

```sh
node bench/ab.mjs --a main                      # main against the working tree, every scene
node bench/ab.mjs --a HEAD~1 --b HEAD --quick   # one commit against its parent
node bench/ab.mjs --a main --scenes station-ultra-hi --rounds 12 --label station-ab
```

It copies `src/` at each revision (`--b` defaults to the working tree) into `bench/.ab/`, and
`ab.html` draws each copy on a canvas of its own. Per scene, a round times a block of `--frames`
frames (default 20) from each, in alternating order, each block after a fresh history and a few
warm-up frames. It prints both medians and B's time over A's, the median of the rounds' ratios, with
their range: a slow stretch slows both blocks of a round, so it mostly cancels. Still scenes are
timed accumulating, as in a full run; moving ones turn as in a full run. One more scene runs only
here, `sweep-ultra-hi` (in `--quick` too): home playback, the threshold sweeping down with glow on,
auto-rotating with one ray, so everything that depends on the threshold is rebuilt every frame. And
`flight-ultra-hi`: the flight from home to the station over 100 frames (`--frames` doesn't apply),
one ray and a short history, the bore opening, the volume moving and the threshold rising to the
station's, so the occupancy bits (which hold the bore) are rebuilt every frame. Comparing a revision with
itself comes out within 1%. `--label` keeps the rounds in `results/<label>/ab.json`. Images aren't
checked; use a full run for that.

Two more scenes run only here, `home-low-hi` and `home-low-lo`: the home view at Low (64³), where the
site starts on a software renderer. Environment variables change how it runs:

```sh
CUBE_BENCH_ANGLE=swiftshader CUBE_BENCH_WALL=1 node bench/ab.mjs --a main --scenes home-low-lo --rounds 4 --frames 6
```

- `CUBE_BENCH_ANGLE` picks ANGLE's backend (default `metal`). `swiftshader` runs WebGL on the CPU,
  a stand-in for a weak GPU; frames there take 50–1500 ms, so use few rounds and frames. On macOS,
  Brave gives no WebGL with `gl` or `vulkan`.
- `CUBE_BENCH_WALL` times each frame by wall clock (the draw plus a 1-pixel read) instead of timer
  queries. Use it for SwiftShader, whose timer queries may not cover all of its work.
- `CUBE_BENCH_SHADOWS=reuse` or `=off` turns reused shadows (`CubeView.shadowReuse`, on by default
  since they were adopted) on or off where the version has them. `run.mjs` takes it too.
- `CUBE_BENCH_SCALE` (e.g. `0.67`, the site's while moving) sets the view's `renderScale` where it
  has one: moving pictures cast their rays at that scale and upscale them (temporal upscaling).
  Without it the bench casts a ray per pixel, the view's default. `run.mjs` takes it too.
  `CUBE_BENCH_STILL_SCALE` sets `stillScale`, the same for still pictures (`ab.mjs` only).
- `CUBE_BENCH_GENERIC` draws the generic ray-cast program throughout, never a variant. That's what
  the site does without `KHR_parallel_shader_compile`, which SwiftShader lacks.

## Where the ray-cast spends its steps

```sh
node bench/steps.mjs                          # every still scene
node bench/steps.mjs --scenes station-ultra-lo
```

Draws each scene once with `STEP_COUNTS` defined in `RENDER_FS`, so each pixel outputs counts
instead of colour, and prints per ray (over the pixels where rays did any work) the mean and p99 of
camera-ray cells and bricks visited, shadow-ray steps, and `carved()` calls. A heatmap per scene goes
to `bench/results/steps/`: red camera cells, green camera bricks, blue shadow steps.

## Scenes (`scenes.ts`)

Each scene runs at 1440×900 CSS px × DPR 1.75 (`-hi`, 2520×1575) and at 1280×720 × 1 (`-lo`).
Colouring, palette, filter and threshold are the site's defaults. Nothing moves on its own. The
view's freeze (`freezeWhenStill`, see `src/cube/freeze.ts`) is off, so still scenes are timed while
they accumulate, not as the frozen picture the site shows once they have converged.

| scene | what |
| --- | --- |
| `home-ultra`, `home-high` | the home view, sun lighting, 320³ and 160³ |
| `studio-ultra` | the same with studio lighting |
| `station-ultra` | parked at Spaghetti: bore carved, the station's threshold and camera |
| `closeup-medium` | 112³ at the closest distance. Voxels are about 11 px wide, so the probe/refine path runs |
| `orbit-ultra` | camera turning 0.01 rad a frame for 60 frames with 1 ray and a short history, as in a flight |
| `drag-ultra` | the same turn with 2 rays and the settled history. This is what `main.ts` does while you drag the finished cube |
| `station-drag-ultra` | the drag at the station, where shadow rays cost the most |

## What a run records (`results.json`)

- **timing**: 60 timed frames after a 10-frame warm-up. Still scenes are timed in their settled
  state (temporal AA, 2 rays), and moving scenes while they turn. `gpu` comes from
  `EXT_disjoint_timer_query_webgl2` and `wall` is the draw plus a 1-pixel read to sync. Both
  give median, p90, mean and min in ms. `passes` is the median ms per pass (edges, bricks, occupancy,
  probe, refine, render, resolve, present) over 20 more frames, split by waiting for the GPU at
  each pass boundary (`passClock.ts`). Timer queries can't split passes on ANGLE Metal. The
  split adds about 1 ms of waiting per frame, so use it to see where the time goes.
- **images**: for still scenes, `single-s1` and `single-s2` are one frame with temporal AA off,
  and `converged` is after 32 accumulated frames. For moving scenes, every frame is saved
  (`frame-NN`), after 16 settled frames at the start pose. All are RGB, composited over the
  page background `#1c1c1f`.
- **temporal** (`temporal.ts`): luminance in levels of 255, over the pixels the cube covers.
  - `noiseMean`, `noiseP99`: the per-pixel standard deviation over the last 16 accumulated
    frames of a still scene, or over all 60 frames of a moving one. Still, this is pure noise
    (shadow-ray noise left in the history, jitter crawl). Moving, it is mostly the motion,
    which is the same in both runs.
  - `flickerPct`: the % of pixel-frames that brighten and then darken (or the reverse) by more
    than 8 levels each step.

## Comparing (`compare.mjs`)

For each image, compared with the baseline's: PSNR (100 = identical), mean absolute error, max
error, and % of pixels off by more than 8/255 in any channel. Heatmaps of the differences go to
`<run>/diff-<baseline>/`, keeping only the worst frame of a moving scene. Speed is the change in
median and p90 GPU ms.

A scene **passes** when:

| | threshold |
| --- | --- |
| still, converged image | PSNR ≥ 40 dB and ≤ 1% of pixels off by more than 8/255 |
| still, noise | mean ≤ 1.1 × baseline + 0.05 and p99 ≤ 1.1 × baseline + 0.5 |
| moving, frames | mean PSNR ≥ 35 dB and worst frame ≥ 30 dB |
| moving, noise and flicker | mean ≤ baseline + 0.5, p99 ≤ baseline + 2, flicker ≤ baseline + 0.5 points |
| single frames | only a warning below 35 dB, since changing how rays are sampled moves their noise |

Speed doesn't affect PASS/FAIL. Two runs of the same code give identical images, so quality
compares exactly. Timings vary by about ±3% in median between runs (up to ±5% for the
small `-lo` frames and moving scenes), so smaller speed changes are noise.

Checked against deliberate regressions: shortening the still history from 16 to 6 frames fails home and
station on noise, even though their converged PSNR stays at 47–49 dB. Turning temporal AA off
while moving fails both orbit scenes on every moving check.
