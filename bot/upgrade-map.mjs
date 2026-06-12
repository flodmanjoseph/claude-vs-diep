// Walk the class-upgrade tree in Sandbox: level up, read the available class tiles, click the
// best per a preference list (toward the drone line), screenshot each tier. Logs the whole path.
import { launch, spawn, evidence } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';

const PREFERENCE = [
  'Overlord', 'Overseer', 'Necromancer', 'Manager', 'Battleship', 'Factory',
  'Auto Gunner', 'Auto 5', 'Auto 3', 'Assassin', 'Ranger', 'Stalker', 'Sniper',
  'Triplet', 'Penta Shot', 'Spread Shot', 'Octo Tank', 'Twin Flank', 'Twin',
  'Gunner', 'Sprayer', 'Hunter', 'Trapper', 'Flank Guard', 'Machine Gun', 'Destroyer', 'Smasher',
];
const ALL_CLASSES = [...new Set([...PREFERENCE,
  'Quad Tank', 'Triple Shot', 'Auto Tank', 'Fighter', 'Hybrid', 'Annihilator', 'Skimmer',
  'Rocketeer', 'Predator', 'Streamliner', 'Booster', 'Tri-Angle', 'Mega Smasher', 'Landmine',
  'Auto Smasher', 'Spike', 'Glider', 'Mega Trapper', 'Tri-Trapper', 'Gunner Trapper',
  'Overtrapper', 'Bushwhacker', 'Auto 7', 'Spreadshot'])];

const { ctx, page } = await launch();
await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);

const ok = await spawn(page, { name: 'claude', gamemode: 'Sandbox' });
console.log('spawned sandbox:', ok);
if (!ok) { await ctx.close(); process.exit(0); }
await page.mouse.click(640, 360);
await page.waitForTimeout(200);

// Expose a DOM reader/clicker for upgrade tiles.
const readTiles = () => page.evaluate((classes) => {
  const out = [];
  for (const e of document.querySelectorAll('*')) {
    if (e.childElementCount !== 0) continue;
    const t = (e.textContent || '').trim();
    if (!classes.includes(t)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.x > 320 || r.y > 280) continue; // upgrade grid is top-left
    out.push({ t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: e.tagName, cls: (e.className || '').toString().slice(0, 30) });
  }
  // de-dup by label
  const seen = new Set();
  return out.filter((o) => (seen.has(o.t) ? false : seen.add(o.t)));
}, ALL_CLASSES);

const path = [];
const burst = async (ms) => { await page.keyboard.down('k'); await page.waitForTimeout(ms); await page.keyboard.up('k'); await page.waitForTimeout(500); };

for (let tier = 1; tier <= 5; tier++) {
  await burst(300); // ~+a few levels
  await page.waitForTimeout(400);
  let tiles = await readTiles();
  if (!tiles.length) { await burst(300); tiles = await readTiles(); } // level more if no tiles yet
  await page.screenshot({ path: evidence(`tree-tier-${tier}.png`) });
  if (!tiles.length) { console.log(`tier ${tier}: no upgrade tiles visible`); continue; }
  const labels = tiles.map((t) => t.t);
  const pick = PREFERENCE.find((p) => labels.includes(p)) || labels[0];
  const tile = tiles.find((t) => t.t === pick);
  console.log(`tier ${tier}: options=${JSON.stringify(labels)} -> pick ${pick} (${tile.tag}.${tile.cls})`);
  path.push({ tier, options: labels, picked: pick });
  // Click the tile (try DOM click then coordinate click).
  await page.evaluate((p) => {
    const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === p);
    if (el) { (el.closest('div') || el).click(); el.click(); }
  }, pick);
  await page.mouse.click(tile.x, tile.y);
  await page.waitForTimeout(700);
}

console.log('\nBUILD PATH:', JSON.stringify(path, null, 1));
await page.screenshot({ path: evidence('tree-final.png') });
await page.waitForTimeout(600);
await ctx.close();
