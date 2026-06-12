// M0 probe 2: click the Cloudflare Turnstile checkbox, then map the post-gate menu.
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
await page.waitForTimeout(8_000);

// Find the Turnstile widget iframe and click its checkbox (left side of the widget).
const ts = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
if (await ts.count()) {
  const box = await ts.boundingBox();
  if (box) {
    console.log('turnstile iframe at', JSON.stringify(box));
    await page.mouse.click(box.x + 30, box.y + box.height / 2);
    console.log('clicked turnstile');
  } else {
    console.log('turnstile iframe present but no bbox (not visible)');
  }
} else {
  console.log('no turnstile iframe found');
}

await page.waitForTimeout(8_000);
await shot(page, 'm0-after-turnstile.png');

// Map everything visible now.
const dom = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll('input, button, select, textarea, [id]')) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      tag: e.tagName,
      id: e.id || undefined,
      type: e.type || undefined,
      text: (e.innerText || e.value || e.placeholder || '').slice(0, 40) || undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
});
console.log('VISIBLE DOM:');
console.log(JSON.stringify(dom, null, 1));

await page.waitForTimeout(2_000);
await ctx.close();
