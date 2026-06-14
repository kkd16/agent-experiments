/**
 * An in-app verification suite. Every check exercises a real engine code path
 * and asserts a property a correct rigid-body engine must satisfy — closed-form
 * mass integrals, GJK distance vs. analytic gaps, momentum/energy conservation,
 * bit-for-bit determinism, broadphase correctness, and ray casting. The results
 * render live in the app so the engine's correctness is inspectable, not just
 * claimed.
 */
import {
  Body,
  BodyType,
  Capsule,
  Circle,
  collide,
  computeMass,
  convexHull,
  DynamicTree,
  epaPenetration,
  gjkDistance,
  Polygon,
  PrismaticJoint,
  RevoluteJoint,
  Rng,
  Transform,
  Vec2,
  World,
} from '../engine';
import { AABB } from '../engine/aabb';

export interface CheckResult {
  name: string;
  group: string;
  passed: boolean;
  detail: string;
}

class Asserter {
  readonly results: CheckResult[] = [];
  private group = '';

  section(name: string): void {
    this.group = name;
  }

  ok(name: string, passed: boolean, detail: string): void {
    this.results.push({ name, group: this.group, passed, detail });
  }

  close(name: string, actual: number, expected: number, tol: number): void {
    const passed = Math.abs(actual - expected) <= tol;
    this.ok(name, passed, `${actual.toFixed(4)} ≈ ${expected.toFixed(4)} (±${tol})`);
  }
}

export function runVerification(): CheckResult[] {
  const a = new Asserter();

  // ---- Mass properties -----------------------------------------------------
  a.section('Mass properties');
  {
    const box = Polygon.box(1, 1); // 2×2 box, density 1
    const m = computeMass(box, 1);
    a.close('Unit box mass = 4', m.mass, 4, 1e-9);
    // I = m(w²+h²)/12 = 4·(4+4)/12 = 8/3.
    a.close('Unit box inertia = 8/3', m.inertia, 8 / 3, 1e-6);
    a.ok('Unit box centroid at origin', m.center.length() < 1e-9, m.center.toString());
  }
  {
    const c = new Circle(1);
    const m = computeMass(c, 1);
    a.close('Unit disc mass = π', m.mass, Math.PI, 1e-9);
    a.close('Unit disc inertia = π/2', m.inertia, Math.PI / 2, 1e-9);
  }
  {
    // Offset box: parallel-axis theorem sanity.
    const box = Polygon.fromVertices([
      new Vec2(2, 1),
      new Vec2(4, 1),
      new Vec2(4, 2),
      new Vec2(2, 2),
    ]);
    const m = computeMass(box, 1);
    a.close('Offset box centroid x', m.center.x, 3, 1e-9);
    a.close('Offset box centroid y', m.center.y, 1.5, 1e-9);
    a.close('Offset box inertia (about COM)', m.inertia, 2 * (4 + 1) / 12, 1e-6);
  }

  // ---- Convex hull ---------------------------------------------------------
  a.section('Convex hull');
  {
    const hull = convexHull([
      new Vec2(0, 0),
      new Vec2(2, 0),
      new Vec2(2, 2),
      new Vec2(0, 2),
      new Vec2(1, 1), // interior point must be discarded
    ]);
    a.ok('Square hull has 4 vertices', hull.length === 4, `got ${hull.length}`);
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      area += hull[i].cross(hull[(i + 1) % hull.length]);
    }
    a.ok('Hull wound counter-clockwise', area > 0, `signed area ${(area / 2).toFixed(2)}`);
  }

  // ---- GJK distance --------------------------------------------------------
  a.section('GJK / EPA');
  {
    const boxA = Polygon.box(1, 1);
    const boxB = Polygon.box(1, 1);
    const xa = new Transform(new Vec2(0, 0));
    const xb = new Transform(new Vec2(5, 0));
    const d = gjkDistance(boxA, xa, boxB, xb);
    // Gap between right face of A (x=1) and left face of B (x=4) is 3.
    a.close('Box gap distance = 3', d.distance, 3, 1e-6);
    a.ok('Boxes reported separated', !d.overlap, `overlap=${d.overlap}`);
  }
  {
    const cA = new Circle(1);
    const cB = new Circle(1);
    const d = gjkDistance(cA, new Transform(new Vec2(0, 0)), cB, new Transform(new Vec2(4, 0)));
    a.close('Disc gap distance = 2', d.distance, 2, 1e-4);
  }
  {
    // Overlapping boxes: EPA depth and normal.
    const boxA = Polygon.box(1, 1);
    const boxB = Polygon.box(1, 1);
    const xa = new Transform(new Vec2(0, 0));
    const xb = new Transform(new Vec2(1.5, 0));
    const p = epaPenetration(boxA, xa, boxB, xb);
    a.close('EPA penetration depth = 0.5', p.depth, 0.5, 1e-3);
    a.ok('EPA normal ≈ ±x', Math.abs(Math.abs(p.normal.x) - 1) < 1e-2, p.normal.toString());
  }

  // ---- Contact manifold ----------------------------------------------------
  a.section('Contact manifold');
  {
    const boxA = Polygon.box(1, 1);
    const boxB = Polygon.box(1, 1);
    const man = collide(boxA, new Transform(new Vec2(0, 0)), boxB, new Transform(new Vec2(0, 1.5)));
    a.ok('Stacked boxes give 2 contact points', man.points.length === 2, `got ${man.points.length}`);
    a.ok('Manifold normal points +y (A→B)', man.normal.y > 0.99, man.normal.toString());
    const pen = man.points.length ? man.points[0].penetration : -1;
    a.close('Penetration ≈ 0.5', pen, 0.5, 1e-3);
  }

  // ---- Dynamics: conservation laws ----------------------------------------
  a.section('Dynamics');
  {
    // Free fall: v = g·t with no damping.
    const w = new World(new Vec2(0, -10));
    const b = w.addBody(new Body(new Circle(0.5), { position: new Vec2(0, 100) }));
    const dt = 1 / 240;
    for (let i = 0; i < 240; i++) w.step(dt);
    a.close('Free-fall speed after 1s = 10', -b.linearVelocity.y, 10, 0.2);
  }
  {
    // Elastic head-on collision of equal discs swaps velocities.
    const w = new World(new Vec2(0, 0));
    w.config.warmStarting = true;
    const A = w.addBody(
      new Body(new Circle(0.5), { position: new Vec2(-2, 0), linearVelocity: new Vec2(3, 0), restitution: 1, friction: 0 }),
    );
    const B = w.addBody(
      new Body(new Circle(0.5), { position: new Vec2(2, 0), restitution: 1, friction: 0 }),
    );
    const dt = 1 / 240;
    for (let i = 0; i < 480; i++) w.step(dt);
    const momentum = A.linearVelocity.x + B.linearVelocity.x; // equal masses
    a.close('Momentum conserved (Σvx = 3)', momentum, 3, 0.15);
    a.ok('Velocity transferred to B', B.linearVelocity.x > 2, `B.vx=${B.linearVelocity.x.toFixed(2)}`);
  }
  {
    // A box dropped on the ground comes to rest above it without sinking.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(10, 0.5), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const box = w.addBody(new Body(Polygon.box(0.5, 0.5), { position: new Vec2(0, 3) }));
    const dt = 1 / 120;
    for (let i = 0; i < 600; i++) w.step(dt);
    a.ok('Dropped box rests above ground', box.worldCenter.y > 0.45, `y=${box.worldCenter.y.toFixed(3)}`);
    a.ok('Dropped box stops moving', box.linearVelocity.length() < 0.05, `|v|=${box.linearVelocity.length().toFixed(3)}`);
    a.ok('Resting box went to sleep', !box.awake, `awake=${box.awake}`);
  }
  {
    // Revolute joint keeps a swinging body a fixed distance from its pivot.
    const w = new World(new Vec2(0, -10));
    const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 5) }));
    const bob = w.addBody(new Body(Polygon.box(0.3, 0.3), { position: new Vec2(2, 5) }));
    w.addJoint(new RevoluteJoint(anchor, bob, new Vec2(0, 5)));
    const dt = 1 / 240;
    let maxErr = 0;
    for (let i = 0; i < 480; i++) {
      w.step(dt);
      maxErr = Math.max(maxErr, Math.abs(bob.worldCenter.distanceTo(new Vec2(0, 5)) - 2));
    }
    a.ok('Revolute keeps pivot distance', maxErr < 0.05, `max drift ${maxErr.toFixed(4)}`);
  }

  // ---- Determinism ---------------------------------------------------------
  a.section('Determinism');
  {
    const run = (): string => {
      const rng = new Rng(1234);
      const w = new World(new Vec2(0, -10));
      w.addBody(new Body(Polygon.box(8, 0.5), { type: BodyType.Static, position: new Vec2(0, 0) }));
      for (let i = 0; i < 12; i++) {
        w.addBody(new Body(Polygon.box(0.4, 0.4), {
          position: new Vec2(rng.range(-3, 3), 2 + i * 1.1),
          angle: rng.range(-1, 1),
        }));
      }
      for (let i = 0; i < 300; i++) w.step(1 / 120);
      return w.bodies
        .map((b) => `${b.worldCenter.x.toFixed(6)},${b.worldCenter.y.toFixed(6)},${b.angle.toFixed(6)}`)
        .join('|');
    };
    a.ok('Two identical runs match exactly', run() === run(), 'byte-identical final state');
  }

  // ---- Broadphase ----------------------------------------------------------
  a.section('Broadphase');
  {
    const rng = new Rng(7);
    const tree = new DynamicTree<number>();
    const boxes: AABB[] = [];
    for (let i = 0; i < 60; i++) {
      const c = new Vec2(rng.range(-20, 20), rng.range(-20, 20));
      const e = new Vec2(rng.range(0.5, 2), rng.range(0.5, 2));
      const box = new AABB(c.sub(e), c.add(e));
      boxes.push(box);
      tree.createProxy(box, i);
    }
    // Compare a tree query against a brute-force scan for a random window.
    const window = new AABB(new Vec2(-5, -5), new Vec2(5, 5));
    const fromTree = new Set<number>();
    tree.query(window, (id) => fromTree.add(tree.get(id) as number));
    let mismatch = 0;
    for (let i = 0; i < boxes.length; i++) {
      // The tree stores fattened AABBs, so a brute-force hit on the tight box
      // must also be a tree hit (the converse can include extra margin hits).
      if (boxes[i].overlaps(window) && !fromTree.has(i)) mismatch++;
    }
    a.ok('Tree query is a superset of true overlaps', mismatch === 0, `${mismatch} misses`);
    a.ok('Tree height is logarithmic', tree.height() <= 2 * Math.ceil(Math.log2(60)) + 2, `height ${tree.height()}`);
  }

  // ---- Ray casting ---------------------------------------------------------
  a.section('Ray casting');
  {
    const w = new World(new Vec2(0, 0));
    w.addBody(new Body(Polygon.box(1, 1), { type: BodyType.Static, position: new Vec2(5, 0) }));
    const hit = w.rayCast(new Vec2(0, 0), new Vec2(10, 0));
    a.ok('Ray hits the box', hit !== null, hit ? `at x=${hit.point.x.toFixed(2)}` : 'miss');
    if (hit) {
      a.close('Ray hit at left face x=4', hit.point.x, 4, 1e-6);
      a.ok('Hit normal faces the ray', hit.normal.x < -0.99, hit.normal.toString());
    }
  }
  {
    // Ray through the side of a horizontal capsule hits its top skin.
    const w = new World(new Vec2(0, 0));
    w.addBody(new Body(Capsule.of(2, 0.5), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const hit = w.rayCast(new Vec2(0, 3), new Vec2(0, -3));
    a.ok('Ray hits capsule side', hit !== null, hit ? `at y=${hit.point.y.toFixed(2)}` : 'miss');
    if (hit) a.close('Capsule hit at top skin y=0.5', hit.point.y, 0.5, 1e-3);
  }

  // ---- Capsule & rounded shapes -------------------------------------------
  a.section('Capsules & rounded shapes');
  {
    // A vanishing-length capsule collapses to the solid-disc mass properties.
    const m = computeMass(Capsule.of(1e-5, 1), 1);
    a.close('Capsule→disc mass = π', m.mass, Math.PI, 1e-3);
    a.close('Capsule→disc inertia = π/2', m.inertia, Math.PI / 2, 1e-3);
  }
  {
    const cap = Capsule.of(2, 0.5); // straight length 2, radius 0.5
    const m = computeMass(cap, 1);
    a.close('Capsule mass = box + disc', m.mass, 2 * 0.5 * 2 + Math.PI * 0.25, 1e-9);
    a.ok('Capsule centroid at origin', m.center.length() < 1e-9, m.center.toString());
  }
  {
    // Two parallel stacked capsules → a stable 2-point manifold, normal +y.
    const cap = Capsule.of(2, 0.4);
    const man = collide(cap, new Transform(new Vec2(0, 0)), cap, new Transform(new Vec2(0, 0.75)));
    a.ok('Parallel capsules give 2 points', man.points.length === 2, `got ${man.points.length}`);
    a.ok('Capsule normal points +y', man.normal.y > 0.99, man.normal.toString());
    a.close('Capsule penetration ≈ 0.05', man.points.length ? man.points[0].penetration : -1, 0.05, 1e-2);
  }
  {
    // Cap-to-cap (collinear) capsules: a single point along the segment axis —
    // exactly the contact pure SAT would miss but GJK resolves.
    const cap = Capsule.of(2, 0.4);
    const man = collide(cap, new Transform(new Vec2(0, 0)), cap, new Transform(new Vec2(2.7, 0)));
    a.ok('Cap-to-cap contact found', man.points.length >= 1, `pts ${man.points.length}`);
    a.ok('Cap-to-cap normal ≈ +x', man.normal.x > 0.95, man.normal.toString());
  }
  {
    // A capsule settles flat on the ground at rest height = radius, level.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(10, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
    const cap = w.addBody(new Body(Capsule.of(2, 0.4), { position: new Vec2(0, 3) }));
    for (let i = 0; i < 400; i++) w.step(1 / 120);
    a.close('Capsule rests at y = radius', cap.worldCenter.y, 0.4, 0.03);
    a.ok('Capsule comes to rest level', Math.abs(cap.angle) < 0.05, `angle=${cap.angle.toFixed(3)}`);
  }
  {
    // A rounded box rests on its skin: centre = half-height + skin radius.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(10, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
    const r = w.addBody(new Body(Polygon.rounded(0.5, 0.5, 0.1), { position: new Vec2(0, 3) }));
    for (let i = 0; i < 400; i++) w.step(1 / 120);
    a.close('Rounded box rests at y = 0.6', r.worldCenter.y, 0.6, 0.03);
  }

  // ---- Continuous collision detection -------------------------------------
  a.section('Continuous collision');
  {
    // A fast bullet vs a thin wall: with CCD it stops, without it tunnels.
    const fire = (ccd: boolean): number => {
      const w = new World(new Vec2(0, 0));
      w.config.continuous = ccd;
      w.addBody(new Body(Polygon.box(0.05, 3), { type: BodyType.Static, position: new Vec2(0, 0) }));
      const b = w.addBody(
        new Body(new Circle(0.15), { position: new Vec2(-5, 0), linearVelocity: new Vec2(900, 0), bullet: ccd }),
      );
      for (let i = 0; i < 30; i++) w.step(1 / 60);
      return b.worldCenter.x;
    };
    a.ok('CCD bullet stops at the wall', fire(true) < 0.1, `x=${fire(true).toFixed(3)}`);
    a.ok('Without CCD the body tunnels through', fire(false) > 1, `x=${fire(false).toFixed(2)}`);
  }

  // ---- Joint limits --------------------------------------------------------
  a.section('Joint limits');
  {
    // A gravity-loaded arm hinged with limits cannot swing past the lower stop.
    const w = new World(new Vec2(0, -10));
    const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 5) }));
    const arm = w.addBody(new Body(Polygon.box(1, 0.1), { position: new Vec2(1, 5) }));
    const j = new RevoluteJoint(anchor, arm, new Vec2(0, 5));
    j.setLimits(-0.5, 0.5);
    w.addJoint(j);
    let minAngle = 0;
    for (let i = 0; i < 600; i++) {
      w.step(1 / 120);
      minAngle = Math.min(minAngle, j.jointAngle());
    }
    a.ok('Revolute limit clamps the swing', minAngle > -0.6, `min angle ${minAngle.toFixed(3)}`);
  }
  {
    // A prismatic carriage falls only as far as its lower translation stop.
    const w = new World(new Vec2(0, -10));
    const base = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 5) }));
    const car = w.addBody(new Body(Polygon.box(0.5, 0.3), { position: new Vec2(0, 5) }));
    const j = new PrismaticJoint(base, car, new Vec2(0, 5), new Vec2(0, 1));
    j.setLimits(-1, 0);
    w.addJoint(j);
    let minDrop = 0;
    for (let i = 0; i < 600; i++) {
      w.step(1 / 120);
      minDrop = Math.min(minDrop, car.worldCenter.y - 5);
    }
    a.ok('Prismatic limit clamps the travel', minDrop > -1.1, `min drop ${minDrop.toFixed(3)}`);
  }

  return a.results;
}
