// Resolve the sandbox level-up mechanism, then capture the class-upgrade UI at level 15/30/45.
import { launch, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1200);
  if (await page.evaluate(() => !!document.getElementById('spawn-nickname'))) break;
  const ts = page.locator('iframe[src*="challenges.cloudflare"]').first();
  if (await ts.count()) { const b = await ts.boundingBox(); if (b) await page.mouse.click(b.x + 30, b.y + b.height / 2); }
}
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const label = [...document.querySelectorAll('.dropdown-label, [class*="dropdown"]')].find((e) => /ffa|game mode/i.test(e.textContent || ''));
  if (label) label.click();
  const opt = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Sandbox');
  if (opt) { opt.click(); if (opt.parentElement) opt.parentElement.click(); }
});
await page.waitForTimeout(600);
await page.evaluate(() => { const nn = document.getElementById('spawn-nickname'); if (nn) { nn.value = 'claude'; nn.dispatchEvent(new Event('input', { bubbles: true })); } });
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);
if (!(await page.evaluate(() => (document.getElementById('canvas')?.getBoundingClientRect().width || 0) > 100))) { console.log('no spawn'); await ctx.close(); process.exit(0); }

// Focus the canvas, then HOLD k to spam level-ups (sandbox).
await page.mouse.click(640, 360);
await page.waitForTimeout(200);
await page.keyboard.down('k');
await page.waitForTimeout(2500);
await page.keyboard.up('k');
await page.waitForTimeout(600);
await page.screenshot({ path: evidence('sb-hold-k.png') });

// Read the bottom-bar level text if captured.
const lvlText = await page.evaluate(() => (window.__diep?.frame?.texts || []).map((t) => t.t).filter((s) => /lvl|level|tank|score/i.test(s)));
console.log('level/score texts after hold-k:', JSON.stringify(lvlText));

// If still level 1, open the flask (sandbox tools) panel and screenshot it.
await page.mouse.click(67, 26);
await page.waitForTimeout(600);
await page.screenshot({ path: evidence('sb-flask-panel.png') });
const panelText = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll('*')) {
    const t = (e.childElementCount === 0 ? e.textContent : '').trim();
    if (t && t.length < 24 && /level|tank|upgrade|god|class|build/i.test(t)) { const r = e.getBoundingClientRect(); if (r.width > 2) out.push({ t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); }
  }
  return out.slice(0, 30);
});
console.log('flask panel text:', JSON.stringify(panelText, null, 1));

await page.waitForTimeout(1200);
await ctx.close();
