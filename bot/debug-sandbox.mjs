import { launch, evidence } from './lib/launch.mjs';

const { ctx, page } = await launch();
await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1200);
  if (await page.evaluate(() => !!document.getElementById('spawn-nickname'))) break;
  const ts = page.locator('iframe[src*="challenges.cloudflare"]').first();
  if (await ts.count()) { const b = await ts.boundingBox(); if (b) await page.mouse.click(b.x + 30, b.y + b.height / 2); }
}
await page.waitForTimeout(1500);

// Step 1: open dropdown, log what labels/options exist.
const step1 = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.dropdown-label')].map((e) => ({ txt: e.textContent.trim(), cls: e.className }));
  const label = [...document.querySelectorAll('.dropdown-label, [class*="dropdown"]')].find((e) => /game mode|ffa|sandbox|teams|maze/i.test(e.textContent || ''));
  return { labels, foundLabelText: label?.textContent?.trim(), foundLabelCls: label?.className };
});
console.log('STEP1 labels:', JSON.stringify(step1));

// Open dropdown by clicking the gamemode label, screenshot.
await page.evaluate(() => {
  const label = [...document.querySelectorAll('.dropdown-label')].find((e) => /ffa/i.test(e.textContent || ''));
  if (label) label.click();
});
await page.waitForTimeout(700);
await page.screenshot({ path: evidence('dbg-1-dropdown-open.png') });

const step2 = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Sandbox').map((e) => {
    const r = e.getBoundingClientRect();
    return { vis: !!(e.offsetWidth || e.offsetHeight), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), tag: e.tagName, cls: e.className };
  });
  return opts;
});
console.log('STEP2 sandbox option elements:', JSON.stringify(step2));

// Click sandbox option.
await page.evaluate(() => {
  const opt = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Sandbox');
  if (opt) { opt.click(); if (opt.parentElement) opt.parentElement.click(); }
});
await page.waitForTimeout(700);
await page.screenshot({ path: evidence('dbg-2-after-select.png') });
const step3 = await page.evaluate(() => [...document.querySelectorAll('.dropdown-label')].map((e) => e.textContent.trim()));
console.log('STEP3 labels after select:', JSON.stringify(step3));

// Spawn (single Enter).
await page.evaluate(() => { const nn = document.getElementById('spawn-nickname'); if (nn) { nn.value = 'claude'; nn.dispatchEvent(new Event('input', { bubbles: true })); } });
await page.keyboard.press('Enter');
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000);
  const w = await page.evaluate(() => document.getElementById('canvas')?.getBoundingClientRect().width || 0);
  if (w > 100) { console.log(`canvas live after ${i + 1}s`); break; }
  if (i === 11) console.log('canvas never came live');
}
await page.screenshot({ path: evidence('dbg-3-spawn-result.png') });
await page.waitForTimeout(500);
await ctx.close();
