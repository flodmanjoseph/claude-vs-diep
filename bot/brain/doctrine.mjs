// The doctrine: every tunable the brain uses. Iteration between shifts mostly edits this.
// Stat indices (diep number keys 1-8):
//   1 HealthRegen 2 MaxHealth 3 BodyDamage 4 BulletSpeed 5 BulletPenetration 6 BulletDamage 7 Reload 8 MovementSpeed
export const DOCTRINE = {
  version: 5,

  // Threat handling
  enemyDangerRadius: 240, // an enemy tank within this distance is a threat
  enemyPanicRadius: 130, // within this, flee hard regardless of farming
  bulletDangerRadius: 150, // enemy bullet within this and approaching => dodge
  fleeWeight: 1.0,

  // Farming
  preferKinds: ['pentagon', 'square', 'triangle'], // value order to seek (pentagons worth most)
  approachStopDist: 70, // stop closing on a shape inside this (let bullets do the work)
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
