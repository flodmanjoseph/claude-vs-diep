// The doctrine: every tunable the brain uses. Iteration between shifts mostly edits this.
// Stat indices (diep number keys 1-8):
//   1 HealthRegen 2 MaxHealth 3 BodyDamage 4 BulletSpeed 5 BulletPenetration 6 BulletDamage 7 Reload 8 MovementSpeed
export const DOCTRINE = {
  // v36: the survival rework. (1) Baseline params reverted to the v18-v20 family — the honest
  // survival record (median lives 161-198s vs v35's 47s; see analysis/v18-20-params.json and
  // clean-fitness.json) — keeping the post-v30 keepers (tile-map upgrades, hunt gate, damage build).
  // (2) Kite-with-lead-fire escape. (3) World-unit perception. (4) ms-denominated timers.
  // (5) Escape-lane scoring. All Layer-1 tested (npm test).
  version: 36,
  // v34: a squishy sniper must not chase weak prey while a clearly-bigger tank is near (it gets run
  // down to point-blank). Suppress hunting when a tank r >= myR*snipeAvoidRatio sits within
  // snipeAvoidRadius. Direct (not ES-tuned), narrow (only gates hunting; no blanket fleeing).
  snipeAvoidRatio: 1.1,
  snipeAvoidRadius: 420, // v36: WORLD units (was 300 screen px, unscaled = ~440 world at Ranger zoom)
  // v32 FOV scaling: median on-screen square radius (px) at the baseline Tank FOV. Measured ~22 (Tank),
  // 19 (Sniper), 15 (Assassin) - so the sniper line zooms out and defensive distance thresholds are
  // rescaled by (currentSquarePx / this) to stay world-consistent. 1.0 multiplier at the Tank baseline.
  fovBaselinePx: 22,
  // RL Phase 0: log a per-decision transition every N ms (~5/sec) so the rules bot banks a real
  // (state,action,reward,next-state) corpus to pre-train the residual policy on. Logging only.
  // v36: ms-denominated (was every 12 frames = 2x the intended rate on this 119fps display).
  transitionLogMs: 200,

  // v29 BUILD: the SNIPER line (Joe's call - "you have good aim, keep upgrading the sniper, no more
  // overlord, that tank sucks"). Upgrades are picked by CLASS NAME from this priority list (the runner
  // reads the upgrade panel's labels and clicks the highest-priority class present), so it's layout-
  // independent and NEVER takes a drone class. Path it produces: Tank ->(L15) Sniper ->(L30) Assassin
  // ->(L45) Ranger (max range/damage bullet sniper, ideal for an aimbot). Hunter->Predator and the
  // Stalker/Streamliner variants are backups. If none of these is visible, the runner SKIPS the upgrade
  // (stays current) rather than risk an irreversible wrong pick. 'Sniper' must be listed so L15 takes it.
  preferUpgrades: ['Ranger', 'Predator', 'Stalker', 'Streamliner', 'Assassin', 'Hunter', 'Trapper', 'Sniper'],
  // v31 TILE MAP (the panel labels aren't capturable, so we click mapped tiles, verified by result).
  // Sniper panel order is [Assassin, Overseer, Hunter, Trapper] -> tiles [0,1,2,3]; the old drone build
  // proved tile1=Overseer, so tile0=Assassin. We NEVER click tile1 from a Sniper (the banned Overlord
  // line). The Hunter step is a backup in case tile0 turns out to be Hunter (still a fine sniper class).
  upgradeTiles: [
    { from: 'Tank', minLevel: 15, tile: 1, to: 'Sniper' },     // proven
    { from: 'Sniper', minLevel: 30, tile: 0, to: 'Assassin' },  // tile0 = Assassin (tile1 = banned Overseer)
    { from: 'Assassin', minLevel: 45, tile: 0, to: 'Ranger' },  // Ranger first in Assassin's options
    { from: 'Hunter', minLevel: 45, tile: 0, to: 'Predator' },  // if L30 gave Hunter instead
    { from: 'Trapper', minLevel: 45, tile: 0, to: 'OverTrapper' }, // if L30 gave Trapper
  ],
  droneClasses: ['Overseer', 'Overlord', 'Necromancer', 'Manager', 'Battleship', 'Factory', 'Hybrid'],

  // Threat handling (tiered, screen-pixel distances; own tank is screen-center). v17 bakes the
  // gen-16 ES champion's evolved radii in as the baseline (proven over 400+ lives), then layers the
  // proactive-spacing redesign on top.
  escapeRadius: 216, // enemy within this (effective dist) => drop everything and flee
  waryRadius: 427, // enemy within this => keep farming but bias movement away from it
  bulletDangerRadius: 161, // enemy bullet within this and approaching => escape trigger
  enemySizeWeight: 0.082, // extra threat per pixel of enemy radius (bigger tanks are deadlier)
  anticipationFrames: 31, // shrink an enemy's effective distance by closingSpeed * this (~0.52s lookahead)
  // Crowd flight: being collapsed on by several foes at once is the dominant death (87% of deaths
  // are point-blank with 2-3 foes near). If >= crowdCount foes sit within crowdRadius, force escape
  // and don't hunt, so a converging swarm breaks farming before the pocket closes to body contact.
  crowdRadius: 260, // v36: v18-v20 family (median 253, top-quartile 266)
  crowdCount: 2,

  // === v18 FRAGILE-PHASE SURVIVAL GATING (the highest-leverage lever per the corpus) ===
  // The survival FUNNEL is the bottleneck: 90% of lives reach Sniper but only 22% reach Overseer and
  // 1% reach Overlord; 68% of ALL deaths are pre-drone Snipers (the "Sniper valley"). A Tank/Sniper
  // has no drones to screen it, so while pre-drone it must play more cautiously - flee earlier and
  // from farther - but it still farms at RANGE (a Sniper's long bullets let it kite-farm without
  // diving in), so caution costs little XP. This multiplier scales the flee triggers (escape/crowd/
  // predator radii up, pressure-escape threshold down) ONLY while pre-drone; a drone class plays at
  // base radii because its drones screen for it. ES-tunable [1.0, 1.6]; 1.0 = off.
  fragilePhaseScale: 1.25,

  // === v19 LEAD-PROTECTION (sustain #1, not just touch it) ===
  // The bot reaches the top band (rank 2 / 88% of leader) then dies right after the peak - the
  // documented failure. When we're at/near #1 (a coherent, populated board says rank<=2 with a real
  // score), kills are not worth the exposure and hunters home in on the leader. So adopt a defensive
  // posture: flee earlier/farther and stop hunting. Reuses the fragile-phase scaling machinery -
  // leadScale multiplies the flee radii (escape/crowd/predator up, pressure-escape down) on top of
  // any fragile scaling. The runner pushes live rank into the brain each heartbeat via __setMeta.
  // Gates mirror the #1 detector's discipline (board>=7, estRank<=2, score>5000) so a noisy board
  // can't fake "leading". ES-tunable [1.0, 1.8]; 1.0 = off.
  leadScale: 1.3,
  leadRankMax: 2, // we count as "leading" at estRank <= this (fixed; not in ES space)
  leadMinScore: 5000, // ...and only above this score (anti-noise, matches the #1 detector)
  // v21 COHERENCE GATE for "leading": the board sample is sparse and can capture the leader plus a
  // few low scores while missing the dense middle, computing a falsely-low estRank (we read rank<=2
  // while actually at 2-7% of the leader). A genuine rank<=2 means our score is a real fraction of
  // the leader's, so also require myScore >= leaderMax * this. Rejects the artifact triggers (where
  // lead-protection made us play defensively while mid-pack, wasting farm time) while keeping real
  // near-#1 (e.g. 30k vs a 34k leader). Mirrors the #1 detector's coherence discipline.
  leadScoreFrac: 0.45,

  // === v22 POST-UPGRADE CAUTION (fix the Overseer->Overlord wall) ===
  // Overseers die at a median level of 31 - right after the L30 upgrade - because fragilePhaseScale
  // protects Tank/Sniper then switches OFF the instant they become a drone Overseer, so a fresh
  // Overseer (drones not yet deployed) plays full-aggressive at its weakest moment. For a brief
  // window after ANY upgrade, scale up the flee triggers (same machinery as fragile/lead) so the new
  // class survives while its drones mature. Bridges L15->Sniper, L30->Overseer, L45->Overlord.
  // v36: ms-denominated (was 180 frames = ~1.5s real on this 119fps display, half the intent).
  upgradeGraceMs: 3000, // caution window after a class upgrade (ES-tunable [1000,6000])
  upgradeScale: 1.3, // flee-radius multiplier during the post-upgrade window (ES-tunable [1.0,1.7])

  // === v17 PROACTIVE SPACING / ANTI-SURROUND (the headline redesign) ===
  // Corpus of 754 lives: 67% of deaths are in farm mode, 84% point-blank, 89% with >=2 foes within
  // 300px - the bot farms greedily and gets COLLAPSED on, and reactive escape-radius fires too late
  // to open space. The fix reads the whole threat field every frame (threatGeometry): a continuous
  // `pressure` scalar and `gapDir`, the bisector of the largest angular gap = the open lane out.
  // - While farming, a graded push along gapDir scaled by pressure keeps a "personal bubble" so
  //   pressure bleeds off continuously instead of building to the collapse (mode "space-farm").
  // - Bias farm-target choice AWAY from the threat centroid so farming itself retreats (safeShapeBias).
  // - Force an EARLY breakout when pressure crosses the budget (pressureEscape) or we are surrounded
  //   with no clean lane (maxGap < safeLaneMinDeg), instead of waiting for one enemy to cross escapeRadius.
  spacingRadius: 400, // foes within this contribute to threat pressure / centroid
  surroundRadius: 300, // foes within this count toward the open-lane / surround analysis
  spacingFloor: 0.02, // pressure above which farming switches to spaced movement (space-farm)
  spacingGain: 1.475, // v36: v18-v20 top-quartile median (the 278-647s lives ran ~1.475)
  pressureCap: 0.06, // pressure at which the spacing push (and safe-shape bias) saturates
  pressureEscape: 0.075, // pressure that forces a full escape, dropping farming entirely (crowd-escape already covers the 2-foe-close case; this is the dense-swarm / big-lone-hunter backstop)
  safeLaneMinDeg: 130, // if the largest angular gap between nearby foes is under this, we're surrounded -> breakout
  safeShapeBias: 70, // px-equivalent penalty for a farm target that lies toward the threat centroid (100->70: less fighting the approach vector)
  // Predator (leaderboard-hunter) avoidance. 85% of Overseer L30-45 deaths are top-10 players at
  // 2-8x our score running us down, usually in pairs. Flee any tank clearly bigger than us, earlier
  // and harder than a normal enemy. Detection is MULTI-FRAME (predatorConfirmFrames consecutive
  // frames) so a single-frame size misread can never trigger flight - same lesson as the score glitch.
  predatorRatio: 1.211, // v36: v18-v20 family — v35's 1.309 only feared MUCH-bigger tanks; the
  // survival-record versions confirmed hunters at 1.211 (earlier, more inclusive detection)
  // v36: WORLD units, and UN-SHRUNK. Under v32 scaling this was effectively ~313 world at Ranger
  // zoom — the max-FOV class was confirming hunters at Tank-class distances, using ~40% of its
  // visible screen. Encounters starting >=450 die 8.2% vs 39-48% under 350: earlier DETECTION is
  // the single strongest lever in the encounter data. Flee radii below stay at their world values —
  // this is earlier awareness, not blanket timidity (the v8 lesson).
  predatorDetectRadius: 550,
  predatorConfirmMs: 270, // persistent presence before we trust it (anti-phantom; v36 ms-denominated)
  predatorFleeRadius: 293, // flee a confirmed hunter within this (vs escapeRadius ~216 for normals)
  // Drone screen (#2): ENABLED v15. v14 hunter-encounter data (7 Overseer L30+ encounters) confirmed
  // predators are faster and kill from RANGE (166-403px): straight-line flight LOST ~88px/encounter
  // and 3 of 4 fled cases died, none escaped. So while fleeing a confirmed predator, a drone class
  // now drives its drones straight ONTO the hunter to pressure/chip it instead of at the nearest
  // threat - the right counter to a faster ranged poker. Measured vs v14 via the same encounter log.
  droneScreen: true,
  // Edge-farming bias: ENABLED v16 (the pre-registered next lever after the drone screen banked).
  // 80% of deaths are still point-blank with 2-3 foes converging - the bot gets COLLAPSED on, in
  // every phase (114/184 deaths last shift were in the no-drone Sniper valley). Farming now drifts
  // toward the nearest single arena edge (one axis only, never a corner -> no trap; targets 0.12/0.88,
  // a buffer inside wallMargin 0.06) so converging foes have ~half the approach angles. Only shapes
  // WHERE we farm during calm farming; escape/flee are untouched, so we still break away freely when
  // attacked. v18: default OFF (0) - edge-bias pins the bot against a wall, removing escape lanes and
  // directly conflicting with v17's open-lane spacing (gapDir wants room on all sides); v16 also showed
  // it ambivalent. Kept in SPACE [0,2.2] so the ES can re-discover it; v17 spacing is now the clean
  // positioning mechanism.
  edgeBiasWeight: 0,

  // Bullet dodging (velocity-based): a bullet aimed at us (cos angle > aimedCos) inside dodgeRadius
  // whose predicted miss distance is under missMargin triggers a perpendicular sidestep.
  // v36: WORLD units (previously unscaled screen px — a Ranger was dodge-blind in its outer view).
  bulletDodgeRadius: 300,
  bulletAimedCos: 0.887, // v36: v18-v20 top-quartile (dodge only genuinely-aimed bullets; less twitch)
  bulletMissMargin: 75,

  // Spawn safety: fresh respawns drop us at ~level 2 next to the killer. For the first few seconds
  // of a life, flee from any enemy within an enlarged radius and do not farm.
  // v36: ms-denominated. The old 256 FRAMES was ~4.3s only at 60fps; on this Mac's 119fps ProMotion
  // display it elapsed in ~2.15s — half the intended protection window (same for every other
  // frame-denominated timer, which is why they're all ms now).
  spawnGraceMs: 4300,
  spawnEscapeRadius: 305,

  // Map awareness (positions normalized 0..1 from the minimap arrow).
  wallMargin: 0.06, // treat being within this of an edge as "at the wall" for escape penalties
  // v36 escape-lane scoring: the wall term must DOMINATE ordinary threat terms (the old -5 was
  // 40-120x weaker than the -600 predator / -200*w foe terms, so hunters pushed us into corners),
  // plus a tangential slide bonus so wall-adjacent flight moves along the wall, and a shape-blocker
  // term so the flight lane deflects around pentagon nests instead of body-ramming through them.
  wallEscapePenalty: 400, // per violated axis (ES-tunable [200,800])
  wallSlideBonus: 120, // x |tangential component| when pinned near an edge (ES-tunable [40,240])
  escapeShapeRadius: 220, // shapes within this can deflect the escape lane
  escapeShapeWeight: 120, // blocker strength (~10x weaker than a same-distance foe; ES-tunable [40,240])
  patrolAnchors: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], // quiet-ish corner waypoints
  anchorReachedDist: 0.08, // advance to next anchor when this close

  // Farming. Target selection is distance-dominant: grab the nearest shape, only mildly preferring
  // higher-value kinds, so we don't trek across the map (slow + risky) chasing a far pentagon.
  preferKinds: ['pentagon', 'square', 'triangle'], // value order; pentagons worth most
  kindDistancePenalty: 48, // pixels of "extra distance" each value rank costs in target scoring
  // v20 economy (pentagon-seeking): DISABLED in v24 (set to 0). Watching the bot, Joe saw it ram the
  // blue pentagons in the middle at L30 - this bonus was pulling Overseers into the dangerous central
  // nest. Eating shapes is the early-game route to level up, but it does NOT reach #1; killing tanks
  // does (v24 predator mode). Kept in SPACE so the ES could revive a mild version, but off by default.
  dronePentagonBonus: 0,
  approachStopDist: 180, // stop closing on a shape inside this; shoot it from range (v36 world units)
  shapeBodyMargin: 59, // if a shape is within me.r+shape.r+this, back off (avoid lethal body contact)
  wanderWhenEmpty: true,

  // Drone-class hunting (v24 PREDATOR MODE): once we have drones, killing weaker tanks is the route
  // to #1 (you absorb a chunk of a tank's score on a kill - far more than shapes). bestPrey picks the
  // best target; we hunt unless genuinely endangered. Joe's strategy: farm shapes to level up early,
  // then "destroy the other tanks".
  huntEnabled: true,
  preyRatio: 0.85, // a tank with radius < myR * this is clearly weaker = prey we can kill (ES-tunable)
  preyCrowdRadius: 220, // count a prey's nearby allies within this when ranking targets
  preyCrowdPenalty: 200, // px-equivalent penalty per ally near a prey (prefer isolated kills)
  huntSizeRatio: 0.832, // (legacy, unused by v24 predator mode; bestPrey uses preyRatio)
  huntRange: 500, // only hunt prey within this distance (v36 world units; preserves sniper reach)
  huntMaxFoes: 1, // (legacy, unused by v24; danger-aware crowd handles swarms of dangerous tanks)
  huntStandoff: 220, // close to this, then hold — a sniper's bullets cover the rest (v36 world units)
  // v27 target lock + pursuit: commit to a prey and chase it to finish the kill instead of dropping it
  // when it leaves the frame. We dead-reckon its last-known position by velocity and pursue for this
  // many frames before giving up; a visible enemy within preyMatchRadius of that spot is the same prey.
  pursuitMs: 1500, // pursuit after losing sight (ES-tunable; v36 ms-denominated)
  preyMatchRadius: 120, // world units: re-acquire the locked prey among visible enemies within this of its predicted pos

  // Aim / fire
  autofire: true,
  // === v36 KITE-WITH-LEAD-FIRE (the devlog's named-but-never-built lever, entries 007/040/045) ===
  // Fled encounters died 39% vs 24% stood (n=2,735): straight-line flight from a ranged hunter is
  // a losing move — the bot gets shot down while running (median closure only ~20px). The kite band
  // holds/opens the range gap with tangential motion while continuously LEAD-FIRING at the pursuer.
  bulletPxPerFrame: 12, // our bullet speed, world px/frame (Sandbox-calibrated; scales with stat 4)
  kiteBandMul: 1.6, // kite (tangent+fire) while pursuer in [escapeR, escapeR*this] (ES [1.3, 2.0])
  kiteExitMul: 1.4, // escape latch releases only past escapeR*this — hysteresis, no thrash (ES [1.2, 1.6])
  // v26 return fire: when a tank is engaging us (within this range, or shooting at us), aim our
  // fire/drones AT it instead of at a shape, until it's dead or out of range. ES-tunable.
  combatRange: 550, // v36: world units (preserves the v32-era effective reach at Ranger zoom)
  // v36 far-field routing (change 2c): farming/patrol drift away from enemy-dense space long before
  // contact. Long lives see 0.70 hunter encounters/min vs 1.24 for short ones — positioning beats
  // fighting. Low weight by design: it routes, it never overrides threat handling. 0 = off.
  farFieldRadius: 700, // world units: enemies within this of a farm target/route count as density
  farFieldWeight: 40, // px-equivalent penalty per unit of enemy density (ES-tunable [0,120])

  // v34 SNIPER perk build - DAMAGE-FORWARD (stat keys: 1 Regen 2 MaxHealth 3 BodyDmg 4 BulletSpeed
  // 5 BulletPen 6 BulletDmg 7 Reload 8 MoveSpeed). v33 tried movement-forward (Move x3 early) to fix
  // the point-blank-to-bigger-tank deaths, but it REGRESSED (median life 94->75s, reach-Assassin
  // 13->3%): trading early damage cost more than the mobility gained - the Sniper killed/farmed slower,
  // stayed exposed longer, and couldn't deter approaching tanks. Reverted to the damage-forward build:
  // lead Dmg(6)+Pen(5)+BulletSpeed(4) for kill power, Reload(7), Move(8)+MaxHealth(2) woven in. The
  // squishy-valley survival is a BEHAVIORAL problem (keep bigger tanks at distance), not a stat one.
  statSequence: [6, 5, 4, 6, 5, 7, 8, 2, 6, 5, 4, 7, 8, 2, 1, 5, 3, 2],
  // Drone class (Overseer/Overlord, PREDATOR MODE): the killing build. Drone Damage(6) + Drone
  // Health/Penetration(5) to win tank fights, woven with Max Health(2) and Reload(7) so we survive
  // and sustain the fights we pick (Joe: "adjust for health"), then Movement(8) to chase, Regen(1),
  // Drone Speed(4). A tanky, deadly Overlord - not a glass cannon, not a farmer.
  droneStatSequence: [6, 5, 2, 6, 5, 7, 2, 8, 6, 5, 7, 1, 2, 8, 6, 5, 4, 1],
  statTickMs: 700,

  // Loop timing
  aimEveryFrame: true,

  // Ram-style play (Smasher line): kill by colliding. Off for the default ranged/drone build.
  ramStyle: false,

  // Reinforcement learning (tabular Q-learning mode arbitration). Off by default — runs as a
  // controlled experiment (RL=1) on frozen champion params, A/B'd against the hand rules.
  rl: {
    enabled: false,
    alpha: 0.15, // learning rate
    gamma: 0.9, // discount
    epsMax: 0.35, epsMin: 0.06, epsDecay: 0.00002, // exploration, decayed by total decisions
    decisionFrames: 12, // re-decide the mode ~5x/sec
    optimistic: 6, // optimistic init encourages trying unseen actions
    scoreScale: 40, // reward = scoreGain/scoreScale + survivalReward per decision
    survivalReward: 0.08,
    deathPenalty: -25, // terminal penalty on death
  },
};

// Smasher ram build (Joe's idea: a tank that kills by colliding suits a bot — no aiming needed).
// Path: stay Tank to 30, take Smasher (tile 4), then Spike (tile 2, highest body damage) at 45.
// Merged over the base doctrine when BUILD=smasher. Ram tuning: close all the way, contact shapes.
export const SMASHER_OVERRIDE = {
  buildPath: [
    { from: 'Tank', tile: 4, to: 'Smasher', minLevel: 30 },
    { from: 'Smasher', tile: 2, to: 'Spike', minLevel: 45 },
  ],
  // Smasher stats are only Health Regen(1), Max Health(2), Body Damage(3), Movement Speed(8).
  statSequence: [3, 2, 8, 3, 2, 8, 3, 2, 3, 8, 2, 1, 3, 2, 8, 1, 3, 2],
  droneClasses: [], // a Smasher is never a drone class
  ramStyle: true,
  // Ram behavior only activates once we are an actual (tanky) Smasher; the base-Tank phase to
  // level 30 still farms at range with its cannon so it doesn't ram-suicide while fragile.
  ramClasses: ['Smasher', 'Spike', 'Landmine', 'Auto Smasher', 'Mega Smasher'],
  huntSizeRatio: 0.95, // ram enemies up to ~our size (we win body fights when tanky)
  huntRange: 420, // chase rammable targets from far
  // approachStopDist / shapeBodyMargin / huntStandoff stay at ranged defaults; the brain overrides
  // them to contact values only when we are a ram class.
};
