// Make the evolution legible: print generation progress, the champion vs the hand-tuned base,
// per-candidate fitness this generation, and the fitness trend across generations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPACE } from '../bot/brain/optimizer.mjs';
import { DOCTRINE as BASE } from '../bot/brain/doctrine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'analysis', 'optimizer-state.json');

let s;
try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { console.log('no optimizer state yet'); process.exit(0); }

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const robustMean = (a) => (a.length >= 3 ? mean([...a].sort((x, y) => x - y).slice(1)) : mean(a));

console.log(`=== optimizer: generation ${s.gen}, ${s.evalNo} total lives evaluated ===\n`);

console.log('this generation (candidate: mean fitness over its lives):');
const ranked = s.population
  .map((c, i) => ({ i, m: robustMean(c.fits), n: c.fits.length, fits: c.fits }))
  .sort((a, b) => b.m - a.m);
for (const c of ranked) {
  const bar = '#'.repeat(Math.max(0, Math.round(c.m / 200)));
  console.log(`  cand ${c.i}  ${c.n} lives  mean ${Math.round(c.m).toString().padStart(5)}  ${bar} ${c.fits.map(Math.round).join(',')}`);
}

if (s.champion) {
  console.log(`\nchampion fitness ${Math.round(s.champion.fitness)} — params vs hand-tuned base (* = changed):`);
  for (const k of Object.keys(SPACE)) {
    const cv = s.champion.params[k], bv = BASE[k];
    const changed = cv !== bv ? ' *' : '';
    const arrow = cv > bv ? 'up' : cv < bv ? 'dn' : '==';
    console.log(`  ${k.padEnd(20)} base ${String(bv).padStart(6)}  ->  champ ${String(cv).padStart(6)}  ${arrow}${changed}`);
  }
}

if (s.history?.length) {
  console.log('\nfitness trend across generations (best mean | champion):');
  for (const h of s.history) console.log(`  gen ${String(h.gen).padStart(2)}  best ${String(h.bestMean).padStart(5)}  champ ${String(h.championFitness).padStart(5)}  (${h.evals} lives)`);
}
