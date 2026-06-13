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
};
const KEYS = Object.keys(SPACE);

const POP = 8; // candidates per generation
const ELITES = 3; // top carried/used as parents
const EVALS = 3; // lives per candidate (averaged) to fight arena variance
const SIGMA = 0.16; // mutation stddev as a fraction of each parameter's range

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const FRACTIONAL = new Set(['bulletAimedCos', 'enemySizeWeight', 'huntSizeRatio', 'predatorRatio']);
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

// Fitness of a single life. Score is the goal; level and survival give signal even in short lives.
export function lifeFitness({ score = 0, level = 0, lifeMs = 0 }) {
  return score + 40 * level + 0.4 * (lifeMs / 1000);
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
// Trimmed mean: drop the worst sample (often a spawn-camp fluke) once we have enough.
const robustMean = (a) => (a.length >= 3 ? mean([...a].sort((x, y) => x - y).slice(1)) : mean(a));

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

  // Record the just-finished life's fitness against the active candidate.
  record(fitness) {
    if (!this._active) return;
    this._active.fits.push(fitness);
    this.evalNo++;
    const m = robustMean(this._active.fits);
    if (!this.champion || m > this.champion.fitness) {
      if (this._active.fits.length >= 2) this.champion = { params: { ...this._active.params }, fitness: m };
    }
    this.save();
  }

  evolve() {
    // Rank by robust mean fitness; carry elites, breed the rest from them, keep the champion.
    const ranked = [...this.population].sort((a, b) => robustMean(b.fits) - robustMean(a.fits));
    const bestMean = robustMean(ranked[0]?.fits || []);
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
