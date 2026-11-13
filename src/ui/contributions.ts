// The GitHub contribution graph by the project list, drawn from public/contributions.json (see
// scripts/contributions.mjs): a week per column, Sunday at the top, like GitHub's own.

interface Day {
  date: string; // YYYY-MM-DD
  count: number;
  level: number; // 0-4, GitHub's own buckets
}

interface Contributions {
  user: string;
  total: number;
  days: Day[];
}

const CELL = 11;
const STEP = 14; // cell plus gap
const TOP = 18; // room for the month labels
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const longDate = (date: string) => utc(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Fills root with the graph; hides root if the data can't be loaded. */
export async function renderContributions(root: HTMLElement): Promise<void> {
  let data: Contributions;
  try {
    const res = await fetch('/contributions.json');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    root.hidden = true;
    return;
  }
  const { days } = data;
  const firstWeekday = utc(days[0].date).getUTCDay();
  const weeks = Math.ceil((days.length + firstWeekday) / 7);
  const width = weeks * STEP;
  const height = TOP + 7 * STEP;

  // Weekday labels sit outside the graph, so they stay put when it scrolls on narrow screens.
  const weekdays = svg('svg', { class: 'contrib__weekdays', viewBox: `0 0 28 ${height}`, width: 28, height, 'aria-hidden': 'true' });
  for (const [row, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const) {
    weekdays.append(svg('text', { x: 0, y: TOP + row * STEP + CELL - 2, class: 'contrib__label' }, name));
  }
  const graph = svg('svg', { class: 'contrib__graph', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `${data.total} GitHub contributions in the last year` });
  let lastMonthCol = -3;
  days.forEach((day, i) => {
    const slot = i + firstWeekday;
    const col = Math.floor(slot / 7), row = slot % 7;
    const x = col * STEP, y = TOP + row * STEP;
    // A month's label goes over the first week that starts in it, if there's room since the last.
    const date = utc(day.date);
    if (row === 0 && date.getUTCDate() <= 7 && col - lastMonthCol >= 3) {
      graph.append(svg('text', { x, y: TOP - 6, class: 'contrib__label' }, MONTHS[date.getUTCMonth()]));
      lastMonthCol = col;
    }
    const cell = svg('rect', { x, y, width: CELL, height: CELL, rx: 2.5, class: `contrib__day contrib__day--${day.level}` });
    const what = day.count === 0 ? 'No contributions' : `${day.count} contribution${day.count === 1 ? '' : 's'}`;
    cell.append(svg('title', {}, `${what} on ${longDate(day.date)}`));
    graph.append(cell);
  });

  const head = document.createElement('div');
  head.className = 'contrib__head';
  const total = document.createElement('p');
  total.className = 'contrib__total';
  total.innerHTML = `<b>${data.total.toLocaleString('en-US')}</b> contributions in the last year`;
  const profile = document.createElement('a');
  profile.className = 'contrib__user mono';
  profile.href = `https://github.com/${data.user}`;
  profile.target = '_blank';
  profile.rel = 'noopener';
  profile.textContent = `@${data.user}`;
  head.append(total, profile);

  const scroll = document.createElement('div');
  scroll.className = 'contrib__scroll';
  scroll.append(graph);
  const body = document.createElement('div');
  body.className = 'contrib__body';
  body.append(weekdays, scroll);

  const legend = document.createElement('div');
  legend.className = 'contrib__legend mono';
  legend.setAttribute('aria-hidden', 'true');
  legend.innerHTML = `Less ${[0, 1, 2, 3, 4].map(l => `<i class="contrib__day--${l}"></i>`).join('')} More`;

  root.append(head, body, legend);
  // On narrow screens the graph scrolls; start at the latest weeks.
  scroll.scrollLeft = scroll.scrollWidth;
}
