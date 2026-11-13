import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

import { chaosToLevel, levelToChaos } from './cube/cubeFile.ts';
import { Flight, type Pose } from './cube/flight.ts';
import { OrbitCamera, orbitBasis } from './cube/orbitCamera.ts';
import { type Cube, unpackCube } from './cube/unpack.ts';
import { type ColorBy, CubeView, type Samples } from './cube/view.ts';
import { CHAOS, cubeUrl, GRID, PRESETS, type Quality } from './presets.ts';
import { PROJECTS } from './projects/content.ts';
import { ProjectStage } from './projects/stage.ts';
import { STATIONS, type Station } from './projects/stations.ts';
import { buildTabs } from './projects/tabs.ts';
import { bindChoice, bindDisclosure, bindFilter, bindThreshold } from './ui/controls.ts';
import { Loader } from './ui/loader.ts';

// Playback lowers the threshold, so the cube grows from its most chaotic voxels outward, holds,
// raises it again and moves to the next preset.
const SWEEP_RATE = 8; // chaos levels per real second
const HOLD_FOR = 8; // real seconds the finished cube stays up; dragging restarts the count
const RISE_FOR = 1.8; // real seconds to clear it before the next preset
const FLOOR = 1.6; // default threshold the sweep stops at, e-folds per second
const CENTER: [number, number, number] = [0.5, 0.5, 0.5]; // default move, as a fraction of the volume
const DRIFT = [0.016, 0.01, 0.0066]; // idle move, fractions of the volume per real second
const DRIFT_AFTER = 4; // real seconds after a manual move before drifting again
// A project tab flies the cube to that project's station: its preset, part of the volume, threshold
// and camera, with a bore cut towards the viewer for the project's panels.
const FLY_FOR = 1.7; // real seconds a flight takes
const TOUR_SWEEP_RATE = 22; // chaos levels per real second on the way to a station
const TOUR_RISE_FOR = 0.6; // real seconds to clear the cube when a station needs another preset
const BORE = 0.6; // the bore's radius at a station, where the box spans -1..1
const HOME = { pitch: 0.42, autoRotate: 0.14 };

type Palette = 'ember' | 'glacier' | 'aurora';
const PALETTES: Record<Palette, { ramp: [string, string, string, string]; glow: string }> = {
  ember: { ramp: ['#6a0e12', '#c8181c', '#ff7b2e', '#ffe9c6'], glow: '#e0181c' },
  glacier: { ramp: ['#1d3a72', '#2f72c8', '#6fd2f2', '#f0fbff'], glow: '#4fb4ff' },
  aurora: { ramp: ['#47207e', '#2b8590', '#86d35c', '#f6ee72'], glow: '#ff4fa8' },
};
const COLOR_BY: Record<ColorBy, true> = { plain: true, neighbours: true, chaos: true, both: true };
const PLAIN_GLOW = '#e0181c';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const smallScreen = matchMedia('(pointer: coarse)').matches || innerWidth < 640;

// A stored choice, if it's still one of the options.
function saved<T extends string>(key: string, options: Record<T, unknown>): T | null {
  const value = localStorage.getItem(key);
  return value !== null && value in options ? (value as T) : null;
}

// ?q=low picks a quality for this visit and ?c=2.1 sets the threshold (handy for sharing and testing).
const query = new URLSearchParams(location.search);
const queryQuality = query.get('q');
const forcedQuality = queryQuality !== null && queryQuality in GRID ? (queryQuality as Quality) : null;
const savedQuality = saved('quality', GRID);
let quality: Quality = forcedQuality ?? savedQuality ?? (smallScreen ? 'low' : 'ultra'); // phones: Ultra is ~20 MB a preset
let userPickedQuality = savedQuality !== null || forcedQuality !== null;
let colorBy: ColorBy = saved('colorBy', COLOR_BY) ?? 'both';
let palette: Palette = saved('palette', PALETTES) ?? 'glacier';
type Lighting = 'studio' | 'sun';
const LIGHTING: Record<Lighting, true> = { studio: true, sun: true };
const lighting: Lighting = saved('lighting', LIGHTING) ?? 'sun';
const queryChaos = Number(query.get('c'));
let floor = chaosToLevel(query.has('c') && queryChaos >= 0 ? Math.min(queryChaos, CHAOS.max) : FLOOR);

const hero = $('.hero');
const canvas = $<HTMLCanvasElement>('.hero__canvas');
const hint = $('#sim-hint');
const statusOut = $('#sim-status');
const countOut = $('#sim-count');
const pauseBtn = $<HTMLButtonElement>('#sim-pause');
const recenterBtn = $<HTMLButtonElement>('#sim-recenter');
type DragMode = 'rotate' | 'move';

const view = CubeView.create(canvas, {
  glow: 1.5, base: '#ecebe6', accent: PLAIN_GLOW, colorBy, ramp: PALETTES[palette].ramp, sun: lighting === 'sun', edgeColor: [1, 1, 1, 0.16],
});

const loader = new Loader($('#loader'));
if (!view) {
  // No WebGL2: show the still and drop the controls that drive it.
  loader.active = false;
  $('#loader').hidden = true;
  canvas.hidden = true;
  $('.hero__poster').hidden = false;
  $('.sim-card').hidden = true;
  hint.hidden = true;
}

// ---------- loading cubes ----------

// Unpacked cubes by URL. Holds the one on screen and the next, so cycling doesn't wait.
const cubes = new Map<string, Promise<Cube>>();

function fetchCube(preset: number, q: Quality, onProgress?: (loaded: number, total: number) => void): Promise<Cube> {
  const url = cubeUrl(preset, GRID[q]);
  let cube = cubes.get(url);
  if (!cube) {
    cube = unpackCube(url, GRID[q], onProgress);
    cube.catch(() => cubes.delete(url));
    cubes.set(url, cube);
  }
  return cube;
}

let presetIndex = 0; // the preset on screen
let wantedPreset = 0; // the one asked for last, which may still be loading
let loadToken = 0;
let loading = false;
let top = CHAOS.levels; // just above the cube's most chaotic voxel: nothing shows here

/** Loads a preset at a quality, then sweeps it in (or stays at `keep`, a threshold). */
async function show(preset: number, q: Quality, keep?: number): Promise<void> {
  if (!view) return;
  const token = ++loadToken;
  wantedPreset = preset;
  loading = true;
  // The load bar is for the first cube, while there's nothing on screen yet.
  const first = loader.active;
  try {
    const cube = await fetchCube(preset, q, first ? (loaded, total) => loader.download(loaded, total) : undefined);
    if (token !== loadToken) return;
    await view.load(cube.bytes, GRID[q]);
    if (token !== loadToken) return;
    presetIndex = preset;
    top = cube.top + 1;
    countOut.textContent = (GRID[q] ** 3).toLocaleString('en-US');
    resetFrameStats(); // loading stalls a few frames; don't count that as slow drawing
    if (first) loader.done();
    seek(reducedMotion ? target() : keep ?? top);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    statusOut.textContent = 'could not load';
    if (first) loader.fail();
    return;
  } finally {
    if (token === loadToken) loading = false;
  }
  const next = (preset + 1) % PRESETS.length;
  const keepUrls = [cubeUrl(preset, GRID[q]), cubeUrl(next, GRID[q])];
  for (const url of cubes.keys()) if (!keepUrls.includes(url)) cubes.delete(url);
  // Warm the next one, unless a project holds this one up; errors surface when it's shown.
  if (projectIndex === null) fetchCube(next, q).catch(() => {});
}

// ---------- playback: sweep, hold, rise, next ----------

// The open project, as an index into PROJECTS (null: none, and the cubes play in turn).
let projectIndex: number | null = null;
const station = (): Station | null => (projectIndex === null ? null : STATIONS[PROJECTS[projectIndex].id]);
/** The threshold the cube settles at: the open project's, or the floor. */
function target(): number {
  const at = station();
  return at ? chaosToLevel(at.lambda) : floor;
}

type Phase =
  | { name: 'sweep' }
  | { name: 'hold'; left: number }
  | { name: 'rise'; left: number; over: number; from: number; next: number };
let phase: Phase = { name: 'sweep' };
let threshold = CHAOS.levels; // in levels; fractional while it moves
let paused = reducedMotion;

/** Jumps to a threshold. At the target the cube is finished and holds. */
function seek(level: number): void {
  if (!view) return;
  threshold = level;
  phase = level === target() ? { name: 'hold', left: HOLD_FOR } : { name: 'sweep' };
  view.heat = level === target() ? 0 : 1;
}

/** Clears the cube, then shows another preset. */
function riseThenShow(next: number, over: number): void {
  if (!view) return;
  if (loading || threshold >= top) { show(next, quality); return; } // nothing on screen to clear
  phase = { name: 'rise', left: over, over, from: threshold, next };
}

function riseThenNext(): void {
  if (!view || phase.name === 'rise' || loading || projectIndex !== null) return;
  setPaused(false);
  riseThenShow((presetIndex + 1) % PRESETS.length, RISE_FOR);
}

function advance(dt: number): void {
  if (!view || paused || loading) return;
  if (camera.dragging) {
    // Nothing animates under the pointer, and the finished cube waits for the drag to end.
    if (phase.name === 'hold') phase.left = HOLD_FOR;
    return;
  }
  if (phase.name === 'sweep') {
    // Down to the target as the cube grows; up to it when a station shows less than is on screen.
    const reach = dt * (projectIndex === null ? SWEEP_RATE : TOUR_SWEEP_RATE);
    const goal = target();
    threshold += Math.min(reach, Math.max(-reach, goal - threshold));
    view.heat = 1;
    if (threshold === goal) phase = { name: 'hold', left: HOLD_FOR };
  } else if (phase.name === 'hold') {
    view.heat = Math.max(0, view.heat - dt * 3); // the front cools in a third of a second
    if (!reducedMotion && projectIndex === null && (phase.left -= dt) <= 0) riseThenNext();
  } else {
    phase.left -= dt;
    const k = Math.max(0, phase.left / phase.over);
    threshold = top - (top - phase.from) * k * k; // slow start, fast finish
    view.heat = 0;
    if (phase.left <= 0) show(phase.next, quality);
  }
}

// ---------- controls ----------

function setPaused(value: boolean): void {
  paused = value;
  pauseBtn.setAttribute('aria-pressed', String(value));
  pauseBtn.setAttribute('aria-label', `${value ? 'Play' : 'Pause'} simulation`);
}
setPaused(paused);
pauseBtn.addEventListener('click', () => setPaused(!paused));
$('#sim-regrow').addEventListener('click', () => riseThenNext());

// Dragging the threshold pauses there and makes it where later sweeps stop.
const setThreshold = bindThreshold(CHAOS.max, lambda => {
  if (!view || loading) return;
  setPaused(true);
  floor = chaosToLevel(lambda);
  seek(floor);
});

const selectQuality = bindChoice<Quality>('quality', quality, q => {
  userPickedQuality = true;
  localStorage.setItem('quality', q);
  setQuality(q);
});

function setQuality(q: Quality): void {
  quality = q;
  if (rays === 'auto') samplesCap = autoRays(); // a different grid costs differently; let adapt() judge again
  show(presetIndex, q, phase.name === 'rise' ? undefined : threshold); // keep the threshold
}

function applyColors(): void {
  paletteField.disabled = colorBy === 'plain';
  if (!view) return;
  view.opts.colorBy = colorBy;
  view.opts.ramp = PALETTES[palette].ramp;
  view.opts.accent = colorBy === 'plain' ? PLAIN_GLOW : PALETTES[palette].glow;
}
const paletteField = $<HTMLFieldSetElement>('#palette');
bindChoice<ColorBy>('color-by', colorBy, c => { colorBy = c; localStorage.setItem('colorBy', c); applyColors(); });
bindChoice<Palette>('palette', palette, p => { palette = p; localStorage.setItem('palette', p); applyColors(); });
applyColors();

bindChoice<Lighting>('lighting', lighting, l => {
  localStorage.setItem('lighting', l);
  if (view) view.opts.sun = l === 'sun';
});

bindFilter(k => view?.setFilter(k));

// The frame rate, in the readout, when switched on in the settings.
const fpsWrap = $('#sim-fps-wrap');
const fpsOut = $('#sim-fps');
const showFps = $<HTMLInputElement>('#show-fps');
showFps.checked = localStorage.getItem('showFps') === 'true';
fpsWrap.hidden = !showFps.checked;
showFps.addEventListener('change', () => {
  fpsWrap.hidden = !showFps.checked;
  localStorage.setItem('showFps', String(showFps.checked));
});
bindDisclosure('sim-settings-toggle', 'settings');

const homeDistance = smallScreen ? 5.6 : 4.1;
const camera = new OrbitCamera({
  yaw: 0.72, pitch: HOME.pitch, distance: homeDistance,
  minDistance: 2, maxDistance: 8, autoRotate: reducedMotion ? 0 : HOME.autoRotate,
});
camera.attach(canvas);
camera.onTap = () => { if (!reducedMotion) riseThenNext(); };

// Moving the volume: in Move mode a drag slides it in the screen plane (shift swaps modes, two
// fingers always move). It wraps around, and drifts slowly while nobody touches it.
let move: [number, number, number] = [...CENTER]; // fraction of the volume per axis
let lastMove = -Infinity; // performance.now() of the last manual move
camera.onPan = (dx, dy) => {
  const { right, up } = camera.basis();
  const { focal } = layout(canvas.clientWidth, canvas.clientHeight);
  const perPx = (2 * camera.distance) / (canvas.clientHeight * focal); // world units at the cube's centre
  // The box spans 2 world units; the data under it moves the opposite way to the content.
  move = move.map((m, i) => m - ((right[i] * dx - up[i] * dy) * perPx) / 2) as typeof move;
  lastMove = performance.now();
};
recenterBtn.addEventListener('click', () => { move = [...CENTER]; lastMove = performance.now(); });

function drift(dt: number): void {
  if (projectIndex !== null || flight) return; // a station is one part of the volume, so it stays put
  if (reducedMotion || paused || camera.dragging || performance.now() - lastMove < DRIFT_AFTER * 1000) return;
  move = move.map((m, i) => m + DRIFT[i] * dt) as typeof move;
}

// The cursor shows what a drag will do; holding shift swaps it.
let dragMode: DragMode = 'rotate';
const showDragMode = (shift: boolean) => canvas.classList.toggle('is-move', (dragMode === 'move') !== shift);
bindChoice<DragMode>('drag', dragMode, m => {
  dragMode = m;
  camera.panMode = m === 'move';
  showDragMode(false);
});
addEventListener('keydown', e => { if (e.key === 'Shift') showDragMode(true); });
addEventListener('keyup', e => { if (e.key === 'Shift') showDragMode(false); });
addEventListener('blur', () => showDragMode(false));

// ---------- projects ----------

let flight: Flight | null = null;
let tour = 0; // 0 at home, 1 parked at a station; in between while flying
let boreAxis: [number, number, number] = [0, 0, 1];

function currentPose(): Pose {
  return { yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance, move, axis: boreAxis, tour };
}

function applyPose(pose: Pose): void {
  camera.yaw = pose.yaw;
  camera.pitch = pose.pitch;
  camera.distance = pose.distance;
  move = pose.move;
  boreAxis = pose.axis;
  tour = pose.tour;
}

/** The pose parked at a station. The bore points at the camera. */
function stationPose(at: Station): Pose {
  const { forward } = orbitBasis(at.yaw, at.pitch, at.distance);
  return { yaw: at.yaw, pitch: at.pitch, distance: at.distance, move: at.move, axis: [-forward[0], -forward[1], -forward[2]], tour: 1 };
}

/** Back out to the whole cube, facing the way the camera already does. */
function homePose(): Pose {
  return { ...currentPose(), pitch: HOME.pitch, distance: homeDistance, tour: 0 };
}

const stage = new ProjectStage($('#stage'), PROJECTS, STATIONS, () => openProject(null));
const selectTab = buildTabs($('#project-tabs'), PROJECTS, index => openProject(index));

/** Opens a project (null: back to the whole cube): flies there, or jumps with `instant`. */
function openProject(index: number | null, instant = false): void {
  if (index === projectIndex) return;
  projectIndex = index;
  selectTab(index);
  stage.show(index);
  hero.classList.toggle('is-touring', index !== null);
  history.replaceState(null, '', index === null ? location.pathname + location.search : `#${PROJECTS[index].id}`);
  if (!view) return;

  const at = station();
  camera.stop();
  camera.autoRotate = at || reducedMotion ? 0 : HOME.autoRotate;
  lastMove = performance.now();
  const to = at ? stationPose(at) : homePose();
  if (instant || reducedMotion) { applyPose(to); flight = null; } else flight = new Flight(currentPose(), to, FLY_FOR);
  if (instant) return; // the caller shows the cube

  const otherPreset = at !== null && at.preset !== wantedPreset;
  if (reducedMotion) {
    if (otherPreset) show(at.preset, quality);
    else if (!loading) seek(target());
    return;
  }
  setPaused(false);
  if (otherPreset) riseThenShow(at.preset, TOUR_RISE_FOR);
  // Sweep to the new target. A cube clearing for the next preset keeps clearing on the way home,
  // but stays for a station that wants it.
  else if (!loading && (phase.name !== 'rise' || at)) phase = { name: 'sweep' };
}

addEventListener('keydown', e => {
  if (projectIndex === null || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape') openProject(null);
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (step && !(e.target instanceof HTMLInputElement)) openProject((projectIndex + step + PROJECTS.length) % PROJECTS.length);
});

// ---------- drawing ----------

// Where the cube sits: centred across wide screens, a little high to clear the cards. Stacked, the
// canvas is a block of its own above the cards, so the cube is centred, a little low to clear the
// header.
const stacked = matchMedia('(max-width: 720px)');
const TOUR_SHIFT = -0.07; // at a station the cards are gone, so the cube sits in the middle of what the header leaves
function layout(w: number, h: number): { shift: [number, number]; focal: number } {
  const aspect = w / h;
  if (stacked.matches) return { shift: [0, -0.1], focal: 1.75 * Math.min(1, aspect / 0.9) };
  const home = aspect < 1.5 ? 0.2 : 0.12;
  return { shift: [0, home + (TOUR_SHIFT - home) * tour], focal: 1.6 * Math.min(1, aspect / 1.6) };
}

type Rays = 'auto' | '1' | '2' | '4';
type Resolution = 'auto' | '50' | '75' | '100';
let rays: Rays = saved<Rays>('rays', { auto: true, 1: true, 2: true, 4: true }) ?? 'auto';
let resolution: Resolution = saved<Resolution>('resolution', { auto: true, 50: true, 75: true, 100: true }) ?? 'auto';
let renderScale = resolution === 'auto' ? 1 : Number(resolution) / 100;
// Several rays per pixel stop pixel-sized voxels flashing as the volume drifts, but each costs
// another full trace. Only the finished (or paused) cube gets them: while the threshold sweeps,
// voxels change every frame anyway, and few showing makes rays long.
//
// The still cube also accumulates its rays over frames (Temporal AA, see accumulate.ts), at about
// a tenth more than the cost of its rays. Measured against a 64-ray image, one ray accumulated comes
// out about as close as four rays without it, and two accumulated a little closer, so Auto starts
// there.
const temporalSwitch = $<HTMLInputElement>('#temporal-aa');
temporalSwitch.checked = localStorage.getItem('temporalAA') !== 'false';
temporalSwitch.disabled = !view?.canAccumulate;
const temporal = () => temporalSwitch.checked && !!view?.canAccumulate;
const autoRays = (): Samples => (temporal() ? 2 : 4);
let samplesCap: Samples = rays === 'auto' ? autoRays() : (Number(rays) as Samples);
temporalSwitch.addEventListener('change', () => {
  localStorage.setItem('temporalAA', String(temporalSwitch.checked));
  if (rays === 'auto') samplesCap = autoRays();
  resetFrameStats();
});

// Frame times since the ray count last changed, judged in windows by their median, so a single
// stall doesn't count. `skip` is in seconds.
const frameStats = { samples: 0, skip: 0, times: [] as number[], slowWindows: 0 };
function resetFrameStats(): void { frameStats.samples = 0; }

// Rays per pixel and render resolution: fixed, or left to adapt().
bindChoice<Rays>('rays', rays, r => {
  rays = r;
  localStorage.setItem('rays', r);
  samplesCap = r === 'auto' ? autoRays() : (Number(r) as Samples);
  resetFrameStats();
});
bindChoice<Resolution>('resolution', resolution, r => {
  resolution = r;
  localStorage.setItem('resolution', r);
  renderScale = r === 'auto' ? 1 : Number(r) / 100;
  resetFrameStats();
});

// When frames run long: fewer rays per pixel first, then lower render resolution, then the grid,
// each only where the settings leave it on Auto. Smooth motion matters more than the extra rays, so those go as soon
// as a third of a second runs below 50 fps, and all at once below 25 fps: at a station, where the
// rays are long, extra rays can take frames past 100 ms, and going down one step per 20 of those
// frames lagged for seconds. The rest wait for two windows of 1.5 s below 40 fps, so the GPU
// clocking up when the cube settles doesn't count.
function adapt(dt: number): void {
  if (!view || loading) return;
  if (view.samples !== frameStats.samples) {
    // The frame the ray count changes on, and the next tenth of a second while the GPU clocks up,
    // don't count.
    Object.assign(frameStats, { samples: view.samples, skip: 0.1, times: [], slowWindows: 0 });
    return;
  }
  if (frameStats.skip > 0) { frameStats.skip -= dt; return; }
  const supersampling = view.samples > 1;
  frameStats.times.push(dt);
  const count = frameStats.times.length;
  // Extra rays are judged over 20 frames or a third of a second (at least 3 frames), whichever
  // comes first.
  const windowDone = supersampling
    ? count >= 20 || (count >= 3 && frameStats.times.reduce((sum, t) => sum + t, 0) >= 1 / 3)
    : count >= 90;
  if (!windowDone) return;
  const median = frameStats.times.sort((a, b) => a - b)[frameStats.times.length >> 1];
  frameStats.times = [];
  if (supersampling) {
    if (rays !== 'auto') return; // picked in the settings: keep it
    if (median > 1 / 25) samplesCap = 1;
    else if (median > 1 / 50) samplesCap = view.samples === 4 ? 2 : 1;
    return;
  }
  if (median <= 1 / 40) { frameStats.slowWindows = 0; return; }
  if (++frameStats.slowWindows < 2) return;
  frameStats.slowWindows = 0;
  if (resolution === 'auto' && renderScale > 0.6) {
    renderScale -= 0.15;
  } else if (!userPickedQuality && quality !== 'low') {
    const order: Quality[] = ['low', 'medium', 'high', 'ultra'];
    const lower = order[order.indexOf(quality) - 1];
    selectQuality(lower);
    setQuality(lower);
    if (resolution === 'auto') renderScale = 1;
  }
}

function draw(): void {
  if (!view) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * renderScale;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const { shift, focal } = layout(w, h);
  view.threshold = threshold;
  const still = (paused || phase.name === 'hold') && !flight;
  view.samples = still ? samplesCap : 1;
  view.accumulate = still && temporal();
  view.offset = move.map(m => m * view.size) as typeof move;
  view.carve = [...boreAxis, BORE * tour];
  view.draw(camera.basis(), w, h, shift, focal);
}

/** Puts the project panels where this frame's camera sees them. */
function placeStage(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const { shift, focal } = layout(w, h);
  stage.flat = !view || stacked.matches;
  stage.place(camera.basis(), camera.distance, {
    centreX: w / 2 + (shift[0] * h) / 2, centreY: h / 2 - (shift[1] * h) / 2, perspective: (focal * h) / 2, width: w, height: h,
  }, camera.turning);
}

function statusText(): string {
  if (loading) return 'loading';
  return `λ ≥ ${levelToChaos(Math.min(threshold, CHAOS.levels - 1)).toFixed(2)}/s`;
}

let heroVisible = true;
new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe(hero);

let last = performance.now();
let readoutClock = 0;
const fpsCount = { frames: 0, since: performance.now() };
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // Averaged over half a second, so the number is readable.
  fpsCount.frames++;
  if (now - fpsCount.since >= 500) {
    if (!fpsWrap.hidden) fpsOut.textContent = String(Math.round((fpsCount.frames * 1000) / (now - fpsCount.since)));
    fpsCount.frames = 0;
    fpsCount.since = now;
  }
  if (view && heroVisible && !document.hidden) {
    camera.update(dt);
    if (flight) {
      applyPose(flight.step(dt));
      if (flight.done) flight = null;
    }
    advance(dt);
    if (loader.active) {
      const onGpu = view.loadProgress;
      if (onGpu !== null) loader.upload(onGpu);
    }
    drift(dt);
    draw();
    placeStage();
    if (!reducedMotion) adapt(dt);
    setThreshold(levelToChaos(Math.min(threshold, CHAOS.levels - 1)));
    if ((readoutClock += dt) > 0.1) {
      readoutClock = 0;
      statusOut.textContent = statusText();
    }
  }
  requestAnimationFrame(frame);
}

// A link to #<project id> opens on that project.
const linkedProject = () => PROJECTS.findIndex(project => `#${project.id}` === location.hash);
const linked = linkedProject();
if (linked >= 0) openProject(linked, true);
addEventListener('hashchange', () => { if (linkedProject() >= 0) openProject(linkedProject()); });
placeStage();

if (view) {
  show(station()?.preset ?? 0, quality, query.has('c') && linked < 0 ? floor : undefined);
  requestAnimationFrame(frame);
}
