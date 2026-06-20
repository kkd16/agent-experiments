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
  BuoyancyZone,
  Capsule,
  Circle,
  collide,
  collideParticle,
  computeMass,
  convexHull,
  DistanceJoint,
  DynamicTree,
  epaPenetration,
  GearJoint,
  gjkDistance,
  makeBlob,
  makeCloth,
  makeRope,
  Mat22,
  MotorJoint,
  Polygon,
  PrismaticJoint,
  PulleyJoint,
  RevoluteJoint,
  Rng,
  solveBlockLcp,
  Transform,
  Vec2,
  WeldJoint,
  WheelJoint,
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

  // ---- Buoyancy & fluid ----------------------------------------------------
  a.section('Buoyancy & fluid');
  {
    // Submerged area + centroid of a 2×2 box half-under the surface is exact:
    // the lower half is a 2×1 rectangle (area 2) centred at y = −0.5.
    const zone = new BuoyancyZone({ surface: 0 });
    const box = new Body(Polygon.box(1, 1), { position: new Vec2(0, 0) });
    const s = zone.submerged(box);
    a.close('Half-submerged box area = 2', s.area, 2, 1e-9);
    a.close('Submerged centroid y = −0.5', s.centroid.y, -0.5, 1e-9);
    a.ok('Submerged centroid x = 0', Math.abs(s.centroid.x) < 1e-9, s.centroid.toString());
  }
  {
    // Fully above the surface ⇒ no submerged area; fully below ⇒ the whole area.
    const zone = new BuoyancyZone({ surface: 0 });
    const above = zone.submerged(new Body(Polygon.box(1, 1), { position: new Vec2(0, 5) }));
    const below = zone.submerged(new Body(Polygon.box(1, 1), { position: new Vec2(0, -5) }));
    a.close('Box above water: area 0', above.area, 0, 1e-9);
    a.close('Box below water: area 4', below.area, 4, 1e-9);
  }
  {
    // A circle of radius 1 half-submerged: area ≈ π/2 (the n-gon under-estimates
    // slightly), centroid below the surface.
    const zone = new BuoyancyZone({ surface: 0 });
    const s = zone.submerged(new Body(new Circle(1), { position: new Vec2(0, 0) }));
    a.close('Half disc area ≈ π/2', s.area, Math.PI / 2, 0.05);
    a.ok('Half disc centroid below surface', s.centroid.y < -0.3 && s.centroid.y > -0.5, s.centroid.toString());
  }
  {
    // A neutrally-half-dense box floats with its centre exactly on the surface:
    // submerged fraction = ρ_body / ρ_fluid = 0.5 ⇒ centre at the waterline.
    const w = new World(new Vec2(0, -10));
    w.addFluid(new BuoyancyZone({ surface: 0, density: 1, linearDrag: 1.6, angularDrag: 1.0 }));
    const box = w.addBody(new Body(Polygon.box(0.6, 0.6), { position: new Vec2(0, 3), density: 0.5 }));
    for (let i = 0; i < 1500; i++) w.step(1 / 120);
    a.close('Half-density box floats at the surface', box.worldCenter.y, 0, 0.06);
    a.ok('Floating box settles level', Math.abs(box.angle) < 0.05, `angle=${box.angle.toFixed(3)}`);
  }
  {
    // A dense ingot (ρ > ρ_fluid) cannot float — it sinks to the floor.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(10, 0.5), { type: BodyType.Static, position: new Vec2(0, -5.5) }));
    w.addFluid(new BuoyancyZone({ surface: 0, density: 1 }));
    const ingot = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(0, 2), density: 6 }));
    for (let i = 0; i < 1200; i++) w.step(1 / 120);
    a.ok('Dense ingot sinks to the floor', ingot.worldCenter.y < -4.5, `y=${ingot.worldCenter.y.toFixed(2)}`);
  }
  {
    // A light cork (ρ ≪ ρ_fluid) floats high, barely dipping below the surface.
    const w = new World(new Vec2(0, -10));
    w.addFluid(new BuoyancyZone({ surface: 0, density: 1, linearDrag: 2 }));
    const cork = w.addBody(new Body(new Circle(0.4), { position: new Vec2(0, 3), density: 0.2 }));
    for (let i = 0; i < 1500; i++) w.step(1 / 120);
    a.ok('Light cork rides high in the water', cork.worldCenter.y > -0.1, `y=${cork.worldCenter.y.toFixed(3)}`);
    a.ok('Cork is mostly above the surface', cork.worldCenter.y > 0, `y=${cork.worldCenter.y.toFixed(3)}`);
  }

  // ---- Spatial queries -----------------------------------------------------
  a.section('Spatial queries');
  {
    // queryAABB must return exactly the bodies whose tight AABB meets the window
    // (compared against a brute-force scan over every body).
    const rng = new Rng(31);
    const w = new World(new Vec2(0, 0));
    for (let i = 0; i < 50; i++) {
      w.addBody(new Body(Polygon.box(rng.range(0.3, 0.8), rng.range(0.3, 0.8)), {
        type: BodyType.Static,
        position: new Vec2(rng.range(-15, 15), rng.range(-15, 15)),
      }));
    }
    const window = new AABB(new Vec2(-4, -4), new Vec2(4, 4));
    const got = new Set(w.queryAABB(window).map((b) => b.id));
    let mismatch = 0;
    for (const b of w.bodies) {
      const overlaps = b.worldAABB().overlaps(window);
      if (overlaps !== got.has(b.id)) mismatch++;
    }
    a.ok('queryAABB matches brute force', mismatch === 0, `${mismatch} mismatches, ${got.size} hits`);
  }
  {
    // Cast a circle at a wall: the analytic first-contact fraction is exact.
    const w = new World(new Vec2(0, 0));
    w.addBody(new Body(Polygon.box(1, 1), { type: BodyType.Static, position: new Vec2(5, 0) }));
    const r = 0.5;
    const hit = w.shapeCast(new Circle(r), new Transform(new Vec2(-5, 0)), new Vec2(10, 0));
    a.ok('shapeCast hits the wall', hit !== null, hit ? `frac=${hit.fraction.toFixed(3)}` : 'miss');
    if (hit) {
      // Circle centre stops at x = 4 − r = 3.5; from −5 over a 10 m cast ⇒ 0.85.
      a.close('shapeCast fraction = 0.85', hit.fraction, 0.85, 0.01);
      a.ok('shapeCast normal faces caster (−x)', hit.normal.x < -0.99, hit.normal.toString());
      a.close('shapeCast contact at x = 4', hit.point.x, 4, 0.05);
    }
  }
  {
    // A cast that clears all geometry returns null.
    const w = new World(new Vec2(0, 0));
    w.addBody(new Body(new Circle(0.5), { type: BodyType.Static, position: new Vec2(0, 10) }));
    const miss = w.shapeCast(new Circle(0.3), new Transform(new Vec2(-5, 0)), new Vec2(10, 0));
    a.ok('shapeCast misses when clear', miss === null, miss ? 'unexpected hit' : 'clean miss');
  }

  // ---- Block solver (exact 2-point LCP) -----------------------------------
  a.section('Block solver');
  {
    // Over many random symmetric positive-definite K and random velocities, the
    // block solve must satisfy the LCP conditions: x ≥ 0, the residual
    // w = Kx + b ≥ 0, and complementarity xᵀw = 0 (with a = 0 so b = vn).
    const rng = new Rng(99);
    let worstX = 0; // most-negative impulse component
    let worstW = 0; // most-negative residual component
    let worstComp = 0; // largest complementarity violation
    for (let i = 0; i < 4000; i++) {
      // SPD K = LLᵀ + diag → guaranteed positive-definite and symmetric.
      const l11 = rng.range(0.3, 2);
      const l21 = rng.range(-1.5, 1.5);
      const l22 = rng.range(0.3, 2);
      const k11 = l11 * l11 + 0.05;
      const k12 = l11 * l21;
      const k22 = l21 * l21 + l22 * l22 + 0.05;
      const K = new Mat22(k11, k12, k12, k22);
      const vn = new Vec2(rng.range(-5, 5), rng.range(-5, 5));
      const x = solveBlockLcp(K, Vec2.ZERO, vn);
      const w = K.mulV(x).add(vn); // residual since a = 0 ⇒ b = vn
      worstX = Math.min(worstX, x.x, x.y);
      worstW = Math.min(worstW, w.x, w.y);
      worstComp = Math.max(worstComp, Math.abs(x.x * w.x), Math.abs(x.y * w.y));
    }
    a.ok('LCP impulses non-negative (x ≥ 0)', worstX > -1e-9, `min x = ${worstX.toExponential(2)}`);
    a.ok('LCP residual non-negative (w ≥ 0)', worstW > -1e-9, `min w = ${worstW.toExponential(2)}`);
    a.ok('LCP complementarity (xᵀw = 0)', worstComp < 1e-9, `max |xᵢwᵢ| = ${worstComp.toExponential(2)}`);
  }
  {
    // A long heavy plank resting across two supports must settle flat and still,
    // with both end contacts loaded — the case the block solver handles cleanly.
    const w = new World(new Vec2(0, -10));
    w.config.blockSolver = true;
    w.addBody(new Body(Polygon.box(0.3, 0.6), { type: BodyType.Static, position: new Vec2(-3, 0.6) }));
    w.addBody(new Body(Polygon.box(0.3, 0.6), { type: BodyType.Static, position: new Vec2(3, 0.6) }));
    const plank = w.addBody(new Body(Polygon.box(4, 0.2), { position: new Vec2(0, 1.4), density: 5 }));
    for (let i = 0; i < 600; i++) w.step(1 / 120);
    a.ok('Plank rests level on two supports', Math.abs(plank.angle) < 0.02, `angle=${plank.angle.toFixed(4)}`);
    a.ok('Plank comes fully to rest', plank.linearVelocity.length() < 0.02, `|v|=${plank.linearVelocity.length().toFixed(4)}`);
    a.close('Plank stays at support height', plank.worldCenter.y, 1.4, 0.05);
  }
  {
    // The block solver and the point-by-point solver must agree at equilibrium
    // (a stacked box rests at the same height either way).
    const settle = (block: boolean): number => {
      const w = new World(new Vec2(0, -10));
      w.config.blockSolver = block;
      w.addBody(new Body(Polygon.box(6, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
      const top = w.addBody(new Body(Polygon.box(0.5, 0.5), { position: new Vec2(0, 3) }));
      for (let i = 0; i < 500; i++) w.step(1 / 120);
      return top.worldCenter.y;
    };
    a.close('Block & sequential agree at rest', settle(true), settle(false), 0.02);
  }

  // ---- Sensors & contact events -------------------------------------------
  a.section('Sensors & events');
  {
    // A body dropped through a static sensor must pass straight through it (no
    // impulse) yet fire exactly one begin and one end contact event.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(20, 0.5), { type: BodyType.Static, position: new Vec2(0, -10) }));
    w.addBody(new Body(Polygon.box(2, 0.6), { type: BodyType.Static, position: new Vec2(0, 0), isSensor: true }));
    let begins = 0;
    let ends = 0;
    w.onBeginContact = (a1, b1) => { if (a1.isSensor || b1.isSensor) begins++; };
    w.onEndContact = (a1, b1) => { if (a1.isSensor || b1.isSensor) ends++; };
    const ball = w.addBody(new Body(new Circle(0.3), { position: new Vec2(0, 4) }));
    for (let i = 0; i < 200; i++) w.step(1 / 120);
    a.ok('Body passes through the sensor', ball.worldCenter.y < -8, `y=${ball.worldCenter.y.toFixed(2)}`);
    a.ok('Exactly one begin event fired', begins === 1, `begins=${begins}`);
    a.ok('Exactly one end event fired', ends === 1, `ends=${ends}`);
  }
  {
    // A solid (non-sensor) block in the same place must instead stop the body.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(2, 0.6), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const ball = w.addBody(new Body(new Circle(0.3), { position: new Vec2(0, 4) }));
    for (let i = 0; i < 200; i++) w.step(1 / 120);
    a.ok('Solid block stops the body (control)', ball.worldCenter.y > 0.5, `y=${ball.worldCenter.y.toFixed(2)}`);
  }

  // ---- Wheel joint & suspension -------------------------------------------
  a.section('Wheel joint');
  {
    // Build a minimal car: a chassis on two sprung, motorised wheels. The
    // suspension's hard perpendicular constraint must keep each wheel directly
    // under its anchor (no horizontal drift relative to the chassis), and the
    // drive motor must push the car forward along the ground.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(30, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5), friction: 1 }));
    const chassis = w.addBody(new Body(Polygon.box(1.5, 0.25), { position: new Vec2(0, 1.3), density: 2 }));
    const axis = new Vec2(0, 1);
    const wheels: Body[] = [];
    const offsets = [-1.1, 1.1];
    for (let i = 0; i < offsets.length; i++) {
      const pos = new Vec2(offsets[i], 0.75);
      const wheel = w.addBody(new Body(new Circle(0.4), { position: pos, density: 1.5, friction: 1.5 }));
      wheels.push(wheel);
      const wj = new WheelJoint(chassis, wheel, pos, axis);
      wj.frequencyHz = 5;
      wj.dampingRatio = 0.7;
      if (i === 0) {
        wj.enableMotor = true;
        wj.motorSpeed = -11;
        wj.maxMotorTorque = 8;
      }
      w.addJoint(wj);
    }
    // Settle briefly, then track motion and the constraint error. The
    // perpendicular line constraint pins each wheel's offset *along the chassis*
    // perpendicular axis, so we measure it in the chassis frame (tilt-invariant).
    for (let i = 0; i < 120; i++) w.step(1 / 120);
    const x0 = chassis.worldCenter.x;
    let maxDrift = 0;
    for (let i = 0; i < 600; i++) {
      w.step(1 / 120);
      for (let k = 0; k < wheels.length; k++) {
        const local = chassis.localPoint(wheels[k].worldCenter);
        maxDrift = Math.max(maxDrift, Math.abs(local.x - offsets[k]));
      }
    }
    const travelled = chassis.worldCenter.x - x0;
    a.ok('Suspension keeps wheels on their line (chassis frame)', maxDrift < 0.05, `max drift ${maxDrift.toFixed(4)} m`);
    a.ok('Drive motor moves the car forward', travelled > 1, `travelled ${travelled.toFixed(2)} m`);
    a.ok('Car stays upright while driving', Math.abs(chassis.angle) < 0.4, `tilt ${chassis.angle.toFixed(3)} rad`);
  }
  {
    // The suspension spring carries the chassis above the wheels and holds it
    // there at rest (it neither collapses to the wheel nor flies apart).
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(30, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5), friction: 1 }));
    const chassis = w.addBody(new Body(Polygon.box(1.2, 0.3), { position: new Vec2(0, 1.6), density: 1 }));
    for (const dx of [-0.9, 0.9]) {
      const pos = new Vec2(dx, 0.9);
      const wheel = w.addBody(new Body(new Circle(0.45), { position: pos, density: 1.5, friction: 1.2 }));
      const wj = new WheelJoint(chassis, wheel, pos, new Vec2(0, 1));
      wj.frequencyHz = 4;
      wj.dampingRatio = 0.8;
      w.addJoint(wj);
    }
    for (let i = 0; i < 800; i++) w.step(1 / 120);
    a.ok('Chassis rides above the wheels at rest', chassis.worldCenter.y > 1.0 && chassis.worldCenter.y < 1.7,
      `y=${chassis.worldCenter.y.toFixed(3)}`);
    a.ok('Suspended chassis comes to rest', chassis.linearVelocity.length() < 0.05,
      `|v|=${chassis.linearVelocity.length().toFixed(4)}`);
  }

  // ---- Conveyor surfaces ---------------------------------------------------
  a.section('Conveyor surfaces');
  {
    // A crate dropped on a level belt is dragged up to the belt's surface speed
    // by friction, then carried along at that speed.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(20, 0.5), {
      type: BodyType.Static, position: new Vec2(0, -0.5), friction: 1, tangentSpeed: 3,
    }));
    const crate = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(-5, 0.4), friction: 1 }));
    for (let i = 0; i < 300; i++) w.step(1 / 120);
    a.close('Crate reaches belt speed (vx = 3)', crate.linearVelocity.x, 3, 0.3);
    a.ok('Crate is carried downstream (+x)', crate.worldCenter.x > -4, `x=${crate.worldCenter.x.toFixed(2)}`);
  }
  {
    // Regression guard: a zero-speed belt is just ordinary ground — the crate
    // sits still (the conveyor term must vanish when tangentSpeed is 0).
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(20, 0.5), {
      type: BodyType.Static, position: new Vec2(0, -0.5), friction: 1, tangentSpeed: 0,
    }));
    const crate = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(0, 0.4), friction: 1 }));
    for (let i = 0; i < 300; i++) w.step(1 / 120);
    a.ok('Zero-speed belt leaves the crate put', Math.abs(crate.worldCenter.x) < 0.05, `x=${crate.worldCenter.x.toFixed(4)}`);
  }
  {
    // A reversed belt carries the crate the other way.
    const w = new World(new Vec2(0, -10));
    w.addBody(new Body(Polygon.box(20, 0.5), {
      type: BodyType.Static, position: new Vec2(0, -0.5), friction: 1, tangentSpeed: -2,
    }));
    const crate = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(5, 0.4), friction: 1 }));
    for (let i = 0; i < 300; i++) w.step(1 / 120);
    a.close('Reversed belt speed (vx = −2)', crate.linearVelocity.x, -2, 0.3);
  }

  // ---- Radial impulse / explosion ------------------------------------------
  a.section('Radial impulse');
  {
    // A symmetric ring of equal discs blown from the centre gets equal-and-
    // opposite momentum: the vector sum is ~zero, every disc flies outward.
    const w = new World(new Vec2(0, 0));
    const n = 8;
    const bodies: Body[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const pos = new Vec2(Math.cos(ang) * 3, Math.sin(ang) * 3);
      bodies.push(w.addBody(new Body(new Circle(0.3), { position: pos })));
    }
    const pushed = w.applyRadialImpulse(new Vec2(0, 0), 10, 6, { occlusion: false });
    let sum = Vec2.ZERO;
    let outward = 0;
    for (const b of bodies) {
      sum = sum.add(b.linearVelocity.mul(b.mass));
      if (b.linearVelocity.dot(b.worldCenter) > 0) outward++;
    }
    a.ok('All discs pushed', pushed.length === n, `pushed ${pushed.length}/${n}`);
    a.ok('Net momentum ~0 (symmetry)', sum.length() < 1e-6, `|Σp|=${sum.length().toExponential(2)}`);
    a.ok('Every disc flies outward', outward === n, `${outward}/${n} outward`);
  }
  {
    // Linear falloff: the near disc gets twice the near/far impulse ratio
    // predicted by 1 − d/radius (d=2 vs d=4 over radius 6 ⇒ 0.667 vs 0.333 = 2×).
    const w = new World(new Vec2(0, 0));
    const near = w.addBody(new Body(new Circle(0.3), { position: new Vec2(2, 0) }));
    const far = w.addBody(new Body(new Circle(0.3), { position: new Vec2(4, 0) }));
    w.applyRadialImpulse(new Vec2(0, 0), 10, 6, { falloff: 'linear', occlusion: false });
    a.close('Falloff impulse ratio = 2', near.linearVelocity.x / far.linearVelocity.x, 2, 0.05);
  }
  {
    // Occlusion: a static wall shadows the body directly behind it, while a body
    // in the clear is still pushed. Turning occlusion off reaches both.
    const build = (): World => {
      const w = new World(new Vec2(0, 0));
      w.addBody(new Body(Polygon.box(0.2, 1.5), { type: BodyType.Static, position: new Vec2(3, 0) }));
      return w;
    };
    const w1 = build();
    const shadowed = w1.addBody(new Body(new Circle(0.3), { position: new Vec2(6, 0) }));
    const clear = w1.addBody(new Body(new Circle(0.3), { position: new Vec2(0, 6) }));
    w1.applyRadialImpulse(new Vec2(0, 0), 10, 10, { occlusion: true });
    a.ok('Wall shadows the body behind it', shadowed.linearVelocity.length() < 1e-9,
      `|v|=${shadowed.linearVelocity.length().toExponential(2)}`);
    a.ok('Body in the clear is still pushed', clear.linearVelocity.length() > 0.1,
      `|v|=${clear.linearVelocity.length().toFixed(2)}`);
    const w2 = build();
    const behind = w2.addBody(new Body(new Circle(0.3), { position: new Vec2(6, 0) }));
    w2.applyRadialImpulse(new Vec2(0, 0), 10, 10, { occlusion: false });
    a.ok('Occlusion off reaches the shadowed body', behind.linearVelocity.length() > 0.1,
      `|v|=${behind.linearVelocity.length().toFixed(2)}`);
  }

  // ---- Pulley joint --------------------------------------------------------
  a.section('Pulley joint');
  {
    // Two masses hang from a rope over two pulleys. The heavier descends and the
    // lighter rises, but the combined length lengthA + ratio·lengthB is conserved.
    const w = new World(new Vec2(0, -10));
    const heavy = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(-2, 4), density: 4 }));
    const light = w.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(2, 4), density: 1 }));
    const pulley = new PulleyJoint(
      heavy, light, new Vec2(-2, 8), new Vec2(2, 8), new Vec2(-2, 4), new Vec2(2, 4), 1,
    );
    w.addJoint(pulley);
    let maxDrift = 0;
    const y0heavy = heavy.worldCenter.y;
    for (let i = 0; i < 140; i++) {
      w.step(1 / 120);
      // Accumulate drift only while both rope runs are healthy (away from the
      // length→0 singularity where a side reaches the pulley and the rope jams).
      if (pulley.lengthA() > 0.4 && pulley.lengthB() > 0.4) {
        const c = pulley.lengthA() + pulley.ratio * pulley.lengthB() - pulley.totalLength;
        maxDrift = Math.max(maxDrift, Math.abs(c));
      }
    }
    a.ok('Pulley conserves combined length', maxDrift < 0.02, `max drift ${maxDrift.toFixed(4)} m`);
    a.ok('Heavier side descends', heavy.worldCenter.y < y0heavy - 0.2, `Δy=${(heavy.worldCenter.y - y0heavy).toFixed(2)}`);
    a.ok('Lighter side rises', light.worldCenter.y > 4.1, `y=${light.worldCenter.y.toFixed(2)}`);
  }

  // ---- Gear joint ----------------------------------------------------------
  a.section('Gear joint');
  {
    // Two discs pinned to ground and meshed by a gear joint of ratio 2. The
    // constraint forces wA + ratio·wB = 0, so the second spins at −wA/2 (the
    // opposite way, half the speed) — exactly meshed teeth.
    const w = new World(new Vec2(0, 0));
    const ground = w.addBody(new Body(new Circle(0.05), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const gearA = w.addBody(new Body(new Circle(1), { position: new Vec2(0, 0), angularVelocity: 5 }));
    const gearB = w.addBody(new Body(new Circle(0.5), { position: new Vec2(1.5, 0) }));
    const rev1 = new RevoluteJoint(ground, gearA, new Vec2(0, 0));
    const rev2 = new RevoluteJoint(ground, gearB, new Vec2(1.5, 0));
    w.addJoint(rev1);
    w.addJoint(rev2);
    w.addJoint(new GearJoint(rev1, rev2, 2));
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      w.step(1 / 120);
      worst = Math.max(worst, Math.abs(gearA.angularVelocity + 2 * gearB.angularVelocity));
    }
    a.ok('Gear holds the ω ratio (ωA + 2·ωB = 0)', worst < 0.05, `max residual ${worst.toFixed(4)}`);
    a.ok('Meshed gears counter-rotate', gearA.angularVelocity * gearB.angularVelocity < 0,
      `ωA=${gearA.angularVelocity.toFixed(2)}, ωB=${gearB.angularVelocity.toFixed(2)}`);
  }
  {
    // Rack and pinion: a motorised pinion drives a prismatic carriage. The gear
    // constraint couples the pinion's angle to the rack's translation, so the
    // carriage actually slides as the pinion turns.
    const w = new World(new Vec2(0, 0));
    const ground = w.addBody(new Body(new Circle(0.05), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const pinion = w.addBody(new Body(new Circle(0.5), { position: new Vec2(0, 0) }));
    const rack = w.addBody(new Body(Polygon.box(1, 0.2), { position: new Vec2(0, 1) }));
    const rev = new RevoluteJoint(ground, pinion, new Vec2(0, 0));
    rev.enableMotor = true;
    rev.motorSpeed = 4;
    rev.maxMotorTorque = 50;
    const pris = new PrismaticJoint(ground, rack, new Vec2(0, 1), new Vec2(1, 0));
    w.addJoint(rev);
    w.addJoint(pris);
    w.addJoint(new GearJoint(rev, pris, 0.5));
    const x0 = rack.worldCenter.x;
    for (let i = 0; i < 240; i++) w.step(1 / 120);
    a.ok('Rack-and-pinion slides the carriage', Math.abs(rack.worldCenter.x - x0) > 0.5,
      `Δx=${(rack.worldCenter.x - x0).toFixed(2)}`);
  }

  // ---- Motor joint ---------------------------------------------------------
  a.section('Motor joint');
  {
    // A motor joint drives B to a target offset + angle relative to A with plenty
    // of force/torque, and gets there.
    const w = new World(new Vec2(0, 0));
    const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const plate = w.addBody(new Body(Polygon.box(0.5, 0.5), { position: new Vec2(0, 0) }));
    const motor = new MotorJoint(anchor, plate, new Vec2(3, 2), 1);
    motor.maxForce = 5000;
    motor.maxTorque = 5000;
    w.addJoint(motor);
    for (let i = 0; i < 400; i++) w.step(1 / 120);
    a.close('Motor reaches target x', plate.worldCenter.x, 3, 0.05);
    a.close('Motor reaches target y', plate.worldCenter.y, 2, 0.05);
    a.close('Motor reaches target angle', plate.angle, 1, 0.05);
  }
  {
    // A force-limited motor cannot hold a heavy load against gravity: with a tiny
    // force budget the plate sags far below its commanded height, while a strong
    // motor holds it there. (An overpowerable actuator, not a rigid weld.)
    const lift = (maxForce: number): number => {
      const w = new World(new Vec2(0, -10));
      const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 0) }));
      const load = w.addBody(new Body(Polygon.box(0.6, 0.6), { position: new Vec2(0, 0), density: 5 }));
      const motor = new MotorJoint(anchor, load, new Vec2(0, 5), 0);
      motor.maxForce = maxForce;
      motor.maxTorque = 5000;
      w.addJoint(motor);
      for (let i = 0; i < 400; i++) w.step(1 / 120);
      return load.worldCenter.y;
    };
    a.ok('Weak motor stalls under load', lift(5) < 2, `y=${lift(5).toFixed(2)}`);
    a.ok('Strong motor holds the load up', lift(5000) > 4.8, `y=${lift(5000).toFixed(2)}`);
  }

  // ---- Breakable joints ----------------------------------------------------
  a.section('Breakable joints');
  {
    // A rigid distance rod holds a mass at rest with a tension ≈ m·g. Set the
    // break budget above that and it holds; set it below and the rod snaps, the
    // mass falls, and exactly one break event fires.
    const run = (breakFactor: number): { joints: number; breaks: number; mass: number } => {
      const w = new World(new Vec2(0, -10));
      const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 5) }));
      const bob = w.addBody(new Body(new Circle(0.4), { position: new Vec2(0, 2), density: 3 }));
      const rod = new DistanceJoint(anchor, bob, new Vec2(0, 5), new Vec2(0, 2), 3);
      const weight = bob.mass * 10;
      rod.breakForce = weight * breakFactor;
      w.addJoint(rod);
      let breaks = 0;
      w.onJointBreak = () => { breaks++; };
      for (let i = 0; i < 240; i++) w.step(1 / 120);
      return { joints: w.joints.length, breaks, mass: bob.mass };
    };
    const strong = run(2); // budget twice the weight ⇒ holds
    const weak = run(0.5); // budget half the weight ⇒ snaps
    a.ok('Rod within budget holds', strong.joints === 1 && strong.breaks === 0,
      `joints=${strong.joints}, breaks=${strong.breaks}`);
    a.ok('Overloaded rod snaps (1 break event)', weak.joints === 0 && weak.breaks === 1,
      `joints=${weak.joints}, breaks=${weak.breaks}`);
  }
  {
    // A heavy body welded to a static anchor by its edge loads the weld with
    // ≈ m·g of force. A weld whose force budget is below that breaks and the body
    // falls; one above it holds the body welded in place.
    const run = (breakForce: number): { fell: boolean; broke: boolean } => {
      const w = new World(new Vec2(0, -10));
      const anchor = w.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(0, 5) }));
      const slab = w.addBody(new Body(Polygon.box(0.5, 0.5), { position: new Vec2(0, 4.4), density: 4 }));
      const weld = new WeldJoint(anchor, slab, new Vec2(0, 5));
      weld.breakForce = breakForce;
      w.addJoint(weld);
      let broke = false;
      w.onJointBreak = () => { broke = true; };
      for (let i = 0; i < 240; i++) w.step(1 / 120);
      return { fell: slab.worldCenter.y < 3, broke };
    };
    const weight = 0.5 * 0.5 * 4 * 4 * 10; // (1×1 box, density 4) · g
    const weak = run(weight * 0.3);
    const strong = run(weight * 3);
    a.ok('Overloaded weld breaks & body falls', weak.broke && weak.fell, `broke=${weak.broke}, fell=${weak.fell}`);
    a.ok('Weld within budget holds', !strong.broke && !strong.fell, `broke=${strong.broke}, fell=${strong.fell}`);
  }

  // ---- Soft bodies (XPBD) --------------------------------------------------
  a.section('Soft bodies (XPBD)');
  {
    // The particle-vs-rigid collision primitive against an analytic box face.
    const box = new Body(Polygon.box(1, 1), { type: BodyType.Static });
    const hit = collideParticle(box, new Vec2(1.05, 0), 0.1);
    a.ok('Particle–box hit found', hit !== null, hit ? 'hit' : 'miss');
    if (hit) {
      a.close('Contact normal points +x', hit.normal.x, 1, 1e-6);
      a.close('Penetration depth = 0.05', hit.depth, 0.05, 1e-6);
    }
    const miss = collideParticle(box, new Vec2(1.5, 0), 0.1);
    a.ok('Particle clear of box ⇒ no hit', miss === null, miss ? 'hit' : 'miss');
  }
  {
    // Internal constraints are symmetric, so a free blob (no gravity, no
    // damping, no contact) conserves linear momentum exactly.
    const w = new World(new Vec2(0, 0));
    const blob = makeBlob(new Vec2(0, 0), 1, 16, { mass: 2, damping: 0 });
    blob.applyImpulseToCenter(new Vec2(3, 1));
    w.addSoftBody(blob);
    const p0 = blob.linearMomentum();
    for (let i = 0; i < 120; i++) w.step(1 / 60);
    const p1 = blob.linearMomentum();
    a.close('Free blob conserves momentum', p1.sub(p0).length(), 0, 1e-6);
  }
  {
    // A blob settling on the ground preserves its area (incompressible) and
    // rests on the surface rather than sinking through or exploding.
    const w = new World(new Vec2(0, -9.8));
    w.addBody(new Body(Polygon.box(30, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
    const blob = makeBlob(new Vec2(0, 2), 0.9, 20, { mass: 2, pressure: 1 });
    const rest = blob.area();
    w.addSoftBody(blob);
    for (let i = 0; i < 420; i++) w.step(1 / 60);
    let finite = true;
    let minY = Infinity;
    for (const p of blob.particles) {
      if (!p.pos.isFinite()) finite = false;
      minY = Math.min(minY, p.pos.y);
    }
    a.ok('Blob stays finite (no blow-up)', finite, finite ? 'finite' : 'NaN/Inf');
    a.close('Blob preserves area ±10%', blob.area() / rest, 1, 0.1);
    a.ok('Blob rests on the ground', minY > -0.2 && minY < 0.3, `minY=${minY.toFixed(3)}`);
  }
  {
    // Pressure > 1 inflates the rest area; the blob ends up visibly larger.
    const w = new World(new Vec2(0, 0));
    const b = makeBlob(new Vec2(0, 0), 1, 20, { pressure: 1.6 });
    const r0 = b.area();
    w.addSoftBody(b);
    for (let i = 0; i < 180; i++) w.step(1 / 60);
    a.ok('Pressure inflates the blob', b.area() > r0 * 1.3, `area ${r0.toFixed(2)}→${b.area().toFixed(2)}`);
  }
  {
    // A rope pinned at one end hangs straight down under gravity.
    const w = new World(new Vec2(0, -9.8));
    const rope = makeRope(new Vec2(0, 3), new Vec2(3, 3), 18, { pinStart: true, mass: 1 });
    w.addSoftBody(rope);
    for (let i = 0; i < 400; i++) w.step(1 / 60);
    const free = rope.particles[rope.particles.length - 1].pos;
    const pin = rope.particles[0].pos;
    a.ok('Pinned rope hangs vertically', free.y < pin.y - 1.5 && Math.abs(free.x - pin.x) < 0.8 && free.isFinite(),
      `free=${free.toString()}`);
  }
  {
    // Two-way coupling: a blob dropped onto a free rigid box pushes it down and
    // the box never tunnels through the floor.
    const w = new World(new Vec2(0, -9.8));
    w.addBody(new Body(Polygon.box(30, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
    const boxBody = w.addBody(new Body(Polygon.box(0.5, 0.4), { position: new Vec2(0, 0.4), density: 1 }));
    w.addSoftBody(makeBlob(new Vec2(0, 2), 0.7, 18, { mass: 1.5, pressure: 1.05 }));
    let minY = Infinity;
    for (let i = 0; i < 300; i++) {
      w.step(1 / 60);
      minY = Math.min(minY, boxBody.worldCenter.y);
    }
    a.ok('Blob pushes the rigid box (coupling)', minY < 0.4, `box dipped to y=${minY.toFixed(3)}`);
    a.ok('Coupled box never tunnels', boxBody.worldCenter.y > -0.1 && boxBody.worldCenter.isFinite(),
      `y=${boxBody.worldCenter.y.toFixed(3)}`);
  }
  {
    // A pinned cloth hammock catches a falling rigid ball (rigid-on-soft load).
    const w = new World(new Vec2(0, -9.8));
    const cloth = makeCloth(new Vec2(-4, 3), 8, 2.5, 24, 7, { pin: 'top-corners', mass: 3, stiffness: 0.9 });
    w.addSoftBody(cloth);
    for (let i = 0; i < 120; i++) w.step(1 / 60);
    const ball = w.addBody(new Body(new Circle(0.5), { position: new Vec2(0, 5), density: 1 }));
    let finite = true;
    for (let i = 0; i < 360; i++) {
      w.step(1 / 60);
      if (!ball.worldCenter.isFinite()) finite = false;
    }
    a.ok('Hammock catches the ball', finite && ball.worldCenter.y > 0.5, `ball y=${ball.worldCenter.y.toFixed(2)}`);
  }
  {
    // Determinism: identical soft-body setups evolve bit-for-bit identically.
    const mk = (): World => {
      const w = new World(new Vec2(0, -9.8));
      w.addBody(new Body(Polygon.box(30, 0.5), { type: BodyType.Static, position: new Vec2(0, -0.5) }));
      w.addSoftBody(makeBlob(new Vec2(0.13, 2.2), 0.8, 20, { mass: 2 }));
      return w;
    };
    const wa = mk();
    const wb = mk();
    for (let i = 0; i < 200; i++) {
      wa.step(1 / 60);
      wb.step(1 / 60);
    }
    const d = wa.softBodies[0].centroid().sub(wb.softBodies[0].centroid()).length();
    a.close('Soft simulation is deterministic', d, 0, 1e-12);
  }

  return a.results;
}
