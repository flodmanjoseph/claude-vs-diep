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

    const me = { x: cx, y: cy, r: 0, alive: false };
    const enemies = [];
    const bullets = [];
    const shapes = [];

    // Circles: tanks (large), bullets/drones (small). Color → side.
    for (const c of f.circles) {
      const isSelf = near(c.c, SELF);
      const isEnemy = near(c.c, ENEMY);
      const dist = Math.hypot(c.x - cx, c.y - cy);
      if (isSelf && dist < 60 && c.r > 8) {
        if (c.r > me.r) { me.r = c.r; me.alive = true; }
        continue;
      }
      if (isEnemy || isSelf) {
        // Tank body vs bullet by radius (tanks ~14-60+, bullets smaller & fast).
        if (c.r >= 12) enemies.push({ x: c.x, y: c.y, r: c.r, dx: c.x - cx, dy: c.y - cy, dist, self: isSelf });
        else bullets.push({ x: c.x, y: c.y, r: c.r, dx: c.x - cx, dy: c.y - cy, dist, enemy: isEnemy });
      }
    }

    // Polys: shapes (farm targets) by color; ignore our own barrels (grey) and tiny bits.
    for (const p of f.polys) {
      let kind = null;
      if (near(p.c, SQUARE)) kind = 'square';
      else if (near(p.c, TRIANGLE)) kind = 'triangle';
      else if (near(p.c, PENTAGON)) kind = 'pentagon';
      if (!kind) continue;
      if (p.r < 4 || p.r > 120) continue;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      shapes.push({ x: p.x, y: p.y, r: p.r, kind, dx: p.x - cx, dy: p.y - cy, dist });
    }

    enemies.sort((a, b) => a.dist - b.dist);
    shapes.sort((a, b) => a.dist - b.dist);
    bullets.sort((a, b) => a.dist - b.dist);

    // Velocity estimation: match entities to the previous frame by proximity and difference the
    // positions (px/frame, ~60fps). Unmatched entities get v=0. The brain calls this every rAF,
    // so the previous-frame store stays fresh; stale gaps (>20 frames) reset tracking.
    const prev = window.__prevEnts;
    const dt = prev ? f.t - prev.t : 0;
    const attachVel = (arr, prevArr, maxJump) => {
      for (const e of arr) {
        e.vx = 0; e.vy = 0;
        if (!prevArr || dt <= 0 || dt > 20) continue;
        let best = null, bestD = maxJump * dt;
        for (const p of prevArr) {
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (best) { e.vx = (e.x - best.x) / dt; e.vy = (e.y - best.y) / dt; }
      }
    };
    attachVel(bullets, prev?.bullets, 14); // bullets move fast: allow up to 14 px/frame jump
    attachVel(enemies, prev?.enemies, 10);
    window.__prevEnts = { t: f.t, bullets: bullets.map((b) => ({ x: b.x, y: b.y })), enemies: enemies.map((e) => ({ x: e.x, y: e.y })) };

    return { ok: true, t: f.t, W, H, me, enemies, bullets, shapes };
  };
};
