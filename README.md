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
npm run bench      # renderer speed and image-quality benchmark (bench/README.md)
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
COPYFILE_DISABLE=1 tar --no-xattrs -cf cubes.tar -C public/cubes . && gh release upload cubes cubes.tar --clobber
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

`content.ts` holds the text and screenshots. The screenshots live in `src/assets/projects/` so
Vite gives them hashed `/assets/` URLs, and a rig's screenshots only load the first time it opens.
Projects with a `page` link to a static write-up under `projects/<id>/index.html` (EagleEye and
Aerie), built as extra Vite entries (`vite.config.ts`) and styled by `src/pages/project.css`. `stations.ts` places each project in a preset,
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

Visitors whose browsers cached older cubes get the new ones automatically. `CUBE_VERSION` in
`src/presets.ts` is a hash of the bake settings; it names the Cache Storage copy and is in every cube
URL (`/cubes/0-320.cube?v=…`), which is what lets `public/_headers` cache the files for a year. If
the cube files change without the settings changing (a fix to the baker itself), bump
`BAKE_REVISION` there.

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

## Search and link previews

The `<head>` in `index.html` carries the description, canonical URL, Open Graph and Twitter tags,
and JSON-LD describing the site and me. Each write-up page has its own title, description,
canonical URL and JSON-LD. `public/` holds `robots.txt`, `sitemap.xml` (list new write-up pages
there), `site.webmanifest` and the icons.

### Caching

`public/_headers` sets browser lifetimes. Everything under `/assets/` (Vite output, with content
hashes) and the versioned cubes cache for a year as immutable. Files at fixed URLs (`og.jpg`,
icons, `brand/`, `sitemap.xml`) cache for an hour or a day. HTML keeps Cloudflare's default,
`max-age=0, must-revalidate`, so a deploy shows up at once.

`public/og.jpg` is the 1200×630 image shown when the site is linked. Its source is
`scripts/og/card.html`: the hero's nav and id cards, restyled from `src/styles.css`, over
`scripts/og/cube.jpg`, a screenshot of the finished cube with the page UI hidden. When the cube or
the hero text changes, update `card.html` to match, then recapture and re-render (macOS, Brave by
default; set `BROWSER` to another Chromium):

```sh
node scripts/og/capture.mjs          # or pass a URL, e.g. a local `npm run preview`
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --headless=new --hide-scrollbars \
  --allow-file-access-from-files --force-device-scale-factor=1 --window-size=1200,630 \
  --screenshot=og.png "file://$PWD/scripts/og/card.html"
sips -s format jpeg -s formatOptions 88 og.png --out public/og.jpg && rm og.png
```
