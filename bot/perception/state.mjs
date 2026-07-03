// Classify a captured frame into game entities, in screen coordinates.
// Runs inside the page. Own tank is at screen center, so (dx,dy) from center = relative position.
//
// diep.io FFA palette (body colors):
//   own tank      #4cc9ea (outline #0085a8)
//   enemy tank    #f14e54 (outline #b43a3f)
//   square        #ffe869   triangle #fc7677   pentagon #768aed   (+ alpha/green variants)
// Bullets/drones inherit owner color; we separate them from tanks by radius.

export const STATE_FN = function () {
  const CENTER = { x: 640, y: 360 };
  const near = (hex, set) => set.includes((hex || '').toLowerCase());

  const SELF = ['#4cc9ea', '#0085a8'];
  const ENEMY = ['#f14e54', '#b43a3f'];
  const SQUARE = ['#ffe869'];
  const TRIANGLE = ['#fc7677'];
  const PENTAGON = ['#768aed', '#768dfc'];

  window.__readState = function () {
    const f = window.__diep && window.__diep.frame;
    if (!f) return { ok: false };
    const W = window.__diep.W || 1280, H = window.__diep.H || 720;
    const cx = W / 2, cy = H / 2;

    // v36 WORLD-UNIT NORMALIZATION. The sniper line zooms the camera out (a square renders 22px as a
    // Tank but ~15px as an Assassin), so raw screen distances mean different WORLD distances per class.
    // v32 patched this by multiplying SOME brain thresholds by fovMul - which silently deleted the
    // Ranger's reach advantage and left other thresholds unscaled (the "blinder at long range, jumpier
    // at mid range" bug class). Instead, normalize ONCE here at the perception boundary: every
    // decision-space field (dx/dy/dist/r/vx/vy, me.r) is divided by fovMul so the brain always thinks
    // in world-equivalent units, while x/y stay SCREEN coordinates (that's what aiming needs).
    // fovMul comes from the previous frame's median-square read (zoom changes slowly; squares are
    // fixed world-size), clamped so a noisy read can't distort geometry.
    const fovMul = Math.max(0.45, Math.min(1.15, (window.__sqMed || 22) / 22));
    const me = { x: cx, y: cy, r: 0, alive: false };
    const enemies = [];
    const bullets = [];
    const shapes = [];

    // Circles: tanks (large), bullets/drones (small), split by WORLD radius so the cutoff is
    // zoom-invariant - at Ranger zoom a distant small tank no longer shrinks under a screen-px
    // threshold and vanishes from threat/prey logic (it was being misread as a bullet).
    const TANK_MIN_WORLD = 10;
    for (const c of f.circles) {
      const isSelf = near(c.c, SELF);
      const isEnemy = near(c.c, ENEMY);
      const dist = Math.hypot(c.x - cx, c.y - cy);
      const wr = c.r / fovMul;
      if (isSelf && dist < 60 && wr > 8) {
        if (wr > me.r) { me.r = wr; me.alive = true; }
        continue;
      }
      if (isEnemy || isSelf) {
        const wd = { x: c.x, y: c.y, r: wr, dx: (c.x - cx) / fovMul, dy: (c.y - cy) / fovMul, dist: dist / fovMul };
        if (wr >= TANK_MIN_WORLD) enemies.push({ ...wd, self: isSelf });
        else bullets.push({ ...wd, enemy: isEnemy });
      }
    }

    // Polys: shapes (farm targets) by color; ignore our own barrels (grey) and tiny bits.
    // Also: the minimap (bottom-right, ~1152..1266 x 590..706) draws our position as a tiny
    // arrow poly. Normalize it to map coords (0..1, x right, y down) for strategic navigation.
    let map = null;
    const MM = { x0: 1152, y0: 590, w: 114, h: 116 };
    for (const p of f.polys) {
      if (p.x > MM.x0 - 6 && p.x < MM.x0 + MM.w + 6 && p.y > MM.y0 - 6 && p.y < MM.y0 + MM.h + 6) {
        if (p.r >= 2 && p.r <= 10 && p.n >= 3 && p.n <= 6) {
          map = { x: Math.min(1, Math.max(0, (p.x - MM.x0) / MM.w)), y: Math.min(1, Math.max(0, (p.y - MM.y0) / MM.h)) };
        }
        continue; // nothing inside the minimap region is a farmable shape
      }
      let kind = null;
      if (near(p.c, SQUARE)) kind = 'square';
      else if (near(p.c, TRIANGLE)) kind = 'triangle';
      else if (near(p.c, PENTAGON)) kind = 'pentagon';
      if (!kind) continue;
      const wr = p.r / fovMul; // v36: size gate in world units (zoom-invariant)
      if (wr < 3 || wr > 120) continue;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      shapes.push({ x: p.x, y: p.y, r: wr, kind, dx: (p.x - cx) / fovMul, dy: (p.y - cy) / fovMul, dist: dist / fovMul });
    }

    enemies.sort((a, b) => a.dist - b.dist);
    shapes.sort((a, b) => a.dist - b.dist);
    bullets.sort((a, b) => a.dist - b.dist);

    // Velocity estimation: match entities to the previous frame by proximity and difference the
    // positions. Unmatched entities get v=0; stale gaps (>20 frames) reset tracking.
    // v36 ONE-TO-ONE: the old matcher let two crossing entities both claim the same previous point,
    // handing one of them a phantom velocity — poison for lead aim. Pairs are now taken in
    // ascending-distance order and each previous point is consumed exactly once.
    // Matching runs in SCREEN space (positions are screen px); the resulting velocities are divided
    // by fovMul so they land in world px/frame like every other decision field.
    const prev = window.__prevEnts;
    const dt = prev ? f.t - prev.t : 0;
    const attachVel = (arr, prevArr, maxJump) => {
      for (const e of arr) { e.vx = 0; e.vy = 0; }
      if (!prevArr || !prevArr.length || dt <= 0 || dt > 20) return;
      const cap = maxJump * dt;
      const pairs = [];
      for (let i = 0; i < arr.length; i++) {
        for (let j = 0; j < prevArr.length; j++) {
          const d = Math.hypot(arr[i].x - prevArr[j].x, arr[i].y - prevArr[j].y);
          if (d < cap) pairs.push([d, i, j]);
        }
      }
      pairs.sort((a, b) => a[0] - b[0]);
      const usedE = new Set(), usedP = new Set();
      for (const [, i, j] of pairs) {
        if (usedE.has(i) || usedP.has(j)) continue;
        usedE.add(i); usedP.add(j);
        const e = arr[i], p = prevArr[j];
        e.vx = (e.x - p.x) / dt / fovMul;
        e.vy = (e.y - p.y) / dt / fovMul;
      }
    };
    attachVel(bullets, prev?.bullets, 14); // bullets move fast: allow up to 14 screen-px/frame jump
    attachVel(enemies, prev?.enemies, 10);
    window.__prevEnts = { t: f.t, bullets: bullets.map((b) => ({ x: b.x, y: b.y })), enemies: enemies.map((e) => ({ x: e.x, y: e.y })) };

    // The minimap may redraw intermittently (cached layers), so persist the last-known position.
    if (map) window.__lastMap = map;
    // FOV/zoom proxy (v30): squares are a fixed WORLD size and don't grow with our level, so the median
    // on-screen square radius tracks the camera zoom (smaller = wider FOV). Persist last-known so it's
    // stable when no squares are in view. NOTE shape radii are already world-normalized above, so
    // multiply back by the fovMul used this frame to keep the proxy in SCREEN px.
    const sq = shapes.filter((s) => s.kind === 'square').map((s) => s.r * fovMul).sort((a, b) => a - b);
    if (sq.length) window.__sqMed = sq[sq.length >> 1];
    return { ok: true, t: f.t, W, H, me, enemies, bullets, shapes, map: map || window.__lastMap || null, fov: window.__sqMed || null, fovMul };
  };
};
