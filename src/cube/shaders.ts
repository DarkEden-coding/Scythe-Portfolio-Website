// GLSL for the cube viewer. Each voxel's chaos level lives in an n³ integer 3D texture (see cubeFile.ts).
// The volume is periodic (angles wrap at ±π), so neighbours and the move offset wrap around. The
// ray-cast works in volume coordinates: the box is a window [offset, offset + n] onto the endless
// tiled volume, so moves can be fractions of a voxel and the box faces cut through voxels.
//  FILTER_FS  per voxel, the highest threshold at which it still shows with k showing neighbours
//  BRICKS_FS  per 4³ block of the volume, its highest level, so rays skip empty blocks
//  RENDER_FS  ray-casts the grid and draws visible voxels as lit cubes, studio-lit or sunlit with shadows;
//             a bore can be cut into them, which is where the project panels float
//  EDGES_*    draws the cube's 12 outline edges

// Full-screen triangle, no vertex buffer needed.
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// A voxel shows at threshold T when its level is at least T. With the filter it also needs k of its
// 26 neighbours to show, so it passes up to min(own, k-th highest neighbour). Storing that level
// keeps the filter exact for every threshold, so sweeping needs no refresh.
export const FILTER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
uniform usampler3D uChaos;
uniform int uN;
uniform int uZ;
uniform int uK;
out uint fragColor;

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
  fragColor = lo;
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
  fragColor = top;
}`;

export const RENDER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uChaos;  // chaos level per voxel
uniform usampler3D uPass;   // highest threshold each voxel shows at (uChaos itself without the filter)
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
uniform float uHeat;        // 0..1, how strongly voxels near the threshold glow
uniform float uGlow;        // levels above the threshold that still glow
uniform float uPixelAngle;  // radians per pixel, to fade seams when voxels get small
uniform vec3 uBase;
uniform vec3 uAccent;
uniform int uColorBy;       // 0 plain, 1 neighbour count, 2 chaos level where surrounded, 3 both
uniform vec3 uRamp[4];      // low → high
uniform bool uSun;          // sun lighting with cast shadows, instead of the studio light
uniform vec3 uSunDir;       // towards the sun
uniform int uSamples;       // rays per pixel: 1, 2 or 4
uniform vec4 uCarve;        // a bore cut into the voxels: xyz its axis, from the centre out; w its radius in box units (0: none)

out vec4 fragColor;

// Cells are in the tiled volume: 0..2n inside the box, a cell further for neighbours, so a
// couple of compares wrap them. Integer % is slow on GPUs, and every voxel read goes through here.
ivec3 wrap(ivec3 c, int n) {
  ivec3 size = ivec3(n);
  c += size * ivec3(lessThan(c, ivec3(0)));
  c -= size * ivec3(greaterThanEqual(c, size));
  return c - size * ivec3(greaterThanEqual(c, size));
}
ivec3 data(ivec3 cell) { return wrap(cell, uN); }
float chaos(ivec3 cell) { return float(texelFetch(uChaos, data(cell), 0).r); }

// A fixed random fraction per voxel. Levels are whole numbers, so without it every voxel in a level
// would appear at once as the threshold passes; with it they appear one by one across the level.
float order(ivec3 d) {
  uint h = uint(d.x) * 73856093u ^ uint(d.y) * 19349663u ^ uint(d.z) * 83492791u;
  h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15;
  return float(h >> 8) / 16777216.0;
}

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
  ivec3 d = data(cell);
  float m = float(texelFetch(uPass, d, 0).r) + order(d) - uThreshold;
  return uCarve.w > 0.0 ? m - carved(cell) * (uLevels + 1.0) : m;
}
bool shows(ivec3 cell) { return margin(cell) >= 0.0; }

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

float faceAO(ivec3 front, ivec3 u, ivec3 v, vec2 f) {
  float pu = solid(front + u), nu = solid(front - u), pv = solid(front + v), nv = solid(front - v);
  float a00 = cornerAO(nu, nv, solid(front - u - v));
  float a10 = cornerAO(pu, nv, solid(front + u - v));
  float a01 = cornerAO(nu, pv, solid(front - u + v));
  float a11 = cornerAO(pu, pv, solid(front + u + v));
  return mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
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
    // Nothing in this brick shows (sub-levels add less than 1): jump to where the ray leaves it.
    // Each brick is looked up once, when the ray enters it.
    ivec3 brick = r.cell >> ${Math.log2(BRICK)};
    if (brick != r.brick && float(texelFetch(uBricks, wrap(brick, uN >> ${Math.log2(BRICK)}), 0).r) + 1.0 <= uThreshold) {
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

vec3 shade(Ray r, float dist) {
  vec3 hit = r.p + r.rd * r.t;
  ivec3 nI = ivec3(r.normal);
  ivec3 u = abs(nI.x) == 1 ? ivec3(0, 1, 0) : ivec3(1, 0, 0);
  ivec3 v = abs(nI.z) == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1);
  if (abs(nI.y) == 1) { u = ivec3(1, 0, 0); v = ivec3(0, 0, 1); }
  vec3 fr = fract(hit);
  vec2 f = vec2(dot(fr, vec3(u)), dot(fr, vec3(v)));
  float ao = shadingSheet ? 1.0 : faceAO(r.cell + nI, u, v, f);

  // Voxels just above the threshold glow while it sweeps, so the growing front reads.
  float level = chaos(r.cell);
  float heat = uHeat * (1.0 - smoothstep(0.0, uGlow, margin(r.cell)));
  vec3 hot = mix(vec3(1.0, 0.93, 0.86), uAccent, smoothstep(0.0, 0.12, 1.0 - heat));
  vec3 surface = mix(albedo(r.cell, level), hot, 0.6 * heat);

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

void main() {
  // Each ray also aims its shadow at its own point on the sun disk, turned per pixel so the
  // softened edges don't band. Two rays or one cast a shadow ray each; four share them in pairs,
  // so a pixel never casts more than two.
  float turn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  mat2 spin = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));
  vec4 sum = vec4(0.0);
  for (int i = 0; i < uSamples; i++) {
    if (uSamples < 4 || i % 2 == 0) sharedSunlight = -1.0;
    vec2 offset = SAMPLES[uSamples - 1 + i];
    sum += trace(gl_FragCoord.xy + offset, spin * (uSamples == 1 ? vec2(0.5, 0.0) : offset * 2.0));
  }
  fragColor = sum / float(uSamples);
}`;

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
