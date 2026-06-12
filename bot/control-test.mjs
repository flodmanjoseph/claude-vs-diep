// M1: prove control. Test in-page synthetic events (the architecture we want) for movement
// and firing, using perception to detect the effect. Fall back to Playwright trusted input.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude' });
console.log('spawned:', ok);
await page.waitForTimeout(2_500);

// Install an in-page synthetic input helper.
await page.evaluate(() => {
  const KEY = { w: 87, a: 65, s: 83, d: 68, e: 69, c: 67 };
  const fire = (type, ch) => {
    const ev = new KeyboardEvent(type, { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: KEY[ch], which: KEY[ch], bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    window.dispatchEvent(ev);
    const cv = document.getElementById('canvas');
    if (cv) cv.dispatchEvent(ev);
  };
  window.__key = { down: (ch) => fire('keydown', ch), up: (ch) => fire('keyup', ch) };
  window.__mouseMove = (x, y) => {
    const cv = document.getElementById('canvas');
    const ev = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
    (cv || document).dispatchEvent(ev);
  };
});

const avgShapeY = async () => page.evaluate(() => {
  const s = window.__readState();
  if (!s.ok || !s.shapes.length) return null;
  return s.shapes.reduce((a, e) => a + e.y, 0) / s.shapes.length;
});

// --- Movement test: hold W (north). If we move up, world shapes drift down (avg y increases). ---
const before = await avgShapeY();
await page.screenshot({ path: evidence('m1-before-move.png') });
await page.evaluate(() => window.__key.down('w'));
await page.waitForTimeout(1000);
const during = await avgShapeY();
await page.evaluate(() => window.__key.up('w'));
await page.waitForTimeout(300);
await page.screenshot({ path: evidence('m1-after-move.png') });
console.log(`SYNTHETIC MOVE: avg shape y before=${before?.toFixed(0)} during=${during?.toFixed(0)} delta=${before != null && during != null ? (during - before).toFixed(0) : 'n/a'} (expect +, world drifts down as we go up)`);

// --- Fire test: toggle autofire (E), check our own bullets appear. ---
const bulletsBefore = await page.evaluate(() => window.__readState().bullets?.length ?? 0);
await page.evaluate(() => { window.__mouseMove(900, 360); window.__key.down('e'); window.__key.up('e'); });
await page.waitForTimeout(900);
const bulletStats = await page.evaluate(() => {
  const s = window.__readState();
  return { total: s.bullets.length, mine: s.bullets.filter(b => !b.enemy).length, sample: s.bullets.slice(0, 5) };
});
console.log(`SYNTHETIC FIRE: bullets before=${bulletsBefore} after total=${bulletStats.total} mine=${bulletStats.mine}`);
console.log('bullet sample:', JSON.stringify(bulletStats.sample));
// turn autofire back off
await page.evaluate(() => { window.__key.down('e'); window.__key.up('e'); });

// --- Fallback: if synthetic movement failed, try Playwright trusted keyboard. ---
let trustedDelta = null;
if (!(before != null && during != null && during - before > 15)) {
  const b2 = await avgShapeY();
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1000);
  const d2 = await avgShapeY();
  await page.keyboard.up('KeyS');
  trustedDelta = b2 != null && d2 != null ? d2 - b2 : null;
  console.log(`TRUSTED MOVE (S/south): delta=${trustedDelta?.toFixed(0)} (expect -, world drifts up)`);
}

const verdict = {
  syntheticMove: before != null && during != null && Math.abs(during - before) > 15,
  syntheticFire: bulletStats.mine > 0 || bulletStats.total > bulletsBefore,
};
console.log('\nVERDICT:', JSON.stringify(verdict));
await ctx.close();
