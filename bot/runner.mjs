// Shift runner: launch, inject perception + brain, play, log deaths, respawn, repeat.
// Env: SHIFT_MS (default 360000 = 6 min), NAME (default "claude").
import fs from 'node:fs';
import path from 'node:path';
import { launch, spawn, evidence, ROOT } from './lib/launch.mjs';
import { SCRAPE_INIT } from './perception/scrape.mjs';
import { STATE_FN } from './perception/state.mjs';
import { BRAIN_FN } from './brain/brain.mjs';
import { DOCTRINE as BASE_DOCTRINE, SMASHER_OVERRIDE } from './brain/doctrine.mjs';

// BUILD selects the tank build: 'overlord' (default drone build) or 'smasher' (ram build).
const BUILD = process.env.BUILD || 'overlord';
const DOCTRINE = BUILD === 'smasher' ? { ...BASE_DOCTRINE, ...SMASHER_OVERRIDE, version: 'smasher' } : BASE_DOCTRINE;
import { enableTrustedCanvasClicks, clickTile, readLevelClass } from './lib/upgrades.mjs';
import { Optimizer, lifeFitness } from './brain/optimizer.mjs';

const SHIFT_MS = +(process.env.SHIFT_MS || 360_000);
const NAME = process.env.NAME || 'claude';
const GAMEMODE = process.env.GAMEMODE || 'FFA';
const OPTIMIZE = process.env.OPTIMIZE === '1';
const RL = process.env.RL === '1'; // controlled RL experiment: freeze champion params, Q-learn modes
const opt = (OPTIMIZE && !RL) ? new Optimizer() : null;
const QPATH = path.join(ROOT, 'analysis', 'qtable.json');

// For the RL experiment we freeze the best-known parameters (the ES champion) so the only thing
// changing is the learned mode policy. A/B'd against the hand rules via per-life fitness.
function loadChampionParams() {
  try { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'optimizer-state.json'), 'utf8')); return s.champion?.params || {}; } catch { return {}; }
}
function loadQTable() { try { return JSON.parse(fs.readFileSync(QPATH, 'utf8')); } catch { return { q: {}, meta: { decisions: 0, eps: 0 } }; } }
function saveQTable(d) { try { fs.writeFileSync(QPATH, JSON.stringify(d)); } catch {} }
const rlDoctrine = RL ? { ...DOCTRINE, ...loadChampionParams(), rl: { ...DOCTRINE.rl, enabled: true }, version: 'rl-champion' } : null;

// Per-life bests, used to score the life for the optimizer / RL comparison.
let lifeMaxScore = 0, lifeMaxLevel = 0;
async function applyNextDoctrine() {
  lifeMaxScore = 0; lifeMaxLevel = 0;
  if (RL) { await page.evaluate((doc) => window.__setDoctrine && window.__setDoctrine(doc), rlDoctrine).catch(() => {}); return; }
  if (!opt) return;
  const d = opt.nextDoctrine();
  await page.evaluate((doc) => window.__setDoctrine && window.__setDoctrine(doc), d).catch(() => {});
  log({ event: 'doctrine_assigned', version: d.version, status: opt.status() });
}
function scoreLife() {
  const fit = lifeFitness({ score: lifeMaxScore, level: lifeMaxLevel, lifeMs: Date.now() - lifeStart });
  const tag = opt ? 'es' : RL ? 'rl' : 'rules';
  if (opt) opt.record(fit);
  // Always log per-life fitness so any build/policy can be A/B compared from telemetry.
  log({ event: 'life_scored', mode: tag, build: BUILD, fitness: Math.round(fit), score: lifeMaxScore, level: lifeMaxLevel, lifeMs: Date.now() - lifeStart, ...(opt ? { gen: opt.status().gen, champion: opt.status().champion } : {}) });
  console.log(`  ${BUILD} life fitness ${Math.round(fit)} (score ${lifeMaxScore}, L${lifeMaxLevel})${opt ? ` | gen ${opt.status().gen} ${opt.status().evalsThisGen}` : ''}`);
}
const TELEM = path.join(ROOT, 'telemetry');
const shiftId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(TELEM, `shift-${shiftId}.jsonl`);
const log = (obj) => fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...obj }) + '\n');

const { ctx, page } = await launch();
page.on('console', (m) => { if (m.type() === 'error') log({ event: 'pageerror', text: m.text().slice(0, 200) }); });

await page.addInitScript(SCRAPE_INIT);
await page.addInitScript(STATE_FN);
if (RL) {
  const seed = loadQTable();
  await page.addInitScript(`window.__qtableSeed = ${JSON.stringify(seed.q || {})}; window.__rlMetaSeed = ${JSON.stringify(seed.meta || { decisions: 0 })};`);
  console.log(`RL experiment: champion params frozen, Q-learning modes. seed ${Object.keys(seed.q || {}).length} states, ${seed.meta?.decisions || 0} prior decisions.`);
}
await page.addInitScript(`(${BRAIN_FN})(${JSON.stringify(DOCTRINE)})`);

log({ event: 'shift_start', shiftId, doctrine: DOCTRINE.version, shiftMs: SHIFT_MS });
console.log(`shift ${shiftId} | doctrine v${DOCTRINE.version} | ${SHIFT_MS / 1000}s`);

async function isAlive() {
  return page.evaluate(() => { const s = window.__readState?.(); return !!(s && s.ok && s.me.alive); }).catch(() => false);
}
async function canvasLive() {
  return page.evaluate(() => { const c = document.getElementById('canvas'); return c ? c.getBoundingClientRect().width > 100 : false; }).catch(() => false);
}
// Sample the leaderboard over a short window (entries are cached and redraw intermittently),
// collecting the distinct scores seen = the board. Our own score comes from the HUD accumulator.
// Estimated rank = 1 + (scores clearly above ours), which is robust when the board is well sampled.
async function readRank() {
  const r = await page.evaluate(() => {
    return new Promise((resolve) => {
      const scores = new Set(); const t0 = performance.now();
      const parse = (s) => { const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim()); if (!m) return null; let v = parseFloat(m[1]); if (/k/i.test(m[2])) v *= 1e3; if (/m/i.test(m[2])) v *= 1e6; return v; };
      const tick = () => {
        const f = window.__diep?.frame;
        if (f) for (const t of f.texts) { const v = parse(t.t); if (v != null && v >= 100 && v < 5e6) scores.add(Math.round(v)); }
        if (performance.now() - t0 < 800) setTimeout(tick, 10);
        else resolve({ board: [...scores].sort((a, b) => b - a).slice(0, 12), myScore: window.__diep?.hud?.score ?? null });
      };
      tick();
    });
  }).catch(() => ({ board: [], myScore: null }));
  const board = r.board || [];
  const myScore = r.myScore;
  const leaderMax = board[0] ?? null;
  let estRank = null;
  if (myScore && board.length) estRank = 1 + board.filter((s) => s > myScore * 1.03).length;
  return { leaderMax, myScore, board, boardSize: board.length, estRank };
}

async function spawnFresh() {
  const ok = await spawn(page, { name: NAME, gamemode: GAMEMODE });
  await enableTrustedCanvasClicks(page); // let trusted upgrade clicks reach the canvas
  await applyNextDoctrine();
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
  await applyNextDoctrine();
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
let lastQSave = 0;
let deadSince = 0;
let extending = false;
let bestRank = 99;
let rank1Streak = 0;

// A shift ends at SHIFT_MS, EXCEPT while the current life is still going: a strong life is the
// whole point, so we extend until it ends naturally (hard cap 4x to bound the process).
const HARD_CAP = SHIFT_MS * 4;

while (true) {
  await page.waitForTimeout(400);
  const elapsed = Date.now() - t0;

  const alive = await isAlive();
  const live = await canvasLive();

  if (elapsed >= HARD_CAP) break;
  // Past the shift timer we keep going while a life is in progress; the shift ends only when the
  // current life's death has been fully recorded (the break lives in the death block below). Do
  // NOT break here on first detecting death, or that death's screenshot/post-mortem is lost.
  if (elapsed >= SHIFT_MS && alive && !extending) {
    extending = true; log({ event: 'shift_extending', elapsed });
    console.log('shift timer up but life in progress; extending until death');
  }

  // Take class upgrades when available (gated by current class), every ~1.5s while alive.
  if (alive && elapsed - lastUpgrade > 1500) {
    lastUpgrade = elapsed;
    await takeUpgrades().catch(() => {});
  }

  // Heartbeat telemetry every 5s.
  if (elapsed - lastHeartbeat > 5000) {
    lastHeartbeat = elapsed;
    const snap = await page.evaluate(() => window.__brain?.snapshot?.() ?? null).catch(() => null);
    const { leaderMax, myScore, board, boardSize, estRank } = await readRank();
    if (myScore) lifeMaxScore = Math.max(lifeMaxScore, myScore);
    lifeMaxLevel = Math.max(lifeMaxLevel, curLevel);
    if (estRank != null) bestRank = Math.min(bestRank, estRank);
    log({ event: 'heartbeat', elapsed, alive, life: Date.now() - lifeStart, deaths, cls: curClass, lvl: curLevel, mode: snap?.mode, myScore, leaderMax, estRank, boardSize, optGen: opt?.status().gen });

    // True #1 detection: estimated rank 1 on a well-populated board, sustained across samples, so
    // a fluke sample can't false-trigger. On confirmation, burst-capture clean evidence and flag.
    if (alive && estRank === 1 && boardSize >= 7 && myScore > 5000) {
      rank1Streak++;
      if (rank1Streak >= 3) {
        const shot = evidence(`NUMBER-ONE-${shiftId}-${Math.round(myScore)}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        log({ event: 'number_one', myScore, board, screenshot: path.basename(shot) });
        console.log(`*** RANK 1 *** score ${myScore}, board ${JSON.stringify(board.slice(0, 5))} -> ${path.basename(shot)}`);
        // Drop a victory marker for the supervising agent to verify and act on (notify Joe).
        try { fs.writeFileSync(path.join(ROOT, 'evidence', 'VICTORY.json'), JSON.stringify({ ts: Date.now(), myScore, board, cls: curClass, lvl: curLevel, screenshot: path.basename(shot), shiftId, verified: false }, null, 1)); } catch {}
      }
    } else {
      rank1Streak = 0;
    }
  }
  // Evidence screenshot every 20s (rolling latest + timeline).
  if (elapsed - lastShot > 20000) {
    lastShot = elapsed;
    await page.screenshot({ path: evidence('latest.png') }).catch(() => {});
  }
  // Persist the Q-table every 15s so the RL policy survives restarts.
  if (RL && elapsed - lastQSave > 15000) {
    lastQSave = elapsed;
    const snap = await page.evaluate(() => ({ q: window.__qtable, meta: window.__rlMeta })).catch(() => null);
    if (snap && snap.q) { saveQTable(snap); log({ event: 'rl_save', states: Object.keys(snap.q).length, decisions: snap.meta?.decisions, eps: snap.meta?.eps }); }
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
      lifeMaxLevel = Math.max(lifeMaxLevel, curLevel);
      log({ event: 'death', n: deaths, lifeMs: life, cls: curClass, lvl: curLevel, screenshot: path.basename(shotPath), enemiesNear: lastState?.enemies?.slice(0, 3) ?? [] });
      console.log(`death #${deaths} after ${(life / 1000).toFixed(0)}s as ${curClass} L${curLevel}`);
      scoreLife();
      deadSince = 0;
      if (elapsed >= SHIFT_MS) break; // shift timer already up: record the death, don't respawn
      await respawn();
      lifeStart = Date.now();
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
