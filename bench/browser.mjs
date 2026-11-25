// Headless Brave on the real GPU, shared by run.mjs and ab.mjs: ANGLE's Metal backend, frames not
// held to the display's refresh, and nothing slowed down for being in the background. Each launch
// gets a fresh temp profile.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
export const BROWSER_ARGS = [
  '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
  '--disable-gpu-vsync', '--disable-frame-rate-limit',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--no-first-run', '--no-default-browser-check',
];

/** Launches the browser; close() also deletes its profile. */
export async function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'cube-bench-'));
  const browser = await puppeteer.launch({ executablePath: BRAVE, headless: true, userDataDir: profile, args: BROWSER_ARGS, protocolTimeout: 600_000 });
  const close = browser.close.bind(browser);
  browser.close = async () => {
    await close();
    rmSync(profile, { recursive: true, force: true });
  };
  return browser;
}

/** Opens a page that reports its errors on the console. */
export async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.error('page:', msg.text()); });
  page.on('pageerror', err => console.error('page:', err.message));
  await page.goto(url);
  return page;
}
