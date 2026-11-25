// Orbit camera around the origin: drag to rotate (with inertia), pinch or ctrl+wheel to zoom.
// With panMode (or shift held, which swaps), and with two fingers, drags go to onPan instead. Plain wheel is left alone so the
// page still scrolls over the canvas. The camera also leans a little toward the cursor, and a
// press that doesn't move counts as a tap.
//
// Presses can start on things laid over the canvas (the project screenshots), so a drag across
// one still turns the cube; `grabs` picks which. A press there that doesn't move stays theirs: it
// clicks them, and isn't a tap.

export type V3 = [number, number, number];

export interface CameraBasis {
  eye: V3;
  right: V3;
  up: V3;
  forward: V3;
}

export interface OrbitOptions {
  yaw: number;
  pitch: number;
  distance: number;
  minDistance: number;
  maxDistance: number;
  autoRotate: number; // radians per second while idle
}

export class OrbitCamera {
  yaw: number;
  pitch: number;
  distance: number;
  autoRotate: number;
  private readonly opts: OrbitOptions;
  private velocity = 0;
  private spin = 0; // current idle rotation, radians per second; works up to autoRotate
  private lastInput = -Infinity;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchDistance = 0;
  private lean = { x: 0, y: 0, tx: 0, ty: 0 };
  private pressMoved = 0;
  private pressTurned = false;
  private pressOnCanvas = false;
  private releasedAt = -Infinity;
  onTap: (() => void) | null = null;
  /** Called with pointer movement in CSS pixels for pan drags. */
  onPan: ((dx: number, dy: number) => void) | null = null;
  /** One-pointer drags pan instead of rotate (shift swaps). */
  panMode = false;

  constructor(opts: OrbitOptions) {
    this.opts = opts;
    this.yaw = opts.yaw;
    this.pitch = opts.pitch;
    this.distance = opts.distance;
    this.autoRotate = opts.autoRotate;
  }

  /** Listens for presses on `surface` that `grabs` says are the camera's, and leans toward the
   * mouse over `canvas`. */
  attach(canvas: HTMLElement, surface: HTMLElement, grabs: (target: Element) => boolean): void {
    surface.addEventListener('pointerdown', e => {
      if (!(e.target instanceof Element) || !grabs(e.target)) return;
      // Captured by what was pressed, so a drag off the page still ends, and a press that started
      // on a screenshot still clicks it.
      e.target.setPointerCapture(e.pointerId);
      this.pressOnCanvas = e.target === canvas;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this.pinchStart = this.spread();
        this.pinchDistance = this.distance;
      }
      this.velocity = 0;
      this.pressMoved = 0;
      this.pressTurned = false;
      this.lastInput = performance.now();
    });
    // The lean follows the mouse anywhere over the canvas, including over the project panels and
    // screenshots laid on top of it, which take its pointer events.
    document.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      const over = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      this.lean.tx = over ? x * 2 - 1 : 0;
      this.lean.ty = over ? y * 2 - 1 : 0;
    });
    document.documentElement.addEventListener('pointerleave', () => { this.lean.tx = 0; this.lean.ty = 0; });
    surface.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pressMoved += Math.abs(dx) + Math.abs(dy);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this.zoomTo(this.pinchDistance * (this.pinchStart / Math.max(1, this.spread())));
        this.onPan?.(dx / 2, dy / 2); // each finger moves the centre by half its own movement
      } else if (this.onPan && e.shiftKey !== this.panMode) {
        this.onPan(dx, dy);
      } else {
        this.yaw -= dx * 0.006;
        this.velocity = -dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.35, 1.35);
        this.pressTurned = true;
      }
      this.lastInput = performance.now();
    });
    surface.addEventListener('pointerup', e => {
      if (!this.pointers.has(e.pointerId)) return;
      const wasSingle = this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      this.releasedAt = performance.now();
      if (wasSingle && this.pressMoved < 6 && this.pressOnCanvas) this.onTap?.();
    });
    surface.addEventListener('pointercancel', e => this.pointers.delete(e.pointerId));
    canvas.addEventListener('wheel', e => {
      if (!e.ctrlKey) return; // trackpad pinch arrives as ctrl+wheel
      e.preventDefault();
      this.zoomTo(this.distance * Math.exp(e.deltaY * 0.01));
      this.lastInput = performance.now();
    }, { passive: false });
  }

  /** Whether a press just ended in a drag, so the click that follows it isn't one. */
  get justDragged(): boolean {
    return this.pressMoved >= 6 && performance.now() - this.releasedAt < 300;
  }

  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  /** A drag is turning the camera, or it is still spinning from one. Auto-rotate doesn't count. */
  get turning(): boolean {
    return (this.dragging && this.pressTurned) || Math.abs(this.velocity) > 0.0005;
  }

  update(dt: number): void {
    const k = 1 - Math.pow(0.02, dt); // ease toward the cursor over about a second
    this.lean.x = settle(this.lean.x + (this.lean.tx - this.lean.x) * k, this.lean.tx, LEAN_EPSILON);
    this.lean.y = settle(this.lean.y + (this.lean.ty - this.lean.y) * k, this.lean.ty, LEAN_EPSILON);
    if (this.dragging) return;
    this.yaw += this.velocity;
    this.velocity = settle(this.velocity * Math.pow(0.04, dt), 0, SPIN_EPSILON); // inertia fades in about a second
    // Idle, the spin builds up to autoRotate over about two seconds instead of starting at full speed.
    const idle = performance.now() - this.lastInput > 1500;
    this.spin = idle ? Math.min(this.autoRotate, this.spin + (this.autoRotate / 2) * dt) : 0;
    this.yaw += this.spin * dt;
  }

  basis(): CameraBasis {
    return orbitBasis(this.yaw - this.lean.x * 0.18, clamp(this.pitch + this.lean.y * 0.12, -1.35, 1.35), this.distance);
  }

  /** Drops any spin left over from the last drag, and the idle spin, which builds up again. */
  stop(): void {
    this.velocity = 0;
    this.spin = 0;
  }

  private zoomTo(d: number): void {
    this.distance = clamp(d, this.opts.minDistance, this.opts.maxDistance);
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

/** The camera looking at the origin from a yaw and pitch, a distance away. */
export function orbitBasis(yaw: number, pitch: number, distance: number): CameraBasis {
  const cp = Math.cos(pitch);
  const eye: V3 = [distance * cp * Math.sin(yaw), distance * Math.sin(pitch), distance * cp * Math.cos(yaw)];
  const forward = normalize([-eye[0], -eye[1], -eye[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { eye, right, up, forward };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Easing never quite arrives, so the camera would keep moving by invisible amounts for seconds,
// and the cube only stops casting rays once nothing moves (see freeze.ts). Within
// these the lean and the leftover spin snap to where they're heading: a lean of 1e-4 is 2e-5 rad of
// camera turn, a few hundredths of a pixel.
const LEAN_EPSILON = 1e-4;
const SPIN_EPSILON = 1e-6; // radians per frame
const settle = (v: number, goal: number, epsilon: number) => (Math.abs(v - goal) < epsilon ? goal : v);
function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
