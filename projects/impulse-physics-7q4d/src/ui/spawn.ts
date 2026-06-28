import {
  AABB,
  Body,
  Capsule,
  Circle,
  FluidSystem,
  fractureMaterial,
  material as mpmMaterial,
  MpmSystem,
  mpmParams,
  Polygon,
  Rng,
  Vec2,
  World,
  type MpmMaterial,
  type Shape,
} from '../engine';

export type SpawnKind =
  | 'circle'
  | 'box'
  | 'capsule'
  | 'rounded'
  | 'triangle'
  | 'pentagon'
  | 'random'
  | 'shatter'
  | 'water'
  | 'sand'
  | 'snow'
  | 'jelly'
  | 'mpm-water';

export const SPAWN_KINDS: SpawnKind[] = [
  'circle',
  'box',
  'capsule',
  'rounded',
  'triangle',
  'pentagon',
  'random',
  'shatter',
  'water',
  'sand',
  'snow',
  'jelly',
  'mpm-water',
];

/** The MPM material a paint tool pours, or null for non-MPM kinds. */
export function mpmKindMaterial(kind: SpawnKind): MpmMaterial | null {
  switch (kind) {
    case 'sand':
      return mpmMaterial('sand');
    case 'snow':
      return mpmMaterial('snow');
    case 'jelly':
      return mpmMaterial('jelly');
    case 'mpm-water':
      return mpmMaterial('water');
    default:
      return null;
  }
}

const COLORS = ['#6ea8ff', '#7CFFCB', '#ffd166', '#ff6b6b', '#c792ea', '#4dd2ff', '#ff9e64', '#9ece6a'];

/** Build the shape for a given spawn kind at a base size. */
export function spawnShape(kind: SpawnKind, size: number, rng: Rng): Shape {
  switch (kind) {
    case 'circle':
      return new Circle(size);
    case 'box':
      return Polygon.box(size, size);
    case 'capsule':
      return Capsule.of(size * 2.4, size * 0.7);
    case 'rounded':
      return Polygon.rounded(size, size, size * 0.35);
    case 'triangle':
      return Polygon.regular(3, size * 1.2, Math.PI / 2);
    case 'pentagon':
      return Polygon.regular(5, size * 1.1);
    case 'shatter':
      // A brittle slab — drop a few, then click them with the Shatter tool.
      return Polygon.box(size * 1.6, size * 1.1);
    case 'water':
    case 'sand':
    case 'snow':
    case 'jelly':
    case 'mpm-water':
      // Particle tools (see sprayFluid / paintMpm); this fallback shape is only
      // here for exhaustiveness and is never actually spawned as a body.
      return new Circle(size);
    case 'random': {
      const pick = rng.int(0, 4);
      if (pick === 0) return new Circle(size);
      if (pick === 1) return Capsule.of(size * 2.4, size * 0.6);
      return Polygon.regular(pick + 1, size * 1.1, rng.range(0, Math.PI));
    }
  }
}

/**
 * Spray a small clump of SPH fluid at a world point. If the scene has no fluid
 * system, one is created on the fly (no domain box, so it rests on whatever rigid
 * geometry the scene already has) — letting you add water to *any* scene.
 */
export function sprayFluid(world: World, at: Vec2, rng: Rng): void {
  let fs = world.fluid;
  if (!fs) {
    fs = new FluidSystem({ spacing: 0.3, maxParticles: 1500 });
    world.setFluid(fs);
  }
  const spread = fs.params.spacing * 1.2;
  for (let k = 0; k < 5; k++) {
    if (fs.particles.length >= fs.params.maxParticles) break;
    const off = new Vec2(rng.range(-spread, spread), rng.range(-spread, spread));
    fs.add(at.add(off), new Vec2(rng.range(-0.6, 0.6), rng.range(-1.5, -0.3)));
  }
}

/**
 * Pour a clump of MPM material at a world point. If the scene has no MPM system
 * one is created on the fly over a generous default grid (so any scene can be
 * sanded/snowed), and particles are added at the paint point with a small
 * downward velocity. The `kind` selects the constitutive material.
 */
export function paintMpm(world: World, at: Vec2, rng: Rng, mat: MpmMaterial): void {
  let sys = world.mpm;
  if (!sys) {
    const region = new AABB(new Vec2(-16, 0), new Vec2(16, 24));
    sys = new MpmSystem(mpmParams(region, { dx: 0.25, substeps: 8, maxParticles: 16000 }));
    world.setMpm(sys);
  }
  const s = sys.params.dx * 0.5;
  for (let k = 0; k < 10; k++) {
    sys.add(
      at.add(new Vec2(rng.range(-2, 2) * s, rng.range(-2, 2) * s)),
      mat,
      new Vec2(rng.range(-0.4, 0.4), rng.range(-1.2, -0.2)),
    );
  }
}

/** Drop a fresh body into the world at a world-space point. */
export function spawnBody(world: World, kind: SpawnKind, at: Vec2, rng: Rng): Body {
  const size = rng.range(0.3, 0.55);
  const brittle = kind === 'shatter';
  const body = new Body(spawnShape(kind, brittle ? size * 1.3 : size, rng), {
    position: at,
    color: brittle ? '#9fd8ff' : COLORS[rng.int(0, COLORS.length - 1)],
    friction: 0.4,
    restitution: 0.15,
    angle: brittle ? 0 : rng.range(0, Math.PI),
    fracture: brittle
      ? fractureMaterial({ toughness: 8, shards: 16, pattern: 'radial', maxGeneration: 2 })
      : undefined,
  });
  return world.addBody(body);
}
