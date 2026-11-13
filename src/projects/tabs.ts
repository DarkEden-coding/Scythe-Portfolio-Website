// The project tabs in the header: one small button per project, with a marker that slides to the
// open one.

import type { ProjectContent } from './content.ts';

/** Builds the tabs. `onPick` gets the project's index, or null when the open tab is clicked again.
 * Returns a function that marks one as open (null: none) without calling back. */
export function buildTabs(root: HTMLElement, projects: ProjectContent[], onPick: (index: number | null) => void): (index: number | null) => void {
  const marker = document.createElement('span');
  marker.className = 'tabs__marker';
  marker.setAttribute('aria-hidden', 'true');
  root.append(marker);

  let open: number | null = null;
  const buttons = projects.map((project, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tabs__tab';
    button.textContent = project.tab;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', `project-${project.id}`);
    button.addEventListener('click', () => onPick(open === index ? null : index));
    root.append(button);
    return button;
  });

  const moveMarker = () => {
    const button = open === null ? null : buttons[open];
    marker.classList.toggle('is-shown', button !== null);
    if (!button) return;
    marker.style.width = `${button.offsetWidth}px`;
    marker.style.height = `${button.offsetHeight}px`;
    marker.style.transform = `translate(${button.offsetLeft}px, ${button.offsetTop}px)`; // the tabs wrap on narrow screens
  };
  new ResizeObserver(moveMarker).observe(root); // also once the fonts load and widths settle

  return index => {
    open = index;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    moveMarker();
  };
}
