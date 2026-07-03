// Layer-1 synthetic-state tests for the brain (run: node bot/brain/brain-test.mjs).
// Scenes are world-unit descriptions rendered through the harness; assertions check the brain's
// OUTPUT behavior (mode, held movement keys, aim) — not internals — so refactors stay honest.
import { makeEnv, scene, check, summary, CX, CY } from './test-harness.mjs';

// ---------- baseline sanity (pre-existing behavior that must never regress) ----------
{
  // Plain farm scene: one square to the right, no threats -> farm mode, move toward it.
  const env = makeEnv({ doctrine: { spawnGraceFrames: 0, spawnGraceMs: 0 } });
  env.setState(scene({ shapes: [{ w: [220, 0], kind: 'square' }] }));
  env.step(3);
  check('baseline: farms a lone shape', env.B.mode === 'farm', `mode=${env.B.mode}`);
  check('baseline: moves toward the shape', env.heldKeys().includes('d'), `held=${env.heldKeys()}`);
}
{
  // Single close enemy inside escapeR -> escape mode, flee away from it, aim at it.
  const env = makeEnv({ doctrine: { spawnGraceFrames: 0, spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [150, 0], r: 18 }] }));
  env.step(3);
  check('baseline: escapes a close enemy', env.B.mode.includes('escape'), `mode=${env.B.mode}`);
  check('baseline: flees away (west), not toward', env.heldKeys().includes('a') && !env.heldKeys().includes('d'), `held=${env.heldKeys()}`);
  const a = env.aim();
  check('baseline: keeps aim on the threat while fleeing', a && a.x > CX, `aim=${JSON.stringify(a)}`);
}

// ---------- change 4: wall-clock timers + corroborated life boundaries ----------
// Spawn grace must last ~4.3s of WALL TIME on any display. The old frame-denominated window
// (256 frames) elapsed in ~2.15s at 119fps — half the intended protection.
for (const fps of [60, 119]) {
  const env = makeEnv({ fps, hud: { cls: 'Tank', level: 1, score: 0 } });
  env.setState(scene({ shapes: [{ w: [220, 0] }] }));
  let frames = 0;
  while (env.B.mode !== 'farm' && frames < 1500) { env.step(1); frames++; }
  const elapsed = frames * env.clock.frameMs;
  check(`change4: spawn grace ≈4.3s wall time at ${fps}fps`, elapsed > 4100 && elapsed < 4700, `elapsed=${Math.round(elapsed)}ms`);
}
{
  // A 2s perception stall with score/class intact is a flicker, NOT a respawn: no grace re-entry.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 }, hud: { cls: 'Sniper', level: 20, score: 3000 } });
  const farm = scene({ shapes: [{ w: [220, 0] }] });
  env.setState(farm);
  env.step(5);
  env.setState(null); // perception stall
  env.step(250);
  env.setState(farm); // tank re-detected, HUD intact
  env.doctrine.spawnGraceMs = 4300; // re-arm grace so a (wrong) life reset would show as spawn-escape
  env.step(60); // ~1s later: a wrongly-reset life clock would still be deep in its 4.3s grace here
  check('change4: mid-life stall with intact HUD does not re-enter spawn grace', env.B.mode === 'farm', `mode=${env.B.mode}`);
  check('change4: rejected stall is counted for telemetry', (env.B.gapRejects || 0) >= 1, `gapRejects=${env.B.gapRejects}`);
  check('change4: no life reset recorded', (env.B.lifeResets || 0) === 0, `lifeResets=${env.B.lifeResets}`);
}
{
  // A GENUINE respawn during the gap (score ~0, base class) still resets the life and re-enters grace.
  const env = makeEnv({ doctrine: { spawnGraceMs: 4300 }, hud: { cls: 'Sniper', level: 20, score: 3000 } });
  const farm = scene({ shapes: [{ w: [220, 0] }] });
  env.setState(farm);
  let frames = 0;
  while (env.B.mode !== 'farm' && frames < 1500) { env.step(1); frames++; } // ride out initial grace
  env.setState(null);
  env.setHud({ cls: 'Tank', level: 2, score: 0 }); // died and respawned during the stall
  env.step(250);
  env.setState(farm);
  env.step(3);
  check('change4: genuine respawn re-enters spawn grace', env.B.mode === 'spawn-escape', `mode=${env.B.mode}`);
  check('change4: life reset recorded', (env.B.lifeResets || 0) === 1, `lifeResets=${env.B.lifeResets}`);
}

// ---------- change 5: escape-lane scoring (walls dominate, slide along them, dodge nests) ----------
{
  // Corner trap: pinned in the NW corner with a threat from the SE. Pure away-from-threat points
  // INTO the corner; the old -5 wall penalty barely argued against it. The chosen escape heading
  // must never push past an edge we're already on.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [180, 180], r: 18 }], map: { x: 0.03, y: 0.03 } }));
  env.step(3);
  check('change5: cornered escape never pushes into the walls', !env.heldKeys().includes('w') && !env.heldKeys().includes('a'), `held=${env.heldKeys()}`);
  check('change5: cornered escape still moves (slides along a wall)', env.heldKeys().length > 0, `held=${env.heldKeys()}`);
}
{
  // Nest in the flight lane: threat behind (west), a tight pentagon cluster dead ahead (east).
  // The lane must deflect around the nest instead of body-ramming through it.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({
    enemies: [{ w: [-200, 0], r: 18 }],
    shapes: [{ w: [80, 25], r: 26, kind: 'pentagon' }, { w: [100, -20], r: 26, kind: 'pentagon' }, { w: [120, 5], r: 26, kind: 'pentagon' }],
  }));
  env.step(3);
  const d = env.B.lastEscapeDir;
  const dotEast = d ? d[0] / Math.hypot(d[0], d[1]) : 1;
  check('change5: escape lane deflects around a pentagon nest', d && dotEast < 0.95, `dir=${JSON.stringify(d)}`);
  check('change5: ...but still flees generally away from the threat', d && d[0] > 0, `dir=${JSON.stringify(d)}`);
}

// ---------- change 2: world-unit perception — the zoom-invariance regression net ----------
{
  // The SAME world scene rendered at Tank zoom (1.0) and Assassin zoom (0.68) must produce
  // identical decisions: same mode, same held keys, world-equivalent aim. This is the net that
  // catches any leftover screen-px threshold anywhere in the brain.
  const scenarios = [
    ['farm+wary threat', { enemies: [{ w: [380, -60], r: 18 }], shapes: [{ w: [200, 40] }] }],
    ['close-threat escape', { enemies: [{ w: [170, 80], r: 20 }], shapes: [{ w: [-150, -100] }] }],
    ['crowd pincer', { enemies: [{ w: [200, 0], r: 18 }, { w: [-190, 40], r: 19 }], shapes: [{ w: [0, -220] }] }],
    ['bullet dodge', { enemies: [{ w: [420, 0], r: 18 }], bullets: [{ w: [200, 10], r: 5, vx: -9, vy: 0 }] }],
  ];
  for (const [name, spec] of scenarios) {
    const runs = [1.0, 0.68].map((f) => {
      const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
      env.setState(scene({ ...spec, fovMul: f }));
      env.step(4);
      const a = env.aim();
      return { mode: env.B.mode, held: env.heldKeys(), aimW: a ? { x: (a.x - CX) / f, y: (a.y - CY) / f } : null };
    });
    const [t, r] = runs;
    const aimOk = t.aimW && r.aimW && Math.abs(t.aimW.x - r.aimW.x) < 1 && Math.abs(t.aimW.y - r.aimW.y) < 1;
    check(`change2: zoom-invariant (${name})`, t.mode === r.mode && t.held === r.held && aimOk,
      `tank={${t.mode},${t.held}} ranger={${r.mode},${r.held}} aimW=${JSON.stringify(t.aimW)} vs ${JSON.stringify(r.aimW)}`);
  }
}
{
  // Far-field routing: two equal-distance shapes, one sitting next to a distant enemy cluster.
  // Farming must pick the shape in empty space (the old code flipped a coin on nearest-distance).
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({
    shapes: [{ w: [250, 120] }, { w: [250, -120] }],
    enemies: [{ w: [560, 180], r: 16 }, { w: [520, 260], r: 16 }], // cluster near the south shape, outside all threat radii
  }));
  env.step(3);
  check('change2: farming routes to the shape away from the enemy cluster', env.B.mode.includes('farm') && env.heldKeys().includes('w'), `mode=${env.B.mode} held=${env.heldKeys()}`);
}

// ---------- v36.1: firing is a held mouse button (idempotent — no toggle to desync) ----------
{
  const env = makeEnv({ doctrine: { spawnGraceMs: 4300 }, hud: { cls: 'Tank', level: 1, score: 0 } });
  env.setState(scene({ shapes: [{ w: [220, 0] }] }));
  env.step(10);
  check('fire: held mouse released during spawn grace', env.fire.held === false, `held=${env.fire.held}`);
  let frames = 0;
  while (env.B.mode !== 'farm' && frames < 1500) { env.step(1); frames++; }
  env.step(2);
  check('fire: held mouse engaged after grace', env.fire.held === true, `held=${env.fire.held}`);
  // A spurious brain restart (the old autofire-toggle killer) must NOT stop the firing.
  env.B.stop(); env.B.start();
  env.B.lifeStartMs = -10000; // keep the same life (no fresh grace) after the restart
  env.step(3);
  check('fire: still firing after a spurious stop/start (the 290-score bug)', env.fire.held === true, `held=${env.fire.held}`);
}

// ---------- change 1: kite-with-lead-fire ----------
{
  // Lead aim intercept: a strafing target at 400 world units moving +y at 6 wpx/frame with our
  // bullets at 12 wpx/frame -> eta 33.3 frames -> intercept ~200 units ahead of it.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [400, 0], r: 15, vy: 6 }] })); // outside escapeR -> return-fire path
  env.step(3);
  const a = env.aim();
  check('change1: lead aim intercepts a strafing target', a && Math.abs(a.x - (CX + 400)) < 2 && Math.abs(a.y - (CY + 200)) < 8, `aim=${JSON.stringify(a)} want ~{${CX + 400},${CY + 200}}`);
}
{
  // Eta clamp: a distant target's intercept never runs past 45 frames of lead.
  // (545 world units: inside combatRange 550 so return-fire engages, past the clamp point 12*45=540.)
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [545, 0], r: 15, vy: 6 }] }));
  env.step(3);
  const a = env.aim();
  check('change1: lead eta is clamped at 45 frames', a && Math.abs(a.y - (CY + 270)) < 8, `aim.y=${a && a.y} want ~${CY + 270}`);
}
{
  // Receding target: the aim point must never fall BEHIND the target's current position.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [400, 0], r: 15, vx: 8 }] }));
  env.step(3);
  const a = env.aim();
  check('change1: never aims behind a receding target', a && a.x >= CX + 400, `aim.x=${a && a.x}`);
}
{
  // Predator-flee target fix: a confirmed hunter east, a small foe west. The old code aimed at the
  // NEAREST foe while the hunter killed it from behind; a bullet class must lead-fire THE HUNTER.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  env.setState(scene({ enemies: [{ w: [350, 0], r: 30 }, { w: [-160, 0], r: 12 }] }));
  env.step(40); // ride out predator confirmation (~270ms)
  const a = env.aim();
  check('change1: predator-flee engages the hunter', env.B.mode.startsWith('predator'), `mode=${env.B.mode}`);
  check('change1: ...and aims at the hunter, not the nearest foe', a && a.x > CX, `aim=${JSON.stringify(a)}`);
}
{
  // Kite hysteresis: a pursuer oscillating across the escapeR boundary (240 <-> 300 world units,
  // escapeR 270 after fragile scaling) must NOT thrash farm<->escape — one entry, no exit until
  // clearly outside the exit band. And in the band, the mode is a KITE that keeps firing.
  const env = makeEnv({ doctrine: { spawnGraceMs: 0 } });
  const at = (d) => scene({ enemies: [{ w: [d, 0], r: 18 }], shapes: [{ w: [-300, 0] }] });
  let transitions = 0, prevFam = null, kiteSeen = 0, aimOnPursuer = 0, outSteps = 0;
  for (let i = 0; i < 20; i++) {
    env.setState(at(i % 2 ? 300 : 240));
    for (let j = 0; j < 15; j++) {
      env.step(1);
      const fam = env.B.mode.includes('escape') || env.B.mode.includes('kite') ? 'esc' : 'other';
      if (prevFam && fam !== prevFam) transitions++;
      prevFam = fam;
      if (env.B.mode.includes('kite')) {
        kiteSeen++;
        const a = env.aim();
        if (a && a.x > CX) aimOnPursuer++;
      }
      if (i > 0) outSteps++;
    }
  }
  check('change1: escape latch never thrashes at the boundary', transitions <= 1, `transitions=${transitions}`);
  check('change1: kite mode engages inside the band', kiteSeen > outSteps * 0.3, `kiteSeen=${kiteSeen}/${outSteps}`);
  check('change1: kiting keeps fire on the pursuer', kiteSeen > 0 && aimOnPursuer === kiteSeen, `${aimOnPursuer}/${kiteSeen}`);
  check('change1: autofire stays on while kiting', env.B.autofireOn === true);
}

summary('brain-test');
