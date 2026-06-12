// The doctrine: every tunable the brain uses. Iteration between shifts mostly edits this.
// Stat indices (diep number keys 1-8):
//   1 HealthRegen 2 MaxHealth 3 BodyDamage 4 BulletSpeed 5 BulletPenetration 6 BulletDamage 7 Reload 8 MovementSpeed
export const DOCTRINE = {
  version: 12,

  // Class build path (the drone line: Tank -> Sniper -> Overseer -> Overlord). Each step is gated
  // by the current class, so the right tile index is clicked even if level reads lag. Tile indices
  // map to the canvas upgrade grid (2 columns; index 0=TL,1=TR,2=ML,3=MR,4=BL,5=BR).
  buildPath: [
    { from: 'Tank', tile: 1, to: 'Sniper', minLevel: 15 },
    { from: 'Sniper', tile: 1, to: 'Overseer', minLevel: 30 },
    { from: 'Overseer', tile: 0, to: 'Overlord', minLevel: 45 },
  ],
  droneClasses: ['Overseer', 'Overlord', 'Necromancer', 'Manager', 'Battleship', 'Factory', 'Hybrid'],

  // Threat handling (tiered, screen-pixel distances; own tank is screen-center)
  escapeRadius: 210, // enemy within this (effective dist) => drop everything and flee
  waryRadius: 360, // enemy within this => keep farming but bias movement away from it
  bulletDangerRadius: 160, // enemy bullet within this and approaching => escape trigger
  enemySizeWeight: 0.05, // extra threat per pixel of enemy radius (bigger tanks are deadlier)
  anticipationFrames: 22, // shrink an enemy's effective distance by closingSpeed * this (~0.37s lookahead)

  // Bullet dodging (velocity-based): a bullet aimed at us (cos angle > aimedCos) inside dodgeRadius
  // whose predicted miss distance is under missMargin triggers a perpendicular sidestep.
  bulletDodgeRadius: 280,
  bulletAimedCos: 0.8,
  bulletMissMargin: 60,

  // Spawn safety: fresh respawns drop us at ~level 2 next to the killer. For the first few seconds
  // of a life, flee from any enemy within an enlarged radius and do not farm.
  spawnGraceFrames: 210, // ~3.5s at 60fps
  spawnEscapeRadius: 330,

  // Map awareness (positions normalized 0..1 from the minimap arrow).
  wallMargin: 0.06, // treat being within this of an edge as "at the wall" for escape penalties
  patrolAnchors: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], // quiet-ish corner waypoints
  anchorReachedDist: 0.08, // advance to next anchor when this close

  // Farming. Target selection is distance-dominant: grab the nearest shape, only mildly preferring
  // higher-value kinds, so we don't trek across the map (slow + risky) chasing a far pentagon.
  preferKinds: ['pentagon', 'square', 'triangle'], // value order; pentagons worth most
  kindDistancePenalty: 70, // pixels of "extra distance" each value rank costs in target scoring
  approachStopDist: 150, // stop closing on a shape inside this; shoot it from range
  shapeBodyMargin: 28, // if a shape is within me.r+shape.r+this, back off (avoid lethal body contact)
  wanderWhenEmpty: true,

  // Drone-class hunting: chase weaker tanks for kill XP (worth far more than shapes). Thresholds
  // are tunable so the optimizer decides how aggressive to be.
  huntEnabled: true,
  huntSizeRatio: 0.78, // hunt only enemies whose radius is < this fraction of ours (clearly smaller)
  huntRange: 340, // only hunt within this distance
  huntMaxFoes: 1, // never hunt when more than this many enemies are near (don't get swarmed)
  huntStandoff: 170, // close to this distance, then hold (drones do the work; don't ram)

  // Aim / fire
  autofire: true,

  // Blind stat allocation: cycle this sequence, one key press per tick when points may exist.
  // Front-load movement (escape) + penetration/damage (farm), then bulk health, then reload.
  statSequence: [8, 8, 5, 6, 8, 5, 6, 7, 2, 5, 6, 7, 2, 2, 2, 4, 1, 3],
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
  huntSizeRatio: 0.95, // ram enemies up to ~our size (we win body fights when tanky)
  huntRange: 420, // chase rammable targets from far
  huntStandoff: 0, // close all the way — contact is the kill
  approachStopDist: 0, // drive into shapes to farm them
  shapeBodyMargin: -999, // never back off a shape; ramming it is the point
};
