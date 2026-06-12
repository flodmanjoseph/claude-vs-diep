// The doctrine: every tunable the brain uses. Iteration between shifts mostly edits this.
// Stat indices (diep number keys 1-8):
//   1 HealthRegen 2 MaxHealth 3 BodyDamage 4 BulletSpeed 5 BulletPenetration 6 BulletDamage 7 Reload 8 MovementSpeed
export const DOCTRINE = {
  version: 9,

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
  escapeRadius: 210, // enemy within this => drop everything and flee toward open space
  waryRadius: 360, // enemy within this => keep farming but bias movement away from it
  bulletDangerRadius: 160, // enemy bullet within this and approaching => dodge
  enemySizeWeight: 0.05, // extra threat per pixel of enemy radius (bigger tanks are deadlier)

  // Spawn safety: fresh respawns drop us at ~level 2 next to the killer. For the first few seconds
  // of a life, flee from any enemy within an enlarged radius and do not farm.
  spawnGraceFrames: 210, // ~3.5s at 60fps
  spawnEscapeRadius: 330,

  // Farming
  preferKinds: ['pentagon', 'square', 'triangle'], // value order to seek (pentagons worth most)
  approachStopDist: 150, // stop closing on a shape inside this; shoot it from range
  shapeBodyMargin: 28, // if a shape is within me.r+shape.r+this, back off (avoid lethal body contact)
  wanderWhenEmpty: true,

  // Aim / fire
  autofire: true,

  // Blind stat allocation: cycle this sequence, one key press per tick when points may exist.
  // Front-load movement (escape) + penetration/damage (farm), then bulk health, then reload.
  statSequence: [8, 8, 5, 6, 8, 5, 6, 7, 2, 5, 6, 7, 2, 2, 2, 4, 1, 3],
  statTickMs: 700,

  // Loop timing
  aimEveryFrame: true,
};
