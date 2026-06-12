// Map the Smasher path: level well past 45 as Tank, pick Smasher (tile 4), then read its tier-4 options.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';
import { enableTrustedCanvasClicks, clickTile, readLevelClass } from './lib/upgrades.mjs';

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'Sandbox' });
console.log('spawned sandbox:', ok);
if (!ok) { await ctx.close(); process.exit(0); }
await page.mouse.click(640, 360);
await page.waitForTimeout(200);
await enableTrustedCanvasClicks(page);

const burst = async (ms) => { await page.keyboard.down('k'); await page.waitForTimeout(ms); await page.keyboard.up('k'); await page.waitForTimeout(600); };
// Level well past 45 so both the Smasher skip (L30) and its tier-4 (L45) are immediately available.
await burst(800); await burst(800); await burst(800);
await page.waitForTimeout(400);
console.log('class before pick:', JSON.stringify(await readLevelClass(page)));
await page.screenshot({ path: evidence('sm-1-tank-panel.png') });

// Smasher = tile 4 (confirmed bottom-left).
await clickTile(page, 4);
await page.waitForTimeout(900);
console.log('class after Smasher pick:', JSON.stringify(await readLevelClass(page)));
await page.screenshot({ path: evidence('sm-2-smasher-tier4.png') });

await page.waitForTimeout(500);
await ctx.close();
