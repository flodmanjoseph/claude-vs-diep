// Shift runner: launch, inject perception + brain, play, log deaths, respawn, repeat.
// Env: SHIFT_MS (default 360000 = 6 min), NAME (default "claude").
import fs from 'node:fs';
import path from 'node:path';
import { launch, spawn, evidence, ROOT } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';
import { BRAIN_FN } from './brain/brain.mjs';
import { DOCTRINE } from './brain/doctrine.mjs';

const SHIFT_MS = +(process.env.SHIFT_MS || 360_000);
const NAME = process.env.NAME || 'claude';
const TELEM = path.join(ROOT, 'telemetry');
const shiftId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(TELEM, `shift-${shiftId}.jsonl`);
const log = (obj) => fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...obj }) + '\n');

const { ctx, page } = await launch();
page.on('console', (m) => { if (m.type() === 'error') log({ event: 'pageerror', text: m.text().slice(0, 200) }); });

await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);
await page.addInitScript(`(${BRAIN_FN})(${JSON.stringify(DOCTRINE)})`);

log({ event: 'shift_start', shiftId, doctrine: DOCTRINE.version, shiftMs: SHIFT_MS });
console.log(`shift ${shiftId} | doctrine v${DOCTRINE.version} | ${SHIFT_MS / 1000}s`);

async function isAlive() {
  return page.evaluate(() => { const s = window.__readState?.(); return !!(s && s.ok && s.me.alive); }).catch(() => false);
}
async function canvasLive() {
  return page.evaluate(() => { const c = document.getElementById('canvas'); return c ? c.getBoundingClientRect().width > 100 : false; }).catch(() => false);
}
// Best-effort: pull the largest leaderboard number we've seen rendered (the current #1 score).
async function readLeaderTop() {
  return page.evaluate(() => {
    const f = window.__diep?.frame; if (!f) return null;
    const nums = [];
    for (const t of f.texts) {
      const m = /^([\d.]+)\s*([km]?)$/i.exec(t.t.trim());
      if (m) { let v = parseFloat(m[1]); if (/k/i.test(m[2])) v *= 1e3; if (/m/i.test(m[2])) v *= 1e6; nums.push(v); }
    }
    return nums.length ? Math.max(...nums) : null;
  }).catch(() => null);
}

async function spawnFresh() {
  const ok = await spawn(page, { name: NAME });
  await page.evaluate(() => window.__brain && window.__brain.start());
  log({ event: 'spawn', ok });
  return ok;
}

async function respawn() {
  await page.evaluate(() => window.__brain && window.__brain.stop());
  // Death screen -> press Enter / click continue to return home, then play again.
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);
  if (!(await canvasLive())) {
    // back at home screen: set nickname + enter again
    await page.evaluate((nm) => { const nn = document.getElementById('spawn-nickname'); if (nn) { nn.value = nm; nn.dispatchEvent(new Event('input', { bubbles: true })); } }, NAME);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => window.__brain && window.__brain.start());
}

const ok = await spawnFresh();
if (!ok) { log({ event: 'spawn_failed' }); await ctx.close(); process.exit(1); }

const t0 = Date.now();
let lifeStart = Date.now();
let life = 0;
let deaths = 0;
let lastHeartbeat = 0;
let lastShot = 0;
let deadSince = 0;

while (Date.now() - t0 < SHIFT_MS) {
  await page.waitForTimeout(400);
  const elapsed = Date.now() - t0;

  const alive = await isAlive();
  const live = await canvasLive();

  // Heartbeat telemetry every 5s.
  if (elapsed - lastHeartbeat > 5000) {
    lastHeartbeat = elapsed;
    const snap = await page.evaluate(() => window.__brain?.snapshot?.() ?? null).catch(() => null);
    const leaderTop = await readLeaderTop();
    log({ event: 'heartbeat', elapsed, alive, life: Date.now() - lifeStart, deaths, mode: snap?.mode, frames: snap?.frames, statIdx: snap?.statIdx, leaderTop });
  }
  // Evidence screenshot every 20s (rolling latest + timeline).
  if (elapsed - lastShot > 20000) {
    lastShot = elapsed;
    await page.screenshot({ path: evidence('latest.png') }).catch(() => {});
  }

  if (!live) {
    // Possibly arena closed / disconnected. Try to get back in.
    log({ event: 'canvas_lost', elapsed });
    await page.waitForTimeout(1500);
    if (!(await canvasLive())) { await page.goto('https://diep.io', { waitUntil: 'domcontentloaded' }).catch(() => {}); await spawnFresh(); lifeStart = Date.now(); }
    continue;
  }

  if (!alive) {
    if (!deadSince) deadSince = Date.now();
    else if (Date.now() - deadSince > 1500) {
      // Confirmed dead. Record the death.
      deaths++;
      life = Date.now() - lifeStart;
      const shotPath = evidence(`death-${shiftId}-${deaths}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      const lastState = await page.evaluate(() => window.__readState?.() ?? null).catch(() => null);
      log({ event: 'death', n: deaths, lifeMs: life, screenshot: path.basename(shotPath), enemiesNear: lastState?.enemies?.slice(0, 3) ?? [] });
      console.log(`death #${deaths} after ${(life / 1000).toFixed(0)}s`);
      await respawn();
      lifeStart = Date.now();
      deadSince = 0;
    }
  } else {
    deadSince = 0;
  }
}

await page.screenshot({ path: evidence(`shift-end-${shiftId}.png`) }).catch(() => {});
log({ event: 'shift_end', elapsed: Date.now() - t0, deaths });
console.log(`shift done: ${deaths} deaths over ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await page.evaluate(() => window.__brain && window.__brain.stop()).catch(() => {});
await ctx.close();
