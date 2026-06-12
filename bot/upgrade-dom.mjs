// Settle it: dump the top-left DOM where the upgrade tiles render, and test click methods.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'Sandbox' });
console.log('spawned sandbox:', ok);
if (!ok) { await ctx.close(); process.exit(0); }
await page.mouse.click(640, 360);
await page.waitForTimeout(200);
await page.keyboard.down('k'); await page.waitForTimeout(500); await page.keyboard.up('k');
await page.waitForTimeout(900);

// Dump every element intersecting the top-left upgrade region.
const dom = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.x > 220 || r.y > 270 || r.x + r.width < 0 || r.y + r.height < 0) continue;
    out.push({ tag: e.tagName, id: e.id || undefined, cls: (e.className || '').toString().slice(0, 36) || undefined, txt: (e.childElementCount === 0 ? e.textContent : '').trim().slice(0, 20) || undefined, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
});
console.log('TOP-LEFT DOM:'); console.log(JSON.stringify(dom, null, 1));

const classNow = async () => page.evaluate(() => {
  const f = window.__diep?.frame; let r = '?';
  if (f) for (const t of f.texts) if (/^Lvl \d+/.test(t.t)) r = t.t;
  return r;
});
console.log('class before:', await classNow());

// Try several click strategies at the Sniper tile (~140,81), checking class after each.
const trySpot = async (label, fn) => { await fn(); await page.waitForTimeout(700); console.log(`${label} -> ${await classNow()}`); };
await trySpot('trusted click 142,80', () => page.mouse.click(142, 80));
await trySpot('trusted click 142,72', () => page.mouse.click(142, 72));
await trySpot('synthetic mousedown+up 142,80', () => page.evaluate(() => {
  const cv = document.getElementById('canvas');
  for (const type of ['mousedown', 'mouseup', 'click']) cv.dispatchEvent(new MouseEvent(type, { clientX: 142, clientY: 80, button: 0, bubbles: true, cancelable: true }));
}));
await page.screenshot({ path: evidence('ud-result.png') });

await page.waitForTimeout(500);
await ctx.close();
