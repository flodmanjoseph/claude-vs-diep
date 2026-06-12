// M0 probe 3: wait out Turnstile, dump the full spawn screen, find name input + play control.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, 'evidence', name) });

const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.profile'), {
  headless: false,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Poll for the canvas to gain real dimensions, OR for a name input to appear.
let state = 'unknown';
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2_000);
  state = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const cr = c ? c.getBoundingClientRect() : { width: 0, height: 0 };
    const inputs = [...document.querySelectorAll('input')]
      .map((e) => ({ type: e.type, id: e.id, ph: e.placeholder, ml: e.maxLength, vis: !!(e.offsetWidth || e.offsetHeight), v: e.value }))
      .filter((x) => x.type !== 'hidden');
    const ts = document.querySelector('iframe[src*="challenges.cloudflare"]');
    return {
      canvas: { w: Math.round(cr.width), h: Math.round(cr.height) },
      inputs,
      turnstilePresent: !!ts,
      bodyText: (document.getElementById('home-screen')?.innerText || '').replace(/\n+/g, ' | ').slice(0, 200),
    };
  });
  console.log(`t+${(i + 1) * 2}s`, JSON.stringify(state));
  if (state.canvas.w > 100) { console.log('CANVAS LIVE'); break; }
}

await shot(page, 'm0-spawn-screen.png');

// Try the documented spawn: focus name input if present, type a name, press Enter.
const nameInput = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
if (await nameInput.count()) {
  await nameInput.click();
  await nameInput.fill('claude');
  console.log('typed name into input');
}
await page.keyboard.press('Enter');
await page.waitForTimeout(4_000);

const after = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  const cr = c ? c.getBoundingClientRect() : { width: 0, height: 0 };
  return { canvas: { w: Math.round(cr.width), h: Math.round(cr.height) } };
});
console.log('after Enter:', JSON.stringify(after));
await shot(page, 'm0-after-enter.png');

await page.waitForTimeout(1_500);
await ctx.close();
