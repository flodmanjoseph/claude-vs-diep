// M0 probe: launch diep.io, screenshot the menu, map the DOM.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.profile'), {
  headless: false,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)));

await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(10_000);

await page.screenshot({ path: path.join(ROOT, 'evidence', 'm0-menu.png') });

const dom = await page.evaluate(() => {
  const els = [...document.querySelectorAll('input, button, canvas, iframe, select, textarea, [id], [class*="modal"], [class*="consent"]')].slice(0, 100);
  return els.map((e) => ({
    tag: e.tagName,
    id: e.id || undefined,
    cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60) || undefined,
    type: e.type || undefined,
    visible: !!(e.offsetWidth || e.offsetHeight),
    rect: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.getBoundingClientRect()),
  }));
});
console.log('DOM MAP:');
console.log(JSON.stringify(dom, null, 1));

console.log('WS endpoints seen:', await page.evaluate(() => window.__wsUrls ?? 'no hook installed'));

await page.waitForTimeout(2_000);
await ctx.close();
