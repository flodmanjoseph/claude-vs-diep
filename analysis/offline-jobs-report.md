# Offline data jobs: v18-v20 params + clean fitness recompute

Date: 2026-07-02. Inputs: all 61 `telemetry/shift-*.jsonl`. Outputs: `analysis/v18-20-params.json`, `analysis/clean-fitness.json`. No bot code touched.

## Job 1 — v18-v20 doctrine params (75 lives)

Shifts with `shift_start.doctrine` 18/19/20 (5 shifts, ES gens g1-g3, champion fitness 13,887). Sanity: median life 161.4s / 172.6s / 198.0s for v18/v19/v20 — matches the survival-record family exactly. Every life had a full `doctrine_assigned` params payload. `crowdCount` is **not** a logged param in this era (26-param space carried from v17; `leadScale` appears only from v19, fixed at its 1.3 backfill in all 38 lives — the ES never actually mutated it here; `dronePentagonBonus` only in v20's g3, fixed at 120).

| param | median | p25 | p75 | topQ median |
|---|---|---|---|---|
| escapeRadius | 216 | 186 | 222 | 216 |
| waryRadius | 427 | 411 | 462 | 427 |
| crowdRadius | 253 | 248 | 349 | 266 |
| predatorRatio | 1.211 | 1.193 | 1.309 | 1.211 |
| predatorFleeRadius | 293 | 267 | 293 | 293 |
| fragilePhaseScale | 1.25 | 1.215 | 1.353 | 1.244 |
| pressureEscape | 0.081 | 0.074 | 0.116 | 0.075 |
| pressureCap | 0.071 | 0.06 | 0.077 | 0.071 |
| spawnGraceFrames | 256 | 235 | 294 | 256 |
| spacingGain | 1.608 | 1.3 | 2.296 | 1.475 |
| safeLaneMinDeg | 142 | 130 | 145 | 130 |
| bulletAimedCos | 0.905 | 0.849 | 0.906 | 0.887 |

(Full 31-param table incl. huntRange, spacingRadius, surroundRadius, etc. in the JSON, plus `impliedBaseDefaults` = the ES center archived in `optimizer-state-v17-partial-archive.json` that seeded this run.) Top-quartile (19 lives, 278-647s) skews: slightly lower pressureEscape (0.075), lower spacingGain (1.475), tighter safeLaneMinDeg (130), slightly wider crowdRadius (266). v18's `opt-g1-*`/`opt-g2-*` candidates dominate the top lives, including the 516s / 32,849 / L45 record life (`opt-g1-7`).

## Job 2 — hardened glitch filter + clean fitness (1,228 lives)

Filter: walk each life's alive heartbeats in order + the terminal `life_scored` read. A read implying >6,000 gain in one ~5s heartbeat is fake unless the next read confirms at >=0.7x AND the (score, level) pair is coherent. Coherence curve fit through L35=10.7k / L40=16.6k / L45=23.5k: `score(L)=20L²-320L-2600`, implied level capped at 45; a level read >=8 levels **above** the score-implied level marks the pair suspect (level can never outrun score in diep). The death event's level read is folded in as a final coherence-guarded level sample. Clean fitness = cleanScore + 100·maxLevel + 25·lifeSec.

**Validation (b): PASS.** The known-clean 16,865 life (462s, L40, Overseer, shift 2026-06-19T10-22-14-233Z, `opt-g3-4`) passes intact: cleanScore 16,865, cleanLevel 40.

**Validation (a): the premise was wrong — and the evidence folder proves it.** 32 lives recorded >=15k; 30 of them contain a single-heartbeat >6,000 discontinuity. But cross-checking death screenshots (the post-death screen is server ground truth):

- `death-2026-06-13T02-28-37-680Z-57.png` — the "impossible" 27,855 @ recorded L24: death screen reads **Score 27,855, Level 45, Overlord, 2m33s**. Real.
- `death-2026-06-13T01-01-51-187Z-8.png` — the 24,971 that DEVLOG 016 declared the canonical fake: death screen reads **Score 24,971, Level 45, Overseer, 36s**, banner "You've killed filet". A last-instant leader-kill, not a perception glitch.
- `death-2026-06-12T17-52-04-451Z-12.png` — 22,068 confirmed at **L44 Overseer, 2m48s**.

These discontinuities are real big-kills (score jumps instantly; the level HUD read lags/sticks, and the v16 online *level* filter then wrongly pinned the recorded level low — the `level_glitch_rejected` events were rejecting *real* instant level-ups). Death-event levels for the other contested lives match the curve within ~1 level (18,945→L42, 17,462→L41, 23,091→L44, 23,548→L45, 29,056→L45). Result: only **1 of 1,228** lives has a rejected score peak — 29,463@v35 (jump appears only in the terminal read, unconfirmable by rule; by pattern it is likely also a real death-transition kill). 13 lives had level reads rejected; 10 lives had their true (higher) level restored via the death read.

### Doctrine ranking by median clean fitness

| version | n | median cleanFit | max cleanScore | median lifeS |
|---|---|---|---|---|
| v28 | 7 | 13,427 | 7,263 | 262.4 |
| **v20** | 18 | 12,509 | 8,711 | 198.0 |
| **v18** | 37 | 11,461 | 32,849 | 161.4 |
| **v19** | 20 | 11,373 | 9,198 | 172.7 |
| v17 | 8 | 10,331 | 20,180 | 134.7 |
| v23 | 24 | 10,109 | 11,737 | 143.3 |
| v22 | 24 | 9,397 | 9,000 | 135.9 |
| v13 | 19 | 9,293 | 24,971 | 109.3 |
| v29 | 12 | 8,521 | 14,784 | 128.6 |
| v21 | 17 | 8,180 | 31,437 | 112.8 |
| v15 | 242 | 8,093 | 34,368 | 114.4 |
| ... | | | | |
| v35 | 148 | 4,071 | 17,595 | 47.2 |

**Confirmed with one caveat:** among versions with n>=10, v20 > v18 > v19 are exactly the top three on median clean fitness. The caveat is v28 (n=7 only): it posts the best median clean fitness AND the best median life (262s > v20's 198s) — a possibly-superior doctrine that never got sample size. v35 (the current 148-life config) ranks near the bottom (median life 47s).

Top verified-clean lives ever: 34,368 (v15) > 33,704 (v34) > 32,849 (v18, 516s — highest clean fitness at 50,262) > 31,437 (v21) > 30,421 (v34) > 30,311 (v16) > 29,252 (v16) > 29,174 (v15) > 29,056 (v30) > 28,341 (v15). Full list with shift ids in `clean-fitness.json`.
