// Campaign analytics: aggregate all telemetry/shift-*.jsonl into per-shift and per-doctrine stats.
// Usage: node analysis/summary.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'telemetry');
const files = fs.readdirSync(dir).filter((f) => f.startsWith('shift-') && f.endsWith('.jsonl')).sort();

const fmt = (ms) => `${Math.round(ms / 1000)}s`;
const byDoctrine = new Map();

console.log('shift                      doc  dur    deaths  lives(s)              maxLvl  maxScore  leaderMax');
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const start = lines.find((l) => l.event === 'shift_start');
  const end = lines.find((l) => l.event === 'shift_end');
  const deaths = lines.filter((l) => l.event === 'death');
  const hbs = lines.filter((l) => l.event === 'heartbeat');
  if (!start) continue;
  const doc = start.doctrine ?? '?';
  const dur = end?.elapsed ?? start.shiftMs ?? 0;
  const lives = deaths.map((d) => d.lifeMs);
  // last life (no death at end) from final heartbeat
  const lastHb = hbs[hbs.length - 1];
  if (lastHb?.life && lastHb.life > 5000) lives.push(lastHb.life);
  const maxLvl = Math.max(0, ...hbs.map((h) => h.lvl || 0), ...deaths.map((d) => d.lvl || 0));
  const maxScore = Math.max(0, ...hbs.map((h) => h.myScore || 0));
  const leaderMax = Math.max(0, ...hbs.map((h) => h.leaderMax || 0));
  console.log(
    `${f.replace('shift-', '').replace('.jsonl', '').slice(0, 24).padEnd(26)} v${String(doc).padEnd(3)} ${fmt(dur).padEnd(6)} ${String(deaths.length).padEnd(7)} ${lives.map((m) => Math.round(m / 1000)).join(',').slice(0, 21).padEnd(21)} ${String(maxLvl).padEnd(7)} ${String(maxScore).padEnd(9)} ${leaderMax ? Math.round(leaderMax / 1000) + 'k' : '-'}`,
  );
  const agg = byDoctrine.get(doc) ?? { shifts: 0, durMs: 0, deaths: 0, lives: [], maxLvl: 0, maxScore: 0 };
  agg.shifts++; agg.durMs += dur; agg.deaths += deaths.length; agg.lives.push(...lives);
  agg.maxLvl = Math.max(agg.maxLvl, maxLvl); agg.maxScore = Math.max(agg.maxScore, maxScore);
  byDoctrine.set(doc, agg);
}

console.log('\ndoctrine  shifts  play-time  deaths/min  avg-life  best-life  maxLvl  maxScore');
for (const [doc, a] of [...byDoctrine.entries()].sort((x, y) => (+x[0] || 0) - (+y[0] || 0))) {
  const dpm = a.deaths / (a.durMs / 60000);
  const avgLife = a.lives.length ? a.lives.reduce((s, v) => s + v, 0) / a.lives.length : 0;
  const bestLife = a.lives.length ? Math.max(...a.lives) : 0;
  console.log(`v${String(doc).padEnd(8)} ${String(a.shifts).padEnd(7)} ${fmt(a.durMs).padEnd(10)} ${dpm.toFixed(2).padEnd(11)} ${fmt(avgLife).padEnd(9)} ${fmt(bestLife).padEnd(10)} ${String(a.maxLvl).padEnd(7)} ${a.maxScore}`);
}
