// Strategy C: synthetic mousemove to the tile (update diep's tracked pointer), then mousedown/up.
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
await page.screenshot({ path: evidence('uc2-before.png') });

// Synthetic move-then-click on the canvas at the Sniper tile.
const clickTile = (x, y) => page.evaluate(({ x, y }) => {
  const cv = document.getElementById('canvas');
  const mk = (type) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0, bubbles: true, cancelable: true, view: window });
  cv.dispatchEvent(mk('mousemove'));
  return new Promise((r) => setTimeout(() => {
    cv.dispatchEvent(mk('mousedown'));
    setTimeout(() => { cv.dispatchEvent(mk('mouseup')); cv.dispatchEvent(mk('click')); r(); }, 80);
  }, 80));
}, { x, y });

await clickTile(142, 81); // Sniper
await page.waitForTimeout(900);
await page.screenshot({ path: evidence('uc2-after-synthetic-move-click.png') });

// Also try a trusted move-then-click with overlay disabled, as a cross-check.
await page.evaluate(() => { for (const id of ['dimmer', 'screen-holder']) { const e = document.getElementById(id); if (e) e.style.pointerEvents = 'none'; } });
await page.mouse.move(142, 81, { steps: 5 });
await page.waitForTimeout(120);
await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
await page.waitForTimeout(900);
await page.screenshot({ path: evidence('uc2-after-trusted-move-click.png') });

console.log('done; compare uc2-after-* screenshots');
await page.waitForTimeout(400);
await ctx.close();
