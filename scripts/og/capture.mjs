// Screenshots the finished cube on a page (default: the live site) with the page UI hidden, at
// 1200×630 and 2x, into scripts/og/cube.jpg. card.html builds public/og.jpg around it.
// Usage: node scripts/og/capture.mjs [url]. Set BROWSER to use a Chromium other than Brave.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'https://elliotscully.dev/';
const browser = process.env.BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const out = new URL('cube.jpg', import.meta.url).pathname;
const HIDE_UI = '.nav,.hero__inner,.hint,.whatis,#stage,.loader{visibility:hidden!important}';
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'og-capture-'));
const proc = spawn(browser, ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

let page;
for (let i = 0; i < 50 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); }
  catch { await sleep(200); }
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  pending.get(msg.id)?.(msg.result);
  pending.delete(msg.id);
});
const send = (method, params = {}) => new Promise((resolve) => {
  pending.set(++nextId, resolve);
  ws.send(JSON.stringify({ id: nextId, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url });

// The status reads "loading" until the cube arrives; then the sweep grows it in for a few seconds.
const status = () => evaluate(`document.getElementById('sim-status')?.textContent ?? ''`);
for (let i = 0; i < 120 && /^(|loading.*)$/i.test(await status()); i++) await sleep(500);
await sleep(12000); // grow-in finishes and temporal AA settles, well inside the hold before the next preset
await evaluate(`document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(HIDE_UI)} }))`);
await sleep(1000);

const { data } = await send('Page.captureScreenshot', { format: 'png' });
const finalStatus = await status();
const png = join(profile, 'cube.png');
writeFileSync(png, Buffer.from(data, 'base64'));
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', png, '--out', out], { stdio: 'ignore' });
proc.kill();
rmSync(profile, { recursive: true, force: true });
console.log(`cube at ${finalStatus} -> ${out}`);
process.exit(0);
