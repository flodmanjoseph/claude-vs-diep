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
  const releaseAll = () => setHeld(new Set());

  const moveMouse = (x, y) => {
    const cv = document.getElementById('canvas');
    const ev = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, cancelable: true });
    (cv || document).dispatchEvent(ev);
    window.__lastAim = { x, y };
  };

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
    // Score by kind preference then proximity.
    const rank = (k) => { const i = DOCTRINE.preferKinds.indexOf(k); return i < 0 ? 99 : i; };
    let best = null, bestScore = Infinity;
    for (const s of shapes) {
      const score = rank(s.kind) * 1000 + s.dist;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function threatVector(state) {
    let vx = 0, vy = 0, danger = 0;
    for (const e of state.enemies) {
      if (e.self) continue;
      if (e.dist < DOCTRINE.enemyDangerRadius) {
        const w = (DOCTRINE.enemyDangerRadius - e.dist) / DOCTRINE.enemyDangerRadius;
        const m = Math.hypot(e.dx, e.dy) || 1;
        vx -= (e.dx / m) * w; vy -= (e.dy / m) * w;
        danger = Math.max(danger, w);
      }
    }
    for (const b of state.bullets) {
      if (!b.enemy) continue;
      if (b.dist < DOCTRINE.bulletDangerRadius) {
        // dodge perpendicular to the bullet's bearing from us
        const m = Math.hypot(b.dx, b.dy) || 1;
        const w = (DOCTRINE.bulletDangerRadius - b.dist) / DOCTRINE.bulletDangerRadius;
        vx -= (-b.dy / m) * w * 0.8; vy -= (b.dx / m) * w * 0.8;
        danger = Math.max(danger, w * 0.7);
      }
    }
    return { vx, vy, danger };
  }

  function step() {
    if (!B.running) return;
    B.frames++;
    const state = window.__readState();
    if (!state || !state.ok) { B._raf = requestAnimationFrame(step); return; }

    if (state.me.alive) B.lastAliveFrame = B.frames;
    ensureAutofire();
    allocStats();

    const threat = threatVector(state);
    let aim = null;
    let moveKeys = new Set();

    if (threat.danger > 0.02) {
      // Under threat: flee, but keep shooting at the nearest enemy.
      B.mode = 'flee';
      moveKeys = vectorToKeys(threat.vx, threat.vy);
      const nearestEnemy = state.enemies.find((e) => !e.self);
      aim = nearestEnemy ? { x: nearestEnemy.x, y: nearestEnemy.y } : (window.__lastAim || { x: 900, y: 360 });
    } else {
      // Safe: farm the best shape.
      const target = bestShape(state.shapes);
      if (target) {
        B.mode = 'farm';
        aim = { x: target.x, y: target.y };
        if (target.dist > DOCTRINE.approachStopDist) moveKeys = vectorToKeys(target.dx, target.dy);
      } else if (DOCTRINE.wanderWhenEmpty) {
        B.mode = 'wander';
        // drift toward screen-up-right to find shapes; aim forward
        moveKeys = vectorToKeys(1, -0.4);
        aim = { x: 1000, y: 250 };
      }
    }

    setHeld(moveKeys);
    if (aim && DOCTRINE.aimEveryFrame) moveMouse(aim.x, aim.y);

    B._raf = requestAnimationFrame(step);
  }

  B.start = () => { if (B.running) return; B.running = true; B.autofireOn = false; B._raf = requestAnimationFrame(step); };
  B.stop = () => { B.running = false; releaseAll(); };
  B.snapshot = () => ({ frames: B.frames, mode: B.mode, statIdx: B.statIdx, autofireOn: B.autofireOn });
};
