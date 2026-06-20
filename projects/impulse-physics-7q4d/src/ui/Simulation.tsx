import { useEffect, useRef } from 'react';
import {
  Body,
  BodyType,
  DEFAULT_CONFIG,
  MouseJoint,
  Particle,
  Rng,
  Vec2,
  World,
  type StepStats,
} from '../engine';
import { Camera } from '../render/camera';
import { Renderer, type DebugOptions, type RenderExtras } from '../render/renderer';
import { sceneById } from '../scenes';
import { spawnBody, type SpawnKind } from './spawn';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const DRAG_THRESHOLD = 4; // px before an empty-space press becomes a pan

export interface SimControls {
  running: boolean;
  gravityY: number;
  velocityIterations: number;
  positionIterations: number;
  baumgarte: number;
  warmStarting: boolean;
  enableSleep: boolean;
  continuous: boolean;
  blockSolver: boolean;
  debug: DebugOptions;
  spawnKind: SpawnKind;
  showGjk: boolean;
}

export interface SimulationProps {
  sceneId: string;
  controls: SimControls;
  /** Bumping these numbers triggers a reset / single-step. */
  resetSignal: number;
  stepSignal: number;
  onStats: (stats: StepStats) => void;
}

interface Interaction {
  mode: 'none' | 'drag' | 'softgrab' | 'maybe' | 'pan';
  startX: number;
  startY: number;
}

/** A grabbed soft-body particle: pinned to the pointer until released. */
interface SoftGrab {
  particle: Particle;
  savedInvMass: number;
  prev: Vec2;
  flingVel: Vec2;
}

const GRAB_RADIUS = 0.5; // world units — how close a click must land to grab

/** Nearest soft-body particle to `wp` within `GRAB_RADIUS`, or null. */
function findSoftParticle(world: World, wp: Vec2): Particle | null {
  let best: Particle | null = null;
  let bestD = GRAB_RADIUS;
  for (const sb of world.softBodies) {
    for (const p of sb.particles) {
      if (p.invMass === 0) continue;
      const d = p.pos.distanceTo(wp);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

export default function Simulation(props: SimulationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Mutable engine state kept out of React's render cycle.
  const worldRef = useRef<World>(new World());
  const cameraRef = useRef<Camera>(new Camera());
  const rendererRef = useRef<Renderer | null>(null);
  const sceneTimeRef = useRef(0);
  const sceneUpdateRef = useRef<((time: number, dt: number) => void) | undefined>(undefined);
  const rngRef = useRef<Rng>(new Rng(0xc0ffee));
  const mouseJointRef = useRef<MouseJoint | null>(null);
  const softGrabRef = useRef<SoftGrab | null>(null);
  const hoveredRef = useRef<Body | null>(null);
  const interactionRef = useRef<Interaction>({ mode: 'none', startX: 0, startY: 0 });
  const pointerWorldRef = useRef<Vec2>(Vec2.ZERO);

  // Latest props mirrored into a ref so the imperative loop sees fresh values.
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  // Build (or rebuild) the scene whenever the id or reset signal changes.
  useEffect(() => {
    const controls = propsRef.current.controls;
    const world = new World(new Vec2(0, controls.gravityY));
    worldRef.current = world;
    applyConfig(world, controls);
    sceneTimeRef.current = 0;
    const result = sceneById(propsRef.current.sceneId).build(world, new Rng(0x1234abc));
    sceneUpdateRef.current = result.update;
    if (result.camera) {
      cameraRef.current.center = result.camera.center;
      cameraRef.current.scale = result.camera.scale;
    }
    mouseJointRef.current = null;
    softGrabRef.current = null;
    hoveredRef.current = null;
  }, [props.sceneId, props.resetSignal]);

  // Apply solver/gravity controls to the live world without rebuilding.
  useEffect(() => {
    applyConfig(worldRef.current, props.controls);
    worldRef.current.gravity = new Vec2(0, props.controls.gravityY);
  }, [props.controls]);

  // Single-step when paused.
  useEffect(() => {
    if (props.stepSignal === 0) return;
    advance(worldRef.current, FIXED_DT, sceneTimeRef, sceneUpdateRef.current);
  }, [props.stepSignal]);

  // Main loop + canvas sizing, set up once.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    rendererRef.current = new Renderer(ctx);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let dpr = 1;

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      cameraRef.current.resize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const frame = (nowMs: number): void => {
      const world = worldRef.current;
      const { controls, onStats } = propsRef.current;
      const dt = Math.min((nowMs - last) / 1000, 0.25);
      last = nowMs;

      if (controls.running) {
        acc += dt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
          advance(world, FIXED_DT, sceneTimeRef, sceneUpdateRef.current);
          acc -= FIXED_DT;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME) acc = 0; // avoid the spiral of death
      }
      // Keep a dragged body's target current even while paused.
      if (mouseJointRef.current) mouseJointRef.current.target = pointerWorldRef.current;
      // Keep a grabbed soft particle pinned to the pointer (a movable anchor).
      if (softGrabRef.current) {
        const g = softGrabRef.current;
        g.particle.pos = pointerWorldRef.current;
        g.particle.prev = pointerWorldRef.current;
        g.particle.vel = Vec2.ZERO;
      }

      const extras = computeExtras(world, controls, hoveredRef.current, mouseJointRef.current);
      ctx.save();
      ctx.scale(dpr, dpr);
      rendererRef.current?.draw(world, cameraRef.current, controls.debug, extras);
      ctx.restore();

      onStats(world.stats);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ---- Pointer interaction -------------------------------------------------

  function toWorld(e: React.PointerEvent): Vec2 {
    const rect = canvasRef.current!.getBoundingClientRect();
    return cameraRef.current.screenToWorld(new Vec2(e.clientX - rect.left, e.clientY - rect.top));
  }

  function onPointerDown(e: React.PointerEvent): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    const world = worldRef.current;
    const wp = toWorld(e);
    pointerWorldRef.current = wp;
    const body = world.queryPoint(wp);
    if (body && body.type === BodyType.Dynamic) {
      const mj = new MouseJoint(body, wp, body.mass * 1000 + 500);
      world.addJoint(mj, true);
      mouseJointRef.current = mj;
      body.wake();
      interactionRef.current = { mode: 'drag', startX: e.clientX, startY: e.clientY };
      return;
    }
    const particle = findSoftParticle(world, wp);
    if (particle) {
      softGrabRef.current = { particle, savedInvMass: particle.invMass, prev: wp, flingVel: Vec2.ZERO };
      particle.invMass = 0;
      particle.pos = wp;
      particle.prev = wp;
      particle.vel = Vec2.ZERO;
      interactionRef.current = { mode: 'softgrab', startX: e.clientX, startY: e.clientY };
      return;
    }
    interactionRef.current = { mode: 'maybe', startX: e.clientX, startY: e.clientY };
  }

  function onPointerMove(e: React.PointerEvent): void {
    const world = worldRef.current;
    const wp = toWorld(e);
    pointerWorldRef.current = wp;
    const it = interactionRef.current;

    if (it.mode === 'drag') {
      if (mouseJointRef.current) mouseJointRef.current.target = wp;
      return;
    }
    if (it.mode === 'softgrab') {
      const g = softGrabRef.current;
      if (g) {
        // Track a (clamped) fling velocity from the pointer's recent motion.
        g.flingVel = clampLen(wp.sub(g.prev).mul(1 / FIXED_DT), 18);
        g.prev = wp;
        g.particle.pos = wp;
        g.particle.prev = wp;
      }
      return;
    }
    if (it.mode === 'maybe' || it.mode === 'pan') {
      const dx = e.clientX - it.startX;
      const dy = e.clientY - it.startY;
      if (it.mode === 'maybe' && Math.hypot(dx, dy) > DRAG_THRESHOLD) it.mode = 'pan';
      if (it.mode === 'pan') cameraRef.current.panPixels(e.movementX, e.movementY);
      return;
    }
    hoveredRef.current = world.queryPoint(wp);
  }

  function onPointerUp(e: React.PointerEvent): void {
    const it = interactionRef.current;
    const world = worldRef.current;
    if (it.mode === 'drag' && mouseJointRef.current) {
      world.removeJoint(mouseJointRef.current);
      mouseJointRef.current = null;
    } else if (it.mode === 'softgrab' && softGrabRef.current) {
      const g = softGrabRef.current;
      g.particle.invMass = g.savedInvMass;
      g.particle.vel = g.flingVel; // release with the flick's momentum
      softGrabRef.current = null;
    } else if (it.mode === 'maybe') {
      spawnBody(world, propsRef.current.controls.spawnKind, toWorld(e), rngRef.current);
    }
    interactionRef.current = { mode: 'none', startX: 0, startY: 0 };
  }

  function onWheel(e: React.WheelEvent): void {
    const rect = canvasRef.current!.getBoundingClientRect();
    const anchor = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
    cameraRef.current.zoomAt(anchor, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  return (
    <div ref={containerRef} className="sim-viewport">
      <canvas
        ref={canvasRef}
        className="sim-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
    </div>
  );
}

/** Clamp a vector's magnitude to at most `max`. */
function clampLen(v: Vec2, max: number): Vec2 {
  const len = v.length();
  return len > max ? v.mul(max / len) : v;
}

function applyConfig(world: World, c: SimControls): void {
  world.config = {
    ...DEFAULT_CONFIG,
    velocityIterations: c.velocityIterations,
    positionIterations: c.positionIterations,
    baumgarte: c.baumgarte,
    warmStarting: c.warmStarting,
    continuous: c.continuous,
    blockSolver: c.blockSolver,
  };
  world.enableSleep = c.enableSleep;
}

function advance(
  world: World,
  dt: number,
  timeRef: { current: number },
  update?: (time: number, dt: number) => void,
): void {
  update?.(timeRef.current, dt);
  world.step(dt);
  timeRef.current += dt;
}

function computeExtras(
  world: World,
  controls: SimControls,
  hovered: Body | null,
  mouseJoint: MouseJoint | null,
): RenderExtras {
  const extras: RenderExtras = { hovered };
  if (mouseJoint) extras.mouseTarget = { from: mouseJoint.anchorB(), to: mouseJoint.target };
  if (controls.showGjk && hovered) {
    const near = nearestNeighbor(world, hovered);
    if (near) extras.gjk = { result: world.distanceBetween(hovered, near), a: hovered, b: near };
  }
  return extras;
}

function nearestNeighbor(world: World, body: Body): Body | null {
  let best: Body | null = null;
  let bestDist = Infinity;
  for (const other of world.bodies) {
    if (other === body) continue;
    const d = other.worldCenter.distanceTo(body.worldCenter);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}
