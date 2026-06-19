// RL Phase 1 - Behavior Cloning. Train a small linear softmax policy to imitate the rules bot's
// macro-action choice (escape/hunt/farm/patrol) from the 16-dim tactical feature vector logged in
// telemetry/transitions-*.jsonl. Pure JS, no deps. Output: analysis/bc-policy.json {W,b,mean,std,...}
// which the in-page brain can run as a forward pass (a learned residual/warm-start over the rules).
//
// This is the warm-start spine of the ResFiT plan: a policy that starts == the proven rules (so it
// can't regress), then later phases (offline IQL) improve it. Usage: node analysis/train-bc.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TELEM = path.join(ROOT, 'telemetry');
const ACTIONS = ['escape', 'hunt', 'farm', 'patrol'];
const AIDX = Object.fromEntries(ACTIONS.map((a, i) => [a, i]));
const NF = 16; // feature-vector length

// --- Load transitions (skip old drone-era rows so we clone the CURRENT sniper policy) ---
const files = fs.readdirSync(TELEM).filter((f) => f.startsWith('transitions-') && f.endsWith('.jsonl')).sort();
const X = [], Y = [];
let skipped = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(TELEM, f), 'utf8').split('\n');
  for (const ln of lines) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!o.x || o.x.length !== NF || !(o.a in AIDX)) { skipped++; continue; }
    if (o.cls === 'Overseer' || o.cls === 'Overlord') { skipped++; continue; } // exclude drone era
    X.push(o.x); Y.push(AIDX[o.a]);
  }
}
const N = X.length;
console.log(`loaded ${N} transitions (${files.length} files, skipped ${skipped})`);
const classCount = [0, 0, 0, 0]; for (const y of Y) classCount[y]++;
console.log('action balance:', ACTIONS.map((a, i) => `${a} ${classCount[i]} (${Math.round(100 * classCount[i] / N)}%)`).join(', '));

// --- Standardize features ---
const mean = new Array(NF).fill(0), std = new Array(NF).fill(0);
for (const x of X) for (let j = 0; j < NF; j++) mean[j] += x[j];
for (let j = 0; j < NF; j++) mean[j] /= N;
for (const x of X) for (let j = 0; j < NF; j++) { const d = x[j] - mean[j]; std[j] += d * d; }
for (let j = 0; j < NF; j++) std[j] = Math.sqrt(std[j] / N) || 1;
const Xs = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));

// --- Train/test split (deterministic interleave; no Math.random) ---
const trIdx = [], teIdx = [];
for (let i = 0; i < N; i++) (i % 10 === 0 ? teIdx : trIdx).push(i);

// --- Linear softmax: logits = W*x + b, W is [4][16] ---
const W = Array.from({ length: 4 }, () => new Array(NF).fill(0));
const b = new Array(4).fill(0);
const softmax = (z) => { const m = Math.max(...z); const e = z.map((v) => Math.exp(v - m)); const s = e.reduce((a, v) => a + v, 0); return e.map((v) => v / s); };
const logits = (x) => { const z = [0, 0, 0, 0]; for (let k = 0; k < 4; k++) { let s = b[k]; const Wk = W[k]; for (let j = 0; j < NF; j++) s += Wk[j] * x[j]; z[k] = s; } return z; };

// class weights (inverse freq) so rare actions (hunt/patrol) aren't ignored
const cw = classCount.map((c) => N / (4 * Math.max(1, c)));
const LR = 0.3, EPOCHS = 250, L2 = 1e-4;
for (let ep = 0; ep < EPOCHS; ep++) {
  const gW = Array.from({ length: 4 }, () => new Array(NF).fill(0));
  const gb = new Array(4).fill(0);
  let loss = 0, wsum = 0;
  for (const i of trIdx) {
    const x = Xs[i], y = Y[i], w = cw[y]; wsum += w;
    const p = softmax(logits(x));
    loss += -w * Math.log(Math.max(1e-9, p[y]));
    for (let k = 0; k < 4; k++) { const g = w * (p[k] - (k === y ? 1 : 0)); const gWk = gW[k]; for (let j = 0; j < NF; j++) gWk[j] += g * x[j]; gb[k] += g; }
  }
  for (let k = 0; k < 4; k++) { for (let j = 0; j < NF; j++) W[k][j] -= LR * (gW[k][j] / wsum + L2 * W[k][j]); b[k] -= LR * (gb[k] / wsum); }
  if (ep % 50 === 0 || ep === EPOCHS - 1) console.log(`epoch ${ep}: weighted-CE ${(loss / wsum).toFixed(4)}`);
}

// --- Evaluate ---
const evalSet = (idx) => {
  let correct = 0; const conf = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (const i of idx) { const p = softmax(logits(Xs[i])); let am = 0; for (let k = 1; k < 4; k++) if (p[k] > p[am]) am = k; conf[Y[i]][am]++; if (am === Y[i]) correct++; }
  return { acc: correct / idx.length, conf };
};
const tr = evalSet(trIdx), te = evalSet(teIdx);
console.log(`\ntrain acc ${(100 * tr.acc).toFixed(1)}% | test acc ${(100 * te.acc).toFixed(1)}%`);
console.log('test confusion (rows=true, cols=pred):', ACTIONS.join('/'));
for (let k = 0; k < 4; k++) console.log('  ' + ACTIONS[k].padEnd(7), te.conf[k].map((v) => String(v).padStart(6)).join(' '));
// per-action recall
console.log('per-action recall:', ACTIONS.map((a, k) => { const tot = te.conf[k].reduce((s, v) => s + v, 0); return `${a} ${tot ? Math.round(100 * te.conf[k][k] / tot) : 0}%`; }).join(', '));

// --- Save policy ---
const out = { kind: 'bc-linear-softmax', actions: ACTIONS, nf: NF, W, b, mean, std, n: N, trainAcc: +tr.acc.toFixed(4), testAcc: +te.acc.toFixed(4), trained: 'phase1-bc' };
fs.writeFileSync(path.join(ROOT, 'analysis', 'bc-policy.json'), JSON.stringify(out));
console.log('\nsaved analysis/bc-policy.json');
