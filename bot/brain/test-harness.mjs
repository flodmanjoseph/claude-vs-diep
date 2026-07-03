// Synthetic test environment for BRAIN_FN: run the in-page brain in Node with a stubbed
// window/document/performance and a manually-stepped requestAnimationFrame, feeding hand-built
// __readState scenes. Layer 1 of the validation stack (DEVLOG 046): every behavior change gets a
// scene + assertion in brain-test.mjs before it ships to a live shift.
//
// The clock is fully synthetic and frame-rate-parameterized (fps option), which is exactly what
// lets us assert wall-time behavior on BOTH a 60fps display and this Mac's 119fps ProMotion panel
// (the bug class change 4 fixes: frame-denominated windows elapsing in half their intended time).
import { BRAIN_FN } from './brain.mjs';
import { DOCTRINE } from './doctrine.mjs';

export const CX = 640, CY = 360;

// Minimal DOM event stand-in: the harness only reads .type/.key/.clientX/.clientY back out.
class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}

// Build a fresh brain instance wired to a synthetic page. Returns handles to drive frames and
// inspect what the brain DID (held movement keys, key taps, aim position, mode).
export function makeEnv({ fps = 60, doctrine = {}, hud = { cls: 'Sniper', level: 20, score: 3000 } } = {}) {
  const clock = { ms: 0, frameMs: 1000 / fps };
  let rafCb = null;
  const held = new Set(); // movement keys currently held (tracked from keydown/keyup)
  const taps = []; // non-movement key taps (stat allocation, autofire toggle)
  const fire = { held: false }; // synthetic mouse button state (v36.1: firing is a held button)
  const canvas = {
    dispatchEvent: (ev) => {
      if (ev.type === 'mousedown') fire.held = true;
      else if (ev.type === 'mouseup') fire.held = false;
    },
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  };
  const doc = {
    getElementById: (id) => (id === 'canvas' ? canvas : null),
    // The brain dispatches each key event to document+window+canvas; record only here (once).
    // Held keys: WASD movement + SPACE (fire, v36.1). Everything else is a tap (stats, toggles).
    dispatchEvent: (ev) => {
      if (ev.type === 'keydown') {
        if ('wasd '.includes(ev.key)) { held.add(ev.key); if (ev.key === ' ') fire.held = true; }
        else taps.push(ev.key);
      } else if (ev.type === 'keyup') { held.delete(ev.key); if (ev.key === ' ') fire.held = false; }
    },
  };
  const win = { dispatchEvent: () => {}, __diep: { hud: { ...hud } } };

  // Install the globals the in-page factory expects (bare refs resolve to globalThis in Node).
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.KeyboardEvent = FakeEvent;
  globalThis.MouseEvent = FakeEvent;
  globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock.ms }, configurable: true });

  const d = { ...structuredClone(DOCTRINE), ...doctrine };
  BRAIN_FN(d);
  const B = win.__brain;
  let state = null;
  win.__readState = () => state;
  B.start(); // schedule the first rAF; nothing runs until step() fires it

  return {
    win, B, doctrine: d, clock, held, taps, fire,
    setState: (s) => { state = s; },
    setHud: (h) => Object.assign(win.__diep.hud, h),
    // Advance n animation frames (each advances the clock by one frame interval, then fires rAF).
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        clock.ms += clock.frameMs;
        const cb = rafCb; rafCb = null;
        if (cb) cb(clock.ms);
      }
    },
    aim: () => win.__lastAim || null,
    heldKeys: () => [...held].sort().join(''),
  };
}

// Scene builder in WORLD units, matching the v36 perception contract exactly (state.mjs):
//   - x/y: absolute SCREEN coordinates (what aiming uses) = CENTER + world * fovMul
//   - dx/dy/dist/r/vx/vy: WORLD-normalized decision fields (screen values / fovMul)
// Entities are given relative to our tank (w: [wx, wy] world offset, r/vx/vy in world units), so
// the SAME scene description rendered at two zooms is the zoom-invariance regression: the brain
// must make identical decisions at fovMul 1.0 and 0.68.
export function scene({ fovMul = 1, meR = 17, alive = true, enemies = [], bullets = [], shapes = [], map = { x: 0.5, y: 0.5 } } = {}) {
  const f = fovMul;
  const mk = (e) => ({
    x: CX + e.w[0] * f, y: CY + e.w[1] * f, // screen position (aim space)
    r: e.r || 15, dx: e.w[0], dy: e.w[1], dist: Math.hypot(e.w[0], e.w[1]),
    vx: e.vx || 0, vy: e.vy || 0, // world px/frame
  });
  return {
    ok: true, t: 0, W: 1280, H: 720,
    me: { x: CX, y: CY, r: meR, alive },
    enemies: enemies.map((e) => ({ ...mk(e), self: false })),
    bullets: bullets.map((b) => ({ ...mk(b), enemy: b.enemy !== false })),
    shapes: shapes.map((s) => ({ ...mk(s), kind: s.kind || 'square' })),
    map,
    fov: 22 * f, // median square px: the zoom proxy (22 at Tank baseline)
    fovMul: f,
  };
}

// Tiny assertion kit shared by the test files.
let pass = 0, fail = 0;
export function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
export function summary(label) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
