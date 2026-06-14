import { Body, Capsule, Circle, Polygon, Rng, Vec2, World, type Shape } from '../engine';

export type SpawnKind = 'circle' | 'box' | 'capsule' | 'rounded' | 'triangle' | 'pentagon' | 'random';

export const SPAWN_KINDS: SpawnKind[] = [
  'circle',
  'box',
  'capsule',
  'rounded',
  'triangle',
  'pentagon',
  'random',
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
    case 'random': {
      const pick = rng.int(0, 4);
      if (pick === 0) return new Circle(size);
      if (pick === 1) return Capsule.of(size * 2.4, size * 0.6);
      return Polygon.regular(pick + 1, size * 1.1, rng.range(0, Math.PI));
    }
  }
}

/** Drop a fresh body into the world at a world-space point. */
export function spawnBody(world: World, kind: SpawnKind, at: Vec2, rng: Rng): Body {
  const size = rng.range(0.3, 0.55);
  const body = new Body(spawnShape(kind, size, rng), {
    position: at,
    color: COLORS[rng.int(0, COLORS.length - 1)],
    friction: 0.4,
    restitution: 0.15,
    angle: rng.range(0, Math.PI),
  });
  return world.addBody(body);
}
