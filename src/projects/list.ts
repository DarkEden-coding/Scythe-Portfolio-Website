// The plain project list below the cube: every project readable at a glance, without WebGL or
// a tab to find first. Each card can also fly the cube to that project's station.

import { el, externalLink } from '../ui/dom.ts';
import { pageLink } from './pageLink.ts';
import type { ProjectContent } from './content.ts';

/** Fills root with one card per project. `onView` gets the project's index when its "See it in
 * the cube" button is pressed; pass null to leave the button out (no WebGL). */
export function buildProjectList(root: HTMLElement, projects: ProjectContent[], onView: ((index: number) => void) | null): void {
  projects.forEach((project, index) => {
    const card = el('article', 'card work-card');
    card.setAttribute('aria-labelledby', `work-${project.id}`);

    const image = project.images[0];
    if (image) {
      const shot = el('div', 'work-card__shot');
      if (project.thumbFocus) shot.style.setProperty('--focus', project.thumbFocus);
      const img = el('img', '');
      Object.assign(img, { src: image.src, alt: image.alt, width: image.width, height: image.height, loading: 'lazy', decoding: 'async' });
      shot.append(img);
      card.append(shot);
    }

    const body = el('div', 'work-card__body');
    const meta = [project.year, project.stars ? `${project.stars} GitHub star${project.stars === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const name = el('h3', 'work-card__name', project.name);
    name.id = `work-${project.id}`;
    body.append(el('p', 'work-card__meta mono', meta), name, el('p', 'work-card__tagline', project.tagline), el('p', 'work-card__summary', project.summary));

    const highlights = el('ul', 'work-card__highlights');
    for (const item of project.highlights) highlights.append(el('li', '', item));
    const stack = el('ul', 'work-card__stack mono');
    stack.setAttribute('aria-label', 'Built with');
    for (const item of project.stack) stack.append(el('li', '', item));

    const actions = el('div', 'work-card__actions');
    if (project.page) actions.append(pageLink(project.page, project.name, 'pill pill--page'));
    actions.append(externalLink(project.repo, 'GitHub', 'pill'));
    if (project.live) actions.append(externalLink(project.live, 'Live site', 'pill'));
    if (onView) {
      const view = el('button', 'pill pill--cube', 'See it in the cube');
      view.type = 'button';
      view.addEventListener('click', () => onView(index));
      actions.append(view);
    }

    body.append(highlights, stack, actions);
    card.append(body);
    root.append(card);
  });
}
