// GLSL for the cube viewer. Each voxel's chaos level lives in an n³ integer 3D texture (see cubeFile.ts).
// The volume is periodic (angles wrap at ±π), so neighbours and the move offset wrap around. The
// ray-cast works in volume coordinates: the box is a window [offset, offset + n] onto the endless
// tiled volume, so moves can be fractions of a voxel and the box faces cut through voxels.
//  FILTER_FS  per voxel, the highest threshold at which it still shows with k showing neighbours,
//             with the voxel's order (see there) packed in below it
//  BRICKS_FS  per 4³ block of the volume, its highest level, so rays skip empty blocks
//  RENDER_FS  ray-casts the grid and draws visible voxels as lit cubes, studio-lit or sunlit with shadows;
//             a bore can be cut into them, which is where the project panels float
//  PROBE_EDGES_FS marks the edges in the probe pass's image and fills in the rest (see RENDER_FS main)
//  RESOLVE_FS blends a frame's rays into the reprojected earlier frames' (see accumulate.ts)
//  PRESENT_FS copies that blend to the screen
//  EDGES_*    draws the cube's 12 outline edges

import { TRAIL_SAMPLES } from './thresholdTrail.ts';

// Full-screen triangle, no vertex buffer needed.
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// A voxel shows at threshold T when its level is at least T. With the filter it also needs k of its
// 26 neighbours to show, so it passes up to min(own, k-th highest neighbour). Storing that level
// keeps the filter exact for every threshold, so sweeping needs no refresh. k = 0 is no filter.
//
// Below the level, in the low 8 bits, goes a fixed random fraction per voxel (its order). Levels are
// whole numbers, so without it every voxel in a level would appear at once as the threshold passes;
// with it they appear one by one across the level. The ray-cast reads this texture for every cell
// it visits, so the hash is worked out here once instead of there each time.
export const FILTER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
uniform usampler3D uChaos;
uniform int uN;
uniform int uZ;
uniform int uK;
out uint fragColor;

uint order(ivec3 d) {
  uint h = uint(d.x) * 73856093u ^ uint(d.y) * 19349663u ^ uint(d.z) * 83492791u;
  h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15;
  return h >> 24;
}

// Neighbours are at most one cell outside the volume, so a compare per side wraps them.
uint level(ivec3 c) {
  ivec3 n = ivec3(uN);
  c += n * ivec3(lessThan(c, ivec3(0))) - n * ivec3(greaterThanEqual(c, n));
  return texelFetch(uChaos, c, 0).r;
}

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uZ);
  uint v[26];
  int i = 0;
  for (int dz = -1; dz <= 1; dz++)
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0 && dz == 0) continue;
        v[i++] = level(c + ivec3(dx, dy, dz));
      }

  // min(own, k-th highest neighbour) is the highest level t, at most its own, with k neighbours at
  // or above t. Fewer neighbours pass as t rises, so a binary search over levels finds it.
  uint lo = 0u, hi = level(c);
  while (lo < hi) {
    uint mid = (lo + hi + 1u) / 2u;
    int above = 0;
    for (int m = 0; m < 26; m++) above += v[m] >= mid ? 1 : 0;
    if (above >= uK) lo = mid; else hi = mid - 1u;
  }
  fragColor = lo << 8 | order(c);
}`;

export const BRICK = 4; // voxels per brick edge; every grid size is a multiple

// One z-slice of bricks per draw.
export const BRICKS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
uniform usampler3D uPass;
uniform int uZ;
out uint fragColor;

void main() {
  ivec3 origin = ivec3(ivec2(gl_FragCoord.xy), uZ) * ${BRICK};
  uint top = 0u;
  for (int z = 0; z < ${BRICK}; z++)
    for (int y = 0; y < ${BRICK}; y++)
      for (int x = 0; x < ${BRICK}; x++)
        top = max(top, texelFetch(uPass, origin + ivec3(x, y, z), 0).r);
  fragColor = top >> 8; // the level, without the order
}`;

export const RENDER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp usampler2D;

// The uniforms inside #ifndef can come as #defines instead, as constants (see variants.ts).
uniform usampler3D uChaos;  // chaos level per voxel
uniform usampler3D uPass;   // highest threshold each voxel shows at, in 256ths, order included (see FILTER_FS)
uniform usampler3D uBricks; // highest uPass level per brick of the volume
uniform float uLevels;      // levels - 1: the top chaos level
uniform int uN;
uniform vec3 uOffset;       // where the box starts in the tiled volume, in voxels, 0..n
uniform vec2 uResolution;
uniform vec2 uShift;
uniform float uFocal;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform float uThreshold;   // voxels below this level (plus their sub-level, see order) are hidden
#ifndef uGlow
uniform bool uGlow;         // whether new voxels glow
#endif
uniform float uTrail[${TRAIL_SAMPLES}]; // the threshold now, then evenly spaced back to when a new voxel's glow is gone (see thresholdTrail.ts)
uniform float uPixelAngle;  // radians per pixel, to fade seams when voxels get small
uniform vec3 uBase;
uniform vec3 uAccent;
#ifndef uColorBy
uniform int uColorBy;       // 0 plain, 1 neighbour count, 2 chaos level where surrounded, 3 both
#endif
uniform vec3 uRamp[4];      // low → high
#ifndef uSun
uniform bool uSun;          // sun lighting with cast shadows, instead of the studio light
#endif
uniform vec3 uSunDir;       // towards the sun
#ifndef uSamples
uniform int uSamples;       // rays per pixel: 1, 2 or 4
#endif
uniform vec4 uCarve;        // a bore cut into the voxels: xyz its axis, from the centre out; w its radius in box units (0: none)
#ifndef CARVING
#define CARVING (uCarve.w > 0.0)
#endif
uniform vec2 uJitter;       // where in the pixel the ray goes when accumulating over frames (see RESOLVE_FS)
uniform int uSunFrame;      // counts accumulated frames, so each one aims its shadow rays at new points on the sun disk
#ifndef uMode
uniform int uMode;          // 0: uSamples rays per pixel; 1: probe, one ray; 2: refine, uSamples more (see main)
#endif
uniform sampler2D uProbeColor;
uniform sampler2D uProbeDepth;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out float fragDepth; // distance to the first surface drawn, -1 for none; for reprojection
layout(location = 2) out uint fragFaces;  // the probe's faces id (see faces)

// Set by trace(): the distance along the ray to the first surface it drew, or -1.
float firstDepth = -1.0;

// Cells are in the tiled volume: 0..2n inside the box, a cell further for neighbours. The volume's
// textures repeat (WebGL's default wrap mode), so reading one at a cell's centre in texture
// coordinates lets the sampler wrap it, where texelFetch would need a few compares per axis. Every
// voxel read goes through here. (Integer textures can be sampled this way with nearest filtering;
// lod 0 keeps the read from needing derivatives inside the ray loops.)
uint voxel(usampler3D tex, ivec3 cell, int size) {
  return textureLod(tex, (vec3(cell) + 0.5) / float(size), 0.0).r;
}
float chaos(ivec3 cell) { return float(voxel(uChaos, cell, uN)); }

// How much of a cell the bore removes: all of it near the axis, less towards the rim, so the wall
// is ragged where chaotic voxels outlast calm ones. The bore runs from the box centre out along
// its axis, with a round end at the centre.
float carved(ivec3 cell) {
  vec3 q = (vec3(cell) + 0.5 - uOffset) * (2.0 / float(uN)) - 1.0;
  vec3 off = q - uCarve.xyz * max(dot(q, uCarve.xyz), 0.0);
  return 1.0 - smoothstep(0.85 * uCarve.w, uCarve.w, length(off));
}

// How far above the threshold a voxel sits; it shows at 0 or more.
float margin(ivec3 cell) {
  float m = float(voxel(uPass, cell, uN)) * (1.0 / 256.0) - uThreshold;
  return CARVING ? m - carved(cell) * (uLevels + 1.0) : m;
}
bool shows(ivec3 cell) { return margin(cell) >= 0.0; }

// How long ago a showing voxel appeared, 0..1 of the trail: the first trail point it wasn't showing
// at, interpolated. 1 when it showed the whole trail.
float age(ivec3 cell) {
  float shownAt = margin(cell) + uThreshold;
  float before = shownAt - uTrail[0];
  for (int i = 1; i < ${TRAIL_SAMPLES}; i++) {
    float m = shownAt - uTrail[i];
    if (m < 0.0) return (float(i - 1) + before / (before - m)) / ${TRAIL_SAMPLES - 1}.0;
    before = m;
  }
  return 1.0;
}

// Whether the bore removes every cell of a brick, so a ray can skip it like an empty one. The
// distance from the axis changes no faster than position, so it is enough that the brick's centre
// sits half a brick diagonal inside where the bore starts to thin.
bool boredOut(ivec3 brick) {
  if (!CARVING) return false;
  float scale = 2.0 / float(uN);
  vec3 q = (vec3(brick * ${BRICK}) + ${BRICK / 2}.0 - uOffset) * scale - 1.0;
  vec3 off = q - uCarve.xyz * max(dot(q, uCarve.xyz), 0.0);
  return length(off) + ${(Math.sqrt(3) * BRICK / 2).toFixed(4)} * scale <= 0.85 * uCarve.w;
}

// Cells near a box face fade, so as the volume moves, a voxel crossing a face changes over several
// voxels of travel and single-voxel holes there open and close gradually instead of blinking.
const float FADE = 3.0; // voxels

// How deep a cell's far side sits inside the box, in voxels (0 or less: outside).
float depthIn(ivec3 c) {
  vec3 lo = vec3(c) - uOffset;
  vec3 depth = min(lo + 1.0, float(uN) - lo);
  return min(min(depth.x, depth.y), depth.z);
}

// How opaque a cell is drawn: it fades in across the FADE voxels nearest each face.
float presence(ivec3 c) { return clamp(depthIn(c) / FADE, 0.0, 1.0); }

// How much a cell shades its neighbours and casts shadow: nothing while it is still fading in,
// then rising over the next voxel. Every surface's shading then changes smoothly with depth;
// if the translucent cells cast shade, faces would dim and brighten as each layer passed.
float blocking(ivec3 c) { return clamp(depthIn(c) - FADE, 0.0, 1.0); }

// Occupancy for ambient occlusion; outside the box is empty, which is what lights the cut faces.
float solid(ivec3 c) {
  float part = blocking(c);
  return part > 0.0 && shows(c) ? part : 0.0;
}

// How many of a cell's 26 neighbours show, as a fraction-friendly count. A neighbour that doesn't
// show only counts as missing as far as it is present: cells beyond the box faces, which are cut
// away and never drawn, don't count at all, and cells fading in at a face count partly. Otherwise
// one hidden empty voxel just past a face marks every voxel around it, and those marks pop in and
// out as the volume moves.
float neighbours(ivec3 c) {
  float missing = 0.0;
  for (int dz = -1; dz <= 1; dz++)
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 d = ivec3(dx, dy, dz);
        if (d != ivec3(0) && !shows(c + d)) missing += presence(c + d);
      }
  return 26.0 - missing;
}

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  int i = min(int(t), 2);
  return mix(uRamp[i], uRamp[i + 1], t - float(i));
}

// Standard voxel ambient occlusion for one face corner, with occupancies from 0 to 1.
float cornerAO(float side1, float side2, float corner) {
  return (3.0 - side1 - side2 - max(corner, side1 * side2)) / 3.0;
}

// The occlusion at a face's four corners: (-u -v), (+u -v), (-u +v), (+u +v).
vec4 faceCorners(ivec3 front, ivec3 u, ivec3 v) {
  float pu = solid(front + u), nu = solid(front - u), pv = solid(front + v), nv = solid(front - v);
  return vec4(
    cornerAO(nu, nv, solid(front - u - v)),
    cornerAO(pu, nv, solid(front + u - v)),
    cornerAO(nu, pv, solid(front - u + v)),
    cornerAO(pu, pv, solid(front + u + v)));
}

vec3 albedo(ivec3 cell, float level) {
  vec3 plain = uBase * mix(0.6, 1.0, level / uLevels); // calmer voxels sit a little darker
  if (uColorBy == 0) return plain;
  float count = neighbours(cell);
  vec3 byNeighbours = ramp((count - 1.0) / 12.0);
  vec3 byChaos = ramp(level / uLevels);
  if (uColorBy == 1) return byNeighbours;
  // Chaos colour takes over as a voxel becomes surrounded, blending in from 20 neighbours to all
  // 26, so a lone nearby hole only tints it instead of switching it off.
  float surrounded = smoothstep(20.0, 26.0, count);
  if (uColorBy == 2) return mix(plain, byChaos, surrounded);
  return mix(byNeighbours, byChaos, surrounded); // both: chaos inside solid regions, neighbours at their edges
  return plain;
}

// ---------- traversal ----------

// A ray stepping cell by cell (Amanatides & Woo), in cell units of the tiled volume. Camera rays
// and shadow rays both use it.
struct Ray {
  vec3 p;        // origin
  vec3 rd, inv, stepDir, tDelta;
  vec3 tMax;     // where the ray crosses into the next cell on each axis
  ivec3 cell;
  vec3 normal;   // face the ray entered the current cell through
  float t;       // where it entered the current cell
  float tLimit;  // where it leaves the box
  ivec3 brick;   // the last brick found to hold something that shows
};

Ray startRay(vec3 p, vec3 rd, ivec3 cell, vec3 normal, float tLimit) {
  Ray r;
  r.p = p; r.rd = rd; r.inv = 1.0 / rd; r.stepDir = sign(rd); r.tDelta = abs(r.inv);
  r.cell = cell; r.normal = normal; r.t = 0.0; r.tLimit = tLimit; r.brick = ivec3(-1);
  r.tMax = (r.stepDir * (vec3(cell) - p) + r.stepDir * 0.5 + 0.5) * r.tDelta;
  return r;
}

void stepCell(inout Ray r) {
  if (r.tMax.x < r.tMax.y && r.tMax.x < r.tMax.z) {
    r.cell.x += int(r.stepDir.x); r.t = r.tMax.x; r.tMax.x += r.tDelta.x; r.normal = vec3(-r.stepDir.x, 0.0, 0.0);
  } else if (r.tMax.y < r.tMax.z) {
    r.cell.y += int(r.stepDir.y); r.t = r.tMax.y; r.tMax.y += r.tDelta.y; r.normal = vec3(0.0, -r.stepDir.y, 0.0);
  } else {
    r.cell.z += int(r.stepDir.z); r.t = r.tMax.z; r.tMax.z += r.tDelta.z; r.normal = vec3(0.0, 0.0, -r.stepDir.z);
  }
}

// Moves to the next cell that shows, skipping empty bricks. False once the ray leaves the box.
bool findShowing(inout Ray r) {
  for (int i = 0; i < 1024; i++) {
    if (r.t > r.tLimit) return false;
    // Nothing in this brick shows (sub-levels add less than 1, or the bore takes all of it): jump to
    // where the ray leaves it.
    // Each brick is looked up once, when the ray enters it.
    ivec3 brick = r.cell >> ${Math.log2(BRICK)};
    if (brick != r.brick && (float(voxel(uBricks, brick, uN >> ${Math.log2(BRICK)})) + 1.0 <= uThreshold || boredOut(brick))) {
      vec3 exitAt = vec3(brick * ${BRICK}) + (r.stepDir * 0.5 + 0.5) * float(${BRICK});
      vec3 tb = (exitAt - r.p) * r.inv;
      float tExit = min(min(tb.x, tb.y), tb.z);
      bvec3 leave = equal(tb, vec3(tExit));
      // The axis the ray leaves through lands exactly on the next brick; rounding floor() there
      // can put the cell on the wrong side when the ray runs almost along that plane.
      ivec3 next = brick * ${BRICK} + ivec3(greaterThan(r.stepDir, vec3(0.0))) * ${BRICK} - ivec3(lessThan(r.stepDir, vec3(0.0)));
      ivec3 along = ivec3(floor(r.p + r.rd * tExit));
      r.cell = ivec3(mix(vec3(along), vec3(next), vec3(leave)));
      r.tMax = (r.stepDir * (vec3(r.cell) - r.p) + r.stepDir * 0.5 + 0.5) * r.tDelta;
      // On the other axes, floor() can land one cell behind the ray; step those forward.
      ivec3 behind = ivec3(lessThan(r.tMax, vec3(tExit))) * ivec3(not(leave));
      r.cell += behind * ivec3(r.stepDir);
      r.tMax += vec3(behind) * r.tDelta;
      r.normal = -r.stepDir * vec3(leave);
      r.t = tExit;
      continue;
    }
    r.brick = brick;
    if (shows(r.cell)) return true;
    stepCell(r);
  }
  return false;
}

// Where a ray from p enters and leaves the box [lo, hi], in cell units (enter > leave: it misses).
vec2 boxSpan(vec3 p, vec3 rd, vec3 lo, vec3 hi) {
  vec3 a = (lo - p) / rd, b = (hi - p) / rd;
  vec3 near = min(a, b), far = max(a, b);
  return vec2(max(max(near.x, near.y), near.z), min(min(far.x, far.y), far.z));
}

// ---------- lighting ----------

const vec3 STUDIO_LIGHT = normalize(vec3(-0.45, 0.85, 0.35));
const vec3 SUN_COLOR = vec3(1.1, 1.0, 0.87);
const vec3 SKY_COLOR = vec3(0.34, 0.38, 0.46);
const float SUN_RADIUS = 0.1; // the sun disk's radius in radians; shadows soften over it

// Towards a point on the sun disk, set per ray: each of a pixel's rays aims at a different point,
// so shadow edges blend instead of stepping.
vec3 sunDir;

// How much sunlight reaches o. Each voxel in the way blocks as much as its depth allows.
float sunlight(vec3 o) {
  Ray s = startRay(o, sunDir, ivec3(floor(o)), vec3(0.0), boxSpan(o, sunDir, uOffset, uOffset + float(uN)).y);
  float light = 1.0;
  for (int k = 0; k < 12; k++) {
    if (!findShowing(s)) break;
    light *= 1.0 - blocking(s.cell);
    if (light < 0.02) return 0.0;
    stepCell(s);
  }
  return light;
}

// Fade-band sheets have neighbours that are all still fading in, so ambient occlusion on them
// would come out as none; skip it.
bool shadingSheet = false;

// Shadow rays are the costly part of sun lighting, so a pixel casts at most two; with four rays,
// each is shared by a pair (reset in main()). Each aims at its own point on the sun disk.
float sharedSunlight = -1.0;

// The last face shaded. A pixel's rays mostly land on the same face, so the colour and corner
// occlusion, which take dozens of voxel reads, are worked out once and shared; each ray only adds
// what changes across the face.
bool faceCached = false;
ivec3 cachedCell;
vec3 cachedNormal;
bool cachedSheet;
vec3 cachedSurface;
float cachedHeat;
vec4 cachedCorners;

// Which voxel faces a ray shaded, hashed in order. Neighbouring pixels with the same id show the
// same faces, so between them the image is smooth; a different id means an edge between them.
uint faces;

vec3 shade(Ray r, float dist) {
  uvec3 at = uvec3(r.cell + 1); // cells start at -1
  uint face = at.x * 73856093u ^ at.y * 19349663u ^ at.z * 83492791u ^ uint(dot(r.normal + 1.0, vec3(1.0, 3.0, 9.0))) * 2654435761u;
  faces = (faces ^ face ^ (shadingSheet ? 0x9e3779b9u : 0u)) * 16777619u;
  vec3 hit = r.p + r.rd * r.t;
  ivec3 nI = ivec3(r.normal);
  ivec3 u = abs(nI.x) == 1 ? ivec3(0, 1, 0) : ivec3(1, 0, 0);
  ivec3 v = abs(nI.z) == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1);
  if (abs(nI.y) == 1) { u = ivec3(1, 0, 0); v = ivec3(0, 0, 1); }
  vec3 fr = fract(hit);
  vec2 f = vec2(dot(fr, vec3(u)), dot(fr, vec3(v)));

  if (!faceCached || r.cell != cachedCell || r.normal != cachedNormal || shadingSheet != cachedSheet) {
    faceCached = true;
    cachedCell = r.cell;
    cachedNormal = r.normal;
    cachedSheet = shadingSheet;
    cachedCorners = shadingSheet ? vec4(1.0) : faceCorners(r.cell + nI, u, v);
    // New voxels glow and cool over a fixed time from when each appeared, so the growing front
    // reads and, once the threshold stops, the last of them go out one by one.
    cachedHeat = uGlow ? 1.0 - smoothstep(0.0, 1.0, age(r.cell)) : 0.0;
    vec3 hot = mix(vec3(1.0, 0.93, 0.86), uAccent, smoothstep(0.0, 0.12, 1.0 - cachedHeat));
    cachedSurface = mix(albedo(r.cell, chaos(r.cell)), hot, 0.6 * cachedHeat);
  }
  vec4 c = cachedCorners;
  float ao = mix(mix(c.x, c.y, f.x), mix(c.z, c.w, f.x), f.y);
  float heat = cachedHeat;
  vec3 surface = cachedSurface;

  vec3 col;
  if (uSun) {
    // Direct sun with cast shadows, plus sky light that ambient occlusion darkens.
    float facing = max(dot(r.normal, uSunDir), 0.0);
    if (facing > 0.0 && sharedSunlight < 0.0) sharedSunlight = sunlight(hit + r.normal * 1e-3);
    float lit = facing > 0.0 ? sharedSunlight : 0.0;
    vec3 sky = SKY_COLOR * (0.55 + 0.45 * r.normal.y) * mix(0.25, 1.0, ao);
    col = surface * (SUN_COLOR * facing * lit + sky);
  } else {
    float diffuse = max(dot(r.normal, STUDIO_LIGHT), 0.0);
    float sky = 0.5 + 0.5 * r.normal.y;
    col = surface * (0.30 + 0.55 * diffuse + 0.25 * sky) * mix(0.32, 1.0, ao);
  }

  // Thin seams between cubes, faded out once a voxel is only a few pixels wide. Each seam spreads
  // over a pixel, so one thinner than a pixel fades instead of flickering as voxels slide past.
  float voxelPx = (2.0 / float(uN)) / (dist * uPixelAngle);
  vec2 edge = min(f, 1.0 - f);
  float px = 0.5 / voxelPx; // half a pixel, in voxels
  float seam = mix(0.84, 1.0, smoothstep(0.08 - px, 0.08 + px, min(edge.x, edge.y)));
  col *= mix(1.0, seam, smoothstep(3.0, 9.0, voxelPx));
  return col + uAccent * 0.3 * heat + vec3(1.0, 0.85, 0.7) * 0.2 * pow(heat, 6.0);
}

// One camera ray through a point on the screen, in pixels; premultiplied colour and coverage.
vec4 trace(vec2 pixel, vec2 sunOffset) {
  faces = 2166136261u;
  vec2 uv = (pixel * 2.0 - uResolution) / uResolution.y - uShift;
  vec3 rd = normalize(uForward * uFocal + uRight * uv.x + uUp * uv.y);
  vec3 ro = uEye;
  vec3 across = normalize(cross(uSunDir, abs(uSunDir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  sunDir = normalize(uSunDir + SUN_RADIUS * (across * sunOffset.x + cross(uSunDir, across) * sunOffset.y));

  // Ray against the [-1, 1]³ box.
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-1.0 - ro) * inv, t1 = (1.0 - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), tmin.z);
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  if (tNear > tFar || tFar < 0.0) return vec4(0.0);

  // Everything below is in cell units of the tiled volume, from where the ray enters the box.
  float n = float(uN);
  float tStart = max(tNear, 0.0);
  vec3 p = (ro + rd * tStart + 1.0) * 0.5 * n + uOffset;
  float tLimit = (tFar - tStart) * 0.5 * n;
  vec3 outerNormal = -sign(rd) * vec3(equal(tmin, vec3(tNear)));
  int axis = outerNormal.x != 0.0 ? 0 : outerNormal.y != 0.0 ? 1 : 2;
  float inward = -outerNormal[axis];
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // The fade band behind the face the ray enters through: one flat sheet per layer, as opaque as
  // its voxel is present. Each layer is sampled straight down from where the ray enters, which
  // keeps voxels crisp (sampling where the ray crosses smears colours along the view at glancing
  // angles); where that column has a hole, the voxel the ray actually passes fills it, so the band
  // still hides what is behind it. Stepping cell by cell instead adds up a different number of
  // cells per pixel, which shows as moiré.
  float face = p[axis];
  float plane = inward > 0.0 ? floor(face) + 1.0 : ceil(face) - 1.0; // the first layer boundary inside
  ivec3 column = ivec3(floor(p));
  int layerCell = inward > 0.0 ? int(floor(face)) : int(ceil(face)) - 1;
  float tPrev = 0.0;
  shadingSheet = true;
  for (int j = 0; j <= int(FADE); j++) {
    if (tPrev > tLimit) break;
    float tNext = (plane - face) / rd[axis];
    ivec3 cell = column;
    cell[axis] = layerCell;
    // Where the column has a hole, the voxel the ray really passes in this layer shows instead.
    if (!shows(cell)) {
      cell = ivec3(floor(p + rd * (0.5 * (tPrev + min(tNext, tLimit)))));
      cell[axis] = layerCell;
    }
    float a = presence(cell);
    if (a > 0.0 && shows(cell)) {
      Ray r = startRay(p, rd, cell, outerNormal, tLimit); // lit where the ray enters, like the face
      if (firstDepth < 0.0) firstDepth = tStart;
      col += (1.0 - alpha) * a * shade(r, tStart);
      alpha += (1.0 - alpha) * a;
      if (alpha > 0.995) { shadingSheet = false; return vec4(col, alpha); }
    }
    tPrev = tNext;
    plane += inward;
    layerCell += int(inward);
  }
  shadingSheet = false;

  // Past the band, voxels are solid cubes. Near the other faces they still fade, so those blend.
  if (tPrev <= tLimit) {
    ivec3 cell = ivec3(floor(p + rd * tPrev));
    cell[axis] = int(plane - inward) - (inward < 0.0 ? 1 : 0); // exactly the layer past the band
    Ray r = startRay(p, rd, cell, outerNormal, tLimit);
    r.t = tPrev;
    // floor() can land one cell behind the ray on the other axes; step those forward.
    for (int k = 0; k < 3; k++) {
      if (k != axis && r.tMax[k] < tPrev) { r.cell[k] += int(r.stepDir[k]); r.tMax[k] += r.tDelta[k]; }
    }
    for (int layer = 0; layer < 8; layer++) {
      if (!findShowing(r)) break;
      float a = presence(r.cell);
      if (firstDepth < 0.0) firstDepth = tStart + r.t * 2.0 / n;
      col += (1.0 - alpha) * a * shade(r, tStart + r.t * 2.0 / n);
      alpha += (1.0 - alpha) * a;
      if (alpha > 0.995) break;
      stepCell(r);
    }
  }
  return vec4(col, alpha);
}

// Voxels can be a pixel wide or less, so one ray per pixel aliases: details flash as the volume
// slides. Several rays per pixel, averaged, keep them steady. Offsets within the pixel for 1, 2
// and 4 rays, from SAMPLES[uSamples - 1]: the centre, a diagonal pair, a rotated grid.
const vec2 SAMPLES[7] = vec2[7](
  vec2(0.0),
  vec2(0.25, 0.25), vec2(-0.25, -0.25),
  vec2(0.125, 0.375), vec2(0.375, -0.125), vec2(-0.125, -0.375), vec2(-0.375, 0.125));

// Interleaved gradient noise (Jimenez, 2014): 0..1 per pixel, laid out so that neighbouring pixels
// differ as much as possible. A few pixels' worth of it averages out to flat, which white noise
// takes far more to do.
float gradientNoise(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

// The k-th of 16 points spread evenly over the unit disk (a Vogel spiral), turned by turn radians.
vec2 diskPoint(int k, float turn) {
  int i = k % 16;
  float a = float(i) * 2.39996323 + turn; // the golden angle
  return sqrt((float(i) + 0.5) / 16.0) * vec2(cos(a), sin(a));
}

// Extra rays only help where a pixel straddles an edge: where voxels are several pixels wide, most
// pixels sit inside one face and every ray in them comes out the same. So with several rays the
// cube can draw in passes: a probe casts one ray per pixel and notes the faces it shaded;
// PROBE_EDGES_FS marks the pixels whose faces differ from a neighbour's in the stencil buffer and
// copies the probe's colour to the rest; then the refine pass, stencilled to the marked pixels, casts the full
// count there. (Doing the edge test in the refine pass itself saves little: the GPU runs pixels in
// groups, and a group with one edge pixel in it waits for that pixel's rays.) Where voxels are
// about a pixel wide, nearly every pixel is an edge, and the single pass (mode 0) is cheaper.
void main() {
  vec4 sum = vec4(0.0);
  int rays = uMode == 1 ? 1 : uSamples;
  int counted = rays;
  if (uMode == 2) {
    // The probe's ray counts as one more.
    ivec2 px = ivec2(gl_FragCoord.xy);
    sum = texelFetch(uProbeColor, px, 0);
    fragDepth = texelFetch(uProbeDepth, px, 0).r;
    counted++;
  }

  // Each shadow ray aims at its own point on the sun disk, so shadow edges soften. Pixels start at
  // different points of the spiral, turned differently, so the softening doesn't band, and each
  // accumulated frame moves on to the next points. Two rays or one cast a shadow ray each; four
  // share them in pairs. The refine pass's rays take the points after the probe's.
  int first = int(gradientNoise(gl_FragCoord.xy) * 16.0) + uSunFrame * (uSamples + 1) + (uMode == 2 ? 1 : 0);
  float turn = gradientNoise(gl_FragCoord.xy + vec2(47.0, 17.0)) * 6.2831853;
  vec2 sunPoint = vec2(0.0);
  int aimed = 0;
  for (int i = 0; i < rays; i++) {
    if (rays < 4 || i % 2 == 0) {
      sharedSunlight = -1.0;
      sunPoint = diskPoint(first + aimed++, turn);
    }
    vec2 offset = uMode == 1 ? vec2(0.0) : SAMPLES[rays - 1 + i];
    sum += trace(gl_FragCoord.xy + uJitter + offset, sunPoint);
    if (i == 0 && uMode != 2) {
      fragDepth = firstDepth;
      fragFaces = faces;
    }
  }
  fragColor = sum / float(counted);
}`;

// Accumulating over frames: each frame casts its rays at different points in the pixel (and on the
// sun disk) from the last, and this blends them into the history. The history is reprojected through
// the first surface's distance, so it follows the camera, and clamped to the spread of this frame's
// 3×3 neighbourhood (mean ± 1.25 standard deviations), so it can't keep colours that are no longer
// there (no ghosting). The clamp works in YCoCg, where that spread hugs the colours actually present
// far closer than in RGB. (Clipping along the line to the mean instead pulls the history nearly onto
// the mean wherever one channel barely varies, alpha on any solid surface, which blurs the image.)
// The history is read with a Catmull-Rom filter: a bilinear read blurs a little every frame the
// camera turns, and that adds up.
//
// Where the image holds still, the history averages over many frames; where it moves on screen or
// the cube is changing (the threshold sweeping), over a few, so lighting that turns with the camera
// and voxels coming and going don't trail. Samples are weighted down by brightness when blended, so
// one bright ray doesn't flash.
export const RESOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uCurrent;  // this frame, premultiplied
uniform sampler2D uDepth;    // this frame's first-surface distances
uniform sampler2D uHistory;  // the blend so far, premultiplied
uniform float uBlend;        // weight of this frame while the history is still short: 1 / frames so far
uniform bool uSettled;       // the cube isn't changing, so still parts can keep a long history
uniform vec2 uResolution;
uniform vec2 uShift;
uniform float uFocal;
uniform vec3 uEye, uRight, uUp, uForward;
uniform vec2 uPrevShift;
uniform float uPrevFocal;
uniform vec3 uPrevEye, uPrevRight, uPrevUp, uPrevForward;
uniform vec3 uMotion;        // how far the voxels moved since the last frame (the volume drifting), in world units
out vec4 fragColor;

// Catmull-Rom over the 4×4 texels around uv, in 5 bilinear reads (the corners are left out; they
// weigh almost nothing). After "Filmic SMAA" (Jimenez, 2016).
vec4 catmullRom(sampler2D tex, vec2 uv, vec2 size) {
  vec2 pos = uv * size;
  vec2 centre = floor(pos - 0.5) + 0.5;
  vec2 f = pos - centre;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tc0 = (centre - 1.0) / size;
  vec2 tc3 = (centre + 2.0) / size;
  vec2 tc12 = (centre + w2 / w12) / size;
  vec4 c = texture(tex, vec2(tc12.x, tc0.y)) * w12.x * w0.y
    + texture(tex, vec2(tc0.x, tc12.y)) * w0.x * w12.y
    + texture(tex, tc12) * w12.x * w12.y
    + texture(tex, vec2(tc3.x, tc12.y)) * w3.x * w12.y
    + texture(tex, vec2(tc12.x, tc3.y)) * w12.x * w3.y;
  float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / weight, 0.0);
}

const float STILL_BLEND = 1.0 / 16.0;  // a still pixel's history averages about 16 frames
const float MOVING_BLEND = 1.0 / 4.0;  // and a moving one's about 4
const float SPREAD = 1.25;             // standard deviations of the neighbourhood the history may sit within

vec4 toYCoCg(vec4 c) {
  return vec4(dot(c.rgb, vec3(0.25, 0.5, 0.25)), dot(c.rgb, vec3(0.5, 0.0, -0.5)), dot(c.rgb, vec3(-0.25, 0.5, -0.25)), c.a);
}
vec4 fromYCoCg(vec4 c) {
  return vec4(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z, c.a);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uResolution) - 1;
  vec4 cur = texelFetch(uCurrent, px, 0);
  vec4 sum = vec4(0.0), sumSq = vec4(0.0);
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      vec4 c = toYCoCg(texelFetch(uCurrent, clamp(px + ivec2(dx, dy), ivec2(0), last), 0));
      sum += c;
      sumSq += c * c;
    }
  vec4 mean = sum / 9.0;
  vec4 spread = sqrt(max(sumSq / 9.0 - mean * mean, 0.0)) * SPREAD;

  // Where this pixel's surface was on screen last frame. Pixels that missed the cube reproject
  // through the cube's centre distance.
  float depth = texelFetch(uDepth, px, 0).r;
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y - uShift;
  vec3 rd = normalize(uForward * uFocal + uRight * uv.x + uUp * uv.y);
  vec3 world = uEye + rd * (depth > 0.0 ? depth : length(uEye));
  vec3 d = world - uMotion - uPrevEye;
  float z = dot(d, uPrevForward);
  vec2 prevUv = vec2(dot(d, uPrevRight), dot(d, uPrevUp)) * uPrevFocal / z + uPrevShift;
  vec2 prev = (prevUv * uResolution.y + uResolution) * 0.5 / uResolution;
  if (z <= 0.0 || any(lessThan(prev, vec2(0.0))) || any(greaterThan(prev, vec2(1.0)))) {
    fragColor = cur;
    return;
  }
  vec4 history = fromYCoCg(clamp(toYCoCg(catmullRom(uHistory, prev, uResolution)), mean - spread, mean + spread));

  float moved = length((prev - gl_FragCoord.xy / uResolution) * uResolution); // in pixels
  float blend = uSettled ? mix(STILL_BLEND, MOVING_BLEND, smoothstep(0.0, 1.0, moved)) : MOVING_BLEND;
  blend = max(blend, uBlend);
  // Weighted by 1 / (1 + brightness), so a lone bright sample counts for less (Karis, 2014).
  float wCur = blend / (1.0 + toYCoCg(cur).x);
  float wHistory = (1.0 - blend) / (1.0 + toYCoCg(history).x);
  fragColor = (cur * wCur + history * wHistory) / (wCur + wHistory);
}`;

// With the probe's image: marks its edges (uMark; the stencil test writes the mark) or copies its
// colour and first-surface distance (see RENDER_FS main).
export const PROBE_EDGES_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp usampler2D;
uniform sampler2D uProbeColor;
uniform sampler2D uProbeDepth;
uniform usampler2D uProbeFaces;
uniform bool uMark;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out float fragDepth;

// Whether any of the 8 neighbours shaded other faces.
bool edge(ivec2 px) {
  ivec2 last = textureSize(uProbeFaces, 0) - 1;
  uint own = texelFetch(uProbeFaces, px, 0).r;
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++)
      if (texelFetch(uProbeFaces, clamp(px + ivec2(dx, dy), ivec2(0), last), 0).r != own) return true;
  return false;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  if (uMark && !edge(px)) discard;
  fragColor = texelFetch(uProbeColor, px, 0);
  fragDepth = texelFetch(uProbeDepth, px, 0).r;
}`;

// Copies the accumulated image to the screen.
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
out vec4 fragColor;
void main() { fragColor = texelFetch(uImage, ivec2(gl_FragCoord.xy), 0); }`;

// The 12 cube edges as 24 line endpoints, projected with the same camera as the ray-cast.
export const EDGES_VS = /* glsl */ `#version 300 es
uniform vec2 uResolution;
uniform vec2 uShift;
uniform float uFocal;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;

const ivec2 EDGES[12] = ivec2[12](
  ivec2(0, 1), ivec2(2, 3), ivec2(4, 5), ivec2(6, 7),
  ivec2(0, 2), ivec2(1, 3), ivec2(4, 6), ivec2(5, 7),
  ivec2(0, 4), ivec2(1, 5), ivec2(2, 6), ivec2(3, 7));

void main() {
  ivec2 e = EDGES[gl_VertexID / 2];
  int corner = (gl_VertexID % 2 == 0) ? e.x : e.y;
  vec3 world = vec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1) * 2.0 - 1.0;
  vec3 d = world - uEye;
  float z = dot(d, uForward);
  vec2 screen = vec2(dot(d, uRight), dot(d, uUp)) * uFocal / z + uShift;
  gl_Position = vec4(screen.x * uResolution.y / uResolution.x, screen.y, 0.0, 1.0);
}`;

export const EDGES_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;
