import {
  Body,
  BodyType,
  BuoyancyZone,
  Capsule,
  Circle,
  DistanceJoint,
  fractureMaterial,
  GearJoint,
  MotorJoint,
  MouseJoint,
  Polygon,
  PrismaticJoint,
  PulleyJoint,
  RevoluteJoint,
  Rng,
  Vec2,
  WheelJoint,
  World,
  crossSV,
  makeBlob,
  makeCloth,
  makeRope,
  makeSoftBox,
  type Joint,
  type Shape,
} from '../engine';

export interface SceneCamera {
  center: Vec2;
  scale: number;
}

export interface BuildResult {
  camera?: SceneCamera;
  /** Optional per-step hook for animated/kinematic scenes. */
  update?: (time: number, dt: number) => void;
}

export interface SceneDef {
  id: string;
  name: string;
  description: string;
  category: 'Stacking' | 'Joints' | 'Soft' | 'Fracture' | 'Showcase' | 'Materials' | 'Stress';
  build: (world: World, rng: Rng) => BuildResult;
}

const PALETTE = ['#6ea8ff', '#7CFFCB', '#ffd166', '#ff6b6b', '#c792ea', '#4dd2ff', '#ff9e64', '#9ece6a'];
function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

// ---- Shared builders -------------------------------------------------------

function ground(world: World, halfWidth = 30, y = 0, thickness = 0.5): Body {
  return world.addBody(
    new Body(Polygon.box(halfWidth, thickness), {
      type: BodyType.Static,
      position: new Vec2(0, y - thickness),
      friction: 0.6,
    }),
  );
}

function walls(world: World, halfWidth: number, height: number, y = 0): void {
  const t = 0.5;
  world.addBody(new Body(Polygon.box(t, height), {
    type: BodyType.Static,
    position: new Vec2(-halfWidth - t, y + height),
    friction: 0.4,
  }));
  world.addBody(new Body(Polygon.box(t, height), {
    type: BodyType.Static,
    position: new Vec2(halfWidth + t, y + height),
    friction: 0.4,
  }));
}

function box(world: World, x: number, y: number, hw: number, hh: number, i = 0, angle = 0): Body {
  return world.addBody(
    new Body(Polygon.box(hw, hh), { position: new Vec2(x, y), angle, color: colorFor(i) }),
  );
}

function randomShape(rng: Rng, scale: number): Shape {
  const kind = rng.int(0, 3);
  if (kind === 0) return new Circle(rng.range(0.25, 0.5) * scale);
  if (kind === 1) return Capsule.of(rng.range(0.7, 1.2) * scale, rng.range(0.18, 0.3) * scale);
  const sides = rng.int(3, 6);
  return Polygon.regular(sides, rng.range(0.3, 0.55) * scale, rng.range(0, Math.PI));
}

// ---- Scenes ----------------------------------------------------------------

const pyramid: SceneDef = {
  id: 'pyramid',
  name: 'Pyramid',
  description: 'A 12-row box pyramid. Watch warm-started impulses settle it solid; toggle Contacts to see the manifolds holding it up.',
  category: 'Stacking',
  build: (world) => {
    ground(world);
    const rows = 12;
    const size = 0.5;
    const gap = 0.01;
    for (let row = 0; row < rows; row++) {
      const count = rows - row;
      const y = size + row * (size * 2 + gap);
      const x0 = -(count - 1) * (size + gap);
      for (let col = 0; col < count; col++) {
        box(world, x0 + col * (size * 2 + gap), y, size, size, row + col);
      }
    }
    return { camera: { center: new Vec2(0, 6), scale: 36 } };
  },
};

const stacks: SceneDef = {
  id: 'stacks',
  name: 'Towers',
  description: 'Several tall single-column towers — a torture test for the solver. Tweak iterations in Controls and watch them wobble or hold.',
  category: 'Stacking',
  build: (world, rng) => {
    ground(world);
    const towers = 5;
    const height = 14;
    for (let t = 0; t < towers; t++) {
      const x = (t - (towers - 1) / 2) * 3;
      for (let i = 0; i < height; i++) {
        // Tiny jitter so towers lean and the solver has to work.
        box(world, x + rng.range(-0.01, 0.01), 0.5 + i, 0.5, 0.5, t * height + i);
      }
    }
    return { camera: { center: new Vec2(0, 7), scale: 30 } };
  },
};

const newtonsCradle: SceneDef = {
  id: 'cradle',
  name: "Newton's Cradle",
  description: 'Five rigid pendulums in contact. Momentum tunnels through the chain via the contact solver — restitution near 1, friction 0.',
  category: 'Joints',
  build: (world) => {
    const r = 0.5;
    const n = 5;
    const length = 4;
    const topY = 9;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * (2 * r);
      const anchor = new Vec2(x, topY);
      const ballPos = i === 0
        ? new Vec2(x - length, topY) // lift the first ball horizontally
        : new Vec2(x, topY - length);
      const ball = world.addBody(
        new Body(new Circle(r), {
          position: ballPos,
          restitution: 0.98,
          friction: 0,
          color: colorFor(i),
          density: 4,
        }),
      );
      const j = new DistanceJoint(
        world.addBody(new Body(new Circle(0.05), { type: BodyType.Static, position: anchor })),
        ball,
        anchor,
        ballPos,
        length,
      );
      world.addJoint(j);
    }
    return { camera: { center: new Vec2(0, 5.5), scale: 42 } };
  },
};

const ropeBridge: SceneDef = {
  id: 'bridge',
  name: 'Rope Bridge',
  description: 'A chain of planks linked by revolute joints, pinned at both ends. Drop crates on it (click) and watch it sag and recover.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 30, -6);
    const planks = 18;
    const pw = 0.6;
    const ph = 0.12;
    const y = 6;
    const startX = -planks * pw;
    let prev = world.addBody(
      new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(startX - pw, y) }),
    );
    for (let i = 0; i < planks; i++) {
      const x = startX + i * (2 * pw);
      const plank = world.addBody(
        new Body(Polygon.box(pw, ph), { position: new Vec2(x, y), density: 2, color: '#c0966b' }),
      );
      world.addJoint(new RevoluteJoint(prev, plank, new Vec2(x - pw, y)));
      prev = plank;
    }
    const anchor = world.addBody(
      new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(startX + planks * 2 * pw - pw, y) }),
    );
    world.addJoint(new RevoluteJoint(prev, anchor, new Vec2(startX + planks * 2 * pw - pw, y)));
    // A few crates to load the bridge.
    for (let i = 0; i < 4; i++) {
      box(world, rng.range(-3, 3), y + 2 + i * 1.2, 0.4, 0.4, i + 2);
    }
    return { camera: { center: new Vec2(0, 3), scale: 26 } };
  },
};

const tumbler: SceneDef = {
  id: 'tumbler',
  name: 'Tumbler',
  description: 'A kinematic square drum rotates, tumbling the debris inside. The four walls are scripted each frame; the contents are fully simulated.',
  category: 'Showcase',
  build: (world, rng) => {
    const center = new Vec2(0, 6);
    const half = 4;
    const t = 0.3;
    const omega = 0.6;
    // Build four walls as kinematic bodies whose poses we drive each frame.
    const offsets = [
      new Vec2(0, half), new Vec2(0, -half), new Vec2(half, 0), new Vec2(-half, 0),
    ];
    const horizontal = [true, true, false, false];
    const wallsK: Array<{ body: Body; offset: Vec2 }> = [];
    for (let i = 0; i < 4; i++) {
      const shape = horizontal[i] ? Polygon.box(half + t, t) : Polygon.box(t, half + t);
      const body = world.addBody(
        new Body(shape, {
          type: BodyType.Kinematic,
          position: center.add(offsets[i]),
          friction: 0.4,
          color: '#5a6478',
        }),
      );
      wallsK.push({ body, offset: offsets[i] });
    }
    for (let i = 0; i < 60; i++) {
      world.addBody(
        new Body(randomShape(rng, 0.9), {
          position: center.add(new Vec2(rng.range(-3, 3), rng.range(-3, 3))),
          color: colorFor(i),
          friction: 0.3,
          restitution: 0.1,
        }),
      );
    }
    return {
      camera: { center, scale: 34 },
      update: (time) => {
        const angle = omega * time;
        for (const { body, offset } of wallsK) {
          const r = offset.rotate(angle);
          body.setTransform(center.add(r), angle);
          body.angularVelocity = omega;
          body.linearVelocity = crossSV(omega, r);
        }
      },
    };
  },
};

const dominoes: SceneDef = {
  id: 'dominoes',
  name: 'Dominoes',
  description: 'A heavy ball rolls in and topples a row of dominoes — a chain reaction carried entirely by frictional contacts.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 30);
    const count = 16;
    for (let i = 0; i < count; i++) {
      world.addBody(
        new Body(Polygon.box(0.1, 0.9), {
          position: new Vec2(-7 + i * 0.95, 0.9),
          friction: 0.5,
          color: colorFor(i),
        }),
      );
    }
    world.addBody(
      new Body(new Circle(0.7), {
        position: new Vec2(-10, 2.5),
        linearVelocity: new Vec2(5, 0),
        density: 6,
        friction: 0.5,
        color: '#ff6b6b',
      }),
    );
    return { camera: { center: new Vec2(0, 2.5), scale: 34 } };
  },
};

const ragdoll: SceneDef = {
  id: 'ragdoll',
  name: 'Ragdolls',
  description: 'Articulated figures built from boxes and revolute joints with non-colliding limbs, dropped onto the floor.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 30);
    walls(world, 14, 10);
    const makeRagdoll = (ox: number, oy: number, tint: number): void => {
      const torso = world.addBody(new Body(Polygon.box(0.35, 0.6), { position: new Vec2(ox, oy), color: colorFor(tint) }));
      const head = world.addBody(new Body(new Circle(0.3), { position: new Vec2(ox, oy + 0.95), color: colorFor(tint + 1) }));
      world.addJoint(new RevoluteJoint(torso, head, new Vec2(ox, oy + 0.65)));
      const limb = (dx: number, dy: number, ang: number, t: number): Body => {
        const upper = world.addBody(new Body(Polygon.box(0.12, 0.4), { position: new Vec2(ox + dx, oy + dy), angle: ang, color: colorFor(t) }));
        world.addJoint(new RevoluteJoint(torso, upper, new Vec2(ox + dx * 0.5, oy + dy + 0.4)));
        const lower = world.addBody(new Body(Polygon.box(0.1, 0.4), { position: new Vec2(ox + dx, oy + dy - 0.8), angle: ang, color: colorFor(t + 2) }));
        world.addJoint(new RevoluteJoint(upper, lower, new Vec2(ox + dx, oy + dy - 0.4)));
        return lower;
      };
      limb(-0.45, 0.4, 0, tint + 2); // arms
      limb(0.45, 0.4, 0, tint + 3);
      limb(-0.2, -0.9, 0, tint + 4); // legs
      limb(0.2, -0.9, 0, tint + 5);
    };
    for (let i = 0; i < 3; i++) makeRagdoll(-4 + i * 4, 6 + rng.range(0, 2), i * 2);
    return { camera: { center: new Vec2(0, 4), scale: 30 } };
  },
};

const arch: SceneDef = {
  id: 'arch',
  name: 'Masonry Arch',
  description: 'A self-supporting semicircular arch of wedge-shaped voussoirs — no joints, no glue. It stands purely on compression and friction.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 30);
    const n = 13;
    const inner = 4;
    const outer = 5.6;
    const cx = 0;
    const cy = 0;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI * (i / n);
      const a1 = Math.PI * ((i + 1) / n);
      // Voussoir = trapezoid between inner and outer radius across the wedge.
      const p0 = new Vec2(cx + Math.cos(a0) * inner, cy + Math.sin(a0) * inner);
      const p1 = new Vec2(cx + Math.cos(a1) * inner, cy + Math.sin(a1) * inner);
      const p2 = new Vec2(cx + Math.cos(a1) * outer, cy + Math.sin(a1) * outer);
      const p3 = new Vec2(cx + Math.cos(a0) * outer, cy + Math.sin(a0) * outer);
      const centroid = p0.add(p1).add(p2).add(p3).mul(0.25);
      const local = [p0, p1, p2, p3].map((p) => p.sub(centroid));
      world.addBody(
        new Body(Polygon.fromVertices(local), {
          position: centroid,
          friction: 0.7,
          density: 3,
          color: i === Math.floor(n / 2) ? '#ffd166' : '#b0a08c',
        }),
      );
    }
    return { camera: { center: new Vec2(0, 3), scale: 34 } };
  },
};

const springs: SceneDef = {
  id: 'springs',
  name: 'Soft Springs',
  description: 'Masses hung from damped distance-joint springs (a soft constraint). Grab and fling them; they oscillate and settle.',
  category: 'Joints',
  build: (world) => {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 1.6;
      const anchorPos = new Vec2(x, 10);
      const anchor = world.addBody(new Body(new Circle(0.08), { type: BodyType.Static, position: anchorPos }));
      const mass = world.addBody(new Body(Polygon.box(0.4, 0.4), { position: new Vec2(x, 6 - i * 0.2), color: colorFor(i), density: 2 }));
      const j = new DistanceJoint(anchor, mass, anchorPos, mass.worldCenter, 3.5);
      j.frequencyHz = 2 + i * 0.4;
      j.dampingRatio = 0.2;
      world.addJoint(j);
    }
    return { camera: { center: new Vec2(0, 6), scale: 34 } };
  },
};

const frictionRamps: SceneDef = {
  id: 'friction',
  name: 'Friction Ramps',
  description: 'Identical boxes released on inclines of increasing friction. The low-friction box slides away; the high-friction box stays put.',
  category: 'Materials',
  build: (world) => {
    ground(world, 30);
    const frictions = [0.0, 0.1, 0.3, 0.6, 1.0];
    for (let i = 0; i < frictions.length; i++) {
      const x = (i - 2) * 5;
      world.addBody(
        new Body(Polygon.box(2.2, 0.2), {
          type: BodyType.Static,
          position: new Vec2(x, 3),
          angle: -0.45,
          friction: frictions[i],
        }),
      );
      world.addBody(
        new Body(Polygon.box(0.4, 0.4), {
          position: new Vec2(x + 1, 4.2),
          angle: -0.45,
          friction: frictions[i],
          color: colorFor(i),
        }),
      );
    }
    return { camera: { center: new Vec2(0, 3), scale: 26 } };
  },
};

const restitution: SceneDef = {
  id: 'restitution',
  name: 'Bouncing',
  description: 'A row of balls dropped from the same height with restitution from 0 to 0.95 — dead splat to near-perfect bounce.',
  category: 'Materials',
  build: (world) => {
    ground(world, 30);
    const values = [0, 0.3, 0.5, 0.7, 0.85, 0.95];
    for (let i = 0; i < values.length; i++) {
      const x = (i - (values.length - 1) / 2) * 2.2;
      world.addBody(
        new Body(new Circle(0.5), {
          position: new Vec2(x, 9),
          restitution: values[i],
          friction: 0.2,
          color: colorFor(i),
        }),
      );
    }
    return { camera: { center: new Vec2(0, 4.5), scale: 34 } };
  },
};

const machine: SceneDef = {
  id: 'machine',
  name: 'Motors & Elevator',
  description: 'A revolute motor spins a paddle wheel while a prismatic-joint elevator rides a motorised rail, ferrying boxes up and dumping them.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 30);
    // Motorised paddle wheel.
    const hub = world.addBody(new Body(new Circle(0.2), { type: BodyType.Static, position: new Vec2(-6, 4) }));
    const wheel = world.addBody(new Body(Polygon.regular(4, 2.2), { position: new Vec2(-6, 4), density: 1, color: '#4dd2ff' }));
    const motor = new RevoluteJoint(hub, wheel, new Vec2(-6, 4));
    motor.enableMotor = true;
    motor.motorSpeed = 1.5;
    motor.maxMotorTorque = 800;
    world.addJoint(motor);

    // Prismatic elevator on a vertical rail with a motor that reverses.
    const railBase = world.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(6, 1) }));
    const platform = world.addBody(new Body(Polygon.box(1.4, 0.2), { position: new Vec2(6, 1.5), density: 4, color: '#9ece6a' }));
    const slider = new PrismaticJoint(railBase, platform, new Vec2(6, 1.5), new Vec2(0, 1));
    slider.enableMotor = true;
    slider.motorSpeed = 2.5;
    slider.maxMotorForce = 2000;
    world.addJoint(slider, true);

    for (let i = 0; i < 6; i++) {
      box(world, -6 + rng.range(-1, 1), 7 + i, 0.3, 0.3, i);
    }

    let dir = 1;
    return {
      camera: { center: new Vec2(0, 4.5), scale: 26 },
      update: () => {
        // Reverse the elevator at the travel extremes.
        if (platform.worldCenter.y > 7 && dir > 0) dir = -1;
        if (platform.worldCenter.y < 1.4 && dir < 0) dir = 1;
        slider.motorSpeed = 2.5 * dir;
      },
    };
  },
};

const galton: SceneDef = {
  id: 'galton',
  name: 'Galton Board',
  description: 'Hundreds of balls cascade through a lattice of pegs into bins, sculpting a bell curve out of pure collision.',
  category: 'Stress',
  build: (world, rng) => {
    ground(world, 14, -8);
    walls(world, 8, 18, -8);
    // Peg lattice.
    for (let row = 0; row < 10; row++) {
      const count = row + 2;
      const y = 7 - row * 1.1;
      for (let i = 0; i < count; i++) {
        const x = (i - (count - 1) / 2) * 1.5;
        world.addBody(new Body(new Circle(0.12), { type: BodyType.Static, position: new Vec2(x, y), friction: 0.1, color: '#5a6478' }));
      }
    }
    // Bin dividers.
    for (let i = -7; i <= 7; i++) {
      world.addBody(new Body(Polygon.box(0.06, 3), { type: BodyType.Static, position: new Vec2(i * 1.0, -5), color: '#5a6478' }));
    }
    let spawned = 0;
    let acc = 0;
    return {
      camera: { center: new Vec2(0, 0), scale: 20 },
      update: (_time, dt) => {
        acc += dt;
        if (spawned < 260 && acc > 0.04) {
          acc = 0;
          world.addBody(
            new Body(new Circle(0.18), {
              position: new Vec2(rng.range(-0.3, 0.3), 8.5),
              restitution: 0.1,
              friction: 0.05,
              color: colorFor(spawned),
            }),
          );
          spawned++;
        }
      },
    };
  },
};

const stress: SceneDef = {
  id: 'stress',
  name: 'Stress Test',
  description: 'A deep pile of mixed shapes poured into a bin — exercises the dynamic-tree broadphase and island solver. Watch the HUD step time.',
  category: 'Stress',
  build: (world, rng) => {
    ground(world, 16);
    walls(world, 12, 20);
    let count = 0;
    let acc = 0;
    return {
      camera: { center: new Vec2(0, 8), scale: 18 },
      update: (_time, dt) => {
        acc += dt;
        if (count < 350 && acc > 0.03) {
          acc = 0;
          for (let i = 0; i < 3; i++) {
            world.addBody(
              new Body(randomShape(rng, 0.8), {
                position: new Vec2(rng.range(-10, 10), 18),
                color: colorFor(count + i),
                friction: 0.4,
                restitution: 0.05,
              }),
            );
          }
          count += 3;
        }
      },
    };
  },
};

const sandbox: SceneDef = {
  id: 'sandbox',
  name: 'Sandbox',
  description: 'An empty bin. Click to drop shapes, drag to fling them, scroll to zoom. Your playground — cycle the spawn shape in Controls.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 18);
    walls(world, 14, 14);
    return { camera: { center: new Vec2(0, 6), scale: 26 } };
  },
};

const bulletTest: SceneDef = {
  id: 'bullets',
  name: 'CCD Bullet Test',
  description:
    'Continuous collision detection in action. The top lane fires CCD "bullet" rounds that are swept to their time of impact and stop dead at the thin wall; the identical bottom-lane rounds have CCD off and tunnel straight through it.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 30, -3);
    // A thin wall — thin enough that a fast body skips over it in one step.
    world.addBody(new Body(Polygon.box(0.06, 1.3), { type: BodyType.Static, position: new Vec2(1.3, 6), friction: 0.3, color: '#5a6478' }));
    world.addBody(new Body(Polygon.box(0.06, 1.3), { type: BodyType.Static, position: new Vec2(1.3, 2), friction: 0.3, color: '#5a6478' }));
    let acc = 1.2;
    return {
      camera: { center: new Vec2(1, 4), scale: 44 },
      update: (_t, dt) => {
        acc += dt;
        if (acc < 1.1) return;
        acc = 0;
        world.addBody(
          new Body(new Circle(0.16), {
            position: new Vec2(-5, 6),
            linearVelocity: new Vec2(95, 0),
            bullet: true,
            restitution: 0.25,
            density: 4,
            color: '#7CFFCB',
          }),
        );
        world.addBody(
          new Body(new Circle(0.16), {
            position: new Vec2(-5, 2),
            linearVelocity: new Vec2(95, 0),
            bullet: false,
            restitution: 0.25,
            density: 4,
            color: '#ff6b6b',
          }),
        );
      },
    };
  },
};

const capsulePile: SceneDef = {
  id: 'capsules',
  name: 'Capsule Pile',
  description:
    'Capsules — segments swept by a radius — poured into a bin. They roll on their caps yet rest flat on their sides, and the radius-aware narrowphase keeps the heap stable. Toggle Contacts to see the 1–2 point manifolds.',
  category: 'Stress',
  build: (world, rng) => {
    ground(world, 14);
    walls(world, 11, 16);
    let count = 0;
    let acc = 0;
    return {
      camera: { center: new Vec2(0, 6), scale: 22 },
      update: (_time, dt) => {
        acc += dt;
        if (count < 90 && acc > 0.06) {
          acc = 0;
          world.addBody(
            new Body(Capsule.of(rng.range(1.0, 1.8), rng.range(0.2, 0.34)), {
              position: new Vec2(rng.range(-8, 8), 15),
              angle: rng.range(0, Math.PI),
              friction: 0.4,
              restitution: 0.05,
              color: colorFor(count),
            }),
          );
          count++;
        }
      },
    };
  },
};

const roundedStack: SceneDef = {
  id: 'rounded',
  name: 'Rounded Stack',
  description:
    'A pyramid of rounded boxes — convex polygons carrying a skin radius. The rounded corners are handled by the same core+radius collision path as capsules, and the warm-started solver still settles the stack solid.',
  category: 'Stacking',
  build: (world) => {
    ground(world);
    const rows = 9;
    const size = 0.55;
    const skin = 0.12;
    const gap = 0.02;
    for (let row = 0; row < rows; row++) {
      const count = rows - row;
      const y = size + row * (size * 2 + gap);
      const x0 = -(count - 1) * (size + gap);
      for (let col = 0; col < count; col++) {
        world.addBody(
          new Body(Polygon.rounded(size - skin, size - skin, skin), {
            position: new Vec2(x0 + col * (size * 2 + gap), y),
            friction: 0.5,
            color: colorFor(row + col),
          }),
        );
      }
    }
    return { camera: { center: new Vec2(0, 5), scale: 34 } };
  },
};

const limits: SceneDef = {
  id: 'limits',
  name: 'Joint Limits',
  description:
    'Revolute angle limits and prismatic travel stops. A motorised crane arm winds up against its angle limit and reverses; a piston bounces between its travel stops; weighted flaps swing only as far as their hinges allow.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 30);

    // Motorised crane arm clamped to ±0.9 rad; the motor drives it into the limit.
    const hub = world.addBody(new Body(new Circle(0.18), { type: BodyType.Static, position: new Vec2(-7, 7) }));
    const arm = world.addBody(new Body(Polygon.box(1.8, 0.16), { position: new Vec2(-5.2, 7), density: 2, color: '#4dd2ff' }));
    const crane = new RevoluteJoint(hub, arm, new Vec2(-7, 7));
    crane.enableMotor = true;
    crane.motorSpeed = 2;
    crane.maxMotorTorque = 3000;
    crane.setLimits(-0.9, 0.9);
    world.addJoint(crane);

    // Piston on a vertical rail with travel stops [0, 3.5]; motor reverses at the ends.
    const base = world.addBody(new Body(new Circle(0.12), { type: BodyType.Static, position: new Vec2(0, 1) }));
    const piston = world.addBody(new Body(Polygon.box(1.2, 0.2), { position: new Vec2(0, 1.5), density: 3, color: '#9ece6a' }));
    const slider = new PrismaticJoint(base, piston, new Vec2(0, 1.5), new Vec2(0, 1));
    slider.enableMotor = true;
    slider.motorSpeed = 3;
    slider.maxMotorForce = 4000;
    slider.setLimits(0, 3.5);
    world.addJoint(slider, true);

    // Weighted flaps hinged at the top, limited to ±1 rad, knocked by rolling balls.
    for (let i = 0; i < 3; i++) {
      const x = 4 + i * 2.4;
      const post = world.addBody(new Body(new Circle(0.1), { type: BodyType.Static, position: new Vec2(x, 7) }));
      const flap = world.addBody(new Body(Polygon.box(0.13, 1.2), { position: new Vec2(x, 5.8), density: 2, color: colorFor(i + 3) }));
      const hinge = new RevoluteJoint(post, flap, new Vec2(x, 7));
      hinge.setLimits(-1.0, 1.0);
      world.addJoint(hinge);
      world.addBody(
        new Body(new Circle(0.32), {
          position: new Vec2(x - 1.4, 5 + rng.range(0, 0.5)),
          linearVelocity: new Vec2(4.5, 0),
          density: 3,
          color: '#ffd166',
        }),
      );
    }

    let craneDir = 1;
    let pistonDir = 1;
    return {
      camera: { center: new Vec2(0, 4), scale: 22 },
      update: () => {
        if (crane.jointAngle() > 0.85 && craneDir > 0) craneDir = -1;
        if (crane.jointAngle() < -0.85 && craneDir < 0) craneDir = 1;
        crane.motorSpeed = 2 * craneDir;
        if (piston.worldCenter.y > 4.3 && pistonDir > 0) pistonDir = -1;
        if (piston.worldCenter.y < 1.4 && pistonDir < 0) pistonDir = 1;
        slider.motorSpeed = 3 * pistonDir;
      },
    };
  },
};

const buoyancy: SceneDef = {
  id: 'buoyancy',
  name: 'Buoyancy',
  description:
    'A water tank with real Archimedes buoyancy. Each body feels a lift equal to the weight of the fluid it displaces, applied at the submerged centroid — so a half-density box floats exactly half-under and rights itself, corks bob high, a dense ingot sinks, and a low-density raft carries its cargo. Drop shapes in and watch them find their waterline.',
  category: 'Showcase',
  build: (world, rng) => {
    const surface = 4;
    const halfW = 11;
    const floorY = -3;
    // Tank: floor + two side walls.
    world.addBody(new Body(Polygon.box(halfW + 0.5, 0.5), {
      type: BodyType.Static, position: new Vec2(0, floorY - 0.5), friction: 0.5, color: '#46506a',
    }));
    world.addBody(new Body(Polygon.box(0.5, 6), {
      type: BodyType.Static, position: new Vec2(-halfW - 0.5, floorY + 5), friction: 0.3, color: '#46506a',
    }));
    world.addBody(new Body(Polygon.box(0.5, 6), {
      type: BodyType.Static, position: new Vec2(halfW + 0.5, floorY + 5), friction: 0.3, color: '#46506a',
    }));

    world.addFluid(new BuoyancyZone({
      surface,
      minX: -halfW,
      maxX: halfW,
      density: 1,
      depth: surface - floorY,
      linearDrag: 1.4,
      angularDrag: 1.0,
    }));

    // A half-density box — floats with its centre right on the waterline.
    world.addBody(new Body(Polygon.box(0.7, 0.7), {
      position: new Vec2(-7, 6), density: 0.5, friction: 0.4, color: '#ffd166',
    }));
    // Light corks bob high.
    for (let i = 0; i < 4; i++) {
      world.addBody(new Body(new Circle(0.32), {
        position: new Vec2(-9 + i * 0.9, 6 + i * 0.4), density: 0.25, friction: 0.2, color: '#7CFFCB',
      }));
    }
    // A dense ingot sinks straight to the floor.
    world.addBody(new Body(Polygon.box(0.5, 0.4), {
      position: new Vec2(-3, 6), density: 6, friction: 0.5, color: '#b9c0cc',
    }));
    // Capsules float lengthwise on the surface.
    for (let i = 0; i < 3; i++) {
      world.addBody(new Body(Capsule.of(1.6, 0.28), {
        position: new Vec2(1 + i * 0.6, 6 + i * 0.5), angle: rng.range(-0.3, 0.3),
        density: 0.4, friction: 0.4, color: colorFor(i + 3),
      }));
    }
    // A low-density raft carrying a little cargo.
    const raft = world.addBody(new Body(Polygon.box(2.2, 0.22), {
      position: new Vec2(6, 5.2), density: 0.3, friction: 0.6, color: '#c0966b',
    }));
    for (let i = 0; i < 3; i++) {
      box(world, 5.2 + i * 0.8, 6.2, 0.28, 0.28, i + 1);
    }
    void raft;

    let acc = 0;
    let dropped = 0;
    return {
      camera: { center: new Vec2(0, 3), scale: 30 },
      update: (_t, dt) => {
        acc += dt;
        if (acc > 2.5 && dropped < 12) {
          acc = 0;
          dropped++;
          const density = rng.range(0.2, 1.4);
          world.addBody(new Body(randomShape(rng, 0.7), {
            position: new Vec2(rng.range(-9, 9), 9),
            density,
            friction: 0.4,
            restitution: 0.05,
            color: density < 1 ? '#6ea8ff' : '#ff6b6b',
          }));
        }
      },
    };
  },
};

const car: SceneDef = {
  id: 'car',
  name: 'Suspension Car',
  description:
    'A car built from a chassis and two wheels joined by wheel joints — each a rigid line constraint plus a sprung suspension axis and a drive motor. It powers itself over bumpy terrain, the suspension soaking up the hills, and reverses at the walls. Toggle Joints to see the suspension lines compress and extend.',
  category: 'Joints',
  build: (world) => {
    const halfW = 16;
    ground(world, halfW, 0);
    walls(world, halfW, 8);
    // Bumpy terrain: a row of low half-buried static humps for the suspension.
    const humpXs = [-9, -5, -1, 4, 8, 12];
    for (let i = 0; i < humpXs.length; i++) {
      world.addBody(new Body(new Circle(0.4 + (i % 2) * 0.12), {
        type: BodyType.Static, position: new Vec2(humpXs[i], -0.2), friction: 0.9, color: '#46506a',
      }));
    }

    const startX = -10;
    const chassisY = 1.2;
    // A wide, low, heavy chassis keeps the centre of mass well under the axles so
    // the drive torque can't flip it.
    const chassis = world.addBody(new Body(Polygon.rounded(1.7, 0.22, 0.08), {
      position: new Vec2(startX, chassisY), density: 3, friction: 0.5, color: '#4dd2ff',
    }));

    const axis = new Vec2(0, 1);
    const wheelDefs: Array<{ dx: number; motor: boolean }> = [
      { dx: -1.3, motor: true },
      { dx: 1.3, motor: true },
    ];
    const motors: WheelJoint[] = [];
    for (const wd of wheelDefs) {
      const wheelPos = new Vec2(startX + wd.dx, chassisY - 0.45);
      const wheel = world.addBody(new Body(new Circle(0.45), {
        position: wheelPos, density: 1, friction: 1.8, color: '#2b3142',
      }));
      const wj = new WheelJoint(chassis, wheel, wheelPos, axis);
      wj.frequencyHz = 5;
      wj.dampingRatio = 0.8;
      if (wd.motor) {
        wj.enableMotor = true;
        wj.motorSpeed = -9; // spin the wheels to roll the car to the right
        wj.maxMotorTorque = 4.5;
        motors.push(wj);
      }
      world.addJoint(wj);
    }

    let dir = 1;
    return {
      camera: { center: new Vec2(0, 2), scale: 22 },
      update: () => {
        if (chassis.worldCenter.x > halfW - 7 && dir > 0) dir = -1;
        if (chassis.worldCenter.x < -(halfW - 7) && dir < 0) dir = 1;
        for (const m of motors) m.motorSpeed = -9 * dir;
      },
    };
  },
};

const sensors: SceneDef = {
  id: 'sensors',
  name: 'Sensor Field',
  description:
    'Two trigger gates built from sensor bodies — detected but never solved, so shapes fall straight through them. The engine fires begin/end contact events as each body enters and leaves a gate; the scene lights the body up while it is inside. Sensors are how you build goals, detectors and trigger volumes.',
  category: 'Showcase',
  build: (world, rng) => {
    ground(world, 14, -7);
    walls(world, 11, 16, -7);

    // Two horizontal sensor gates at different heights, each a glowing colour.
    const gates: Array<{ body: Body; glow: string }> = [];
    const gateDefs = [
      { y: 4, glow: '#7CFFCB' },
      { y: 0, glow: '#ff6b6b' },
    ];
    for (const g of gateDefs) {
      const gate = world.addBody(new Body(Polygon.box(9, 0.7), {
        type: BodyType.Static, position: new Vec2(0, g.y), isSensor: true, color: g.glow,
      }));
      gates.push({ body: gate, glow: g.glow });
    }

    // Track each body's original colour so we can restore it on exit, and how
    // many gates it is currently inside (so overlapping gates don't fight).
    const original = new Map<number, string>();
    const inside = new Map<number, number>();
    const gateOf = (a: Body, b: Body): { mover: Body; glow: string } | null => {
      const g = gates.find((x) => x.body === a || x.body === b);
      if (!g) return null;
      const mover = g.body === a ? b : a;
      if (mover.isSensor) return null;
      return { mover, glow: g.glow };
    };
    world.onBeginContact = (a, b) => {
      const hit = gateOf(a, b);
      if (!hit) return;
      if (!original.has(hit.mover.id)) original.set(hit.mover.id, hit.mover.color);
      inside.set(hit.mover.id, (inside.get(hit.mover.id) ?? 0) + 1);
      hit.mover.color = hit.glow;
    };
    world.onEndContact = (a, b) => {
      const hit = gateOf(a, b);
      if (!hit) return;
      const n = (inside.get(hit.mover.id) ?? 1) - 1;
      inside.set(hit.mover.id, n);
      if (n <= 0) {
        const orig = original.get(hit.mover.id);
        if (orig !== undefined) hit.mover.color = orig;
      }
    };

    let acc = 0;
    let count = 0;
    return {
      camera: { center: new Vec2(0, -1), scale: 22 },
      update: (_t, dt) => {
        acc += dt;
        if (acc > 0.35 && count < 120) {
          acc = 0;
          count++;
          world.addBody(new Body(randomShape(rng, 0.7), {
            position: new Vec2(rng.range(-8, 8), 9),
            color: '#6ea8ff',
            friction: 0.3,
            restitution: 0.1,
          }));
        }
      },
    };
  },
};

// ---- v4 mechanisms scenes --------------------------------------------------

const pulley: SceneDef = {
  id: 'pulley',
  name: 'Pulley',
  description:
    'Two trays hang from a rope routed over two pulleys, so lengthA + lengthB is conserved — load one tray and the other rises. Weights drop onto the left tray on a timer; watch the right one climb. Box2D-style pulley constraint.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 16, -7);
    const gay = 8;
    const gax = 3.2;
    const trayY = 3;
    const trayA = world.addBody(
      new Body(Polygon.box(1.3, 0.18), { position: new Vec2(-gax, trayY), density: 1.5, color: '#6ea8ff' }),
    );
    const trayB = world.addBody(
      new Body(Polygon.box(1.3, 0.18), { position: new Vec2(gax, trayY), density: 1.5, color: '#ffd166' }),
    );
    world.addJoint(
      new PulleyJoint(
        trayA, trayB,
        new Vec2(-gax, gay), new Vec2(gax, gay),
        new Vec2(-gax, trayY), new Vec2(gax, trayY),
        1,
      ),
    );
    let acc = 0;
    let dropped = 0;
    return {
      camera: { center: new Vec2(0, 3), scale: 26 },
      update: (_t, dt) => {
        acc += dt;
        if (acc > 1.8 && dropped < 7) {
          acc = 0;
          dropped++;
          world.addBody(
            new Body(Polygon.box(0.32, 0.32), {
              position: new Vec2(-gax + rng.range(-0.3, 0.3), 7),
              density: 2,
              friction: 0.7,
              color: colorFor(dropped),
            }),
          );
        }
      },
    };
  },
};

const gearTrain: SceneDef = {
  id: 'gears',
  name: 'Gear Train',
  description:
    'A row of meshed gears, each pinned to the frame and coupled to its neighbour by a gear joint whose ratio is their size ratio — so they counter-rotate at speeds set by their radii. A motor drives the first. Below, a rack-and-pinion turns spin into the straight-line travel of a carriage.',
  category: 'Joints',
  build: (world) => {
    const frame = world.addBody(new Body(new Circle(0.05), { type: BodyType.Static, position: new Vec2(0, 0) }));
    const radii = [1.3, 0.8, 1.1, 0.7, 1.0];
    const cy = 5.5;
    let cx = -4.5;
    const revs: RevoluteJoint[] = [];
    for (let i = 0; i < radii.length; i++) {
      if (i > 0) cx += radii[i - 1] + radii[i];
      const center = new Vec2(cx, cy);
      const sides = Math.max(8, Math.round(radii[i] * 12));
      const gear = world.addBody(
        new Body(Polygon.regular(sides, radii[i]), { position: center, density: 1, color: colorFor(i) }),
      );
      const rev = new RevoluteJoint(frame, gear, center);
      world.addJoint(rev);
      revs.push(rev);
      if (i > 0) world.addJoint(new GearJoint(revs[i - 1], rev, radii[i] / radii[i - 1]));
    }
    revs[0].enableMotor = true;
    revs[0].motorSpeed = 1.1;
    revs[0].maxMotorTorque = 6000;

    // Rack and pinion.
    const pinionC = new Vec2(-4.5, 1.0);
    const pinion = world.addBody(new Body(Polygon.regular(12, 0.7), { position: pinionC, density: 1, color: '#7CFFCB' }));
    const pRev = new RevoluteJoint(frame, pinion, pinionC);
    pRev.enableMotor = true;
    pRev.motorSpeed = 1.6;
    pRev.maxMotorTorque = 3000;
    world.addJoint(pRev);
    const rackStart = new Vec2(-4.5, 1.85);
    const rack = world.addBody(new Body(Polygon.box(2.2, 0.22), { position: rackStart, density: 0.5, color: '#ffd166' }));
    const pris = new PrismaticJoint(frame, rack, rackStart, new Vec2(1, 0));
    world.addJoint(pris, true);
    world.addJoint(new GearJoint(pRev, pris, -1 / 0.7));

    return {
      camera: { center: new Vec2(0, 3.5), scale: 22 },
      update: () => {
        // Reverse the pinion before the carriage runs off its short rail.
        const dx = rack.worldCenter.x - rackStart.x;
        if (dx > 3 && pRev.motorSpeed > 0) pRev.motorSpeed = -1.6;
        if (dx < -3 && pRev.motorSpeed < 0) pRev.motorSpeed = 1.6;
      },
    };
  },
};

const conveyor: SceneDef = {
  id: 'conveyor',
  name: 'Conveyor',
  description:
    'A cascade of conveyor belts at different speeds and tilts ferries crates across and down; the chevron arrows show each belt\'s surface velocity. The crates recirculate forever (anything that reaches the bottom is lifted back to the top), so the line never empties. Belt speed is a contact material solved right inside the friction constraint.',
  category: 'Materials',
  build: (world, rng) => {
    const belt = (cx: number, cy: number, hw: number, angle: number, speed: number, color: string): void => {
      world.addBody(
        new Body(Polygon.box(hw, 0.25), {
          type: BodyType.Static, position: new Vec2(cx, cy), angle, friction: 1, tangentSpeed: speed, color,
        }),
      );
    };
    belt(-3.5, 3.2, 3.4, 0, 4, '#6ea8ff'); // top, →
    belt(2.2, 1.5, 2.8, -0.32, 4, '#7CFFCB'); // ramp, ↘
    belt(-0.8, -0.6, 4.8, 0, -4.5, '#ffd166'); // return, ←
    // Containment so crates stay roughly over the line.
    world.addBody(new Body(Polygon.box(0.25, 2.4), { type: BodyType.Static, position: new Vec2(6.0, 0.6), color: '#5a6478' }));

    const spawn = (): Vec2 => new Vec2(rng.range(-6.5, -5.0), 4.4 + rng.range(0, 0.6));
    const crates: Body[] = [];
    for (let i = 0; i < 16; i++) {
      crates.push(
        new Body(Polygon.box(0.3, 0.3), { position: spawn(), friction: 0.8, color: colorFor(i) }),
      );
      world.addBody(crates[i]);
    }
    return {
      camera: { center: new Vec2(0, 1), scale: 30 },
      update: () => {
        // Recycle: lift any crate that has dropped past the bottom back to the top.
        for (const c of crates) {
          if (c.worldCenter.y < -4 || Math.abs(c.worldCenter.x) > 9) {
            c.setTransform(spawn(), rng.range(-0.5, 0.5));
            c.linearVelocity = Vec2.ZERO;
            c.angularVelocity = 0;
            c.wake();
          }
        }
      },
    };
  },
};

const demolition: SceneDef = {
  id: 'demolition',
  name: 'Demolition',
  description:
    'A brick tower wired to a charge: a radial impulse at its base blows the bricks outward, with magnitude falling off by distance. A blast-proof bunker wall shadows the barrel behind it — the explosion is ray-occluded by static geometry, so it can\'t punch through walls. Rebuilds and detonates on a loop.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 18, -6);
    // Bunker wall + the barrel it protects (which must survive every blast).
    world.addBody(new Body(Polygon.box(0.4, 2.2), { type: BodyType.Static, position: new Vec2(6.5, -3.8), color: '#5a6478' }));
    world.addBody(new Body(Capsule.of(1.0, 0.45, true), { position: new Vec2(8.0, -5), density: 1, color: '#7CFFCB' }));

    let bricks: Body[] = [];
    const buildTower = (): void => {
      const cols = 4;
      const rows = 9;
      const bw = 0.55;
      const bh = 0.3;
      for (let r = 0; r < rows; r++) {
        for (let cI = 0; cI < cols; cI++) {
          const x = (cI - (cols - 1) / 2) * (bw * 2 + 0.02);
          const y = -6 + bh + r * (bh * 2 + 0.01);
          bricks.push(world.addBody(new Body(Polygon.box(bw, bh), { position: new Vec2(x, y), density: 1.5, color: r % 2 ? '#ff9e64' : '#ffd166' })));
        }
      }
    };
    buildTower();

    let phase = 0;
    let timer = 0;
    return {
      camera: { center: new Vec2(1, -2), scale: 28 },
      update: (_t, dt) => {
        timer += dt;
        if (phase === 0 && timer > 2.5) {
          world.applyRadialImpulse(new Vec2(0, -5.2), 14, 7, { falloff: 'linear', occlusion: true });
          phase = 1;
          timer = 0;
        } else if (phase === 1 && timer > 3.5) {
          for (const b of bricks) world.removeBody(b);
          bricks = [];
          buildTower();
          phase = 0;
          timer = 0;
        }
      },
    };
  },
};

const breakableBridge: SceneDef = {
  id: 'breakbridge',
  name: 'Breakable Bridge',
  description:
    'A plank bridge on revolute pins, each given a breaking-force budget. A heavy ball rolls out across it; once the load on a pin passes its limit the pin snaps and the span gives way, dropping the ball into the gorge. It all rebuilds on a timer so you can watch it fail again and again.',
  category: 'Showcase',
  build: (world) => {
    ground(world, 26, -10);
    const top = 2;
    const span = 6.5;
    for (const sx of [-span - 0.6, span + 0.6]) {
      world.addBody(new Body(Polygon.box(0.6, 6), { type: BodyType.Static, position: new Vec2(sx, top - 6), color: '#5a6478' }));
    }

    let pieces: Body[] = [];
    let pins: Joint[] = [];
    let ball: Body | null = null;
    const buildBridge = (): void => {
      const planks = 16;
      const pw = span / planks;
      const ph = 0.13;
      let prev = world.addBody(new Body(new Circle(0.08), { type: BodyType.Static, position: new Vec2(-span, top) }));
      const anchorA = prev;
      for (let i = 0; i < planks; i++) {
        const x = -span + pw + i * (2 * pw);
        const plank = world.addBody(new Body(Polygon.box(pw, ph), { position: new Vec2(x, top), density: 1.2, friction: 0.6, color: '#c0966b' }));
        const pin = new RevoluteJoint(prev, plank, new Vec2(x - pw, top));
        pin.breakForce = 42;
        world.addJoint(pin);
        pins.push(pin);
        if (prev !== anchorA) pieces.push(prev);
        prev = plank;
      }
      pieces.push(prev);
      const anchorB = world.addBody(new Body(new Circle(0.08), { type: BodyType.Static, position: new Vec2(span, top) }));
      const pinEnd = new RevoluteJoint(prev, anchorB, new Vec2(span, top));
      pinEnd.breakForce = 42;
      world.addJoint(pinEnd);
      pins.push(pinEnd);
      // The wrecking ball: heavy, rolls out across the deck.
      ball = world.addBody(new Body(new Circle(0.5), { position: new Vec2(-span + 1, top + 0.7), density: 9, friction: 0.5, linearVelocity: new Vec2(3.5, 0), color: '#ff6b6b' }));
      pieces.push(ball);
    };
    buildBridge();

    let timer = 0;
    return {
      camera: { center: new Vec2(0, -1), scale: 24 },
      update: (_t, dt) => {
        timer += dt;
        if (timer > 7) {
          for (const p of pins) world.removeJoint(p);
          for (const b of pieces) world.removeBody(b);
          pins = [];
          pieces = [];
          ball = null;
          buildBridge();
          timer = 0;
        }
      },
    };
  },
};

const motorPlatform: SceneDef = {
  id: 'motorplatform',
  name: 'Powered Platform',
  description:
    'A platform held aloft and swept side to side by a motor joint — a force-limited actuator, not a rigid weld. It carries its cargo along; pile on more or drag it past its force budget and it sags or stalls, then recovers. Box2D\'s motor joint, ported here.',
  category: 'Joints',
  build: (world, rng) => {
    ground(world, 30, -4);
    const baseAt = new Vec2(0, 4);
    const base = world.addBody(new Body(new Circle(0.12), { type: BodyType.Static, position: baseAt }));
    const platform = world.addBody(new Body(Polygon.box(1.7, 0.22), { position: baseAt, density: 3, color: '#9ece6a' }));
    const motor = new MotorJoint(base, platform, new Vec2(0, 0), 0);
    motor.maxForce = 7000;
    motor.maxTorque = 5000;
    motor.correctionFactor = 0.5;
    world.addJoint(motor);
    for (let i = 0; i < 5; i++) {
      world.addBody(new Body(Polygon.box(0.3, 0.3), { position: new Vec2(rng.range(-1.2, 1.2), 4.6 + i * 0.7), color: colorFor(i) }));
    }
    return {
      camera: { center: new Vec2(0, 3), scale: 26 },
      update: (t) => {
        motor.linearOffset = new Vec2(Math.sin(t * 0.8) * 4, 0);
      },
    };
  },
};

// ---- Soft bodies (XPBD) ----------------------------------------------------

const jellyPit: SceneDef = {
  id: 'jelly-pit',
  name: 'Jelly Pit',
  description:
    'Pressurised XPBD blobs poured into a bowl — they wobble, squash and pile up, each one two-way coupled to the rigid world. Grab a blob and fling it, or drop shapes on the pile.',
  category: 'Soft',
  build: (world, rng) => {
    ground(world, 7);
    walls(world, 7, 8);
    const cols = ['#ff79c6', '#ffd166', '#7CFFCB', '#4dd2ff', '#c792ea', '#ff9e64', '#ff6b6b'];
    for (let i = 0; i < 7; i++) {
      const r = rng.range(0.62, 1.0);
      world.addSoftBody(
        makeBlob(new Vec2(rng.range(-4, 4), 2.5 + i * 1.9), r, 18, {
          mass: r * r * 3,
          stiffness: 0.9,
          color: cols[i % cols.length],
        }),
      );
    }
    return { camera: { center: new Vec2(0, 4.5), scale: 32 } };
  },
};

const clothHammock: SceneDef = {
  id: 'cloth-hammock',
  name: 'Hammock',
  description:
    'A pinned cloth sheet sags into a hammock and catches falling rigid bodies — the weight bends the cloth, the cloth holds the weight. Two-way coupling you can watch settle.',
  category: 'Soft',
  build: (world, rng) => {
    ground(world, 16, -5);
    world.addBody(new Body(Polygon.box(0.25, 2.2), { type: BodyType.Static, position: new Vec2(-4.2, 2) }));
    world.addBody(new Body(Polygon.box(0.25, 2.2), { type: BodyType.Static, position: new Vec2(4.2, 2) }));
    const cloth = makeCloth(new Vec2(-4, 4), 8, 2.6, 26, 8, {
      pin: 'top-corners',
      mass: 3.5,
      stiffness: 0.9,
      color: '#7CFFCB',
    });
    world.addSoftBody(cloth);
    let dropped = 0;
    return {
      camera: { center: new Vec2(0, 2), scale: 34 },
      update: (time) => {
        if (dropped < 6 && time > dropped * 1.5 + 1) {
          dropped++;
          world.addBody(
            new Body(new Circle(rng.range(0.3, 0.5)), {
              position: new Vec2(rng.range(-2.4, 2.4), 6),
              density: 1,
              color: colorFor(dropped),
            }),
          );
        }
      },
    };
  },
};

const jelloCubes: SceneDef = {
  id: 'jello-cubes',
  name: 'Jello Cubes',
  description:
    'Deformable lattice solids — structural + shear + bend springs and per-cell area preservation — dropped onto the floor. They squash on impact, wobble back to shape, and jiggle when you grab and stretch them.',
  category: 'Soft',
  build: (world) => {
    ground(world, 9);
    walls(world, 9, 6);
    const specs: Array<[number, number, number, string]> = [
      [-2.4, 2.6, 0.45, '#6ea8ff'],
      [0, 3.6, 0.6, '#c792ea'],
      [2.4, 2.9, 0.5, '#7CFFCB'],
    ];
    for (const [x, y, h, color] of specs) {
      world.addSoftBody(
        makeSoftBox(new Vec2(x, y), h, h, 6, 6, {
          mass: 1.4,
          stiffness: 0.42,
          restitution: 0.15,
          color,
        }),
      );
    }
    return { camera: { center: new Vec2(0, 2.5), scale: 40 } };
  },
};

const trampoline: SceneDef = {
  id: 'trampoline',
  name: 'Trampoline',
  description:
    'A springy cloth membrane pinned between two posts. Rigid balls rain down, the sheet stretches taut and flings them back — momentum handed cleanly from soft to rigid and back.',
  category: 'Soft',
  build: (world, rng) => {
    ground(world, 14, -6);
    world.addBody(new Body(Polygon.box(0.4, 1.5), { type: BodyType.Static, position: new Vec2(-5.4, 2.4) }));
    world.addBody(new Body(Polygon.box(0.4, 1.5), { type: BodyType.Static, position: new Vec2(5.4, 2.4) }));
    const mat = makeCloth(new Vec2(-5, 3.1), 10, 1.0, 30, 4, {
      pin: 'sides',
      mass: 6,
      stiffness: 0.82,
      color: '#4dd2ff',
    });
    world.addSoftBody(mat);
    let dropped = 0;
    return {
      camera: { center: new Vec2(0, 2), scale: 34 },
      update: (time) => {
        if (dropped < 8 && time > dropped * 0.85 + 0.5) {
          dropped++;
          world.addBody(
            new Body(new Circle(rng.range(0.3, 0.45)), {
              position: new Vec2(rng.range(-3, 3), 7),
              density: 1,
              restitution: 0.2,
              color: colorFor(dropped),
            }),
          );
        }
      },
    };
  },
};

const waterBalloons: SceneDef = {
  id: 'water-balloons',
  name: 'Water Balloons',
  description:
    'High-pressure, low-friction blobs dropped into a tank — they jiggle, splat and bounce off one another and the walls. Crank gravity down and watch them slosh in slow motion.',
  category: 'Soft',
  build: (world, rng) => {
    ground(world, 7);
    walls(world, 7, 11);
    const cols = ['#4dd2ff', '#ff79c6', '#7CFFCB', '#ffd166'];
    for (let i = 0; i < 5; i++) {
      const r = rng.range(0.7, 0.95);
      world.addSoftBody(
        makeBlob(new Vec2(rng.range(-3.5, 3.5), 3 + i * 2.2), r, 20, {
          mass: r * r * 3,
          stiffness: 0.86,
          areaStiffness: 4,
          restitution: 0.18,
          friction: 0.12,
          color: cols[i % cols.length],
        }),
      );
    }
    return { camera: { center: new Vec2(0, 4), scale: 32 } };
  },
};

const ropeSwings: SceneDef = {
  id: 'rope-swings',
  name: 'Rope Swings',
  description:
    'A row of ropes pinned at the top, each a slightly different stiffness. Grab and swing them, or let the falling blobs barge through — Verlet ropes coupled to the soft and rigid worlds.',
  category: 'Soft',
  build: (world, rng) => {
    ground(world, 9, -1);
    walls(world, 9, 9, -1);
    const cols = ['#ffd166', '#ff79c6', '#7CFFCB', '#4dd2ff', '#c792ea'];
    for (let i = 0; i < 5; i++) {
      const x = -4 + i * 2;
      world.addSoftBody(
        makeRope(new Vec2(x, 5), new Vec2(x, 1.3), 14, {
          pinStart: true,
          mass: 0.8,
          stiffness: 0.96,
          color: cols[i % cols.length],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      world.addSoftBody(
        makeBlob(new Vec2(-2.5 + i * 5, 7 + i), rng.range(0.6, 0.8), 16, {
          mass: 2,
          color: '#ff6b6b',
        }),
      );
    }
    return { camera: { center: new Vec2(0, 3), scale: 34 } };
  },
};

// ---- Fracture scenes -------------------------------------------------------

/** Remove every dynamic body, leaving the static set, for a clean rebuild. */
function clearDynamic(world: World): void {
  for (const b of [...world.bodies]) {
    if (b.type === BodyType.Dynamic) world.removeBody(b);
  }
}

const glassPane: SceneDef = {
  id: 'glass',
  name: 'Glass Pane',
  description:
    'A pane of glass held in a frame, drilled through the middle by a bullet on a loop. The Voronoi shatter spider-webs out from the impact — fine cracks at the hole, coarse shards at the rim — and the freed pieces rain down. Rebuilds and fires again.',
  category: 'Fracture',
  build: (world) => {
    ground(world, 14, -6);
    // A window frame: two posts and a lintel pin the pane upright.
    world.addBody(new Body(Polygon.box(0.35, 4.6), { type: BodyType.Static, position: new Vec2(-3.6, -1.4), color: '#5a6478' }));
    world.addBody(new Body(Polygon.box(0.35, 4.6), { type: BodyType.Static, position: new Vec2(3.6, -1.4), color: '#5a6478' }));
    world.addBody(new Body(Polygon.box(3.95, 0.35), { type: BodyType.Static, position: new Vec2(0, 3.45), color: '#5a6478' }));
    const buildPane = (): void => {
      world.addBody(new Body(Polygon.box(3.2, 4.2), {
        position: new Vec2(0, -1.4),
        density: 0.7,
        friction: 0.3,
        restitution: 0,
        color: '#9fd8ff',
        fracture: fractureMaterial({ toughness: 5, shards: 46, pattern: 'radial', jitter: 0.3, maxGeneration: 1 }),
      }));
    };
    buildPane();
    let phase = 0;
    let timer = 0;
    return {
      camera: { center: new Vec2(0, -0.6), scale: 42 },
      update: (_t, dt) => {
        timer += dt;
        if (phase === 0 && timer > 1.8) {
          world.addBody(new Body(new Circle(0.2), { position: new Vec2(-11, -1.2), density: 14, linearVelocity: new Vec2(40, 1.5), bullet: true, color: '#ff6b6b' }));
          phase = 1;
          timer = 0;
        } else if (phase === 1 && timer > 4.5) {
          clearDynamic(world);
          buildPane();
          phase = 0;
          timer = 0;
        }
      },
    };
  },
};

const shatterWall: SceneDef = {
  id: 'shatterwall',
  name: 'Cannon & Wall',
  description:
    'A masonry wall of brittle blocks takes a cannonball at speed. Every block hit hard enough shatters into Voronoi rubble that tumbles and piles; glancing blocks just topple. The cannon reloads and fires on a loop.',
  category: 'Fracture',
  build: (world) => {
    ground(world, 22, -6);
    const buildWall = (): void => {
      const cols = 2;
      const rows = 6;
      const bw = 0.7;
      const bh = 0.9;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = 6 + c * (bw * 2 + 0.02);
          const y = -6 + bh + r * (bh * 2 + 0.02);
          world.addBody(new Body(Polygon.box(bw, bh), {
            position: new Vec2(x, y),
            density: 1.3,
            friction: 0.55,
            color: (r + c) % 2 ? '#c0966b' : '#a87b58',
            fracture: fractureMaterial({ toughness: 6, shards: 9, pattern: 'uniform', jitter: 0.5, maxGeneration: 1 }),
          }));
        }
      }
    };
    buildWall();
    let phase = 0;
    let timer = 0;
    return {
      camera: { center: new Vec2(4, -2), scale: 26 },
      update: (_t, dt) => {
        timer += dt;
        if (phase === 0 && timer > 1.5) {
          world.addBody(new Body(new Circle(0.55), { position: new Vec2(-10, -3.4), density: 24, linearVelocity: new Vec2(34, 3), color: '#5a6478' }));
          phase = 1;
          timer = 0;
        } else if (phase === 1 && timer > 5) {
          clearDynamic(world);
          buildWall();
          phase = 0;
          timer = 0;
        }
      },
    };
  },
};

const shatterTower: SceneDef = {
  id: 'shattertower',
  name: 'Shatter Tower',
  description:
    "A tower of brittle slabs with a heavy ball dropped onto its crown. The top slab bursts into shards, and lower slabs crack as the rubble lands — a fracture cascade bounded by each slab's generation cap. Rebuilds on a timer.",
  category: 'Fracture',
  build: (world) => {
    ground(world, 16, -6);
    const buildTower = (): void => {
      const n = 6;
      const hw = 1.1;
      const hh = 0.42;
      for (let i = 0; i < n; i++) {
        world.addBody(new Body(Polygon.box(hw, hh), {
          position: new Vec2(0, -6 + hh + i * (hh * 2 + 0.01)),
          density: 1.1,
          friction: 0.6,
          color: i % 2 ? '#7CFFCB' : '#4dd2ff',
          fracture: fractureMaterial({ toughness: 9, shards: 12, pattern: 'radial', maxGeneration: 1 }),
        }));
      }
    };
    buildTower();
    let phase = 0;
    let timer = 0;
    return {
      camera: { center: new Vec2(0, -2.5), scale: 34 },
      update: (_t, dt) => {
        timer += dt;
        if (phase === 0 && timer > 1.2) {
          world.addBody(new Body(new Circle(0.6), { position: new Vec2(0.15, 6), density: 20, color: '#ff6b6b', bullet: true }));
          phase = 1;
          timer = 0;
        } else if (phase === 1 && timer > 5) {
          clearDynamic(world);
          buildTower();
          phase = 0;
          timer = 0;
        }
      },
    };
  },
};

const crystalGallery: SceneDef = {
  id: 'crystals',
  name: 'Crystal Gallery',
  description:
    'A row of brittle crystals — triangle, square, pentagon, hexagon, octagon — bombarded from above one after another. Watch the same Voronoi fracture carve every convex parent shape, focused on each impact point. Reloads on a loop.',
  category: 'Fracture',
  build: (world) => {
    ground(world, 18, -6);
    const sidesList = [3, 4, 5, 6, 8];
    const buildRow = (): void => {
      sidesList.forEach((s, i) => {
        const x = (i - (sidesList.length - 1) / 2) * 3;
        world.addBody(new Body(Polygon.regular(s, 1.0, Math.PI / 2), {
          position: new Vec2(x, -4.4),
          density: 1,
          friction: 0.5,
          color: colorFor(i),
          fracture: fractureMaterial({ toughness: 6, shards: 14, pattern: 'radial', maxGeneration: 1 }),
        }));
      });
    };
    buildRow();
    let phase = 0;
    let timer = 0;
    let idx = 0;
    return {
      camera: { center: new Vec2(0, -3), scale: 30 },
      update: (_t, dt) => {
        timer += dt;
        if (phase === 0 && timer > 0.9) {
          const x = (idx - (sidesList.length - 1) / 2) * 3;
          world.addBody(new Body(new Circle(0.25), { position: new Vec2(x, 5), density: 14, linearVelocity: new Vec2(0, -26), bullet: true, color: '#ff6b6b' }));
          idx++;
          timer = 0;
          if (idx >= sidesList.length) {
            phase = 1;
            idx = 0;
          }
        } else if (phase === 1 && timer > 3.5) {
          clearDynamic(world);
          buildRow();
          phase = 0;
          timer = 0;
        }
      },
    };
  },
};

const shatterYard: SceneDef = {
  id: 'shatteryard',
  name: 'Shatter Yard',
  description:
    'A sandbox for the Shatter tool. Pick the Shatter spawn tool (bottom toolbar), then click any brittle slab or crystal to splinter it into Voronoi shards — pieces can re-shatter once more. Click empty space to drop fresh brittle slabs, or lob heavy shapes at them.',
  category: 'Fracture',
  build: (world) => {
    ground(world, 18, -6);
    walls(world, 12, 9, -6);
    const mat = () => fractureMaterial({ toughness: 7, shards: 16, pattern: 'radial', maxGeneration: 2 });
    world.addBody(new Body(Polygon.box(1.6, 1.0), { position: new Vec2(-4, -4.5), density: 1, friction: 0.5, color: '#9fd8ff', fracture: mat() }));
    world.addBody(new Body(Polygon.box(1.2, 1.2), { position: new Vec2(0, -4.5), density: 1, friction: 0.5, color: '#c792ea', fracture: mat() }));
    world.addBody(new Body(Polygon.regular(6, 1.1, Math.PI / 2), { position: new Vec2(4, -4.2), density: 1, friction: 0.5, color: '#7CFFCB', fracture: mat() }));
    return { camera: { center: new Vec2(0, -3), scale: 30 } };
  },
};

export const SCENES: SceneDef[] = [
  pyramid,
  stacks,
  roundedStack,
  arch,
  newtonsCradle,
  ropeBridge,
  ragdoll,
  springs,
  machine,
  pulley,
  gearTrain,
  motorPlatform,
  conveyor,
  demolition,
  breakableBridge,
  limits,
  jellyPit,
  clothHammock,
  jelloCubes,
  trampoline,
  waterBalloons,
  ropeSwings,
  glassPane,
  shatterWall,
  shatterTower,
  crystalGallery,
  shatterYard,
  car,
  tumbler,
  dominoes,
  buoyancy,
  sensors,
  bulletTest,
  galton,
  capsulePile,
  frictionRamps,
  restitution,
  stress,
  sandbox,
];

export function sceneById(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? SCENES[0];
}

/** Re-exported so the interaction layer can build mouse joints. */
export { MouseJoint };
