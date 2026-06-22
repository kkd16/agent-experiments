import { Body, Capsule, Circle, FluidSystem, fractureMaterial, Polygon, Rng, Vec2, World, type Shape } from '../engine';

export type SpawnKind =
  | 'circle'
  | 'box'
  | 'capsule'
  | 'rounded'
  | 'triangle'
  | 'pentagon'
  | 'random'
  | 'shatter'
  | 'water';

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
];

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
      // The water tool sprays particles (see sprayFluid); this fallback shape is
      // only here for exhaustiveness and is never actually spawned as a body.
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
