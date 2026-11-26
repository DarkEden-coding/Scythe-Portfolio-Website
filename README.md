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
  what keeps the ray count low as the cube thins out. Each brick also stores the highest level in
  the cubes of bricks around it (radius 1, 2 and 4, rebuilt with the brick map, so not while the
  threshold sweeps), and a ray in an empty brick jumps out of the largest of those cubes that is
  empty too, with the same code as a one-brick jump: at home that cuts a camera ray's brick steps
  from 26 to 10, at a project from 15 to 8. The brick passes draw into 2D atlases where they can,
  since a draw per layer of a 3D texture costs more than the work. Voxels are read through the
  sampler with REPEAT wrapping, so the periodic volume wraps for free instead of costing compares
  per read.
- **The bore:** at a project the cube has a bore cut towards the camera. What it carves is baked
  into the occupancy bits below (rebuilt only when the bore, the volume's place or the threshold
  changes, so every frame of a flight but not while parked), so rays, brick skips and shading read
  it there instead of working it out per cell; the brick reach still applies, since the bore only
  takes voxels away. Rays also jump straight across its hollow (a
  ray–capsule exit, wider as the threshold rises), so they don't step through the empty middle.
- **Shading:** colour comes from the chaos level and the neighbouring voxels, with soft shadows
  from points on a sun disk. A bit volume of which voxels show at the current threshold (64 bits
  per brick, rebuilt in one draw when the threshold changes) gives each shaded voxel its 3×3×3
  neighbourhood in 8 reads, for ambient occlusion and the neighbour count. Shadow rays only walk
  the box inset by the fade bands (nothing nearer the faces casts shade), and each pair of camera
  rays shares one, cast after both are traced.
- **Reused shadows (experiment, `?shadows=reuse`):** while the camera moves with two rays (dragging
  the finished cube), the ray-cast leaves the direct sun apart and casts no shadow rays; a pass at
  half size casts one per 2×2 block of pixels, a different pixel of it each frame, and each pixel
  takes the light from the 3×3 blocks around it whose rays started on its own plane
  (`shadowReuse.ts`). A still picture casts its own as before, so it comes out the same.
- **Specialised shaders:** the ray-cast compiles a variant per combination of lighting, colouring,
  glow, rays per pixel and bore (`#define`s, `variants.ts`), in the background where the browser
  allows, so each draw runs only the code it needs. The variants the site will want next (the
  other ray count, the other bore setting) compile ahead and draw one pixel each as they finish,
  so a first visit doesn't stall when the cube settles or the first flight starts. Passes are
  scissored to the cube's rectangle on screen.
- **Temporal AA:** while the camera is still, rays are jittered and the sun disk turns a little
  each frame. Earlier frames are reprojected through the first surface's depth, and Catmull-Rom
  sampling and variance clipping keep that from ghosting. Measured against a 64-ray reference
  image, one ray per pixel accumulated is about as close as four rays without it
  (`accumulate.ts`). Once a still picture has accumulated 32 frames with nothing changed, the view
  stops casting rays and shows it as it is until something does (`freeze.ts`), which at a
  project is most of the time.
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
