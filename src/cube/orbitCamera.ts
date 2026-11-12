// Orbit camera around the origin: drag to rotate (with inertia), pinch or ctrl+wheel to zoom.
// With panMode (or shift held, which swaps), and with two fingers, drags go to onPan instead. Plain wheel is left alone so the
// page still scrolls over the canvas. The camera also leans a little toward the cursor, and a
// press that doesn't move counts as a tap.

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
  private lastInput = -Infinity;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchDistance = 0;
  private lean = { x: 0, y: 0, tx: 0, ty: 0 };
  private pressMoved = 0;
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

  attach(el: HTMLElement): void {
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this.pinchStart = this.spread();
        this.pinchDistance = this.distance;
      }
      this.velocity = 0;
      this.pressMoved = 0;
      this.lastInput = performance.now();
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') {
        const r = el.getBoundingClientRect();
        this.lean.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.lean.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      }
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
      }
      this.lastInput = performance.now();
    });
    el.addEventListener('pointerup', e => {
      const wasSingle = this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (wasSingle && this.pressMoved < 6) this.onTap?.();
    });
    el.addEventListener('pointercancel', e => this.pointers.delete(e.pointerId));
    el.addEventListener('pointerleave', () => { this.lean.tx = 0; this.lean.ty = 0; });
    el.addEventListener('wheel', e => {
      if (!e.ctrlKey) return; // trackpad pinch arrives as ctrl+wheel
      e.preventDefault();
      this.zoomTo(this.distance * Math.exp(e.deltaY * 0.01));
      this.lastInput = performance.now();
    }, { passive: false });
  }

  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  update(dt: number): void {
    const k = 1 - Math.pow(0.02, dt); // ease toward the cursor over about a second
    this.lean.x += (this.lean.tx - this.lean.x) * k;
    this.lean.y += (this.lean.ty - this.lean.y) * k;
    if (this.dragging) return;
    this.yaw += this.velocity;
    this.velocity *= Math.pow(0.04, dt); // inertia fades in about a second
    const idle = performance.now() - this.lastInput > 1500;
    if (idle) this.yaw += this.autoRotate * dt;
  }

  basis(): CameraBasis {
    const yaw = this.yaw - this.lean.x * 0.18;
    const pitch = clamp(this.pitch + this.lean.y * 0.12, -1.35, 1.35);
    const cp = Math.cos(pitch);
    const eye: V3 = [this.distance * cp * Math.sin(yaw), this.distance * Math.sin(pitch), this.distance * cp * Math.cos(yaw)];
    const forward = normalize([-eye[0], -eye[1], -eye[2]]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    return { eye, right, up, forward };
  }

  private zoomTo(d: number): void {
    this.distance = clamp(d, this.opts.minDistance, this.opts.maxDistance);
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
