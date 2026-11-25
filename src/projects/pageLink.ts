import { el } from '../ui/dom.ts';

/** A link to a project's write-up page. Same tab: it's part of this site. */
export function pageLink(href: string, projectName: string, className: string): HTMLAnchorElement {
  const a = el('a', className, 'Read the write-up');
  a.href = href;
  a.setAttribute('aria-label', `Read the ${projectName} write-up`);
  return a;
}
