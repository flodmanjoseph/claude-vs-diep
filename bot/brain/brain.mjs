// The in-page brain. Runs at requestAnimationFrame rate: read perception, decide, dispatch
// synthetic input. Exposes window.__brain for the runner to start/stop and read stats.
// Injected as a factory that receives the doctrine object.
export const BRAIN_FN = function (initialDoctrine) {
  // DOCTRINE is mutable so the runner can hot-swap it per life (the evolutionary optimizer assigns
  // a candidate before each respawn). All helpers read this binding, so the swap takes effect live.
  let DOCTRINE = initialDoctrine;
  window.__setDoctrine = (d) => { if (d) DOCTRINE = d; };
  window.__getDoctrineVersion = () => DOCTRINE.version;
  // Q-learning state lives on window so the runner can seed it on launch and persist it to disk.
  window.__qtable = window.__qtableSeed || window.__qtable || {};
  window.__rlMeta = window.__rlMetaSeed || window.__rlMeta || { decisions: 0, eps: 0 };
  const CENTER = { x: 640, y: 360 };
  const KEYCODE = { w: 87, a: 65, s: 83, d: 68, e: 69, c: 67, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56 };

  const dispatchKey = (type, ch) => {
    const code = /\d/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase();
    const ev = new KeyboardEvent(type, { key: ch, code, keyCode: KEYCODE[ch], which: KEYCODE[ch], bubbles: true, cancelable: true });
    document.dispatchEvent(ev); window.dispatchEvent(ev);
    const cv = document.getElementById('canvas'); if (cv) cv.dispatchEvent(ev);
  };
  const tapKey = (ch) => { dispatchKey('keydown', ch); dispatchKey('keyup', ch); };
  const held = new Set();
  const setHeld = (want) => {
    for (const k of held) if (!want.has(k)) { dispatchKey('keyup', k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { dispatchKey('keydown', k); held.add(k); }
  };
  const releaseAll = () => { setHeld(new Set()); setMouseHold(false); };

  const moveMouse = (x, y) => {
    const cv = document.getElementById('canvas');
    const ev = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, cancelable: true });
    (cv || document).dispatchEvent(ev);
    window.__lastAim = { x, y };
  };

  // Hold/release the left mouse button. For drone tanks (Overseer/Overlord) holding it sends the
  // drones toward the cursor (our aim), which is how they farm and fight.
  let mouseDown = false;
  function setMouseHold(down) {
    const cv = document.getElementById('canvas');
    const a = window.__lastAim || { x: 900, y: 360 };
    if (down && !mouseDown) { cv && cv.dispatchEvent(new MouseEvent('mousedown', { clientX: a.x, clientY: a.y, button: 0, buttons: 1, bubbles: true, cancelable: true })); mouseDown = true; }
    else if (!down && mouseDown) { cv && cv.dispatchEvent(new MouseEvent('mouseup', { clientX: a.x, clientY: a.y, button: 0, buttons: 0, bubbles: true, cancelable: true })); mouseDown = false; }
  }

  // Convert a desired screen-space vector into the set of WASD keys to hold (8-direction).
  const vectorToKeys = (vx, vy) => {
    const keys = new Set();
    const mag = Math.hypot(vx, vy) || 1;
    const nx = vx / mag, ny = vy / mag;
    if (ny < -0.38) keys.add('w');
    if (ny > 0.38) keys.add('s');
    if (nx < -0.38) keys.add('a');
    if (nx > 0.38) keys.add('d');
    return keys;
  };

  const B = (window.__brain = {
    running: false,
    frames: 0,
    lastStat: 0,
    statIdx: 0,
    autofireOn: false,
    deaths: 0,
    lastAliveFrame: 0,
    mode: 'init',
    // Predator (hunter) avoidance: a tank clearly bigger than us is a likely leaderboard hunter.
    // hunterStreak counts consecutive frames a big tank has persisted (multi-frame confirmation so a
    // single-frame size misread can't trigger flight); hunterLast is its latest position to flee.
    // activeEncounter records the current confirmed-hunter episode for instrumentation.
    hunterStreak: 0,
    hunterLast: null,
    activeEncounter: null,
    // v19 lead-protection: the runner pushes live leaderboard rank here each heartbeat via __setMeta.
    meta: { estRank: null, leaderMax: null, myScore: null, boardSize: 0 },
    _raf: null,
  });
  // Live rank/board push channel from the runner (mirrors __setDoctrine). Pure additive; only step()
  // reads B.meta, so a stale/missing push just means we don't apply lead-protection that frame.
  window.__setMeta = (m) => { if (m) B.meta = m; };
  // Closed hunter encounters wait here for the runner to drain into telemetry (detected/fled/outcome).
  window.__hunterLog = window.__hunterLog || [];

  const now = () => performance.now();

  function ensureAutofire() {
    if (DOCTRINE.autofire && !B.autofireOn) { tapKey('e'); B.autofireOn = true; }
  }

  function allocStats() {
    if (now() - B.lastStat < DOCTRINE.statTickMs) return;
    B.lastStat = now();
    // v25 phase-aware perks: a drone class invests in the KILL+SURVIVE build (drone damage/health,
    // reload, health) to win tank fights, not the farming build. On the phase flip, reset the index so
    // the new sequence starts from its top priorities (the next points go to the stats that matter now).
    const cls = (window.__diep && window.__diep.hud && window.__diep.hud.cls) || 'Tank';
    const isDrone = DOCTRINE.droneClasses.includes(cls);
    const seq = (isDrone && DOCTRINE.droneStatSequence) ? DOCTRINE.droneStatSequence : DOCTRINE.statSequence;
    if (isDrone !== B._lastAllocDrone) { B.statIdx = 0; B._lastAllocDrone = isDrone; }
    const stat = seq[B.statIdx % seq.length];
    B.statIdx++;
    tapKey(String(stat));
  }

  // bestShape picks the farm target. v17: when threatened, a shape in the direction of the threats
  // costs extra "distance" (safeShapeBias * how-much-toward-threats it is), so farming naturally pulls
  // us into open space instead of toward the foes closing on us - farming itself becomes defensive.
  // v20 economy: pentagonBonus gives pentagons a distance discount (they're worth far more XP than
  // squares/triangles, and alpha pentagons hugely more) so a drone class farming SAFELY prioritizes
  // them - a conservative score-ceiling boost (a discount, not a cross-map nest trek). The caller
  // only passes it >0 when isDrone AND pressure is low (pressure-veto), so it never overrides safety.
  function bestShape(shapes, toward, pressure, pentagonBonus) {
    if (!shapes.length) return null;
    const rank = (k) => { const i = DOCTRINE.preferKinds.indexOf(k); return i < 0 ? 5 : i; };
    const bias = (DOCTRINE.safeShapeBias || 0) * Math.min(1, (pressure || 0) / (DOCTRINE.pressureCap || 0.06));
    let best = null, bestScore = Infinity;
    for (const s of shapes) {
      let score = s.dist + rank(s.kind) * DOCTRINE.kindDistancePenalty;
      if (pentagonBonus && s.kind === 'pentagon') score -= pentagonBonus;
      if (bias > 0 && toward && (toward[0] * toward[0] + toward[1] * toward[1] > 0.001)) {
        const m = s.dist || 1;
        const dot = (s.dx / m) * toward[0] + (s.dy / m) * toward[1]; // >0 => toward the threats
        if (dot > 0) score += dot * bias;
      }
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  const enemiesOf = (state) => state.enemies.filter((e) => !e.self);

  // v24: the best KILL target. You don't reach #1 by eating shapes - leaders get there by killing
  // tanks (you absorb a chunk of their score). Once we're a drone class, HUNT the weakest reachable
  // tank (smaller radius = lower level), preferring near + isolated ones (fewer of its own allies
  // around it to retaliate). Radius is our only power proxy (no level/health read), so we only commit
  // to a tank clearly smaller than us - a fight we win - and leave bigger/equal ones to the flee logic.
  function bestPrey(foes, myR) {
    let best = null, bestScore = Infinity;
    for (const e of foes) {
      if (e.r >= myR * (DOCTRINE.preyRatio || 0.85)) continue; // not clearly weaker -> not prey
      if (e.dist > (DOCTRINE.huntRange || 340)) continue;
      let allies = 0;
      for (const o of foes) if (o !== e && Math.hypot(o.x - e.x, o.y - e.y) < (DOCTRINE.preyCrowdRadius || 220)) allies++;
      const score = e.dist + allies * (DOCTRINE.preyCrowdPenalty || 200);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // Pick the 8-direction heading that moves most away from all weighted threats (toward open
  // space). Bigger/closer enemies and incoming bullets weigh more. Beats a raw repulsion sum,
  // which can point straight through a third enemy.
  // Threat geometry (v17): the corpus says 84% of deaths are point-blank with >=2 foes converging,
  // i.e. we get COLLAPSED on while farming. Reactive escape-radius triggers too late. Instead we read
  // the whole threat field every frame: a continuous `pressure` scalar, the direction `away` from the
  // weighted threat centroid, and `gapDir` - the bisector of the LARGEST angular gap between nearby
  // foes, i.e. the most-open lane out. gapDir is geometry-correct where 8-way sampling is crude: one
  // foe -> straight opposite it; two foes pincering us -> perpendicular to their axis (the only way
  // out). maxGapDeg small => we are surrounded with no clean lane (force a hard breakout early).
  function threatGeometry(foes) {
    const R = DOCTRINE.spacingRadius || 400;
    const SR = DOCTRINE.surroundRadius || 300;
    let pressure = 0, cx = 0, cy = 0;
    const bearings = [];
    for (const e of foes) {
      if (e.dist > R) continue;
      const w = (1 + e.r * DOCTRINE.enemySizeWeight) / Math.max(40, e.dist);
      pressure += w;
      cx += (e.dx / (e.dist || 1)) * w;
      cy += (e.dy / (e.dist || 1)) * w;
      if (e.dist < SR) bearings.push(Math.atan2(e.dy, e.dx));
    }
    let gapDir = null, maxGap = Math.PI * 2;
    if (bearings.length) {
      bearings.sort((a, b) => a - b);
      maxGap = 0; let gapMid = bearings[0] + Math.PI;
      for (let i = 0; i < bearings.length; i++) {
        const a = bearings[i], b = (i + 1 < bearings.length) ? bearings[i + 1] : bearings[0] + Math.PI * 2;
        const g = b - a;
        if (g > maxGap) { maxGap = g; gapMid = a + g / 2; }
      }
      gapDir = [Math.cos(gapMid), Math.sin(gapMid)];
    }
    const cmag = Math.hypot(cx, cy) || 1;
    return { pressure, toward: [cx / cmag, cy / cmag], away: [-cx / cmag, -cy / cmag], gapDir, maxGapDeg: (maxGap * 180) / Math.PI, nThreat: bearings.length };
  }

  const DIRS = [[0, -1], [0.71, -0.71], [1, 0], [0.71, 0.71], [0, 1], [-0.71, 0.71], [-1, 0], [-0.71, -0.71]];
  function bestEscapeDir(state, priority, extraDirs) {
    let best = [0, 1], bestScore = -Infinity;
    const foes = enemiesOf(state);
    const pos = state.map; // normalized map position or null
    // The open-lane heading(s) from threatGeometry are evaluated alongside the 8 compass dirs, so the
    // geometry-correct escape still gets the wall/bullet penalties below before being chosen.
    const dirs = extraDirs && extraDirs.length ? DIRS.concat(extraDirs.filter(Boolean)) : DIRS;
    for (const [dx, dy] of dirs) {
      let score = 0;
      // Never flee into an arena wall: penalize headings that push past an edge we're already near.
      if (pos) {
        const m = DOCTRINE.wallMargin;
        if ((pos.x < m && dx < 0) || (pos.x > 1 - m && dx > 0)) score -= 5;
        if ((pos.y < m && dy < 0) || (pos.y > 1 - m && dy > 0)) score -= 5;
      }
      // A confirmed predator dominates the choice: heading toward it is heavily penalized so we put
      // real distance between us and the hunter, not just drift off the average threat vector.
      if (priority) {
        const m = Math.hypot(priority.dx, priority.dy) || 1;
        const toward = (dx * priority.dx + dy * priority.dy) / m;
        score -= toward * 600;
      }
      for (const e of foes) {
        const m = Math.hypot(e.dx, e.dy) || 1;
        const toward = (dx * e.dx + dy * e.dy) / m; // >0 => heading toward this enemy
        const w = (1 + e.r * DOCTRINE.enemySizeWeight) / Math.max(50, e.dist);
        score -= toward * w * 200;
      }
      for (const b of state.bullets) {
        if (!b.enemy) continue;
        const m = Math.hypot(b.dx, b.dy) || 1;
        const toward = (dx * b.dx + dy * b.dy) / m;
        score -= toward * (1 / Math.max(40, b.dist)) * 120;
      }
      if (score > bestScore) { bestScore = score; best = [dx, dy]; }
    }
    return best;
  }

  // Effective distance of an enemy: its real distance minus how much it will close in the next
  // ~anticipationFrames. A fast rammer 300px away is nearer, threat-wise, than a parked tank at 220.
  function effectiveDist(e) {
    const sp = Math.hypot(e.vx || 0, e.vy || 0);
    if (!sp) return e.dist;
    const closing = -((e.dx * (e.vx || 0)) + (e.dy * (e.vy || 0))) / (e.dist || 1); // px/frame toward us
    return e.dist - Math.max(0, closing) * DOCTRINE.anticipationFrames;
  }

  // Velocity-based bullet dodge: find the most urgent enemy bullet aimed at us whose predicted
  // miss distance is small, and return a unit sidestep perpendicular to its flight path, on the
  // side of the line we are already on (increases miss distance fastest).
  function bulletDodge(state) {
    let urgent = null, urgency = Infinity;
    for (const b of state.bullets) {
      if (!b.enemy || b.dist > DOCTRINE.bulletDodgeRadius) continue;
      const sp = Math.hypot(b.vx || 0, b.vy || 0);
      if (sp < 1.5) continue;
      const aimedCos = (-(b.dx * b.vx) - (b.dy * b.vy)) / ((b.dist || 1) * sp);
      if (aimedCos < DOCTRINE.bulletAimedCos) continue;
      const miss = b.dist * Math.sqrt(Math.max(0, 1 - aimedCos * aimedCos));
      if (miss > DOCTRINE.bulletMissMargin) continue;
      const eta = b.dist / sp; // frames until arrival
      if (eta < urgency) { urgency = eta; urgent = b; }
    }
    if (!urgent) return null;
    const sp = Math.hypot(urgent.vx, urgent.vy);
    const cross = urgent.vx * (-urgent.dy) - urgent.vy * (-urgent.dx);
    const s = cross >= 0 ? 1 : -1;
    return [(-urgent.vy / sp) * s, (urgent.vx / sp) * s];
  }

  // --- Q-learning mode arbitration (real RL: tabular TD(0), epsilon-greedy, reward-driven) ---
  // State is a coarse discretization of the tactical situation; actions are the macro-modes.
  function qStateKey(state, c) {
    const drone = c.isDrone ? 'D' : 'G';
    const threat = !c.nearest ? '0' : c.nd < c.escapeR ? 'N' : c.nd < DOCTRINE.waryRadius ? 'W' : 'F';
    const rel = !c.nearest ? '-' : c.nearest.r < c.myR * 0.85 ? 's' : c.nearest.r > c.myR * 1.15 ? 'b' : 'e';
    const crowd = c.foes.length >= 2 ? '2' : c.foes.length === 1 ? '1' : '0';
    const bul = c.bulletThreat ? 'B' : '.';
    const shp = state.shapes.length ? 'S' : '.';
    return drone + threat + rel + crowd + bul + shp;
  }
  function qValidActions(state, c) {
    const v = ['patrol', 'escape'];
    if (c.isDrone && c.nearest) v.push('hunt');
    if (state.shapes.length) v.push('farm');
    return v;
  }
  function qLearn(s, a, r, sNext, rl) {
    if (!s || !a) return;
    const Q = window.__qtable;
    Q[s] = Q[s] || {};
    const cur = Q[s][a] != null ? Q[s][a] : rl.optimistic;
    let maxNext = 0;
    if (sNext && Q[sNext]) { const vals = Object.values(Q[sNext]); if (vals.length) maxNext = Math.max(...vals); }
    Q[s][a] = cur + rl.alpha * (r + rl.gamma * maxNext - cur);
  }
  // Apply the terminal death penalty to the last decision of the life that just ended.
  function rlTerminal() {
    const rl = DOCTRINE.rl;
    if (rl && rl.enabled && B.rlPrevState != null) { qLearn(B.rlPrevState, B.rlAction, rl.deathPenalty, null, rl); }
    B.rlPrevState = null; B.rlAction = null; B.lastScore = 0;
  }
  function rlSelect(state, c, rl) {
    const Q = window.__qtable, meta = window.__rlMeta;
    const s = qStateKey(state, c);
    const due = B.rlAction == null || (B.frames - (B.rlSince || 0)) >= rl.decisionFrames;
    if (due) {
      const score = (window.__diep && window.__diep.hud && window.__diep.hud.score) || 0;
      const r = Math.max(0, score - (B.lastScore != null ? B.lastScore : score)) / rl.scoreScale + rl.survivalReward;
      B.lastScore = score;
      if (B.rlPrevState != null) qLearn(B.rlPrevState, B.rlAction, r, s, rl);
      const valid = qValidActions(state, c);
      const eps = Math.max(rl.epsMin, rl.epsMax - rl.epsDecay * (meta.decisions || 0));
      let a;
      if (Math.random() < eps) { a = valid[(Math.random() * valid.length) | 0]; }
      else { Q[s] = Q[s] || {}; let bv = -Infinity; a = valid[0]; for (const cc of valid) { const v = Q[s][cc] != null ? Q[s][cc] : rl.optimistic; if (v > bv) { bv = v; a = cc; } } }
      B.rlAction = a; B.rlPrevState = s; B.rlSince = B.frames;
      meta.decisions = (meta.decisions || 0) + 1; meta.eps = +eps.toFixed(3);
    }
    return B.rlAction;
  }

  function step() {
    if (!B.running) return;
    B.frames++;
    const state = window.__readState();
    if (!state || !state.ok) { B._raf = requestAnimationFrame(step); return; }

    // Track life boundaries: a gap in alive frames means we just (re)spawned.
    if (state.me.alive) {
      // New-life detection must tell a REAL respawn (long alive-gap AND we return at a low level) from
      // a brief perception flicker mid-life (the tank momentarily undetected, e.g. during the upgrade
      // pause or heavy drone/effect frames). The old ">10 frame gap" alone re-triggered spawn grace
      // MID-LIFE, so the bot went defenseless (no fire + flee) for ~4s, 39x/shift, and kept dying at
      // the L30 upgrade. Now also require a low level, with a large-gap fallback in case the HUD level
      // read is briefly stale on a genuine respawn.
      const lvl = (window.__diep && window.__diep.hud && window.__diep.hud.level) || 99;
      const gap = B.frames - B.lastAliveFrame;
      if (gap > 10 && (lvl <= 3 || gap > 120)) { B.lifeStartFrame = B.frames; B.lastScore = 0; }
      B.lastAliveFrame = B.frames;
    } else {
      rlTerminal(); // death: charge the terminal penalty to the last RL decision, reset the episode
      // If a predator encounter was open when we died, it killed us: close it as 'died' for the data.
      if (B.activeEncounter) { B.activeEncounter.outcome = 'died'; B.activeEncounter.frames = B.frames - B.activeEncounter.t0; window.__hunterLog.push(B.activeEncounter); B.activeEncounter = null; }
      B.hunterStreak = 0; B.hunterLast = null;
    }
    const sinceSpawn = B.frames - (B.lifeStartFrame || 0);
    const grace = sinceSpawn < DOCTRINE.spawnGraceFrames;

    // During spawn grace, do NOT fire: diep's spawn protection ends on your first shot. Stay
    // unshielded only after we've used the protection window to flee to open space.
    const cls = (window.__diep && window.__diep.hud && window.__diep.hud.cls) || 'Tank';
    const isDrone = DOCTRINE.droneClasses.includes(cls);
    // v22 post-upgrade caution: Overseers die at a median level of 31 - right after the L30 upgrade -
    // because fragilePhaseScale protects the Tank/Sniper then switches OFF the instant they become a
    // (drone) Overseer, so a fresh Overseer with no mature drones suddenly plays full-aggressive at
    // its most vulnerable moment. Detect a class UPGRADE (to a non-Tank class; a respawn-to-Tank is
    // handled by spawn grace) and apply a brief caution window so the fresh class flees while its
    // drones deploy. Bridges the L30->45 and L45 transitions.
    if (cls !== B.lastClass) { if (B.lastClass != null && cls !== 'Tank') B.upgradeFrame = B.frames; B.lastClass = cls; }
    const postUpgrade = !grace && B.upgradeFrame != null && (B.frames - B.upgradeFrame) < (DOCTRINE.upgradeGraceFrames || 180);
    if (!grace) { ensureAutofire(); setMouseHold(isDrone); } else { setMouseHold(false); }
    allocStats();

    let aim = null;
    let moveKeys = new Set();

    // Rank foes by EFFECTIVE distance (closing speed shortens it), so fast approachers trigger
    // escape earlier than their raw distance would.
    const foes = enemiesOf(state);
    let nearest = null, nd = Infinity;
    for (const e of foes) { const ed = effectiveDist(e); if (ed < nd) { nd = ed; nearest = e; } }
    const bulletThreat = state.bullets.some((b) => b.enemy && b.dist < DOCTRINE.bulletDangerRadius);
    // v18 fragile-phase gating: a pre-drone Tank/Sniper (the "Sniper valley", 68% of all deaths) has
    // no drone screen, so flee earlier and from farther. v19 lead-protection: when a coherent populated
    // board says we're at/near #1, also play defensively (kills aren't worth the exposure; hunters home
    // on the leader). Both fold into one defensive multiplier `fScale` applied to the flee triggers
    // (escape/crowd/predator radii up, pressure-escape threshold down); a relaxed mid-tier tank uses 1.
    const fragile = !isDrone && !grace;
    const meta = B.meta || {};
    const leading = !grace && meta.boardSize >= 7 && meta.estRank != null && meta.estRank <= (DOCTRINE.leadRankMax || 2)
      && (meta.myScore || 0) > (DOCTRINE.leadMinScore || 5000)
      && meta.leaderMax > 0 && (meta.myScore || 0) >= meta.leaderMax * (DOCTRINE.leadScoreFrac || 0.45); // v21: reject sparse-board false leads
    const fScale = (fragile ? (DOCTRINE.fragilePhaseScale || 1) : 1) * (leading ? (DOCTRINE.leadScale || 1) : 1) * (postUpgrade ? (DOCTRINE.upgradeScale || 1) : 1);
    const escapeR = grace ? DOCTRINE.spawnEscapeRadius : DOCTRINE.escapeRadius * fScale;
    const myR = state.me.r || 17;
    // Crowd pressure: ~87% of deaths are point-blank (<40px) with 2-3 foes converging, i.e. the
    // pocket gets collapsed because escape only fires on the single nearest enemy crossing escapeR
    // while the others sit just outside it. Count foes inside crowdRadius; if too many, force flight
    // regardless of the chosen policy, and refuse to hunt into a crowd.
    // v24: crowd-flee keys on DANGEROUS foes, not weaklings. A pre-drone tank treats every nearby
    // tank as dangerous (can't fight back well); a drone class only fears tanks that aren't clearly
    // weaker than it (a swarm of small tanks is a hunting opportunity, not a reason to flee).
    const preyR = myR * (DOCTRINE.preyRatio || 0.85);
    const dangerFoes = foes.filter((e) => !isDrone || e.r >= preyR);
    const crowdN = dangerFoes.filter((e) => e.dist < (DOCTRINE.crowdRadius || 300) * fScale).length;
    const crowded = crowdN >= (DOCTRINE.crowdCount || 2);

    // v17 threat field: continuous pressure + the open-lane heading. Drives graded spacing while
    // farming and an EARLY forced breakout when pressure is high or we are being surrounded (no clean
    // lane), so the pocket never collapses to the point-blank death the corpus shows 84% of the time.
    const tg = threatGeometry(foes);
    const surrounded = !grace && tg.nThreat >= 2 && tg.maxGapDeg < (DOCTRINE.safeLaneMinDeg || 110);
    const overPressure = !grace && tg.pressure > (DOCTRINE.pressureEscape || 0.075) / fScale;
    const gapEsc = tg.gapDir ? [tg.gapDir] : null;

    // --- Predator (leaderboard-hunter) detection, MULTI-FRAME confirmed ---
    // 85% of Overseer L30-45 deaths are top-10 players (2-8x our score) running us down. Any tank
    // clearly bigger than us within detect range is a candidate hunter. It must persist for
    // predatorConfirmFrames CONSECUTIVE frames before we trust it, so a single-frame size misread
    // (the 24,971-style phantom) can never make us flee a ghost. The streak decays x2 as fast as it
    // builds, so flicker can't accumulate into a false trigger. A confirmed predator is fled at
    // predatorFleeRadius, well beyond the normal escapeRadius (flee big tanks early, they're faster).
    const predConfirm = DOCTRINE.predatorConfirmFrames || 16;
    let predCand = null, pcd = Infinity;
    for (const e of foes) {
      if (e.r >= myR * (DOCTRINE.predatorRatio || 1.15) && e.dist < (DOCTRINE.predatorDetectRadius || 460) && e.dist < pcd) { pcd = e.dist; predCand = e; }
    }
    if (predCand) { B.hunterStreak = Math.min(predConfirm + 4, B.hunterStreak + 1); B.hunterLast = predCand; }
    else { B.hunterStreak = Math.max(0, B.hunterStreak - 2); if (B.hunterStreak === 0) B.hunterLast = null; }
    const predatorConfirmed = B.hunterStreak >= predConfirm && !!B.hunterLast && state.me.alive;
    const predatorClose = predatorConfirmed && B.hunterLast.dist < (DOCTRINE.predatorFleeRadius || 320) * fScale;
    // Instrument the encounter: open on first confirmation, track closest approach, mark fled when we
    // actually enter predator-flight. Closed on escape (here) or death (the death branch above).
    if (predatorConfirmed) {
      if (!B.activeEncounter) B.activeEncounter = { startDist: Math.round(B.hunterLast.dist), minDist: Math.round(B.hunterLast.dist), hunterR: B.hunterLast.r, myR: Math.round(myR), fled: false, cls, t0: B.frames };
      else B.activeEncounter.minDist = Math.min(B.activeEncounter.minDist, Math.round(B.hunterLast.dist));
    } else if (B.activeEncounter) {
      B.activeEncounter.outcome = 'escaped'; B.activeEncounter.frames = B.frames - B.activeEncounter.t0;
      window.__hunterLog.push(B.activeEncounter); B.activeEncounter = null;
    }

    // Ram behavior is active only once we are an actual ram class (a tanky Smasher); the base-Tank
    // phase farms at range. ramNow flips contact distances on and lets us chase+ram.
    const ramNow = DOCTRINE.ramStyle && DOCTRINE.ramClasses && DOCTRINE.ramClasses.includes(cls);
    const stopDist = ramNow ? 0 : DOCTRINE.approachStopDist;
    const bodyMargin = ramNow ? -999 : DOCTRINE.shapeBodyMargin;
    const standoff = ramNow ? 0 : DOCTRINE.huntStandoff;
    // v24 PREDATOR MODE: once we're a drone class, killing tanks - not eating shapes - is the route
    // to #1, so we actively pick the best weaker tank (prey) and hunt it. Gated only by genuine danger
    // (a bigger-tank crowd, a confirmed predator, being surrounded, over-pressure, or holding the #1
    // lead) - NOT by raw foe count, because a swarm of weaklings is prey, not a threat. The old
    // huntSizeRatio/huntMaxFoes "only if the nearest happens to be small and alone" gating made the
    // bot a passive farmer; bestPrey + danger-aware crowd replace it.
    const prey = (isDrone || ramNow) && !grace ? bestPrey(foes, myR) : null;
    const huntable = DOCTRINE.huntEnabled && prey && !crowded && !predatorClose && !surrounded && !overPressure && !leading;

    // Each tactical mode is an action: it returns the movement keys + aim and labels B.mode.
    const actEscape = () => {
      // Predator flight takes priority: flee the confirmed hunter specifically (it dominates the
      // direction sampler), not just the average threat vector.
      if (predatorClose && B.hunterLast) {
        B.mode = 'predator-flee';
        if (B.activeEncounter) B.activeEncounter.fled = true;
        // Flee along the open lane (gapDir), not just away from the one hunter - the corpus shows
        // straight-line flight from a hunter loses ground (fled died 43% vs not-fled 25%) because we
        // run into the rest of the field. The lane keeps the whole threat field behind us.
        const [dx, dy] = bestEscapeDir(state, B.hunterLast, gapEsc);
        const aim = (DOCTRINE.droneScreen && isDrone)
          ? { x: B.hunterLast.x, y: B.hunterLast.y }
          : (nearest ? { x: nearest.x, y: nearest.y } : { x: B.hunterLast.x, y: B.hunterLast.y });
        return { moveKeys: vectorToKeys(dx, dy), aim };
      }
      B.mode = grace ? 'spawn-escape' : (surrounded ? 'breakout' : 'escape');
      const [dx, dy] = bestEscapeDir(state, null, gapEsc);
      return { moveKeys: vectorToKeys(dx, dy), aim: nearest ? { x: nearest.x, y: nearest.y } : (window.__lastAim || { x: 900, y: 360 }) };
    };
    const actHunt = () => {
      const t = prey || nearest; // chase the chosen prey, not just whoever is nearest
      if (!t) return actFarm();
      B.mode = 'hunt';
      // Close to standoff so drones reach the target, then hold the distance (don't body-ram a tank);
      // aim the drones/guns straight AT the prey to chip it down for the kill.
      const mk = t.dist > standoff ? vectorToKeys(t.dx, t.dy) : vectorToKeys(-t.dx, -t.dy);
      return { moveKeys: mk, aim: { x: t.x, y: t.y } };
    };
    function actFarm() {
      // v20 economy: only chase high-XP pentagons as a drone class when it's genuinely calm
      // (pressure below the spacing floor) - a pressure veto so the score push never trades away survival.
      const econ = (isDrone && tg.pressure < (DOCTRINE.spacingFloor || 0.02)) ? (DOCTRINE.dronePentagonBonus || 0) : 0;
      const target = bestShape(state.shapes, tg.toward, tg.pressure, econ);
      if (!target) return actPatrol();
      const spaced = tg.pressure > (DOCTRINE.spacingFloor || 0.02);
      B.mode = spaced ? 'space-farm' : 'farm';
      let mvx = 0, mvy = 0;
      if (target.dist > stopDist) { const m = target.dist || 1; mvx += target.dx / m; mvy += target.dy / m; }
      for (const s of state.shapes) {
        const contact = (state.me.r || 17) + s.r + bodyMargin;
        if (s.dist < contact) { const m = s.dist || 1; mvx -= (s.dx / m) * 1.5; mvy -= (s.dy / m) * 1.5; }
      }
      // v17 graded spacing bubble: a continuous push along the open lane (gapDir) that scales with
      // threat pressure, replacing the old binary wary-radius nudge. This bleeds pressure off *while*
      // farming so it never builds to the collapse - the bot keeps a personal bubble instead of
      // waiting for one enemy to cross escapeRadius. gapDir keeps the push out of the field, not just
      // off the single nearest foe.
      if (spaced) {
        const lane = tg.gapDir || ((tg.away[0] || tg.away[1]) ? tg.away : [0, -1]);
        const g = (DOCTRINE.spacingGain || 1.6) * Math.min(1, tg.pressure / (DOCTRINE.pressureCap || 0.06));
        mvx += lane[0] * g; mvy += lane[1] * g;
      }
      // Edge-farming bias (GATED; edgeBiasWeight 0 = off). Drift toward the NEAREST single arena edge
      // (one axis only, never both -> no corner trap) so foes can converge from fewer angles. ES-tunable
      // when enabled. Built now, off this shift to keep one live behavior change at a time.
      const ew = DOCTRINE.edgeBiasWeight || 0;
      if (ew > 0 && state.map) {
        const p = state.map;
        if (Math.min(p.x, 1 - p.x) <= Math.min(p.y, 1 - p.y)) { const ex = p.x < 0.5 ? 0.12 : 0.88; mvx += (ex - p.x) * ew; }
        else { const ey = p.y < 0.5 ? 0.12 : 0.88; mvy += (ey - p.y) * ew; }
      }
      const a = (nearest && nd < escapeR * 1.3) ? { x: nearest.x, y: nearest.y } : { x: target.x, y: target.y };
      return { moveKeys: (mvx || mvy) ? vectorToKeys(mvx, mvy) : new Set(), aim: a };
    }
    function actPatrol() {
      B.mode = 'patrol';
      const pos = state.map;
      if (pos) {
        const anchors = DOCTRINE.patrolAnchors;
        B.anchorIdx = B.anchorIdx ?? 0;
        let a = anchors[B.anchorIdx % anchors.length];
        if (Math.hypot(a[0] - pos.x, a[1] - pos.y) < DOCTRINE.anchorReachedDist) { B.anchorIdx = (B.anchorIdx + 1) % anchors.length; a = anchors[B.anchorIdx]; }
        return { moveKeys: vectorToKeys(a[0] - pos.x, a[1] - pos.y), aim: { x: 640 + (a[0] - pos.x) * 600, y: 360 + (a[1] - pos.y) * 600 } };
      }
      return { moveKeys: vectorToKeys(0.6, -0.5), aim: { x: 1000, y: 200 } };
    }
    const ACT = { escape: actEscape, hunt: actHunt, farm: actFarm, patrol: actPatrol };

    // --- Mode selection: spawn-grace forces escape; otherwise Q-learning (if enabled) or rules. ---
    const rl = DOCTRINE.rl;
    let chosen;
    if (grace) {
      chosen = 'escape';
    } else if (rl && rl.enabled) {
      chosen = rlSelect(state, { nearest, nd, foes, bulletThreat, escapeR, myR, isDrone }, rl);
    } else {
      if (nearest && (nd < escapeR || bulletThreat) && !huntable) chosen = 'escape';
      else if (huntable) chosen = 'hunt';
      else if (state.shapes.length) chosen = 'farm';
      else chosen = 'patrol';
    }
    // Forced-flight overrides (highest priority first): a confirmed predator closing on us, a
    // converging crowd, being surrounded (no clean lane), or threat pressure over the escape budget.
    // Any breaks farming/hunting immediately so the pocket never closes to the point-blank collapse.
    if (!grace && (predatorClose || crowded || surrounded || overPressure)) chosen = 'escape';
    const out = (ACT[chosen] || actFarm)();
    moveKeys = out.moveKeys; aim = out.aim;
    // Tag the trigger in telemetry (predator-flee labels itself inside actEscape; crowd prefixes here).
    if (!grace && crowded && !predatorClose) B.mode = 'crowd-' + B.mode;
    if (leading) B.mode = 'lead-' + B.mode; // tag so the corpus can A/B time-survived-while-leading
    if (postUpgrade) B.mode = 'up-' + B.mode; // tag the post-upgrade caution window

    // Bullet dodge overrides movement in any mode: sidestepping an incoming shot beats whatever
    // else we were doing for these few frames. Aim is unaffected.
    const dodge = bulletDodge(state);
    if (dodge) { moveKeys = vectorToKeys(dodge[0], dodge[1]); B.mode = B.mode + '+dodge'; }

    setHeld(moveKeys);
    if (aim && DOCTRINE.aimEveryFrame) moveMouse(aim.x, aim.y);

    B._raf = requestAnimationFrame(step);
  }

  // start() begins a fresh life: autofire is off on a new tank, so allow it to be re-enabled.
  B.start = () => { if (B.running) return; B.running = true; B.autofireOn = false; B._raf = requestAnimationFrame(step); };
  B.stop = () => { B.running = false; releaseAll(); };
  // pause()/resume() bracket a brief external action (e.g. an upgrade click) WITHOUT touching
  // autofire state, so resuming does not toggle E and turn our guns off mid-life.
  B.pause = () => { B.running = false; releaseAll(); };
  B.resume = () => { if (B.running) return; B.running = true; B._raf = requestAnimationFrame(step); };
  B.snapshot = () => ({ frames: B.frames, mode: B.mode, statIdx: B.statIdx, autofireOn: B.autofireOn, hunterStreak: B.hunterStreak, predator: !!B.hunterLast });
};
