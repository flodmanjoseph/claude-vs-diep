// The in-page brain. Runs at requestAnimationFrame rate: read perception, decide, dispatch
// synthetic input. Exposes window.__brain for the runner to start/stop and read stats.
// Injected as a factory that receives the doctrine object.
export const BRAIN_FN = function (DOCTRINE) {
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
    _raf: null,
  });

  const now = () => performance.now();

  function ensureAutofire() {
    if (DOCTRINE.autofire && !B.autofireOn) { tapKey('e'); B.autofireOn = true; }
  }

  function allocStats() {
    if (now() - B.lastStat < DOCTRINE.statTickMs) return;
    B.lastStat = now();
    const seq = DOCTRINE.statSequence;
    const stat = seq[B.statIdx % seq.length];
    B.statIdx++;
    tapKey(String(stat));
  }

  function bestShape(shapes) {
    if (!shapes.length) return null;
    // Distance-dominant: nearest shape wins, higher-value kinds get a small distance discount.
    const rank = (k) => { const i = DOCTRINE.preferKinds.indexOf(k); return i < 0 ? 5 : i; };
    let best = null, bestScore = Infinity;
    for (const s of shapes) {
      const score = s.dist + rank(s.kind) * DOCTRINE.kindDistancePenalty;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  const enemiesOf = (state) => state.enemies.filter((e) => !e.self);

  // Pick the 8-direction heading that moves most away from all weighted threats (toward open
  // space). Bigger/closer enemies and incoming bullets weigh more. Beats a raw repulsion sum,
  // which can point straight through a third enemy.
  const DIRS = [[0, -1], [0.71, -0.71], [1, 0], [0.71, 0.71], [0, 1], [-0.71, 0.71], [-1, 0], [-0.71, -0.71]];
  function bestEscapeDir(state) {
    let best = [0, 1], bestScore = -Infinity;
    const foes = enemiesOf(state);
    for (const [dx, dy] of DIRS) {
      let score = 0;
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

  function step() {
    if (!B.running) return;
    B.frames++;
    const state = window.__readState();
    if (!state || !state.ok) { B._raf = requestAnimationFrame(step); return; }

    // Track life boundaries: a gap in alive frames means we just (re)spawned.
    if (state.me.alive) {
      if (B.frames - B.lastAliveFrame > 10) B.lifeStartFrame = B.frames;
      B.lastAliveFrame = B.frames;
    }
    const sinceSpawn = B.frames - (B.lifeStartFrame || 0);
    const grace = sinceSpawn < DOCTRINE.spawnGraceFrames;

    // During spawn grace, do NOT fire: diep's spawn protection ends on your first shot. Stay
    // unshielded only after we've used the protection window to flee to open space.
    const cls = (window.__diep && window.__diep.hud && window.__diep.hud.cls) || 'Tank';
    const isDrone = DOCTRINE.droneClasses.includes(cls);
    if (!grace) { ensureAutofire(); setMouseHold(isDrone); } else { setMouseHold(false); }
    allocStats();

    let aim = null;
    let moveKeys = new Set();

    const foes = enemiesOf(state);
    const nearest = foes[0]; // state.enemies is sorted by distance
    const nd = nearest ? nearest.dist : Infinity;
    const bulletThreat = state.bullets.some((b) => b.enemy && b.dist < DOCTRINE.bulletDangerRadius);
    const escapeR = grace ? DOCTRINE.spawnEscapeRadius : DOCTRINE.escapeRadius;

    if (nearest && (nd < escapeR || bulletThreat)) {
      // Flee toward open space; keep shooting the nearest enemy.
      B.mode = grace ? 'spawn-escape' : 'escape';
      const [dx, dy] = bestEscapeDir(state);
      moveKeys = vectorToKeys(dx, dy);
      aim = { x: nearest.x, y: nearest.y };
    } else {
      // Farm. Approach to shooting range, never body-contact a shape, and keep distance from any
      // enemy inside the wary radius (kite). Shoot a close-ish enemy, otherwise shoot the shape.
      const target = bestShape(state.shapes);
      if (target) {
        B.mode = (nearest && nd < DOCTRINE.waryRadius) ? 'kite-farm' : 'farm';
        let mvx = 0, mvy = 0;
        if (target.dist > DOCTRINE.approachStopDist) { const m = target.dist || 1; mvx += target.dx / m; mvy += target.dy / m; }
        for (const s of state.shapes) {
          const contact = (state.me.r || 17) + s.r + DOCTRINE.shapeBodyMargin;
          if (s.dist < contact) { const m = s.dist || 1; mvx -= (s.dx / m) * 1.5; mvy -= (s.dy / m) * 1.5; }
        }
        if (nearest && nd < DOCTRINE.waryRadius) {
          const m = nd || 1; const wb = (DOCTRINE.waryRadius - nd) / DOCTRINE.waryRadius;
          mvx -= (nearest.dx / m) * wb * 1.8; mvy -= (nearest.dy / m) * wb * 1.8;
        }
        aim = (nearest && nd < escapeR * 1.3) ? { x: nearest.x, y: nearest.y } : { x: target.x, y: target.y };
        moveKeys = (mvx || mvy) ? vectorToKeys(mvx, mvy) : new Set();
      } else if (DOCTRINE.wanderWhenEmpty) {
        B.mode = 'wander';
        moveKeys = vectorToKeys(0.6, -0.5);
        aim = { x: 1000, y: 200 };
      }
    }

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
  B.snapshot = () => ({ frames: B.frames, mode: B.mode, statIdx: B.statIdx, autofireOn: B.autofireOn });
};
