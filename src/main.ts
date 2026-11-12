import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

import { chaosToLevel, levelToChaos, loadCube } from './cube/cubeFile.ts';
import { OrbitCamera } from './cube/orbitCamera.ts';
import { type ColorBy, CubeView } from './cube/view.ts';
import { CHAOS, cubeUrl, GRID, PRESETS, type Quality } from './presets.ts';
import { bindChoice, bindFilter, bindThreshold } from './ui/controls.ts';

// Playback lowers the threshold, so the cube grows from its most chaotic voxels outward, holds,
// raises it again and moves to the next preset.
const SWEEP_RATE = 8; // chaos levels per real second
const HOLD_FOR = 8; // real seconds the finished cube stays up; dragging restarts the count
const RISE_FOR = 1.8; // real seconds to clear it before the next preset
const FLOOR = 1.6; // default threshold the sweep stops at, e-folds per second
const CENTER: [number, number, number] = [0.5, 0.5, 0.5]; // default move, as a fraction of the volume
const DRIFT = [0.016, 0.01, 0.0066]; // idle move, fractions of the volume per real second
const DRIFT_AFTER = 4; // real seconds after a manual move before drifting again

type Palette = 'ember' | 'glacier' | 'aurora';
const PALETTES: Record<Palette, { ramp: [string, string, string, string]; glow: string }> = {
  ember: { ramp: ['#6a0e12', '#c8181c', '#ff7b2e', '#ffe9c6'], glow: '#e0181c' },
  glacier: { ramp: ['#1d3a72', '#2f72c8', '#6fd2f2', '#f0fbff'], glow: '#4fb4ff' },
  aurora: { ramp: ['#47207e', '#2b8590', '#86d35c', '#f6ee72'], glow: '#ff4fa8' },
};
const COLOR_BY: Record<ColorBy, true> = { plain: true, neighbours: true, chaos: true };
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
let quality: Quality = forcedQuality ?? savedQuality ?? (smallScreen ? 'low' : 'high');
let userPickedQuality = savedQuality !== null || forcedQuality !== null;
let colorBy: ColorBy = saved('colorBy', COLOR_BY) ?? 'plain';
let palette: Palette = saved('palette', PALETTES) ?? 'ember';
type Lighting = 'studio' | 'sun';
const LIGHTING: Record<Lighting, true> = { studio: true, sun: true };
const lighting: Lighting = saved('lighting', LIGHTING) ?? 'studio';
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
  glow: 3, base: '#ecebe6', accent: PLAIN_GLOW, colorBy, ramp: PALETTES[palette].ramp, sun: lighting === 'sun', edgeColor: [1, 1, 1, 0.16],
});

if (!view) {
  // No WebGL2: show the still and drop the controls that drive it.
  canvas.hidden = true;
  $('.hero__poster').hidden = false;
  $('.sim-card').hidden = true;
  hint.hidden = true;
}

// ---------- loading cubes ----------

// Unpacked cubes by URL. Holds the one on screen and the next, so cycling doesn't wait.
const cubes = new Map<string, Promise<Uint8Array>>();

function fetchCube(preset: number, q: Quality): Promise<Uint8Array> {
  const url = cubeUrl(preset, GRID[q]);
  let cube = cubes.get(url);
  if (!cube) {
    cube = loadCube(url, GRID[q]);
    cube.catch(() => cubes.delete(url));
    cubes.set(url, cube);
  }
  return cube;
}

let presetIndex = 0;
let loadToken = 0;
let loading = false;
let top = CHAOS.levels; // just above the cube's most chaotic voxel: nothing shows here

/** Loads a preset at a quality, then sweeps it in (or stays at `keep`, a threshold). */
async function show(preset: number, q: Quality, keep?: number): Promise<void> {
  if (!view) return;
  const token = ++loadToken;
  loading = true;
  try {
    const bytes = await fetchCube(preset, q);
    if (token !== loadToken) return;
    view.load(bytes, GRID[q]);
    presetIndex = preset;
    top = 0;
    for (const v of bytes) if (v > top) top = v;
    top += 1;
    countOut.textContent = (GRID[q] ** 3).toLocaleString('en-US');
    frameStats.avg = 1 / 60; // unpacking stalls a few frames; don't count that as slow drawing
    seek(reducedMotion ? floor : keep ?? top);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    statusOut.textContent = 'could not load';
    return;
  } finally {
    if (token === loadToken) loading = false;
  }
  const next = (preset + 1) % PRESETS.length;
  const keepUrls = [cubeUrl(preset, GRID[q]), cubeUrl(next, GRID[q])];
  for (const url of cubes.keys()) if (!keepUrls.includes(url)) cubes.delete(url);
  fetchCube(next, q).catch(() => {}); // warm the next one; errors surface when it's shown
}

// ---------- playback: sweep, hold, rise, next ----------

type Phase = { name: 'sweep' } | { name: 'hold'; left: number } | { name: 'rise'; left: number; from: number };
let phase: Phase = { name: 'sweep' };
let threshold = CHAOS.levels; // in levels; fractional while it moves
let paused = reducedMotion;

/** Jumps to a threshold. At or below the floor the cube is finished and holds. */
function seek(level: number): void {
  if (!view) return;
  threshold = level;
  phase = level > floor ? { name: 'sweep' } : { name: 'hold', left: HOLD_FOR };
  view.heat = level > floor ? 1 : 0;
}

function riseThenNext(): void {
  if (!view || phase.name === 'rise' || loading) return;
  setPaused(false);
  phase = { name: 'rise', left: RISE_FOR, from: threshold };
}

function advance(dt: number): void {
  if (!view || paused || loading) return;
  if (camera.dragging) {
    // Nothing animates under the pointer, and the finished cube waits for the drag to end.
    if (phase.name === 'hold') phase.left = HOLD_FOR;
    return;
  }
  if (phase.name === 'sweep') {
    threshold = Math.max(floor, threshold - dt * SWEEP_RATE);
    view.heat = 1;
    if (threshold <= floor) phase = { name: 'hold', left: HOLD_FOR };
  } else if (phase.name === 'hold') {
    view.heat = Math.max(0, view.heat - dt); // the front cools
    if (!reducedMotion && (phase.left -= dt) <= 0) riseThenNext();
  } else {
    phase.left -= dt;
    const k = Math.max(0, phase.left / RISE_FOR);
    threshold = top - (top - phase.from) * k * k; // slow start, fast finish
    view.heat = 0;
    if (phase.left <= 0) show((presetIndex + 1) % PRESETS.length, quality);
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
  samplesCap = 4; // a different grid costs differently; let adapt() judge again
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

const camera = new OrbitCamera({
  yaw: 0.72, pitch: 0.42, distance: smallScreen ? 5.6 : 4.6,
  minDistance: 2.4, maxDistance: 8, autoRotate: reducedMotion ? 0 : 0.14,
});
camera.attach(canvas);
camera.onTap = () => { if (!reducedMotion) riseThenNext(); };
canvas.addEventListener('pointerdown', () => hint.classList.add('is-gone'), { once: true });

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

// ---------- drawing ----------

// Where the cube sits: right of the cards on wide screens. Stacked, the canvas is a block of its
// own above the cards, so the cube is centred, a little low to clear the header.
const stacked = matchMedia('(max-width: 720px)');
function layout(w: number, h: number): { shift: [number, number]; focal: number } {
  const aspect = w / h;
  if (stacked.matches) return { shift: [0, -0.1], focal: 1.75 * Math.min(1, aspect / 0.9) };
  return { shift: [Math.min(aspect * 0.2, 0.42), aspect < 1.5 ? 0.4 : 0.22], focal: 1.6 * Math.min(1, aspect / 1.6) };
}

let renderScale = 1;
// Four rays per pixel stop pixel-sized voxels flashing as the volume drifts, but cost four times
// as much. Only the finished (or paused) cube gets them: while the threshold sweeps, voxels change
// every frame anyway, and few showing makes rays long.
let samplesCap: 1 | 4 = 4;
const frameStats = { avg: 1 / 60, since: 0, slowWindows: 0 };

// When frames keep running long: drop to one ray per pixel first, then lower render resolution,
// then the grid (unless someone picked one). It waits for two slow windows in a row, so a brief
// stall, or the GPU clocking up when the cube settles, doesn't count.
function adapt(dt: number): void {
  frameStats.avg += (dt - frameStats.avg) * 0.05;
  frameStats.since += dt;
  if (frameStats.since < 1.5 || loading) return;
  frameStats.since = 0;
  // Smooth motion matters more than the extra rays, so those go below 50 fps; the rest below 40.
  const supersampling = samplesCap === 4 && view?.samples === 4;
  if (frameStats.avg < (supersampling ? 1 / 50 : 1 / 40)) { frameStats.slowWindows = 0; return; }
  if (++frameStats.slowWindows < 2) return;
  frameStats.slowWindows = 0;
  if (supersampling) {
    samplesCap = 1;
  } else if (renderScale > 0.6) {
    renderScale -= 0.15;
  } else if (!userPickedQuality && quality !== 'low') {
    const order: Quality[] = ['low', 'medium', 'high', 'ultra'];
    const lower = order[order.indexOf(quality) - 1];
    selectQuality(lower);
    setQuality(lower);
    renderScale = 1;
  }
}

function draw(): void {
  if (!view) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * renderScale;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const { shift, focal } = layout(w, h);
  view.threshold = threshold;
  view.samples = paused || phase.name === 'hold' ? samplesCap : 1;
  view.offset = move.map(m => m * view.size) as typeof move;
  view.draw(camera.basis(), w, h, shift, focal);
}

function statusText(): string {
  if (loading) return 'loading';
  return `λ ≥ ${levelToChaos(Math.min(threshold, CHAOS.levels - 1)).toFixed(2)}/s`;
}

let heroVisible = true;
new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe(hero);

let last = performance.now();
let readoutClock = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view && heroVisible && !document.hidden) {
    camera.update(dt);
    advance(dt);
    drift(dt);
    draw();
    if (!reducedMotion) adapt(dt);
    setThreshold(levelToChaos(Math.min(threshold, CHAOS.levels - 1)));
    if ((readoutClock += dt) > 0.1) {
      readoutClock = 0;
      statusOut.textContent = statusText();
    }
  }
  requestAnimationFrame(frame);
}

if (view) {
  show(0, quality, query.has('c') ? floor : undefined);
  requestAnimationFrame(frame);
}
