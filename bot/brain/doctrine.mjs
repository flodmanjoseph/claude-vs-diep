// The doctrine: every tunable the brain uses. Iteration between shifts mostly edits this.
// Stat indices (diep number keys 1-8):
//   1 HealthRegen 2 MaxHealth 3 BodyDamage 4 BulletSpeed 5 BulletPenetration 6 BulletDamage 7 Reload 8 MovementSpeed
export const DOCTRINE = {
  version: 25,

  // Class build path (the drone line: Tank -> Sniper -> Overseer -> Overlord). Each step is gated
  // by the current class, so the right tile index is clicked even if level reads lag. Tile indices
  // map to the canvas upgrade grid (2 columns; index 0=TL,1=TR,2=ML,3=MR,4=BL,5=BR).
  buildPath: [
    { from: 'Tank', tile: 1, to: 'Sniper', minLevel: 15 },
    { from: 'Sniper', tile: 1, to: 'Overseer', minLevel: 30 },
    { from: 'Overseer', tile: 0, to: 'Overlord', minLevel: 45 },
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
  crowdRadius: 248,
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
  upgradeGraceFrames: 180, // ~3s of caution after a class upgrade (ES-tunable [60,360])
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
  spacingGain: 1.3, // strength of the along-lane spacing push during farming (1.6->1.3: let approach win in low pressure, less farm-stall)
  pressureCap: 0.06, // pressure at which the spacing push (and safe-shape bias) saturates
  pressureEscape: 0.075, // pressure that forces a full escape, dropping farming entirely (crowd-escape already covers the 2-foe-close case; this is the dense-swarm / big-lone-hunter backstop)
  safeLaneMinDeg: 130, // if the largest angular gap between nearby foes is under this, we're surrounded -> breakout
  safeShapeBias: 70, // px-equivalent penalty for a farm target that lies toward the threat centroid (100->70: less fighting the approach vector)
  // Predator (leaderboard-hunter) avoidance. 85% of Overseer L30-45 deaths are top-10 players at
  // 2-8x our score running us down, usually in pairs. Flee any tank clearly bigger than us, earlier
  // and harder than a normal enemy. Detection is MULTI-FRAME (predatorConfirmFrames consecutive
  // frames) so a single-frame size misread can never trigger flight - same lesson as the score glitch.
  predatorRatio: 1.309, // enemy with radius > myR * this is a candidate hunter (clearly bigger)
  predatorDetectRadius: 460, // only consider big tanks within this as hunters
  predatorConfirmFrames: 16, // ~0.27s of persistent presence before we trust it (anti-phantom)
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
  bulletDodgeRadius: 257,
  bulletAimedCos: 0.844,
  bulletMissMargin: 67,

  // Spawn safety: fresh respawns drop us at ~level 2 next to the killer. For the first few seconds
  // of a life, flee from any enemy within an enlarged radius and do not farm.
  spawnGraceFrames: 256, // ~4.3s at 60fps
  spawnEscapeRadius: 305,

  // Map awareness (positions normalized 0..1 from the minimap arrow).
  wallMargin: 0.06, // treat being within this of an edge as "at the wall" for escape penalties
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
  approachStopDist: 154, // stop closing on a shape inside this; shoot it from range
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
  huntRange: 360, // only hunt prey within this distance
  huntMaxFoes: 1, // (legacy, unused by v24; danger-aware crowd handles swarms of dangerous tanks)
  huntStandoff: 166, // close to this distance, then hold (drones do the work; don't body-ram a tank)

  // Aim / fire
  autofire: true,

  // v25 strategic, PHASE-AWARE perk allocation (stat keys: 1 Regen 2 MaxHealth 3 BodyDmg
  // 4 Bullet/DroneSpeed 5 BulletPen/DroneHealth 6 BulletDmg/DroneDmg 7 Reload 8 MoveSpeed).
  // Early (Tank/Sniper, farming to level up): lead with Penetration(5)+Damage(6) - they kill shapes
  // fast AND, because keys 5/6 double as Drone Health/Damage, they pre-build the eventual drone tank -
  // plus Movement(8) and Health(2) to survive the fragile climb.
  statSequence: [5, 6, 8, 5, 6, 2, 8, 5, 6, 2, 7, 8, 5, 6, 2, 1, 4, 3],
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
