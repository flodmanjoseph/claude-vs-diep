// Validate the canvas scraper: sample many frames to learn how world vs HUD draws are distributed.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);

const ok = await spawn(page, { name: 'claude' });
console.log('spawned:', ok);
await page.waitForTimeout(3_000);

// Sample 40 distinct published frames; report the distribution and the richest frames.
const samples = await page.evaluate(async () => {
  const seen = [];
  let lastT = -1;
  const t0 = performance.now();
  while (seen.length < 60 && performance.now() - t0 < 4000) {
    const f = window.__diep?.frame;
    if (f && f.t !== lastT) {
      lastT = f.t;
      seen.push({ t: f.t, nT: f.texts.length, nC: f.circles.length, nP: f.polys.length });
    }
    await new Promise((r) => setTimeout(r, 8));
  }
  return seen;
});
const sum = (k) => samples.reduce((a, s) => a + s[k], 0);
console.log(`sampled ${samples.length} frames | texts/frame avg ${(sum('nT') / samples.length).toFixed(1)} max ${Math.max(...samples.map(s => s.nT))} | circles avg ${(sum('nC') / samples.length).toFixed(1)} max ${Math.max(...samples.map(s => s.nC))} | polys avg ${(sum('nP') / samples.length).toFixed(1)} max ${Math.max(...samples.map(s => s.nP))}`);
console.log('per-frame:', samples.map(s => `${s.nT}t/${s.nC}c/${s.nP}p`).join('  '));

// Grab the richest text frame and richest circle frame in full.
const rich = await page.evaluate(() => {
  // Re-collect over a short window, keep the frame with most texts and the one with most circles.
  return new Promise((resolve) => {
    let bestText = null, bestCircle = null, lastT = -1;
    const t0 = performance.now();
    const tick = () => {
      const f = window.__diep?.frame;
      if (f && f.t !== lastT) {
        lastT = f.t;
        if (!bestText || f.texts.length > bestText.texts.length) bestText = f;
        if (!bestCircle || f.circles.length > bestCircle.circles.length) bestCircle = f;
      }
      if (performance.now() - t0 < 3000) setTimeout(tick, 8);
      else resolve({
        bestTextTexts: bestText.texts.map(t => ({ t: t.t, x: t.x, y: t.y, c: t.c })),
        bestTextCounts: { nT: bestText.texts.length, nC: bestText.circles.length, nP: bestText.polys.length },
        bestCircleCounts: { nT: bestCircle.texts.length, nC: bestCircle.circles.length, nP: bestCircle.polys.length },
        bestCircleCircles: bestCircle.circles.slice(0, 40),
      });
    };
    tick();
  });
});
console.log('\nRICHEST TEXT FRAME counts:', JSON.stringify(rich.bestTextCounts));
console.log('texts:', JSON.stringify(rich.bestTextTexts, null, 0));
console.log('\nRICHEST CIRCLE FRAME counts:', JSON.stringify(rich.bestCircleCounts));
console.log('circles:', JSON.stringify(rich.bestCircleCircles, null, 0));

await page.screenshot({ path: evidence('m2-perception.png') });
await ctx.close();
