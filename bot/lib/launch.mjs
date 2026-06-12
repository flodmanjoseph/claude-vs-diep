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

// Navigate, clear Turnstile, and spawn. Returns when the canvas is live.
// gamemode: pass a value to switch the FFA dropdown later; for now spawns whatever is selected.
export async function spawn(page, { name = 'claude', timeoutMs = 90_000 } = {}) {
  await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now ? null : null; // Date.now unavailable in some contexts; use loop counter
  let clicked = false;
  for (let i = 0; i < Math.ceil(timeoutMs / 1500); i++) {
    await page.waitForTimeout(1_500);
    const s = await page.evaluate(() => {
      const c = document.getElementById('canvas');
      const cr = c ? c.getBoundingClientRect() : { width: 0 };
      const nn = document.getElementById('spawn-nickname');
      return { canvasW: Math.round(cr.width), nick: !!(nn && (nn.offsetWidth || nn.offsetHeight)) };
    });
    if (s.canvasW > 100 || s.nick) break;
    if (!clicked && i >= 2) {
      const ts = page.locator('iframe[src*="challenges.cloudflare"]').first();
      if (await ts.count()) {
        const box = await ts.boundingBox();
        if (box) { await page.mouse.click(box.x + 30, box.y + box.height / 2); clicked = true; }
      }
    }
  }

  await page.evaluate((nm) => {
    const nn = document.getElementById('spawn-nickname');
    if (nn) { nn.value = nm; nn.dispatchEvent(new Event('input', { bubbles: true })); }
  }, name);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3_000);

  const live = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    return c ? Math.round(c.getBoundingClientRect().width) : 0;
  });
  return live > 100;
}
