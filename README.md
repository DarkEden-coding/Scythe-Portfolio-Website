# Scythe Portfolio Website

My portfolio site. The hero is a WebGL2 voxel render of a triple pendulum's chaos map: each voxel
is one pendulum released from a different starting pose, coloured by how chaotic it is. Projects
sit as "stations" inside the cube; picking one flies the camera there and opens its panels. The
same projects are listed in plain HTML below the hero, next to a GitHub contribution graph.

Built with Vite and TypeScript, with no framework. The renderer is hand-written WebGL2.

## Running it

```sh
npm install
npm run dev        # dev server
npm test           # unit tests (vitest)
npm run build      # fetches the contribution graph, type-checks, builds to dist/
npm run deploy     # build, then upload dist/ to Cloudflare with wrangler
```

The cube files in `public/cubes/` are not in the repo (about 120 MB). Without them the page loads
but the cube says "could not load". To make them, see [Baking the cubes](#baking-the-cubes), or
download the current set from the `cubes` release:

```sh
gh release download cubes --pattern cubes.tar && mkdir -p public/cubes && tar -xf cubes.tar -C public/cubes
```

## Deploying

Publishing a GitHub release deploys the site to [elliotscully.dev](https://elliotscully.dev) (and
`www.`). The workflow in `.github/workflows/deploy.yml` downloads the cubes from the `cubes`
release, runs the tests, builds, and runs `wrangler deploy`. It reads the `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

```sh
gh release create v1.2.0 --generate-notes
```

After re-baking, upload the new cubes, then publish a release:

```sh
tar -cf cubes.tar -C public/cubes . && gh release upload cubes cubes.tar --clobber
```

## How the cube works

### Data

Each preset is a planar triple pendulum with its own arm lengths and masses (`src/presets.ts`).
The three starting arm angles span ±π along x, y and z, so every voxel is one starting pose. Its
value is the finite-time Lyapunov exponent over the first 5 seconds: how fast a tiny change to the
start grows, in e-folds per second. It's stored as one of 64 levels per voxel and gzipped. There
are five presets, each at four grid sizes (64³, 112³, 160³, 320³).

### Rendering (`src/cube/`)

- **Ray marching:** a DDA over a 3D integer texture, with a brick map (max level per 4³ block)
  to skip empty space. The threshold slider hides voxels below a chaos level, so the brick map is
  what keeps the ray count low as the cube thins out.
- **Shading:** colour comes from the chaos level and the neighbouring voxels, with soft shadows
  from points on a sun disk.
- **Temporal AA:** while the camera is still, rays are jittered and the sun disk turns a little
  each frame. Earlier frames are reprojected through the first surface's depth, and Catmull-Rom
  sampling and variance clipping keep that from ghosting. Measured against a 64-ray reference
  image, one ray per pixel accumulated is about as close as four rays without it
  (`accumulate.ts`).
- **Adaptive quality:** when frames run long, the renderer drops rays per pixel first, then render
  resolution, then grid size. Each can also be pinned in the settings panel.
- **Loading:** a worker streams and unpacks the files (`unpack.worker.ts`) and keeps them in Cache
  Storage, so a cube is only downloaded once.

### Projects (`src/projects/`)

`content.ts` holds the text and screenshots. `stations.ts` places each project in a preset,
with its camera pose and chaos threshold. `stage.ts` lays the panels out in 3D with CSS
`matrix3d` so they line up with the WebGL camera.

## Baking the cubes

The chaos maps are computed on an NVIDIA GPU by [`bake/lyapunov.cu`](bake/lyapunov.cu). It
integrates every pendulum with RK4 and carries the perturbation along as dual numbers, which stays
accurate in float32. [`scripts/bake.mjs`](scripts/bake.mjs) drives it over SSH:

```sh
npm run bake                          # every preset and grid
npm run bake -- --grid 64,160         # only these grid sizes
npm run bake -- --preset 0 --force    # re-bake preset 0
npm run bake -- --host my-gpu-box     # GPU host (default: scythe-desktop, or $BAKE_HOST)
```

The host needs CUDA (`nvcc`) and passwordless SSH. The script copies the source over and builds it
there if it has changed. For each preset and grid it keeps a master on the host: float16 exponents
at several horizons (5–60 s). It then packs the horizon the site uses into a byte-per-voxel cube
and copies it to `public/cubes/`. Changing `CHAOS` in `src/presets.ts` only needs a repack, which
is quick. Changing a preset's lengths, masses or gravity needs a re-bake.

Visitors whose browsers cached older cubes get the new ones automatically: the cache is named
after the bake settings.

You can run the baker by hand too:

```sh
nvcc -O3 -arch=native -o lyapunov bake/lyapunov.cu
./lyapunov bake --n 160 --lengths 1,1,1 --masses 1,1,1 --gravity 9.81 --dt 0.01 \
  --horizons 5,10,20,40,60 --out master.f16
./lyapunov pack --in master.f16 --n 160 --plane 0 --max 5 --levels 64 --out cube.raw
gzip -9 -n -c cube.raw > public/cubes/0-160.cube
```

## Contribution graph

`scripts/contributions.mjs` reads the public contribution calendar on my GitHub profile (no token
needed) and saves it to `public/contributions.json`. It runs before every build. If GitHub can't
be reached, it keeps the last saved file.
