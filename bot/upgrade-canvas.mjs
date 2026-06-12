// Can we read the canvas-drawn upgrade tile labels, and does clicking a tile position upgrade us?
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
await page.waitForTimeout(800);

// Dump short text draws (candidate labels) with positions, captured over a short window.
const texts = await page.evaluate(() => {
  return new Promise((resolve) => {
    const acc = new Map();
    const t0 = performance.now();
    const tick = () => {
      const f = window.__diep?.frame;
      if (f) for (const t of f.texts) { const s = t.t.trim(); if (s && s.length < 16 && /[A-Za-z]/.test(s)) acc.set(s, { x: t.x, y: t.y, c: t.c, font: t.font }); }
      if (performance.now() - t0 < 1500) setTimeout(tick, 10); else resolve([...acc.entries()].map(([t, v]) => ({ t, ...v })));
    };
    tick();
  });
});
console.log('CANVAS TEXTS:', JSON.stringify(texts, null, 0));

// Trusted click on the Sniper tile position (col 2, row 1) ~ (140, 81).
await page.screenshot({ path: evidence('uc-before-pick.png') });
await page.mouse.click(140, 81);
await page.waitForTimeout(800);
await page.screenshot({ path: evidence('uc-after-pick.png') });

// Did the class change? Read the bottom-bar class text if captured.
const after = await page.evaluate(() => {
  const acc = [];
  const f = window.__diep?.frame;
  if (f) for (const t of f.texts) { const s = t.t.trim(); if (/sniper|tank|twin|machine|flank|lvl|level/i.test(s)) acc.push(s); }
  return acc;
});
console.log('AFTER PICK texts mentioning class/level:', JSON.stringify(after));

await page.waitForTimeout(500);
await ctx.close();
