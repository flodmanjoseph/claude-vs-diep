// M0 probe 4: solve Turnstile via a real mouse click on the checkbox, then reach a spawnable state.
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
await page.waitForTimeout(6_000);

const listFrames = () => page.frames().map((f) => f.url().slice(0, 80));
console.log('frames before:', JSON.stringify(listFrames(), null, 1));

// The Cloudflare checkbox sits at the left edge of the widget. From the screenshot the
// checkbox center is ~ (510, 339) in a 1280x720 viewport. Click it with a real mouse move+click.
async function clickCheckbox() {
  await page.mouse.move(400, 339);
  await page.waitForTimeout(150);
  await page.mouse.move(510, 339, { steps: 8 });
  await page.waitForTimeout(150);
  await page.mouse.click(510, 339);
}

// Poll: click, wait, re-check whether the gate cleared (nickname input becomes visible or canvas grows).
let cleared = false;
for (let attempt = 0; attempt < 4 && !cleared; attempt++) {
  await clickCheckbox();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2_000);
    const s = await page.evaluate(() => {
      const c = document.getElementById('canvas');
      const cr = c ? c.getBoundingClientRect() : { width: 0, height: 0 };
      const nn = document.getElementById('spawn-nickname');
      const nr = nn ? nn.getBoundingClientRect() : null;
      return {
        canvasW: Math.round(cr.width),
        nickVisible: !!(nn && (nn.offsetWidth || nn.offsetHeight)),
        nickRect: nr ? { x: Math.round(nr.x), y: Math.round(nr.y), w: Math.round(nr.width), h: Math.round(nr.height) } : null,
        nickFocusable: nn ? !nn.disabled : null,
      };
    });
    if (s.canvasW > 100 || s.nickVisible) {
      console.log(`gate cleared on attempt ${attempt} t+${i * 2}s`, JSON.stringify(s));
      cleared = true;
      break;
    }
    if (i === 5) console.log(`attempt ${attempt} no change`, JSON.stringify(s));
  }
}

console.log('frames after:', JSON.stringify(listFrames(), null, 1));
await shot(page, 'm0-after-checkbox.png');

// Whether or not the nickname field is "visible", try the spawn: type name + Enter.
await page.evaluate(() => {
  const nn = document.getElementById('spawn-nickname');
  if (nn) { nn.value = 'claude'; nn.dispatchEvent(new Event('input', { bubbles: true })); }
});
await page.waitForTimeout(500);
await page.keyboard.press('Enter');
await page.waitForTimeout(5_000);

const final = await page.evaluate(() => {
  const c = document.getElementById('canvas');
  const cr = c ? c.getBoundingClientRect() : { width: 0, height: 0 };
  return { canvasW: Math.round(cr.width), canvasH: Math.round(cr.height) };
});
console.log('FINAL canvas:', JSON.stringify(final));
await shot(page, 'm0-final.png');

await page.waitForTimeout(1_500);
await ctx.close();
