// Cross-corpus miner: read EVERY telemetry/shift-*.jsonl and extract the campaign-wide patterns
// that single-shift summaries miss. Answers "what actually kills us, what actually correlates with
// long lives and high scores" across all 754+ lives. Usage: node analysis/corpus.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'telemetry');
const files = fs.readdirSync(dir).filter((f) => f.startsWith('shift-') && f.endsWith('.jsonl')).sort();

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

// Per-shift parse, keeping heartbeats so we can find the mode/state right before each death.
const shifts = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const start = lines.find((l) => l.event === 'shift_start');
  if (!start) continue;
  shifts.push({ f, t0: start.t, doc: start.doctrine, lines });
}
shifts.sort((a, b) => a.t0 - b.t0);

// --- Campaign-wide aggregates ---
let lives = 0;
const lifeSecs = [];
const reach = { Tank: 0, Sniper: 0, Overseer: 0, Overlord: 0 }; // lives that ENDED at >= this class
const deathByClass = {};
const deathByMode = {}; // mode at the last heartbeat before death
let withEnemy = 0, pblank = 0, crowdAtDeath = 0; // proximity / crowd at death
const crowdSizes = [];
const allScores = []; // peak myScore per life
const heAll = { fledDied: 0, fledEsc: 0, notDied: 0, notEsc: 0 };
const heByClass = {};
const gapClosed = [];

// classify class rank for "reached" accounting
const RANK = { Tank: 0, Sniper: 1, Overseer: 2, Overlord: 3 };

for (const sh of shifts) {
  const hbs = sh.lines.filter((l) => l.event === 'heartbeat');
  // index heartbeats by time for nearest-before-death lookup
  for (const l of sh.lines) {
    if (l.event === 'death') {
      lives++;
      lifeSecs.push((l.lifeMs || 0) / 1000);
      const c = l.cls || 'Tank';
      deathByClass[c] = (deathByClass[c] || 0) + 1;
      for (const k of Object.keys(RANK)) if (RANK[c] >= RANK[k]) reach[k]++;
      // nearest heartbeat at or before this death
      let best = null;
      for (const h of hbs) { if (h.t <= l.t && (!best || h.t > best.t)) best = h; }
      if (best) deathByMode[best.mode || '?'] = (deathByMode[best.mode || '?'] || 0) + 1;
      // proximity + crowd
      const en = (l.enemiesNear || []).filter((e) => !e.self);
      if (en.length) {
        withEnemy++;
        const nd = Math.min(...en.map((e) => e.dist));
        if (nd < 40) pblank++;
        const near = en.filter((e) => e.dist < 300).length;
        crowdSizes.push(near);
        if (near >= 2) crowdAtDeath++;
      }
    } else if (l.event === 'hunter_encounter') {
      const o = l.outcome; if (o !== 'escaped' && o !== 'died') continue;
      if (l.fled) { if (o === 'died') heAll.fledDied++; else heAll.fledEsc++; }
      else { if (o === 'died') heAll.notDied++; else heAll.notEsc++; }
      const c = l.cls || '?'; heByClass[c] = heByClass[c] || { n: 0, died: 0 };
      heByClass[c].n++; if (o === 'died') heByClass[c].died++;
      if (typeof l.startDist === 'number' && typeof l.minDist === 'number') gapClosed.push(l.startDist - l.minDist);
    }
  }
  // peak score per life within the shift (reset on a score decrease = new life)
  let cur = 0;
  for (const h of hbs) {
    const s = h.myScore || 0;
    if (s < cur) { allScores.push(cur); cur = 0; }
    cur = Math.max(cur, s);
  }
  if (cur > 0) allScores.push(cur);
}

console.log(`# CORPUS: ${shifts.length} shifts, ${lives} lives, ${(lifeSecs.reduce((s, v) => s + v, 0) / 3600).toFixed(1)}h alive-time\n`);

console.log('## Life length');
console.log(`  median ${Math.round(med(lifeSecs))}s | mean ${Math.round(mean(lifeSecs))}s | p90 ${Math.round([...lifeSecs].sort((a, b) => a - b)[Math.floor(lifeSecs.length * 0.9)])}s | max ${Math.round(Math.max(...lifeSecs))}s`);
const re = (s) => `${pct(lifeSecs.filter((x) => x >= s).length, lives)}%`;
console.log(`  lives >=60s ${re(60)} | >=180s ${re(180)} | >=300s ${re(300)} | >=600s ${re(600)}`);

console.log('\n## Reach rate (share of lives that got to each class)');
for (const k of ['Sniper', 'Overseer', 'Overlord']) console.log(`  ${k.padEnd(9)} ${pct(reach[k], lives)}%  (${reach[k]} lives)`);

console.log('\n## Deaths by class (where we die)');
for (const [c, n] of Object.entries(deathByClass).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(9)} ${n}  (${pct(n, lives)}%)`);

console.log('\n## Mode at death (what we were doing when we died)');
for (const [m, n] of Object.entries(deathByMode).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${m.padEnd(22)} ${n}  (${pct(n, lives)}%)`);

console.log('\n## Death geometry');
console.log(`  point-blank (<40px): ${pct(pblank, withEnemy)}%  | crowd (>=2 foes <300px): ${pct(crowdAtDeath, withEnemy)}%  | median foes near at death: ${med(crowdSizes)}`);

console.log('\n## Hunter encounters (all shifts, n=' + (heAll.fledDied + heAll.fledEsc + heAll.notDied + heAll.notEsc) + ')');
console.log(`  FLED     -> died ${pct(heAll.fledDied, heAll.fledDied + heAll.fledEsc)}%  (${heAll.fledDied}/${heAll.fledDied + heAll.fledEsc})`);
console.log(`  NOT-FLED -> died ${pct(heAll.notDied, heAll.notDied + heAll.notEsc)}%  (${heAll.notDied}/${heAll.notDied + heAll.notEsc})`);
console.log(`  median gap closed (startDist-minDist): ${Math.round(med(gapClosed))}px  (negative = we opened distance)`);
console.log('  by class (died%):');
for (const [c, s] of Object.entries(heByClass).sort((a, b) => b[1].n - a[1].n)) console.log(`    ${c.padEnd(9)} ${pct(s.died, s.n)}%  (n=${s.n})`);

console.log('\n## Score competitiveness');
const ss = allScores.filter((s) => s > 0).sort((a, b) => b - a);
console.log(`  best ${ss[0]} | top-5: ${ss.slice(0, 5).join(', ')}`);
console.log(`  lives >=10k: ${allScores.filter((s) => s >= 10000).length} | >=20k: ${allScores.filter((s) => s >= 20000).length} | >=30k: ${allScores.filter((s) => s >= 30000).length}`);

console.log('\n## Trend over time (chronological, per shift)');
console.log('  date/time            doc  lives  medLife  bestScore');
for (const sh of shifts.slice(-12)) {
  const ds = sh.lines.filter((l) => l.event === 'death');
  const hb = sh.lines.filter((l) => l.event === 'heartbeat');
  const ml = Math.round(med(ds.map((d) => (d.lifeMs || 0) / 1000)));
  const bs = Math.max(0, ...hb.map((h) => h.myScore || 0));
  console.log(`  ${sh.f.replace('shift-', '').replace('.jsonl', '').slice(0, 19).padEnd(20)} v${String(sh.doc).padEnd(3)} ${String(ds.length).padEnd(6)} ${String(ml + 's').padEnd(8)} ${bs}`);
}
