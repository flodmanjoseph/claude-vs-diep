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
  const KEYCODE = { w: 87, a: 65, s: 83, d: 68, e: 69, c: 67, ' ': 32, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56 };

  const dispatchKey = (type, ch) => {
    const code = ch === ' ' ? 'Space' : /\d/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase();
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
  // RL Phase-1: an optional learned policy (bc-policy.json {W,b,mean,std,actions}) the runner pushes
  // for an A/B vs the rules (set on BC lives, null on rules lives). When set, it RE-RANKS the macro-mode
  // among the currently-valid actions; the hard forced-flight shields still override it afterward.
  B.policy = null;
  window.__setPolicy = (p) => { B.policy = (p && p.W) ? p : null; };
  // Linear-softmax forward pass -> best valid action (argmax of W*standardized(feat)+b over `valid`).
  function bcPick(feat, pol, valid) {
    if (!pol) return null;
    let best = null, bv = -Infinity;
    for (let k = 0; k < pol.actions.length; k++) {
      if (valid && valid.indexOf(pol.actions[k]) < 0) continue;
      let z = pol.b[k]; const Wk = pol.W[k];
      for (let j = 0; j < feat.length; j++) z += Wk[j] * ((feat[j] - pol.mean[j]) / (pol.std[j] || 1));
      if (z > bv) { bv = z; best = pol.actions[k]; }
    }
    return best;
  }
  // Closed hunter encounters wait here for the runner to drain into telemetry (detected/fled/outcome).
  window.__hunterLog = window.__hunterLog || [];

  const now = () => performance.now();
  // v36.1: firing is a HELD SPACE KEY (diep's keyboard fire), managed like a movement key.
  // The old 'e' autofire toggle was STATE-BLIND: a falsely-detected death made start() re-tap E on
  // a tank whose autofire was already ON, silently turning fire OFF for the rest of the life
  // (first v36 Sandbox bench: mode 'farm', zero bullets on screen, 290 score in 300s). A held key
  // is idempotent — there is no toggle state to desync. (A held synthetic MOUSE button was tried
  // first: diep accepts synthetic mouse for drone steering but not for bullet firing — bench 2
  // showed zero bullets. Keyboard input is the proven path.)

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
  function bestShape(shapes, toward, pressure, pentagonBonus, foes, fovMul) {
    if (!shapes.length) return null;
    const rank = (k) => { const i = DOCTRINE.preferKinds.indexOf(k); return i < 0 ? 5 : i; };
    const bias = (DOCTRINE.safeShapeBias || 0) * Math.min(1, (pressure || 0) / (DOCTRINE.pressureCap || 0.06));
    // v36 far-field routing: shapes sitting in enemy-dense space cost extra "distance", so farming
    // drifts away from clusters minutes before they become encounters. The corpus's strongest
    // life-length correlate: long lives see 0.70 hunter encounters/min vs 1.24 for short ones —
    // being where hunters aren't beats out-fighting them. Low weight: routing, not fleeing.
    const ffR = DOCTRINE.farFieldRadius || 700;
    const ffW = DOCTRINE.farFieldWeight || 0;
    let best = null, bestScore = Infinity;
    for (const s of shapes) {
      let score = s.dist + rank(s.kind) * DOCTRINE.kindDistancePenalty;
      if (pentagonBonus && s.kind === 'pentagon') score -= pentagonBonus;
      if (bias > 0 && toward && (toward[0] * toward[0] + toward[1] * toward[1] > 0.001)) {
        const m = s.dist || 1;
        const dot = (s.dx / m) * toward[0] + (s.dy / m) * toward[1]; // >0 => toward the threats
        if (dot > 0) score += dot * bias;
      }
      if (ffW > 0 && foes && foes.length) {
        let dens = 0;
        for (const e of foes) {
          const d = Math.hypot(e.x - s.x, e.y - s.y) / (fovMul || 1); // screen coords -> world dist
          if (d < ffR) dens += 1 - d / ffR;
        }
        score += dens * ffW;
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
    // v36: perception is world-normalized at the boundary (state.mjs), so no fovMul here — every
    // dist/r below is already world-equivalent and pressure is zoom-invariant by construction.
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

  // v36: 16 headings (half-step compass). Finer tangents matter for wall slides and the kite band —
  // with 8 dirs the difference between "along the wall" and "into the wall" is a single 45° step.
  const DIRS = Array.from({ length: 16 }, (_, i) => {
    const a = (i * Math.PI) / 8;
    return [Math.round(Math.cos(a) * 100) / 100, Math.round(Math.sin(a) * 100) / 100];
  });
  function bestEscapeDir(state, priority, extraDirs) {
    let best = [0, 1], bestScore = -Infinity;
    const foes = enemiesOf(state);
    const pos = state.map; // normalized map position or null
    // The open-lane heading(s) from threatGeometry are evaluated alongside the compass dirs, so the
    // geometry-correct escape still gets the wall/bullet penalties below before being chosen.
    const dirs = extraDirs && extraDirs.length ? DIRS.concat(extraDirs.filter(Boolean)) : DIRS;
    for (const [dx, dy] of dirs) {
      let score = 0;
      // v36 wall handling: fleeing into an arena edge is how corner-trap deaths happen, and the old
      // -5 penalty was 40-120x weaker than the threat terms below, so a hunter could push us straight
      // into a wall. The penalty now dominates ordinary threat terms, and when pinned near an edge the
      // TANGENTIAL component earns a bonus so flight slides along the wall instead of stalling on it.
      if (pos) {
        const m = DOCTRINE.wallMargin;
        const wp = DOCTRINE.wallEscapePenalty || 400;
        const ws = DOCTRINE.wallSlideBonus || 120;
        if ((pos.x < m && dx < 0) || (pos.x > 1 - m && dx > 0)) score -= wp;
        if ((pos.y < m && dy < 0) || (pos.y > 1 - m && dy > 0)) score -= wp;
        if (pos.x < m || pos.x > 1 - m) score += Math.abs(dy) * ws; // near a vertical wall: slide along y
        if (pos.y < m || pos.y > 1 - m) score += Math.abs(dx) * ws; // near a horizontal wall: slide along x
      }
      // v36 shape blockers: never flee THROUGH a shape field — mid-flight body contact bleeds speed
      // and HP exactly when it's fatal (80% of deaths are point-blank). A blocker term much weaker
      // than a same-distance foe: deflect the lane, don't panic over a pentagon.
      const sr = DOCTRINE.escapeShapeRadius || 220;
      const sw = DOCTRINE.escapeShapeWeight || 120;
      for (const s of state.shapes) {
        if (s.dist > sr) continue;
        const sm = s.dist || 1;
        const toward = (dx * s.dx + dy * s.dy) / sm;
        if (toward > 0) score -= toward * (sw / Math.max(50, s.dist));
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
    B.lastEscapeDir = best; // exposed for tests/telemetry (held keys quantize to 8-way)
    return best;
  }

  // v36 LEAD AIM: every shot used to target the enemy's CURRENT position — against a strafing tank
  // at 400-700 world units that misses by 60-150px, so return fire deterred nothing and fleeing
  // couldn't kill (fled encounters died 39% vs 24% stood). Predict the intercept instead:
  // eta (frames) = dist / our bullet speed, intercept = pos + v * eta. dist/vx/vy are world units;
  // the returned point converts back to SCREEN via fovMul (the one place the zoom factor is needed).
  // bulletPxPerFrame is our own bullet speed in world px/frame — a doctrine tunable (it scales with
  // the BulletSpeed stat), calibrated in Sandbox. The eta clamp bounds how far a bad velocity read
  // can drag the aim point.
  function leadAim(t, fovMul) {
    const bs = Math.max(4, DOCTRINE.bulletPxPerFrame || 12);
    const eta = Math.min(45, (t.dist || 0) / bs);
    return { x: t.x + (t.vx || 0) * eta * (fovMul || 1), y: t.y + (t.vy || 0) * eta * (fovMul || 1) };
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
    // Wall-clock frame delta: every caution/confirmation window below is ms-denominated (v36) so
    // behavior is display-independent. The old frame-denominated timers ran ~2x fast on this Mac's
    // 119fps ProMotion panel (spawn grace was really ~2.15s, not the intended 4.3s). Clamped so a
    // background-tab stall can't dump a giant delta into the accumulators.
    const tNow = now();
    const frameDt = Math.min(100, tNow - (B._lastStepMs != null ? B._lastStepMs : tNow));
    B._lastStepMs = tNow;
    const state = window.__readState();
    if (!state || !state.ok) { B._raf = requestAnimationFrame(step); return; }

    // Track life boundaries: a gap in alive frames means we just (re)spawned.
    if (state.me.alive) {
      // New-life detection must tell a REAL respawn (long alive-gap AND we return at a low level) from
      // a brief perception flicker mid-life (the tank momentarily undetected, e.g. during the upgrade
      // pause or heavy drone/effect frames). The old ">10 frame gap" alone re-triggered spawn grace
      // MID-LIFE, so the bot went defenseless (no fire + flee) for ~4s, 39x/shift, and kept dying at
      // the L30 upgrade. v36: the large-gap fallback must ALSO be corroborated by the HUD looking like
      // a fresh spawn (score reset or base class) — a ~2s perception stall with score/class intact is
      // a flicker, not a respawn, and re-entering spawn grace there re-opened the exact v23
      // defenseless-window bug class. gapRejects counts rejected stalls for telemetry.
      const hud0 = (window.__diep && window.__diep.hud) || {};
      const lvl = hud0.level || 99;
      const gap = B.frames - B.lastAliveFrame;
      const looksFresh = (hud0.score || 0) < 500 || (hud0.cls || 'Tank') === 'Tank';
      if (gap > 10 && (lvl <= 3 || (gap > 120 && looksFresh))) {
        if (B.lifeStartMs != null) B.lifeResets = (B.lifeResets || 0) + 1; // observable: grace re-entries
        B.lifeStartFrame = B.frames; B.lifeStartMs = tNow; B.lastScore = 0;
      } else if (gap > 120) {
        B.gapRejects = (B.gapRejects || 0) + 1;
      }
      B.lastAliveFrame = B.frames;
    } else {
      rlTerminal(); // death: charge the terminal penalty to the last RL decision, reset the episode
      // If a predator encounter was open when we died, it killed us: close it as 'died' for the data.
      if (B.activeEncounter) { B.activeEncounter.outcome = 'died'; B.activeEncounter.frames = B.frames - B.activeEncounter.t0; window.__hunterLog.push(B.activeEncounter); B.activeEncounter = null; }
      B.hunterStreak = 0; B.hunterLast = null; B.lockedPrey = null; B.escaping = false;
    }
    const sinceSpawnMs = tNow - (B.lifeStartMs || 0);
    const grace = sinceSpawnMs < (DOCTRINE.spawnGraceMs != null ? DOCTRINE.spawnGraceMs : 4300);

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
    if (cls !== B.lastClass) { if (B.lastClass != null && cls !== 'Tank') B.upgradeMs = tNow; B.lastClass = cls; }
    const postUpgrade = !grace && B.upgradeMs != null && (tNow - B.upgradeMs) < (DOCTRINE.upgradeGraceMs || 3000);
    // Hold fire during spawn grace (diep's spawn protection ends on the first shot) and during the
    // brief aim-suspension window around trusted upgrade clicks. Drone classes also hold the mouse
    // (synthetic mousedown steers drones toward the cursor — the v15 drone-screen mechanism).
    const aimSuspended = B.suspendAimUntil != null && tNow < B.suspendAimUntil;
    const firing = !grace && !aimSuspended && DOCTRINE.autofire !== false;
    setMouseHold(firing && isDrone);
    B.autofireOn = firing; // "firing intent" (kept for snapshot/tests); the space key is added to the held-set below
    allocStats();

    let aim = null;
    let moveKeys = new Set();

    // Rank foes by EFFECTIVE distance (closing speed shortens it), so fast approachers trigger
    // escape earlier than their raw distance would.
    const foes = enemiesOf(state);
    let nearest = null, nd = Infinity;
    for (const e of foes) { const ed = effectiveDist(e); if (ed < nd) { nd = ed; nearest = e; } }
    // v36: perception normalizes all decision fields to world units at the boundary (state.mjs), so
    // the v32-era per-threshold fovMul multiplications are GONE — that scheme rescaled only some
    // radii (deleting the Ranger's FOV reach on the scaled ones, leaving the rest zoom-distorted).
    // fovMul is still needed exactly once: converting world-frame predictions back to screen for aim.
    const fovMul = state.fovMul || Math.max(0.45, Math.min(1.15, (state.fov || (DOCTRINE.fovBaselinePx || 22)) / (DOCTRINE.fovBaselinePx || 22)));
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
    // v36: the confirmation streak is a wall-clock ms accumulator (display-independent); it still
    // builds only on consecutive presence and decays 2x as fast as it builds, capped just above the
    // threshold so a long stalk can't bank hours of confirmation.
    const predConfirm = DOCTRINE.predatorConfirmMs || 270;
    let predCand = null, pcd = Infinity;
    for (const e of foes) {
      if (e.r >= myR * (DOCTRINE.predatorRatio || 1.15) && e.dist < (DOCTRINE.predatorDetectRadius || 550) && e.dist < pcd) { pcd = e.dist; predCand = e; }
    }
    if (predCand) { B.hunterStreak = Math.min(predConfirm + 80, B.hunterStreak + frameDt); B.hunterLast = predCand; }
    else { B.hunterStreak = Math.max(0, B.hunterStreak - 2 * frameDt); if (B.hunterStreak === 0) B.hunterLast = null; }
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
    // v27 TARGET LOCK + PURSUIT: commit to a prey and chase it to FINISH the kill, instead of
    // re-picking from scratch every frame and abandoning a wounded tank the moment it leaves the
    // frame. We lock onto a prey, advance its last-known position by its velocity, re-acquire it among
    // visible enemies by proximity, and if it briefly leaves sight we PURSUE the predicted position for
    // pursuitFrames before giving up. Lock drops on real danger or expiry (it's gated below).
    // v29: hunting is no longer drone-only. Joe's call - the bot has good aim, so the Sniper line
    // (Sniper/Assassin/Ranger, bullet classes) hunts and snipes weaker tanks too. Any non-Tank class
    // can hunt (the base Tank still farms shapes to level up first); danger gates keep it cautious.
    const canHunt = (cls !== 'Tank' || ramNow) && !grace;
    let prey = null;
    if (canHunt) {
      const PURSUIT = DOCTRINE.pursuitMs || 1500; // v36 ms-denominated
      const MATCH = DOCTRINE.preyMatchRadius || 90;
      // The lock stores SCREEN x/y (aiming space) with SCREEN velocities (svx/svy = world v * fovMul)
      // for dead-reckoning; the ghost's decision fields are converted back to world units. Mixing the
      // two spaces here was a real bug class once perception went world-normalized (v36).
      if (B.lockedPrey) { B.lockedPrey.x += B.lockedPrey.svx || 0; B.lockedPrey.y += B.lockedPrey.svy || 0; } // dead-reckon
      let matched = null;
      if (B.lockedPrey) {
        let bestD = MATCH;
        for (const e of foes) { if (e.r >= myR * (DOCTRINE.preyRatio || 0.85)) continue; const d = Math.hypot(e.x - B.lockedPrey.x, e.y - B.lockedPrey.y) / fovMul; if (d < bestD) { bestD = d; matched = e; } }
      }
      const canPursue = !crowded && !predatorClose && !surrounded && !overPressure;
      if (matched) {
        prey = matched;
        B.lockedPrey = { x: matched.x, y: matched.y, svx: (matched.vx || 0) * fovMul, svy: (matched.vy || 0) * fovMul, r: matched.r, seen: tNow };
      } else if (B.lockedPrey && canPursue && (tNow - B.lockedPrey.seen) < PURSUIT) {
        // lost sight of the locked prey but recently committed -> chase its predicted spot to finish it
        const lp = B.lockedPrey;
        const gdx = (lp.x - CENTER.x) / fovMul, gdy = (lp.y - CENTER.y) / fovMul;
        prey = { x: lp.x, y: lp.y, dx: gdx, dy: gdy, dist: Math.hypot(gdx, gdy), r: lp.r, vx: 0, vy: 0, ghost: true };
      } else {
        B.lockedPrey = null; // no lock or it expired/we're in danger -> acquire fresh
        const fresh = bestPrey(foes, myR);
        if (fresh && canPursue) { prey = fresh; B.lockedPrey = { x: fresh.x, y: fresh.y, svx: (fresh.vx || 0) * fovMul, svy: (fresh.vy || 0) * fovMul, r: fresh.r, seen: tNow }; }
      }
    } else { B.lockedPrey = null; }
    // v34: don't chase prey while a clearly-bigger tank is near. 8/25 Sniper deaths were hunt-chase:
    // the squishy Sniper tunnel-visioned on weak prey while a bigger tank (r>=18 vs our ~16) closed to
    // point-blank and killed it. Deal with the bigger threat first (farm/escape), THEN hunt. This is a
    // safe, narrow fix - it only suppresses hunting near a bigger tank, it does NOT add blanket fleeing
    // (no over-timidity risk). snipeAvoidRatio/Radius are direct (not ES-tuned).
    const biggerNear = foes.some((e) => e.r >= myR * (DOCTRINE.snipeAvoidRatio || 1.1) && e.dist < (DOCTRINE.snipeAvoidRadius || 300));
    const huntable = DOCTRINE.huntEnabled && prey && !crowded && !predatorClose && !surrounded && !overPressure && !leading && !biggerNear;

    // Each tactical mode is an action: it returns the movement keys + aim and labels B.mode.
    // v36 KITE BAND: pure straight-line flight measurably LOSES to standing ground (fled encounters
    // died 39% vs 24% stood, n=2,735) because ranged hunters kill from ~280 units stand-off — the
    // bot was shot down while running, never caught (median closure only ~20px). So once the pursuer
    // is outside the hard flee radius (escapeR) but still inside the kite band, blend TANGENTIAL
    // headings into the escape sampler (hold/open the range band instead of giving the hunter a
    // zero-deflection stern chase) and keep LEAD-FIRING at the pursuer the whole way — a sniper's
    // version of the v15 drone screen, the one intervention that ever beat ranged hunters.
    const kiteCandidates = (t) => {
      const m = Math.hypot(t.dx, t.dy) || 1;
      const ux = t.dx / m, uy = t.dy / m; // unit toward the pursuer
      const s = 0.7071;
      // Both pure tangents plus both 45° retreat-tangent blends (normalize(away + tangent));
      // bestEscapeDir scores them against walls/shapes/other foes, so a tangent into a second
      // threat or a wall never wins.
      return [
        [-uy, ux], [uy, -ux], // pure tangents
        [(-ux - uy) * s, (ux - uy) * s], // away + tangent1
        [(-ux + uy) * s, (-ux - uy) * s], // away + tangent2
      ];
    };
    const actEscape = () => {
      // Predator flight takes priority: flee the confirmed hunter specifically (it dominates the
      // direction sampler), not just the average threat vector.
      if (predatorClose && B.hunterLast) {
        if (B.activeEncounter) B.activeEncounter.fled = true;
        const hd = B.hunterLast.dist || 0;
        const kiting = !isDrone && hd >= escapeR && hd < escapeR * (DOCTRINE.kiteBandMul || 1.6);
        B.mode = kiting ? 'predator-kite' : 'predator-flee';
        // Flee along the open lane (gapDir), not just away from the one hunter - the corpus shows
        // straight-line flight from a hunter loses ground because we run into the rest of the field.
        const extra = kiting ? (gapEsc || []).concat(kiteCandidates(B.hunterLast)) : gapEsc;
        const [dx, dy] = bestEscapeDir(state, B.hunterLast, extra);
        // v36: a bullet-class tank fleeing a predator aims at THE HUNTER (with lead), not at the
        // nearest foe — Ranger recoil also pushes us away from it. Drone classes keep the v15
        // drone-screen aim (drives drones onto the hunter).
        const aim = (DOCTRINE.droneScreen && isDrone)
          ? { x: B.hunterLast.x, y: B.hunterLast.y }
          : leadAim(B.hunterLast, fovMul);
        return { moveKeys: vectorToKeys(dx, dy), aim };
      }
      const kt = !grace && !isDrone && nearest ? nearest : null;
      const kiting = kt && nd >= escapeR && nd < escapeR * (DOCTRINE.kiteBandMul || 1.6);
      B.mode = grace ? 'spawn-escape' : (surrounded ? 'breakout' : (kiting ? 'kite' : 'escape'));
      const extra = kiting ? (gapEsc || []).concat(kiteCandidates(kt)) : gapEsc;
      const [dx, dy] = bestEscapeDir(state, null, extra);
      return { moveKeys: vectorToKeys(dx, dy), aim: nearest ? leadAim(nearest, fovMul) : (window.__lastAim || { x: 900, y: 360 }) };
    };
    const actHunt = () => {
      const t = prey || nearest; // chase the chosen prey, not just whoever is nearest
      if (!t) return actFarm();
      B.mode = t.ghost ? 'hunt-chase' : 'hunt'; // hunt-chase = pursuing a prey that left the frame
      // Close to standoff so drones reach the target, then hold (don't body-ram a tank). When pursuing
      // a prey that slipped out of sight, always push toward its predicted spot to catch and finish it.
      const mk = (t.ghost || t.dist > standoff) ? vectorToKeys(t.dx, t.dy) : vectorToKeys(-t.dx, -t.dy);
      return { moveKeys: mk, aim: leadAim(t, fovMul) }; // v36: intercept the prey, don't trail it
    };
    function actFarm() {
      // v20 economy: only chase high-XP pentagons as a drone class when it's genuinely calm
      // (pressure below the spacing floor) - a pressure veto so the score push never trades away survival.
      const econ = (isDrone && tg.pressure < (DOCTRINE.spacingFloor || 0.02)) ? (DOCTRINE.dronePentagonBonus || 0) : 0;
      const target = bestShape(state.shapes, tg.toward, tg.pressure, econ, foes, fovMul);
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
        // v36 far-field: blend the anchor heading away from any enemy presence en route, so patrol
        // routes around occupied space instead of marching through it.
        const ah = Math.hypot(a[0] - pos.x, a[1] - pos.y) || 1;
        let hx = (a[0] - pos.x) / ah, hy = (a[1] - pos.y) / ah;
        const ffR = DOCTRINE.farFieldRadius || 700;
        if ((DOCTRINE.farFieldWeight || 0) > 0 && nearest && nd < ffR) {
          const k = Math.min(0.7, 1 - nd / ffR);
          const m = nearest.dist || 1;
          hx = hx * (1 - k) - (nearest.dx / m) * k;
          hy = hy * (1 - k) - (nearest.dy / m) * k;
        }
        return { moveKeys: vectorToKeys(hx, hy), aim: { x: 640 + hx * 600, y: 360 + hy * 600 } };
      }
      // v36.1: no minimap read (Sandbox renders no arrow) -> SWEEP instead of a fixed diagonal.
      // The old fixed (0.6,-0.5) heading marched the tank into the nearest corner and pinned it
      // there for good once local shapes ran dry (bench 3: 180s of corner-staring patrol). A slow
      // rotating heading leaves any corner and re-crosses the shape fields.
      const a = ((tNow / 9000) % 1) * Math.PI * 2;
      const hx = Math.cos(a), hy = Math.sin(a);
      return { moveKeys: vectorToKeys(hx, hy), aim: { x: 640 + hx * 600, y: 360 + hy * 600 } };
    }
    const ACT = { escape: actEscape, hunt: actHunt, farm: actFarm, patrol: actPatrol };

    // The 16-dim tactical feature vector (built once here so both the BC policy and the Phase-0
    // transition log use the exact same features). Mirrors the bc-policy.json training inputs.
    const hud = (window.__diep && window.__diep.hud) || {};
    const feat = [
      isDrone ? 1 : 0,
      grace ? 1 : 0,
      Math.min(3, nd / (escapeR || 1)),
      nearest ? Math.min(3, nearest.r / myR) : 0,
      Math.min(6, crowdN),
      Math.min(0.3, tg.pressure),
      tg.maxGapDeg / 180,
      Math.min(8, tg.nThreat),
      bulletThreat ? 1 : 0,
      predatorConfirmed ? 1 : 0,
      Math.min(8, foes.length),
      Math.min(12, state.shapes.length),
      state.map ? state.map.x : 0.5,
      state.map ? state.map.y : 0.5,
      Math.min(1, ((hud.level || 1) / 60)),
      prey ? 1 : 0,
    ];

    // --- Mode selection: spawn-grace forces escape; otherwise Q-learning, the BC policy (A/B), or rules. ---
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
    // RL Phase-1 A/B: on a BC life (runner set B.policy), the learned policy re-ranks the macro-mode
    // among the currently-valid actions. The hard shields below still override it, so it can't suicide.
    if (B.policy && !grace) {
      const valid = ['escape', 'patrol'];
      if (huntable) valid.push('hunt');
      if (state.shapes.length) valid.push('farm');
      const ba = bcPick(feat, B.policy, valid);
      if (ba) { chosen = ba; B.bcActive = true; }
    } else B.bcActive = false;
    // Forced-flight overrides (highest priority first): a confirmed predator closing on us, a
    // converging crowd, being surrounded (no clean lane), or threat pressure over the escape budget.
    // Any breaks farming/hunting immediately so the pocket never closes to the point-blank collapse.
    if (!grace && (predatorClose || crowded || surrounded || overPressure)) chosen = 'escape';
    // v36 KITE HYSTERESIS: entering escape latches it; the latch releases only once the field is
    // calm AND the nearest foe has been pushed clearly outside the exit band (kiteExitMul*escapeR).
    // Without this the mode thrashed farm<->escape right at the escapeR boundary — never actually
    // opening distance, which is the corpus's signature of being slowly run down. The latch defers
    // to hunt (prey engagement is gated by its own danger checks), it only overrides farm/patrol.
    if (!grace) {
      if (chosen === 'escape') B.escaping = true;
      else if (B.escaping
        && (!nearest || nd > escapeR * (DOCTRINE.kiteExitMul || 1.4))
        && !bulletThreat && !predatorClose && !crowded && !surrounded && !overPressure) B.escaping = false;
      if (B.escaping && (chosen === 'farm' || chosen === 'patrol')) chosen = 'escape';
    } else B.escaping = false;

    // === RL Phase 0: per-decision transition logging ===
    // The brain decides at frame rate but telemetry only logged ~5s heartbeats, so no (state,action,
    // reward,next-state) data existed to pre-train on. Here we capture the REAL tactical state + the
    // chosen macro-action at the RL decision cadence, into an in-page ring buffer the runner drains to
    // telemetry/transitions-*.jsonl. The rules bot thus becomes a behavior-policy data factory: the
    // 16-dim feature vector (values already computed above) + the action + score (for offline reward =
    // next.score - score) + the qStateKey + forced-override + life id. Pure logging - no behavior change.
    const RL_LOG_MS = DOCTRINE.transitionLogMs || 200; // ~5 decisions/sec, display-independent (v36)
    {
      const cadence = grace ? RL_LOG_MS * 2 : RL_LOG_MS; // log fewer during spawn grace
      if (tNow - (B._lastTxMs != null ? B._lastTxMs : -1e9) >= cadence) {
        B._lastTxMs = tNow;
        (window.__transitionLog = window.__transitionLog || []).push({
          f: B.frames, life: B.lifeStartFrame || 0, sKey: qStateKey(state, { isDrone, nearest, nd, foes, bulletThreat, escapeR, myR }),
          x: feat.map((v) => +v.toFixed(3)), a: chosen, bc: B.bcActive ? 1 : 0,
          forced: predatorClose ? 'pred' : crowded ? 'crowd' : surrounded ? 'surr' : overPressure ? 'press' : null,
          prey: prey ? 1 : 0, lead: leading ? 1 : 0, cls, lvl: hud.level || null, score: hud.score || 0,
          mr: Math.round(myR), sq: state.fov || 0, // v30: our tank px-radius + median-square px (FOV/zoom proxies)
        });
        if (window.__transitionLog.length > 6000) window.__transitionLog.splice(0, window.__transitionLog.length - 6000);
      }
    }

    const out = (ACT[chosen] || actFarm)();
    moveKeys = out.moveKeys; aim = out.aim;
    // v26 RETURN FIRE: if a tank is engaging us - chasing/within combat range, or actively shooting
    // at us - put our fire (bullets, or drones for a drone class) ON it instead of on a shape, until
    // it's dead or out of range. Never keep plinking blocks while a tank attacks you. Hunt (aims at
    // prey) and predator-flee (aims at the confirmed hunter) already target the right enemy, so skip.
    if (!grace && nearest && chosen !== 'hunt' && !predatorClose) {
      const combatRange = DOCTRINE.combatRange || 400;
      const engaging = nd < combatRange || state.bullets.some((b) => b.enemy && b.dist < combatRange);
      if (engaging) {
        aim = leadAim(nearest, fovMul); // v36: return fire leads the target
        if (chosen === 'farm' || chosen === 'patrol') B.mode = B.mode + '+fire';
      }
    }
    // Tag the trigger in telemetry (predator-flee labels itself inside actEscape; crowd prefixes here).
    if (!grace && crowded && !predatorClose) B.mode = 'crowd-' + B.mode;
    if (leading) B.mode = 'lead-' + B.mode; // tag so the corpus can A/B time-survived-while-leading
    if (postUpgrade) B.mode = 'up-' + B.mode; // tag the post-upgrade caution window

    // Bullet dodge overrides movement in any mode: sidestepping an incoming shot beats whatever
    // else we were doing for these few frames. Aim is unaffected.
    const dodge = bulletDodge(state);
    if (dodge) { moveKeys = vectorToKeys(dodge[0], dodge[1]); B.mode = B.mode + '+dodge'; }

    if (firing) moveKeys.add(' '); // v36.1: SPACE = fire, held exactly like a movement key
    setHeld(moveKeys);
    // v36: the runner suspends synthetic aim briefly around trusted upgrade clicks (a stable pointer
    // is all the click needs) — movement keeps running, so the tank no longer freezes at L15/30/45.
    if (aim && DOCTRINE.aimEveryFrame && !aimSuspended) moveMouse(aim.x, aim.y);

    B._raf = requestAnimationFrame(step);
  }

  // start() begins a fresh life: autofire is off on a new tank, so allow it to be re-enabled.
  // v36: stamp the life clock here too — the runner calls start() right after each (re)spawn, so
  // the ms-denominated spawn grace measures from the actual life start, not from page navigation.
  B.start = () => { if (B.running) return; B.running = true; B.autofireOn = false; B.lifeStartMs = now(); B._raf = requestAnimationFrame(step); };
  B.stop = () => { B.running = false; releaseAll(); };
  // pause()/resume() bracket a brief external action (e.g. an upgrade click) WITHOUT touching
  // autofire state, so resuming does not toggle E and turn our guns off mid-life.
  B.pause = () => { B.running = false; releaseAll(); };
  B.resume = () => { if (B.running) return; B.running = true; B._raf = requestAnimationFrame(step); };
  B.snapshot = () => ({ frames: B.frames, mode: B.mode, statIdx: B.statIdx, autofireOn: B.autofireOn, hunterStreak: B.hunterStreak, predator: !!B.hunterLast, gapRejects: B.gapRejects || 0, lifeResets: B.lifeResets || 0 });
};
