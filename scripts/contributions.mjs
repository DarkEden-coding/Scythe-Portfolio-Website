// Saves the last year of GitHub contributions to public/contributions.json, for the graph by the
// project list. Reads the public contribution calendar GitHub draws on a profile, so no token is
// needed. Runs before each build; if GitHub can't be reached, the last saved file stays.
//
//   npm run contributions

import { writeFileSync } from 'node:fs';

const USER = 'DarkEden-coding';
const OUT = new URL('../public/contributions.json', import.meta.url);

async function main() {
  const res = await fetch(`https://github.com/users/${USER}/contributions`, { headers: { 'User-Agent': 'scythe-portfolio-build' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const html = await res.text();

  // Each day is a cell with its date and level (0-4); its count is in a tooltip pointing at the cell's id.
  const counts = new Map();
  for (const [, id, text] of html.matchAll(/<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const number = text.match(/^([\d,]+) contribution/);
    counts.set(id, number ? Number(number[1].replace(/,/g, '')) : 0);
  }
  const days = [];
  for (const [cell] of html.matchAll(/<td[^>]*ContributionCalendar-day[^>]*>/g)) {
    const date = cell.match(/data-date="([^"]+)"/)?.[1];
    const level = Number(cell.match(/data-level="(\d)"/)?.[1] ?? 0);
    const id = cell.match(/\bid="([^"]+)"/)?.[1];
    if (date) days.push({ date, count: counts.get(id) ?? 0, level });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const total = Number(html.match(/([\d,]+)\s+contributions\s+in the last year/)?.[1].replace(/,/g, '') ?? days.reduce((sum, d) => sum + d.count, 0));
  if (days.length < 300) throw new Error(`only found ${days.length} days; GitHub's page may have changed`);

  writeFileSync(OUT, JSON.stringify({ user: USER, total, fetched: new Date().toISOString().slice(0, 10), days }) + '\n');
  console.log(`contributions: ${total} over ${days.length} days`);
}

main().catch(err => {
  console.warn(`contributions: kept the saved file (${err.message})`);
});
