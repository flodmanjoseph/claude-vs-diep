import { launch, evidence } from './lib/launch.mjs';

const { ctx, page } = await launch();
await page.goto('https://diep.io', { waitUntil: 'domcontentloaded', timeout: 60_000 });

const frames = () => page.frames().filter((f) => f.url().includes('challenges.cloudflare')).map((f) => f.url().slice(40, 90));

for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1500);
  const live = await page.evaluate(() => (document.getElementById('canvas')?.getBoundingClientRect().width || 0) > 100);
  console.log(`t+${(i + 1) * 1.5}s live=${live} cfFrames=${JSON.stringify(frames())}`);
  if (live) { console.log('auto-cleared'); break; }
}
await page.screenshot({ path: evidence('dbg-ts-1.png') });

// The checkbox iframe is nested; click absolute screen coords (510,339) with human-like motion.
const hasCf = page.frames().some((f) => f.url().includes('challenges.cloudflare'));
console.log('cf frame present:', hasCf);
await page.mouse.move(300, 500, { steps: 4 });
await page.waitForTimeout(120);
await page.mouse.move(480, 345, { steps: 10 });
await page.waitForTimeout(150);
await page.mouse.move(510, 339, { steps: 5 });
await page.mouse.click(510, 339);
console.log('clicked checkbox at (510,339)');
// Wait generously for managed challenge to resolve.
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    return { live: (c?.getBoundingClientRect().width || 0) > 100, nick: !!document.getElementById('spawn-nickname') };
  });
  console.log(`post-click t+${(i + 1) * 1.5}s`, JSON.stringify(st), 'cfFrames=', JSON.stringify(frames()));
}
await page.screenshot({ path: evidence('dbg-ts-2.png') });

// Now try spawning.
await page.evaluate(() => { const nn = document.getElementById('spawn-nickname'); if (nn) { nn.value = 'claude'; nn.dispatchEvent(new Event('input', { bubbles: true })); } });
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);
console.log('after Enter, live:', await page.evaluate(() => (document.getElementById('canvas')?.getBoundingClientRect().width || 0) > 100));
await page.screenshot({ path: evidence('dbg-ts-3.png') });
await ctx.close();
