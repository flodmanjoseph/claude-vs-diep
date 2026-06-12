// Confirm the drone path: Tank -> Sniper(idx1) -> Overseer(idx1) -> capture Overseer's tier-4 (Overlord).
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';
import { enableTrustedCanvasClicks, clickTile } from './lib/upgrades.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'Sandbox' });
console.log('spawned:', ok);
if (!ok) { await ctx.close(); process.exit(0); }
await page.mouse.click(640, 360);
await page.waitForTimeout(200);
await enableTrustedCanvasClicks(page);

const levelBurst = async (ms) => { await page.keyboard.down('k'); await page.waitForTimeout(ms); await page.keyboard.up('k'); await page.waitForTimeout(700); };

await levelBurst(700);                 // past 15
await clickTile(page, 1);              // Sniper
await page.waitForTimeout(700);
await page.screenshot({ path: evidence('walk2-after-sniper.png') });

await levelBurst(900);                 // past 30
await page.screenshot({ path: evidence('walk2-tier3.png') });
await clickTile(page, 1);              // Overseer
await page.waitForTimeout(700);
await page.screenshot({ path: evidence('walk2-after-overseer.png') });

await levelBurst(900);                 // past 45
await page.screenshot({ path: evidence('walk2-tier4.png') });  // Overseer's options: Overlord etc.

console.log('captured walk2-* screenshots');
await page.waitForTimeout(500);
await ctx.close();
