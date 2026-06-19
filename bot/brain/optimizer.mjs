// Evolutionary doctrine optimizer. A (mu+lambda) evolution strategy over the brain's numeric
// policy parameters: each life evaluates a candidate doctrine, fitness = how well that life went,
// and the population evolves between generations. Champion (best-ever) is always carried so we
// never regress. State persists to disk so it resumes across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCTRINE as BASE } from './doctrine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_PATH = path.join(ROOT, 'analysis', 'optimizer-state.json');

// The search space: [min, max] for each tunable. Everything else in the doctrine (buildPath,
// droneClasses, preferKinds, patrolAnchors, ...) is fixed and merged in around these.
export const SPACE = {
  escapeRadius: [120, 320],
  waryRadius: [240, 480],
  bulletDangerRadius: [80, 240],
  enemySizeWeight: [0, 0.15],
  anticipationFrames: [0, 45],
  bulletDodgeRadius: [150, 380],
  bulletAimedCos: [0.6, 0.96],
  bulletMissMargin: [25, 110],
  spawnGraceFrames: [60, 320],
  spawnEscapeRadius: [200, 460],
  kindDistancePenalty: [0, 200],
  approachStopDist: [80, 260],
  shapeBodyMargin: [10, 60],
  huntSizeRatio: [0.5, 1.0],
  huntRange: [200, 460],
  huntStandoff: [110, 260],
  crowdRadius: [180, 420], // how far out a converging swarm triggers forced flight
  predatorRatio: [1.05, 1.5], // size ratio at which a bigger tank counts as a hunter to flee
  predatorFleeRadius: [220, 420], // how early to flee a confirmed hunter
  edgeBiasWeight: [0, 2.2], // strength of the farm-toward-nearest-edge drift (0 = off); v16's lever
  // v17 proactive-spacing tunables (the headline redesign):
  spacingRadius: [300, 480], // foes within this build threat pressure
  surroundRadius: [250, 400], // foes within this count toward the open-lane / surround analysis
  spacingFloor: [0.01, 0.05], // pressure above which farming switches to spaced movement
  spacingGain: [0.4, 3.0], // strength of the along-lane spacing push while farming
  pressureCap: [0.03, 0.12], // pressure at which the spacing push saturates
  pressureEscape: [0.04, 0.14], // pressure that forces a full escape
  safeLaneMinDeg: [90, 170], // surround threshold: smallest "open lane" before a forced breakout
  safeShapeBias: [0, 220], // penalty steering farm targets away from the threat centroid
  // v18 fragile-phase survival gating:
  fragilePhaseScale: [1.0, 1.6], // how much more cautious a pre-drone Tank/Sniper plays (1.0 = off)
  // v19 lead-protection:
  leadScale: [1.0, 1.8], // how much more defensively we play when at/near #1 (1.0 = off)
  // v20 economy:
  dronePentagonBonus: [0, 300], // px discount steering a safe drone toward high-XP pentagons (0 = off)
  // v22 post-upgrade caution:
  upgradeGraceFrames: [60, 360], // frames of caution after a class upgrade
  upgradeScale: [1.0, 1.7], // flee-radius multiplier during the post-upgrade window (1.0 = off)
};
const KEYS = Object.keys(SPACE);

const POP = 8; // candidates per generation
const ELITES = 3; // top carried/used as parents
const EVALS = 4; // lives per candidate to fight arena variance (median needs a few)
const SIGMA = 0.16; // mutation stddev as a fraction of each parameter's range

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const FRACTIONAL = new Set(['bulletAimedCos', 'enemySizeWeight', 'huntSizeRatio', 'predatorRatio', 'edgeBiasWeight', 'spacingGain', 'pressureCap', 'pressureEscape', 'spacingFloor', 'fragilePhaseScale', 'leadScale', 'upgradeScale']);
const round = (k, v) => FRACTIONAL.has(k) ? +v.toFixed(3) : Math.round(v);

function gauss() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function paramsFromBase() {
  const p = {};
  for (const k of KEYS) p[k] = round(k, BASE[k]);
  return p;
}
function mutate(parent) {
  const child = {};
  for (const k of KEYS) {
    const [lo, hi] = SPACE[k];
    let v = parent[k];
    if (Math.random() < 0.7) v += gauss() * SIGMA * (hi - lo);
    child[k] = round(k, clamp(v, SPACE[k]));
  }
  return child;
}
function randomParams() {
  const p = {};
  for (const k of KEYS) { const [lo, hi] = SPACE[k]; p[k] = round(k, lo + Math.random() * (hi - lo)); }
  return p;
}

// Fitness of a single life. v17 reweight: the path to #1 is a CONSISTENT long life that reaches
// Overlord (then score follows), but the old score-dominated fitness chased rare high-score spikes
// the population couldn't reproduce. Survival seconds and class/level now carry real weight so a
// reliable long Overlord life out-scores a lucky short spike, and the optimizer optimizes the skill
// that actually precedes a #1 run. Score still counts fully - it is the ultimate goal.
export function lifeFitness({ score = 0, level = 0, lifeMs = 0 }) {
  // v18: level weight 55 -> 100. The bottleneck is the survival funnel (only 22% reach Overseer, 1%
  // reach Overlord), so reaching a higher class/level must carry real weight to push evolution toward
  // params that get THROUGH the funnel - the prerequisite for the high-score lives that win #1.
  return score + 100 * level + 7 * (lifeMs / 1000);
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

export class Optimizer {
  constructor() {
    this.gen = 0;
    this.evalNo = 0;
    this.population = []; // [{ params, fits: [] }]
    this.champion = null; // { params, fitness }
    this.history = []; // [{ gen, bestMean, championFitness }]
    this.load();
    if (!this.population.length) this.seed();
    // Backfill any params added to SPACE since the state was saved (from base), so older
    // candidates and the champion gain the new search dimensions without resetting progress.
    const fix = (p) => { if (p) for (const k of KEYS) if (p[k] == null) p[k] = round(k, BASE[k]); return p; };
    for (const c of this.population) fix(c.params);
    if (this.champion) fix(this.champion.params);
  }

  seed() {
    // Start from the hand-tuned base plus mutations and a couple of random explorers.
    const base = paramsFromBase();
    this.population = [{ params: base, fits: [] }];
    for (let i = 1; i < POP - 2; i++) this.population.push({ params: mutate(base), fits: [] });
    this.population.push({ params: randomParams(), fits: [] }, { params: randomParams(), fits: [] });
    this.gen = 1;
  }

  // The doctrine to play the next life with. Cycles candidates until each has EVALS lives, then evolves.
  nextDoctrine() {
    let cand = this.population.find((c) => c.fits.length < EVALS);
    if (!cand) { this.evolve(); cand = this.population[0]; }
    this._active = cand;
    const version = `opt-g${this.gen}-${this.population.indexOf(cand)}`;
    return { ...BASE, ...cand.params, version };
  }

  // Record the just-finished life's fitness against the active candidate. Champion is crowned ONLY
  // from a FULLY evaluated candidate (all EVALS lives) scored by its MEDIAN, so a single lucky life
  // can't freeze an unbeatable benchmark the way the gen-16 champion did. Median rewards a repeatable
  // life over a one-off spike.
  record(fitness) {
    if (!this._active) return;
    this._active.fits.push(fitness);
    this.evalNo++;
    if (this._active.fits.length >= EVALS) {
      const m = median(this._active.fits);
      if (!this.champion || m > this.champion.fitness) this.champion = { params: { ...this._active.params }, fitness: m };
    }
    this.save();
  }
  // The active candidate's params, for per-life telemetry (so the corpus becomes minable).
  activeParams() { return this._active ? this._active.params : null; }

  evolve() {
    // Rank by median fitness; carry elites, breed the rest from them, keep the champion.
    const ranked = [...this.population].sort((a, b) => median(b.fits) - median(a.fits));
    const bestMean = median(ranked[0]?.fits || []);
    this.history.push({ gen: this.gen, bestMean: +bestMean.toFixed(0), championFitness: +(this.champion?.fitness || 0).toFixed(0), evals: this.evalNo });

    const elites = ranked.slice(0, ELITES).map((c) => c.params);
    if (this.champion && !elites.some((e) => JSON.stringify(e) === JSON.stringify(this.champion.params))) {
      elites[elites.length - 1] = this.champion.params; // guarantee the champion competes
    }
    const next = elites.map((params) => ({ params, fits: [] }));
    while (next.length < POP) {
      const parent = elites[Math.floor(Math.random() * elites.length)];
      next.push({ params: mutate(parent), fits: [] });
    }
    this.population = next;
    this.gen++;
    this.save();
  }

  status() {
    const cur = this.population.map((c) => c.fits.length).reduce((s, v) => s + v, 0);
    return { gen: this.gen, evalsThisGen: `${cur}/${POP * EVALS}`, totalEvals: this.evalNo, champion: this.champion ? Math.round(this.champion.fitness) : null };
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      Object.assign(this, { gen: s.gen, evalNo: s.evalNo, population: s.population, champion: s.champion, history: s.history || [] });
    } catch { /* fresh */ }
  }
  save() {
    const out = { gen: this.gen, evalNo: this.evalNo, population: this.population, champion: this.champion, history: this.history, space: SPACE, updated: this._stamp || null };
    fs.writeFileSync(STATE_PATH, JSON.stringify(out, null, 1));
  }
}
