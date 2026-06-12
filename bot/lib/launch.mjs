// Shared launch + spawn for diep.io under real Chrome with a clean automation fingerprint.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const evidence = (name) => path.join(ROOT, 'evidence', name);

export async function launch({ headless = false } = {}) {
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.profile'), {
    headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { ctx, page };
}

const canvasLive = (page) =>
  page.evaluate(() => (document.getElementById('canvas')?.getBoundingClientRect().width || 0) > 100).catch(() => false);

// Clear the Cloudflare Turnstile if its challenge is present. The checkbox lives in a nested
// iframe the top-level locator can't see, so we detect the CF frame via page.frames() and click
// the checkbox at its fixed screen position (~510,339 in our 1280x720 viewport) with human-like
// motion. In stealth Chrome this reliably passes the managed challenge. Harmless if already clear.
async function clickTurnstile(page) {
  const hasCf = page.frames().some((f) => f.url().includes('challenges.cloudflare'));
  if (!hasCf) return false;
  await page.mouse.move(300, 500, { steps: 4 }).catch(() => {});
  await page.waitForTimeout(100);
  await page.mouse.move(480, 345, { steps: 10 }).catch(() => {});
  await page.waitForTimeout(120);
  await page.mouse.move(510, 339, { steps: 5 }).catch(() => {});
  await page.mouse.click(510, 339).catch(() => {});
  return true;
}

async function selectGamemode(page, gm) {
  await page.evaluate((g) => {
    const cur = [...document.querySelectorAll('.dropdown-label')].find((e) => /sandbox|ffa|teams|maze|domination|tag|mothership|survival/i.test(e.textContent || ''));
    if (cur && cur.textContent.trim().toLowerCase() === g.toLowerCase()) return; // already selected
    const label = [...document.querySelectorAll('.dropdown-label, [class*="dropdown"]')].find((e) => /game mode|ffa|sandbox|teams|maze/i.test(e.textContent || ''));
    if (label) label.click();
    const opt = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim().toLowerCase() === g.toLowerCase());
    if (opt) { opt.click(); if (opt.parentElement) opt.parentElement.click(); }
  }, gm);
  await page.waitForTimeout(500);
}

// Navigate, clear Turnstile, optionally select a gamemode, then spawn. Robust to flaky timing:
// the Turnstile may show a fresh checkbox that must be clicked before Enter will spawn, so we
// interleave checkbox-click + Enter + canvas-check until the canvas goes live. gamemode e.g. 'Sandbox'.
export async function spawn(page, { name = 'claude', gamemode = null, timeoutMs = 90_000 } = {}) {
  await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for the menu (nickname field) to exist.
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1_000);
    if (await page.evaluate(() => !!document.getElementById('spawn-nickname')).catch(() => false)) break;
    await clickTurnstile(page);
  }

  if (gamemode) await selectGamemode(page, gamemode);

  // Spawn loop: clear Turnstile, set nickname, Enter, check canvas. Repeat until live.
  const attempts = Math.ceil(timeoutMs / 4000);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await clickTurnstile(page);
    await page.waitForTimeout(1500); // give the challenge a moment to clear
    if (gamemode) await selectGamemode(page, gamemode);
    await page.evaluate((nm) => {
      const nn = document.getElementById('spawn-nickname');
      if (nn) { nn.value = nm; nn.dispatchEvent(new Event('input', { bubbles: true })); }
    }, name);
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter').catch(() => {});
    for (let i = 0; i < 5; i++) { await page.waitForTimeout(500); if (await canvasLive(page)) return true; }
  }
  return canvasLive(page);
}
