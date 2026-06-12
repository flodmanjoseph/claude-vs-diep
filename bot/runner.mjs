// Shift runner: launch, inject perception + brain, play, log deaths, respawn, repeat.
// Env: SHIFT_MS (default 360000 = 6 min), NAME (default "claude").
import fs from 'node:fs';
import path from 'node:path';
import { launch, spawn, evidence, ROOT } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';
import { BRAIN_FN } from './brain/brain.mjs';
import { DOCTRINE } from './brain/doctrine.mjs';
import { enableTrustedCanvasClicks, clickTile, readLevelClass } from './lib/upgrades.mjs';

const SHIFT_MS = +(process.env.SHIFT_MS || 360_000);
const NAME = process.env.NAME || 'claude';
const GAMEMODE = process.env.GAMEMODE || 'FFA';
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
// Sample the leaderboard over a short window (entries are cached and redraw intermittently) and
// return the max score = the current #1. Also returns our own score from the HUD accumulator.
async function readRank() {
  return page.evaluate(() => {
    return new Promise((resolve) => {
      let leaderMax = 0; const t0 = performance.now();
      const parse = (s) => { const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim()); if (!m) return null; let v = parseFloat(m[1]); if (/k/i.test(m[2])) v *= 1e3; if (/m/i.test(m[2])) v *= 1e6; return v; };
      const tick = () => {
        const f = window.__diep?.frame;
        if (f) for (const t of f.texts) { const v = parse(t.t); if (v != null && v < 5e6) leaderMax = Math.max(leaderMax, v); }
        if (performance.now() - t0 < 700) setTimeout(tick, 10);
        else resolve({ leaderMax: leaderMax || null, myScore: window.__diep?.hud?.score ?? null });
      };
      tick();
    });
  }).catch(() => ({ leaderMax: null, myScore: null }));
}

async function spawnFresh() {
  const ok = await spawn(page, { name: NAME, gamemode: GAMEMODE });
  await enableTrustedCanvasClicks(page); // let trusted upgrade clicks reach the canvas
  await page.evaluate(() => window.__brain && window.__brain.start());
  log({ event: 'spawn', ok });
  return ok;
}

// Class-upgrade state for the current life. Gated by current class so the right tile is clicked.
let curClass = 'Tank';
let curLevel = 1;
const doneSteps = new Set();
function resetUpgrades() { curClass = 'Tank'; curLevel = 1; doneSteps.clear(); }

async function takeUpgrades() {
  const lc = await readLevelClass(page);
  if (lc) { curClass = lc.cls; curLevel = lc.level; }
  // Mark steps whose target class we've reached as done.
  DOCTRINE.buildPath.forEach((s, i) => { if (curClass === s.to) doneSteps.add(i); });
  // Find the next step to take: matches current class, not done, level threshold met.
  const idx = DOCTRINE.buildPath.findIndex((s, i) => !doneSteps.has(i) && s.from === curClass && curLevel >= (s.minLevel || 0));
  if (idx < 0) return;
  const step = DOCTRINE.buildPath[idx];
  // Pause the brain so its per-frame synthetic aim (mousemove) does not drag diep's tracked
  // pointer off the tile between our move and mousedown. Trusted UI clicks need a stable pointer.
  await page.evaluate(() => window.__brain && window.__brain.pause()).catch(() => {});
  await enableTrustedCanvasClicks(page);
  await clickTile(page, step.tile);
  await page.evaluate(() => window.__brain && window.__brain.resume()).catch(() => {});
  log({ event: 'upgrade_attempt', from: step.from, tile: step.tile, to: step.to, level: curLevel });
  // Re-read shortly to confirm.
  await page.waitForTimeout(400);
  const lc2 = await readLevelClass(page);
  if (lc2 && lc2.cls === step.to) { doneSteps.add(idx); curClass = lc2.cls; log({ event: 'upgrade_ok', to: step.to }); console.log(`upgraded -> ${step.to}`); }
}

// Get from the death screen back into the arena. The death screen -> menu transition takes a
// moment, so poll until we are actually ALIVE again, re-issuing the spawn action each round.
// (A one-shot Enter often lands on the menu, which the main loop then miscounts as a death.)
async function respawn() {
  await page.evaluate(() => window.__brain && window.__brain.stop());
  let alive = false;
  for (let i = 0; i < 24 && !alive; i++) {
    await page.evaluate((nm) => { const nn = document.getElementById('spawn-nickname'); if (nn) { nn.value = nm; nn.dispatchEvent(new Event('input', { bubbles: true })); } }, NAME);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(700);
    alive = await isAlive();
  }
  log({ event: 'respawned', alive });
  await enableTrustedCanvasClicks(page);
  resetUpgrades();
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
let lastUpgrade = 0;
let deadSince = 0;

while (Date.now() - t0 < SHIFT_MS) {
  await page.waitForTimeout(400);
  const elapsed = Date.now() - t0;

  const alive = await isAlive();
  const live = await canvasLive();

  // Take class upgrades when available (gated by current class), every ~1.5s while alive.
  if (alive && elapsed - lastUpgrade > 1500) {
    lastUpgrade = elapsed;
    await takeUpgrades().catch(() => {});
  }

  // Heartbeat telemetry every 5s.
  if (elapsed - lastHeartbeat > 5000) {
    lastHeartbeat = elapsed;
    const snap = await page.evaluate(() => window.__brain?.snapshot?.() ?? null).catch(() => null);
    const { leaderMax, myScore } = await readRank();
    const pct = leaderMax && myScore ? +(100 * myScore / leaderMax).toFixed(1) : null;
    log({ event: 'heartbeat', elapsed, alive, life: Date.now() - lifeStart, deaths, cls: curClass, lvl: curLevel, mode: snap?.mode, myScore, leaderMax, pctOfLeader: pct });
    // Victory check: our score at or above the current leader (and a real score), capture evidence.
    if (alive && myScore && leaderMax && myScore >= leaderMax && myScore > 1000) {
      await page.screenshot({ path: evidence(`LEADER-${shiftId}-${Math.round(myScore)}.png`) }).catch(() => {});
      log({ event: 'possible_number_one', myScore, leaderMax });
    }
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
      log({ event: 'death', n: deaths, lifeMs: life, cls: curClass, lvl: curLevel, screenshot: path.basename(shotPath), enemiesNear: lastState?.enemies?.slice(0, 3) ?? [] });
      console.log(`death #${deaths} after ${(life / 1000).toFixed(0)}s as ${curClass} L${curLevel}`);
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
