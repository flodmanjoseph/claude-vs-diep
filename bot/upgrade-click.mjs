// Determine the working way to click a canvas-drawn upgrade tile.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'Sandbox' });
console.log('spawned:', ok);
if (!ok) { await ctx.close(); process.exit(0); }
await page.mouse.click(640, 360);
await page.waitForTimeout(200);
await page.keyboard.down('k'); await page.waitForTimeout(500); await page.keyboard.up('k');
await page.waitForTimeout(900);

const SX = 142, SY = 81; // Sniper tile center
const hit = await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  return el ? { id: el.id, tag: el.tagName, cls: (el.className || '').toString().slice(0, 30), pe: getComputedStyle(el).pointerEvents } : null;
}, { x: SX, y: SY });
console.log('elementFromPoint(142,81):', JSON.stringify(hit));

// Strategy A: synthetic pointer+mouse sequence to whatever is at that point, bubbling.
await page.evaluate(({ x, y }) => {
  const tgt = document.elementFromPoint(x, y) || document.getElementById('canvas');
  const opts = { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    tgt.dispatchEvent(new E(type, opts));
  }
}, { x: SX, y: SY });
await page.waitForTimeout(800);
await page.screenshot({ path: evidence('uclk-A-synthetic.png') });

// Strategy B: drop overlay pointer-events, then a trusted click.
await page.evaluate(() => { for (const id of ['dimmer', 'screen-holder']) { const e = document.getElementById(id); if (e) e.style.pointerEvents = 'none'; } });
await page.mouse.click(SX, SY);
await page.waitForTimeout(800);
await page.screenshot({ path: evidence('uclk-B-trusted-nope.png') });

console.log('done; compare uclk-A and uclk-B screenshots for class change');
await page.waitForTimeout(400);
await ctx.close();
