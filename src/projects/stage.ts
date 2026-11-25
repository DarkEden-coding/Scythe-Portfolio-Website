// The project panels. Each project has a rig: a flat layout of panels on a plane through the cube's
// centre, facing the camera at that project's station. The rig is transformed with the cube's own
// camera, so the panels fly in with the cube, turn with it when it is dragged, and shift against
// each other by depth. With flat set (no WebGL) a rig is an ordinary card.

import { type CameraBasis, orbitBasis, type V3 } from '../cube/orbitCamera.ts';
import { el, externalLink } from '../ui/dom.ts';
import { pageLink } from './pageLink.ts';
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

  /** `onStep` gets -1 or 1 when a rig's previous or next button is pressed (shown on phones, which
   * have no tabs). */
  constructor(root: HTMLElement, projects: ProjectContent[], stations: Record<string, Station>, onClose: () => void, onStep: (step: number) => void) {
    this.root = root;
    this.rigs = projects.map(project => {
      const station = stations[project.id];
      const el = buildRig(project, onClose, onStep);
      el.inert = true;
      root.append(el);
      return { el, facing: orbitBasis(station.yaw, station.pitch, station.distance), distance: station.distance };
    });
    // A press anywhere but on a screenshot puts a brought-forward one back.
    document.addEventListener('pointerdown', e => {
      if (this.active !== null && !(e.target instanceof Element && e.target.closest('.shot'))) zoomShot(this.rigs[this.active].el, null);
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
      // The next time this rig opens, its screenshots fly in with the panels again.
      for (const shot of old.querySelectorAll('.is-returning')) shot.classList.remove('is-returning');
    }
    this.leaving = this.active;
    this.active = index;
    if (index !== null) {
      const el = this.rigs[index].el;
      for (const img of el.querySelectorAll<HTMLImageElement>('img[data-src]')) {
        img.src = img.dataset.src!;
        delete img.dataset.src;
      }
      el.classList.add('is-active');
      el.inert = false;
    }
  }

  /** Places the rigs on screen for this frame's camera. While `turning`, the panels dim and hatch;
   * from behind the open rig's plane, its cards show their backs. */
  place(camera: CameraBasis, distance: number, lens: StageLens, turning: boolean): void {
    const { style } = this.root;
    this.root.classList.toggle('stage--flat', this.flat);
    this.root.classList.toggle('is-turning', turning && !this.flat);
    // The station's camera looks along its forward, so a camera on the far side of the cube's
    // centre from it, along that line, sees the rig's back.
    const behind = !this.flat && this.active !== null && dot(camera.eye, this.rigs[this.active].facing.forward) > 0;
    this.root.classList.toggle('is-behind', behind);
    if (this.flat) {
      style.cssText = '';
      for (const rig of this.rigs) rig.el.style.transform = '';
      return;
    }
    // The rig box is the largest one centred on the cube that fits the stage, so a rig's own layout
    // centres on the cube.
    style.setProperty('--stage-h', `${lens.height.toFixed(1)}px`); // the canvas's; on phones the cards below it are in the hero too
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

/** What a card shows from behind. Spans, so it can sit inside the screenshot buttons. */
function cardBack(): HTMLElement {
  const back = el('span', 'card-back');
  back.setAttribute('aria-hidden', 'true');
  back.innerHTML = '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" /><circle class="card-back__eye" cx="11" cy="13" r="1.6" /><circle class="card-back__eye" cx="21" cy="13" r="1.6" /><path d="M10.5 23c1.4-2.4 3.3-3.5 5.5-3.5s4.1 1.1 5.5 3.5" /></svg>';
  back.append(el('span', 'card-back__text', 'Stop looking hereeee :('));
  return back;
}

/** Brings one of a rig's screenshots forward, out of the bore, and puts any other back (null: all back). */
function zoomShot(rig: HTMLElement, shot: HTMLElement | null): void {
  for (const other of rig.querySelectorAll<HTMLElement>('.shot')) {
    const zoomed = other === shot;
    // Going back is quick, not the slow, delayed fly-in the screenshot entered with.
    if (!zoomed && other.classList.contains('is-zoomed')) other.classList.add('is-returning');
    other.classList.toggle('is-zoomed', zoomed);
    other.setAttribute('aria-pressed', String(zoomed));
  }
}

function buildRig(project: ProjectContent, onClose: () => void, onStep: (step: number) => void): HTMLElement {
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
  if (project.page) links.append(pageLink(project.page, project.name, 'panel__link panel__link--page'));
  links.append(externalLink(project.repo, 'GitHub', 'panel__link'));
  if (project.live) links.append(externalLink(project.live, 'Live site', 'panel__link'));
  const steps = el('p', 'panel__steps');
  for (const [step, text] of [[-1, 'Previous'], [1, 'Next']] as const) {
    const button = el('button', 'panel__step', text);
    button.type = 'button';
    button.addEventListener('click', () => onStep(step));
    steps.append(button);
  }
  about.append(
    close,
    el('p', 'panel__meta mono', meta),
    el('h2', 'panel__name', project.name),
    el('p', 'panel__tagline', project.tagline),
    el('p', 'panel__summary', project.summary),
    links,
    steps,
    cardBack(),
  );

  const shots = el('div', 'rig__shots');
  for (const image of project.images) {
    // A button, so a click or Enter brings the screenshot forward to read it, and again puts it back.
    const shot = el('button', 'shot');
    shot.type = 'button';
    shot.setAttribute('aria-pressed', 'false');
    // No src until the rig first opens (see show), so the page doesn't fetch every gallery up front.
    const img = el('img', '');
    Object.assign(img, { alt: image.alt, width: image.width, height: image.height, decoding: 'async', draggable: false });
    img.dataset.src = image.src;
    shot.append(img, cardBack());
    shot.addEventListener('click', () => zoomShot(rig, shot.classList.contains('is-zoomed') ? null : shot));
    shots.append(shot);
  }

  const facts = el('div', 'panel panel--facts');
  const highlights = el('ul', 'panel__highlights');
  for (const item of project.highlights) highlights.append(el('li', '', item));
  const stack = el('ul', 'panel__stack mono');
  for (const item of project.stack) stack.append(el('li', '', item));
  facts.append(highlights, stack, cardBack());

  rig.append(about, shots, facts);
  return rig;
}
