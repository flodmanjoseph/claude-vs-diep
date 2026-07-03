// Layer-1 tests for the perception classifier (run: node bot/perception/state-test.mjs).
// Exercises the REAL STATE_FN against hand-built raw frames ({circles, polys}), verifying the v36
// world-unit contract, the zoom-scaled tank/bullet classifier, and the one-to-one velocity matcher.
import { STATE_FN } from './state.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

globalThis.window = { __diep: { frame: null, W: 1280, H: 720 } };
STATE_FN();
const read = (frame) => { window.__diep.frame = frame; return window.__readState(); };
const reset = () => { window.__sqMed = undefined; window.__prevEnts = undefined; window.__lastMap = undefined; };
const SELF = '#4cc9ea', ENEMY = '#f14e54', SQUARE = '#ffe869';
const meC = { x: 640, y: 360, r: 15, c: SELF };
const sq = (x, y, r) => ({ x, y, r, n: 4, c: SQUARE });

// ---------- zoom-scaled tank/bullet classifier ----------
{
  reset();
  // Frame 1 at Assassin zoom: squares render ~15px (fovMul 15/22 = 0.68). Seeds the zoom proxy.
  read({ t: 1, circles: [meC], polys: [sq(300, 200, 15), sq(500, 500, 15), sq(1000, 250, 15)] });
  // Frame 2: an 8px enemy circle. At Tank zoom that's a bullet; at THIS zoom it's a small tank
  // (world r = 8/0.68 = 11.7 >= 10). The old fixed screen-px cutoff made distant tanks vanish
  // from threat logic exactly at the zoom where the Ranger should see farthest.
  const s = read({ t: 2, circles: [meC, { x: 900, y: 300, r: 8, c: ENEMY }, { x: 500, y: 400, r: 4, c: ENEMY }], polys: [sq(300, 200, 15)] });
  check('classifier: 8px circle at Assassin zoom is a TANK', s.enemies.length === 1, `enemies=${s.enemies.length}`);
  check('classifier: 4px circle stays a bullet', s.bullets.length === 1, `bullets=${s.bullets.length}`);
  const e = s.enemies[0];
  check('classifier: decision fields are world units', e && Math.abs(e.dist - Math.hypot(900 - 640, 300 - 360) / (15 / 22)) < 2, `dist=${e && e.dist}`);
  check('classifier: x/y stay screen units for aiming', e && e.x === 900 && e.y === 300, `x=${e && e.x}`);
}

// ---------- one-to-one velocity matcher ----------
{
  reset();
  // Clean tracking: two enemies moving apart get their own velocities.
  read({ t: 1, circles: [meC, { x: 700, y: 300, r: 14, c: ENEMY }, { x: 900, y: 300, r: 14, c: ENEMY }], polys: [] });
  const s = read({ t: 2, circles: [meC, { x: 708, y: 300, r: 14, c: ENEMY }, { x: 892, y: 300, r: 14, c: ENEMY }], polys: [] });
  const vs = s.enemies.map((e) => Math.round(e.vx)).sort((a, b) => a - b);
  check('attachVel: clean two-entity tracking', vs[0] === -8 && vs[1] === 8, `vx=${JSON.stringify(vs)}`);
}
{
  reset();
  // One previous point, TWO current entities near it (one just appeared). The old greedy matcher
  // let BOTH claim the same prev point — handing the new entity a phantom velocity that poisons
  // lead aim. One-to-one: exactly one gets a velocity, the newcomer gets v=0.
  read({ t: 1, circles: [meC, { x: 800, y: 300, r: 14, c: ENEMY }], polys: [] });
  const s = read({ t: 2, circles: [meC, { x: 806, y: 300, r: 14, c: ENEMY }, { x: 796, y: 300, r: 14, c: ENEMY }], polys: [] });
  const nonzero = s.enemies.filter((e) => e.vx !== 0 || e.vy !== 0).length;
  check('attachVel: crossing/appearing entities never share a prev point', nonzero === 1, `nonzero=${nonzero}`);
}
{
  reset();
  // Velocities are world units: 6.8 screen px/frame at fovMul 0.68 must read ~10 world px/frame.
  read({ t: 1, circles: [meC], polys: [sq(300, 200, 15), sq(500, 500, 15), sq(1000, 250, 15)] });
  read({ t: 2, circles: [meC, { x: 900, y: 300, r: 14, c: ENEMY }], polys: [sq(300, 200, 15)] });
  const s = read({ t: 3, circles: [meC, { x: 906.8, y: 300, r: 14, c: ENEMY }], polys: [sq(300, 200, 15)] });
  const e = s.enemies[0];
  check('attachVel: velocities are world px/frame', e && Math.abs(e.vx - 10) < 0.4, `vx=${e && e.vx}`);
}

console.log(`\nstate-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
