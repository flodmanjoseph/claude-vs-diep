// Map the class-upgrade UI: level up incrementally in Sandbox and screenshot each tier.
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

const burst = async (ms) => { await page.keyboard.down('k'); await page.waitForTimeout(ms); await page.keyboard.up('k'); await page.waitForTimeout(500); };
for (let r = 1; r <= 5; r++) {
  await burst(350);
  await page.mouse.move(640, 360);
  await page.screenshot({ path: evidence(`up-tier-${r}.png`) });
  console.log(`captured up-tier-${r}.png`);
}

await page.waitForTimeout(600);
await ctx.close();
