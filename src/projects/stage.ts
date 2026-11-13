// The project panels. Each project has a rig: a flat layout of panels on a plane through the cube's
// centre, facing the camera at that project's station. The rig is transformed with the cube's own
// camera, so the panels fly in with the cube, turn with it when it is dragged, and shift against
// each other by depth. With flat set (narrow screens, no WebGL) a rig is an ordinary card.

import { type CameraBasis, orbitBasis, type V3 } from '../cube/orbitCamera.ts';
import type { ProjectContent } from './content.ts';
import type { Station } from './stations.ts';

/** Where the cube's centre is on the page and how strong the perspective is, in CSS pixels. */
export interface StageLens {
  centreX: number;
  centreY: number;
  perspective: number; // distance at which one world unit per unit of depth covers one pixel: focal · height / 2
  width: number;
  height: number;
}

interface Rig {
  el: HTMLElement;
  facing: CameraBasis; // the station's camera, which the rig faces
  distance: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class ProjectStage {
  /** Lay rigs out as plain cards instead of placing them in the cube. */
  flat = false;
  private readonly root: HTMLElement;
  private readonly rigs: Rig[];
  private active: number | null = null;
  private leaving: number | null = null;

  constructor(root: HTMLElement, projects: ProjectContent[], stations: Record<string, Station>, onClose: () => void) {
    this.root = root;
    this.rigs = projects.map(project => {
      const station = stations[project.id];
      const el = buildRig(project, onClose);
      el.inert = true;
      root.append(el);
      return { el, facing: orbitBasis(station.yaw, station.pitch, station.distance), distance: station.distance };
    });
  }

  /** Shows one project's panels (null: none). The last one stays placed while it fades out. */
  show(index: number | null): void {
    if (index === this.active) return;
    if (this.active !== null) {
      const old = this.rigs[this.active].el;
      old.classList.remove('is-active');
      old.inert = true;
      zoomShot(old, null);
    }
    this.leaving = this.active;
    this.active = index;
    if (index !== null) {
      const el = this.rigs[index].el;
      el.classList.add('is-active');
      el.inert = false;
    }
  }

  /** Places the rigs on screen for this frame's camera. */
  place(camera: CameraBasis, distance: number, lens: StageLens): void {
    const { style } = this.root;
    this.root.classList.toggle('stage--flat', this.flat);
    if (this.flat) {
      style.cssText = '';
      for (const rig of this.rigs) rig.el.style.transform = '';
      return;
    }
    // The rig box is the largest one centred on the cube that fits the stage, so a rig's own layout
    // centres on the cube.
    style.setProperty('--stage-p', `${lens.perspective.toFixed(1)}px`);
    style.setProperty('--stage-cx', `${lens.centreX.toFixed(1)}px`);
    style.setProperty('--stage-cy', `${lens.centreY.toFixed(1)}px`);
    style.setProperty('--rig-top', `${Math.max(0, 2 * lens.centreY - lens.height).toFixed(1)}px`);
    style.setProperty('--rig-bottom', `${Math.max(0, lens.height - 2 * lens.centreY).toFixed(1)}px`);
    for (const index of [this.active, this.leaving]) {
      if (index !== null) this.rigs[index].el.style.transform = rigMatrix(this.rigs[index], camera, distance, lens.perspective);
    }
  }
}

// CSS matrix taking a rig's layout (x right, y down, z towards the station's camera, one pixel per
// pixel when the camera is at the station) to the page under the current camera. The stage's CSS
// perspective is the cube's, so a point on the rig lands where the ray-cast draws that point.
function rigMatrix(rig: Rig, camera: CameraBasis, distance: number, perspective: number): string {
  const { right, up, forward } = rig.facing;
  const columns = [
    [dot(right, camera.right), -dot(right, camera.up), -dot(right, camera.forward), 0],
    [-dot(up, camera.right), dot(up, camera.up), dot(up, camera.forward), 0],
    [-dot(forward, camera.right), dot(forward, camera.up), dot(forward, camera.forward), 0],
    [0, 0, perspective * (1 - distance / rig.distance), 1],
  ];
  return `matrix3d(${columns.flat().map(v => v.toFixed(5)).join(',')})`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', 'panel__link', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** Brings one of a rig's screenshots forward, out of the bore (null: all back in place). */
function zoomShot(rig: HTMLElement, shot: HTMLElement | null): void {
  for (const other of rig.querySelectorAll<HTMLElement>('.shot')) {
    const zoomed = other === shot;
    other.classList.toggle('is-zoomed', zoomed);
    other.setAttribute('aria-pressed', String(zoomed));
  }
}

function buildRig(project: ProjectContent, onClose: () => void): HTMLElement {
  const rig = el('article', 'rig');
  rig.id = `project-${project.id}`;
  rig.setAttribute('aria-label', project.name);

  const about = el('div', 'panel panel--about');
  const close = el('button', 'icon-btn panel__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close project');
  close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.1 3 8 6.9 11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z" /></svg>';
  close.addEventListener('click', onClose);
  const meta = [project.year, project.stars ? `${project.stars} GitHub stars` : ''].filter(Boolean).join(' · ');
  const links = el('p', 'panel__links');
  links.append(link(project.repo, 'GitHub'));
  if (project.live) links.append(link(project.live, 'Live site'));
  about.append(
    close,
    el('p', 'panel__meta mono', meta),
    el('h2', 'panel__name', project.name),
    el('p', 'panel__tagline', project.tagline),
    el('p', 'panel__summary', project.summary),
    links,
  );

  const shots = el('div', 'rig__shots');
  for (const image of project.images) {
    // A button, so a click or Enter brings the screenshot forward to read it, and again puts it back.
    const shot = el('button', 'shot');
    shot.type = 'button';
    shot.setAttribute('aria-pressed', 'false');
    const img = el('img', '');
    Object.assign(img, { src: image.src, alt: image.alt, width: image.width, height: image.height, loading: 'lazy', draggable: false });
    shot.append(img);
    shot.addEventListener('click', () => zoomShot(rig, shot.classList.contains('is-zoomed') ? null : shot));
    shots.append(shot);
  }

  const facts = el('div', 'panel panel--facts');
  const highlights = el('ul', 'panel__highlights');
  for (const item of project.highlights) highlights.append(el('li', '', item));
  const stack = el('ul', 'panel__stack mono');
  for (const item of project.stack) stack.append(el('li', '', item));
  facts.append(highlights, stack);

  rig.append(about, shots, facts);
  return rig;
}
