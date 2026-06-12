import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'FFA' });
console.log('spawned:', ok);
await page.waitForTimeout(3000);
await page.screenshot({ path: evidence('verify-ffa.png') });

// Count distinct leaderboard-style numbers captured (FFA shows ~10 entries; Sandbox shows ~1).
const lead = await page.evaluate(() => {
  return new Promise((resolve) => {
    const nums = new Set(); const t0 = performance.now();
    const tick = () => {
      const f = window.__diep?.frame;
      if (f) for (const t of f.texts) { const m = /^[\d.]+\s*[km]?$/i.exec(t.t.trim()); if (m) nums.add(t.t.trim()); }
      if (performance.now() - t0 < 2500) setTimeout(tick, 10); else resolve([...nums]);
    };
    tick();
  });
});
console.log('leaderboard-ish numbers seen:', JSON.stringify(lead));
await ctx.close();
