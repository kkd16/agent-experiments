import {
  Body,
  BodyType,
  BuoyancyZone,
  PulleyJoint,
  SoftBody,
  Vec2,
  World,
  type DistanceResult,
  type Joint,
} from '../engine';
import { Camera } from './camera';

/** Toggleable debug overlays. */
export interface DebugOptions {
  fill: boolean;
  outlines: boolean;
  aabb: boolean;
  contacts: boolean;
  centerOfMass: boolean;
  velocities: boolean;
  joints: boolean;
  broadphaseTree: boolean;
  sleeping: boolean;
}

export const DEFAULT_DEBUG: DebugOptions = {
  fill: true,
  outlines: true,
  aabb: false,
  contacts: false,
  centerOfMass: false,
  velocities: false,
  joints: true,
  broadphaseTree: false,
  sleeping: true,
};

/** Extra one-frame overlays passed in from interaction (drag, GJK inspector). */
export interface RenderExtras {
  mouseTarget?: { from: Vec2; to: Vec2 };
  gjk?: { result: DistanceResult; a: Body; b: Body };
  hovered?: Body | null;
  spawnGhost?: { center: Vec2; radius: number; sides: number };
}

const COLORS = {
  bg: '#0b0e14',
  grid: 'rgba(120,140,180,0.06)',
  gridAxis: 'rgba(120,140,180,0.16)',
  staticFill: 'rgba(70,80,98,0.55)',
  staticStroke: '#5a6478',
  sleepFill: 'rgba(90,100,120,0.5)',
  sleepStroke: '#6b7689',
  contact: '#ffd166',
  normal: '#ff6b6b',
  com: '#7CFFCB',
  velocity: '#4dd2ff',
  joint: '#c792ea',
  aabb: 'rgba(120,200,255,0.25)',
  tree: 'rgba(255,160,90,0.18)',
  treeLeaf: 'rgba(120,255,180,0.18)',
  gjk: '#ff79c6',
  hover: '#ffffff',
  waterFill: 'rgba(58,160,220,0.16)',
  waterTint: 'rgba(58,160,220,0.14)',
  waterLine: 'rgba(140,210,255,0.65)',
};

/** Draws a {@link World} and its debug overlays onto a 2D canvas. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  draw(world: World, camera: Camera, opts: DebugOptions, extras: RenderExtras = {}): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, camera.width, camera.height);
    this.drawGrid(camera);

    if (opts.broadphaseTree) this.drawTree(world, camera);

    // Water fill sits behind the bodies; a faint tint is layered back over their
    // submerged parts after they're drawn.
    for (const zone of world.fluidZones) this.drawWaterFill(zone, camera);

    for (const body of world.bodies) {
      if (body.isSensor) this.drawSensor(body, camera);
      else this.drawBody(body, camera, opts, extras.hovered === body);
      if (body.tangentSpeed !== 0) this.drawConveyor(body, camera);
      if (opts.aabb) this.drawAABB(body, camera);
      if (opts.velocities) this.drawVelocity(body, camera);
      if (opts.centerOfMass) this.drawCOM(body, camera);
    }

    for (const sb of world.softBodies) this.drawSoft(sb, camera, opts);

    for (const zone of world.fluidZones) this.drawWaterSurface(zone, camera);

    if (opts.joints) {
      for (const joint of world.joints) this.drawJointShape(joint, camera);
    }
    if (opts.contacts) this.drawContacts(world, camera);
    if (extras.mouseTarget) this.drawMouse(extras.mouseTarget, camera);
    if (extras.gjk) this.drawGjk(extras.gjk.result, camera);
    if (extras.spawnGhost) this.drawSpawnGhost(extras.spawnGhost, camera);
    if (world.flashes.length > 0) this.drawFlashes(world, camera);

    ctx.restore();
  }

  /**
   * Impact sparks left by recent shatters: a fading expanding ring plus a burst
   * of short radial shards, their count scaled by how many pieces flew off.
   */
  private drawFlashes(world: World, camera: Camera): void {
    const ctx = this.ctx;
    for (const f of world.flashes) {
      const t = Math.min(f.age / f.ttl, 1);
      const fade = 1 - t;
      if (fade <= 0) continue;
      const c = camera.worldToScreen(f.point);
      const ring = camera.toPixels(0.15 + t * 0.9);
      ctx.save();
      // Expanding shock ring.
      ctx.beginPath();
      ctx.arc(c.x, c.y, ring, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha('#ffe9a8', fade * 0.8);
      ctx.lineWidth = 2 * fade + 0.5;
      ctx.stroke();
      // Radial spark burst.
      const spikes = Math.min(18, 5 + Math.round(f.shards * 0.6));
      ctx.strokeStyle = withAlpha('#fff1c2', fade);
      ctx.lineWidth = 1.5;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2 + f.shards;
        const r0 = ring * 0.5;
        const r1 = ring * (0.9 + ((i * 37) % 10) / 25);
        ctx.beginPath();
        ctx.moveTo(c.x + Math.cos(a) * r0, c.y + Math.sin(a) * r0);
        ctx.lineTo(c.x + Math.cos(a) * r1, c.y + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawGrid(camera: Camera): void {
    const ctx = this.ctx;
    const tl = camera.screenToWorld(new Vec2(0, 0));
    const br = camera.screenToWorld(new Vec2(camera.width, camera.height));
    const step = gridStep(camera.scale);
    ctx.lineWidth = 1;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = camera.worldToScreen(new Vec2(x, 0)).x;
      ctx.strokeStyle = Math.abs(x) < 1e-6 ? COLORS.gridAxis : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, camera.height);
      ctx.stroke();
    }
    for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) {
      const sy = camera.worldToScreen(new Vec2(0, y)).y;
      ctx.strokeStyle = Math.abs(y) < 1e-6 ? COLORS.gridAxis : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(camera.width, sy);
      ctx.stroke();
    }
  }

  private drawBody(body: Body, camera: Camera, opts: DebugOptions, hovered: boolean): void {
    const ctx = this.ctx;
    let fill = body.color;
    let stroke = shade(body.color, 0.6);
    if (body.type === BodyType.Static) {
      fill = COLORS.staticFill;
      stroke = COLORS.staticStroke;
    } else if (!body.awake && opts.sleeping) {
      fill = COLORS.sleepFill;
      stroke = COLORS.sleepStroke;
    }

    const strokeStyle = hovered ? COLORS.hover : stroke;
    const strokeWidth = hovered ? 2.5 : 1.5;

    ctx.beginPath();
    if (body.shape.kind === 'circle') {
      const c = camera.worldToScreen(body.worldPoint(body.shape.center));
      const r = camera.toPixels(body.shape.radius);
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      // Orientation spoke.
      const edge = camera.worldToScreen(body.worldPoint(body.shape.center.add(new Vec2(body.shape.radius, 0))));
      if (opts.fill) {
        ctx.fillStyle = withAlpha(fill, 0.85);
        ctx.fill();
      }
      if (opts.outlines) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(edge.x, edge.y);
      ctx.strokeStyle = withAlpha(stroke, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    if (body.shape.kind === 'capsule') {
      const a = camera.worldToScreen(body.worldPoint(body.shape.p1));
      const b = camera.worldToScreen(body.worldPoint(body.shape.p2));
      const r = camera.toPixels(body.shape.radius);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      // Stadium outline: a half-circle cap at each endpoint joined by the sides.
      ctx.arc(b.x, b.y, r, ang - Math.PI / 2, ang + Math.PI / 2);
      ctx.arc(a.x, a.y, r, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
      ctx.closePath();
      if (opts.fill) {
        ctx.fillStyle = withAlpha(fill, 0.85);
        ctx.fill();
      }
      if (opts.outlines) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      }
      // Orientation spoke from the capsule centre toward p2.
      const c = camera.worldToScreen(body.worldPoint(body.shape.center()));
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = withAlpha(stroke, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    const verts = body.shape.vertices;
    for (let i = 0; i < verts.length; i++) {
      const s = camera.worldToScreen(body.worldPoint(verts[i]));
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    const skin = camera.toPixels(body.shape.radius);
    if (opts.fill) {
      ctx.fillStyle = withAlpha(fill, 0.85);
      // Rounded polygons: a round-joined stroke fattens the core out by its skin.
      if (skin > 0.5) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = skin * 2;
        ctx.strokeStyle = withAlpha(fill, 0.85);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fill();
    }
    if (opts.outlines) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  /** Dispatch a soft body to the right look: blob, rope or filled mesh. */
  private drawSoft(sb: SoftBody, camera: Camera, opts: DebugOptions): void {
    if (sb.render.kind === 'blob' && sb.render.loop) this.drawBlob(sb, camera, opts);
    else if (sb.render.kind === 'rope') this.drawRope(sb, camera);
    else this.drawMesh(sb, camera, opts);
    if (opts.centerOfMass) {
      const c = camera.worldToScreen(sb.centroid());
      this.ctx.fillStyle = COLORS.com;
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  /** A pressurised blob: a smooth filled outline through the ring particles. */
  private drawBlob(sb: SoftBody, camera: Camera, opts: DebugOptions): void {
    const ctx = this.ctx;
    const loop = sb.render.loop!;
    const pts = loop.map((i) => camera.worldToScreen(sb.particles[i].pos));
    if (pts.length < 3) return;
    smoothClosedPath(ctx, pts);
    if (opts.fill) {
      ctx.fillStyle = withAlpha(sb.render.color, 0.85);
      ctx.fill();
      // A soft top highlight sells the "jelly" look.
      let top = pts[0];
      for (const p of pts) if (p.y < top.y) top = p;
      const grad = ctx.createRadialGradient(top.x, top.y + 4, 1, top.x, top.y + 6, 60);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fill();
    }
    if (opts.outlines) {
      ctx.strokeStyle = shade(sb.render.color, 0.7);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  /** A rope: a thick round-capped stroke through the chain of particles. */
  private drawRope(sb: SoftBody, camera: Camera): void {
    const ctx = this.ctx;
    const pts = sb.particles.map((p) => camera.worldToScreen(p.pos));
    if (pts.length < 2) return;
    const w = Math.max(3, camera.toPixels(sb.particles[0].radius * 2.2));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = shade(sb.render.color, 0.7);
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.strokeStyle = withAlpha(sb.render.color, 0.95);
    ctx.lineWidth = Math.max(1.5, w - 3);
    ctx.stroke();
    // Pinned ends get a small anchor dot.
    for (const p of sb.particles) {
      if (!p.pinned) continue;
      const s = camera.worldToScreen(p.pos);
      ctx.fillStyle = COLORS.staticStroke;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  /** A cloth or soft solid: filled triangles plus the structural lattice. */
  private drawMesh(sb: SoftBody, camera: Camera, opts: DebugOptions): void {
    const ctx = this.ctx;
    const screen = sb.particles.map((p) => camera.worldToScreen(p.pos));
    const tris = sb.render.tris;
    if (opts.fill && tris) {
      ctx.fillStyle = withAlpha(sb.render.color, sb.render.kind === 'cloth' ? 0.5 : 0.8);
      ctx.beginPath();
      for (const [a, b, c] of tris) {
        ctx.moveTo(screen[a].x, screen[a].y);
        ctx.lineTo(screen[b].x, screen[b].y);
        ctx.lineTo(screen[c].x, screen[c].y);
        ctx.closePath();
      }
      ctx.fill();
    }
    if (opts.outlines) {
      ctx.strokeStyle = withAlpha(shade(sb.render.color, 0.7), sb.render.kind === 'cloth' ? 0.55 : 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of sb.render.links) {
        ctx.moveTo(screen[a].x, screen[a].y);
        ctx.lineTo(screen[b].x, screen[b].y);
      }
      ctx.stroke();
    }
    // Pinned particles as small anchors.
    for (const p of sb.particles) {
      if (!p.pinned) continue;
      const s = camera.worldToScreen(p.pos);
      ctx.fillStyle = COLORS.staticStroke;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A sensor (trigger) body: a dashed, barely-filled outline — it's intangible. */
  private drawSensor(body: Body, camera: Camera): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    if (body.shape.kind === 'circle') {
      const c = camera.worldToScreen(body.worldPoint(body.shape.center));
      ctx.arc(c.x, c.y, camera.toPixels(body.shape.radius), 0, Math.PI * 2);
    } else if (body.shape.kind === 'capsule') {
      const a = camera.worldToScreen(body.worldPoint(body.shape.p1));
      const b = camera.worldToScreen(body.worldPoint(body.shape.p2));
      const r = camera.toPixels(body.shape.radius);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.arc(b.x, b.y, r, ang - Math.PI / 2, ang + Math.PI / 2);
      ctx.arc(a.x, a.y, r, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
      ctx.closePath();
    } else {
      const verts = body.shape.vertices;
      for (let i = 0; i < verts.length; i++) {
        const s = camera.worldToScreen(body.worldPoint(verts[i]));
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = withAlpha(body.color, 0.08);
    ctx.fill();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = withAlpha(body.color, 0.85);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private drawAABB(body: Body, camera: Camera): void {
    const ctx = this.ctx;
    const aabb = body.worldAABB();
    const lo = camera.worldToScreen(new Vec2(aabb.lower.x, aabb.upper.y));
    const hi = camera.worldToScreen(new Vec2(aabb.upper.x, aabb.lower.y));
    ctx.strokeStyle = COLORS.aabb;
    ctx.lineWidth = 1;
    ctx.strokeRect(lo.x, lo.y, hi.x - lo.x, hi.y - lo.y);
  }

  private drawTree(world: World, camera: Camera): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    world.eachTreeNode((aabb, leaf) => {
      if (leaf) return; // internal nodes only, to show the hierarchy
      const lo = camera.worldToScreen(new Vec2(aabb.lower.x, aabb.upper.y));
      const hi = camera.worldToScreen(new Vec2(aabb.upper.x, aabb.lower.y));
      ctx.strokeStyle = COLORS.tree;
      ctx.strokeRect(lo.x, lo.y, hi.x - lo.x, hi.y - lo.y);
    });
  }

  /** Horizontal span and a wavy surface polyline for a water zone (screen space). */
  private waterGeometry(zone: BuoyancyZone, camera: Camera): {
    left: number;
    right: number;
    surface: Vec2[];
  } {
    const viewL = camera.screenToWorld(new Vec2(0, 0)).x;
    const viewR = camera.screenToWorld(new Vec2(camera.width, 0)).x;
    const left = Math.max(zone.minX, viewL - 1);
    const right = Math.min(zone.maxX, viewR + 1);
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const amp = 0.06;
    const surface: Vec2[] = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const x = left + ((right - left) * i) / steps;
      const y = zone.surface + amp * Math.sin(x * 1.6 + t * 1.5) + amp * 0.5 * Math.sin(x * 3.1 - t * 2.2);
      surface.push(camera.worldToScreen(new Vec2(x, y)));
    }
    return { left, right, surface };
  }

  private drawWaterFill(zone: BuoyancyZone, camera: Camera): void {
    const ctx = this.ctx;
    const { surface } = this.waterGeometry(zone, camera);
    if (surface.length < 2) return;
    const bottomY = camera.worldToScreen(new Vec2(0, zone.surface - zone.depth)).y;
    const floor = Math.min(bottomY, camera.height);
    ctx.beginPath();
    ctx.moveTo(surface[0].x, surface[0].y);
    for (const p of surface) ctx.lineTo(p.x, p.y);
    ctx.lineTo(surface[surface.length - 1].x, floor);
    ctx.lineTo(surface[0].x, floor);
    ctx.closePath();
    ctx.fillStyle = COLORS.waterFill;
    ctx.fill();
  }

  private drawWaterSurface(zone: BuoyancyZone, camera: Camera): void {
    const ctx = this.ctx;
    const { surface } = this.waterGeometry(zone, camera);
    if (surface.length < 2) return;
    // A faint tint over the submerged bodies, then the bright crest line.
    const bottomY = camera.worldToScreen(new Vec2(0, zone.surface - zone.depth)).y;
    const floor = Math.min(bottomY, camera.height);
    ctx.beginPath();
    ctx.moveTo(surface[0].x, surface[0].y);
    for (const p of surface) ctx.lineTo(p.x, p.y);
    ctx.lineTo(surface[surface.length - 1].x, floor);
    ctx.lineTo(surface[0].x, floor);
    ctx.closePath();
    ctx.fillStyle = COLORS.waterTint;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(surface[0].x, surface[0].y);
    for (const p of surface) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = COLORS.waterLine;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawContacts(world: World, camera: Camera): void {
    const ctx = this.ctx;
    for (const { point, normal } of world.contactPoints()) {
      const s = camera.worldToScreen(point);
      ctx.fillStyle = COLORS.contact;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
      const tip = camera.worldToScreen(point.add(normal.mul(0.4)));
      ctx.strokeStyle = COLORS.normal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }
  }

  private drawVelocity(body: Body, camera: Camera): void {
    if (body.type !== BodyType.Dynamic) return;
    const ctx = this.ctx;
    const from = camera.worldToScreen(body.worldCenter);
    const to = camera.worldToScreen(body.worldCenter.add(body.linearVelocity.mul(0.15)));
    ctx.strokeStyle = COLORS.velocity;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  private drawCOM(body: Body, camera: Camera): void {
    const ctx = this.ctx;
    const s = camera.worldToScreen(body.worldCenter);
    ctx.fillStyle = COLORS.com;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Dispatch joint rendering: a pulley draws its rope over both wheels. */
  private drawJointShape(joint: Joint, camera: Camera): void {
    if (joint instanceof PulleyJoint) {
      this.drawPulley(joint, camera);
      return;
    }
    this.drawJoint(joint.anchorA(), joint.anchorB(), camera);
  }

  /** A pulley: the rope from each ground wheel down to its body, joined across the top. */
  private drawPulley(joint: PulleyJoint, camera: Camera): void {
    const ctx = this.ctx;
    const ga = camera.worldToScreen(joint.groundAnchorA);
    const gb = camera.worldToScreen(joint.groundAnchorB);
    const aa = camera.worldToScreen(joint.anchorA());
    const ab = camera.worldToScreen(joint.anchorB());
    ctx.strokeStyle = COLORS.joint;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(aa.x, aa.y);
    ctx.lineTo(ga.x, ga.y);
    ctx.lineTo(gb.x, gb.y);
    ctx.lineTo(ab.x, ab.y);
    ctx.stroke();
    // The two pulley wheels.
    for (const p of [ga, gb]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.joint;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    for (const p of [aa, ab]) {
      ctx.fillStyle = COLORS.joint;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Chevron flow arrows along a conveyor body, pointing in its surface direction. */
  private drawConveyor(body: Body, camera: Camera): void {
    if (body.shape.kind !== 'polygon') return;
    const ctx = this.ctx;
    const verts = body.shape.vertices;
    let minX = Infinity;
    let maxX = -Infinity;
    let topY = -Infinity;
    for (const v of verts) {
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      topY = Math.max(topY, v.y);
    }
    const dir = Math.sign(body.tangentSpeed);
    const y = topY - 0.05;
    const sz = 0.13;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let x = minX + 0.3; x <= maxX - 0.3; x += 0.5) {
      const tip = camera.worldToScreen(body.worldPoint(new Vec2(x + dir * sz, y)));
      const top = camera.worldToScreen(body.worldPoint(new Vec2(x - dir * sz, y + sz)));
      const bot = camera.worldToScreen(body.worldPoint(new Vec2(x - dir * sz, y - sz)));
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  private drawJoint(a: Vec2, b: Vec2, camera: Camera): void {
    const ctx = this.ctx;
    const sa = camera.worldToScreen(a);
    const sb = camera.worldToScreen(b);
    ctx.strokeStyle = COLORS.joint;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    for (const p of [sa, sb]) {
      ctx.fillStyle = COLORS.joint;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawMouse(target: { from: Vec2; to: Vec2 }, camera: Camera): void {
    const ctx = this.ctx;
    const a = camera.worldToScreen(target.from);
    const b = camera.worldToScreen(target.to);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawGjk(result: DistanceResult, camera: Camera): void {
    const ctx = this.ctx;
    const a = camera.worldToScreen(result.pointA);
    const b = camera.worldToScreen(result.pointB);
    ctx.strokeStyle = COLORS.gjk;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) {
      ctx.fillStyle = COLORS.gjk;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const mid = camera.worldToScreen(result.pointA.add(result.pointB).mul(0.5));
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(`${result.distance.toFixed(2)} m`, mid.x + 6, mid.y - 6);
  }

  private drawSpawnGhost(
    ghost: { center: Vec2; radius: number; sides: number },
    camera: Camera,
  ): void {
    const ctx = this.ctx;
    const c = camera.worldToScreen(ghost.center);
    const r = camera.toPixels(ghost.radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ghost.sides === 0) {
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    } else {
      for (let i = 0; i <= ghost.sides; i++) {
        const a = (i / ghost.sides) * Math.PI * 2;
        const px = c.x + Math.cos(a) * r;
        const py = c.y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Trace a smooth closed curve through `pts` (quadratics via edge midpoints). */
function smoothClosedPath(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  const n = pts.length;
  ctx.beginPath();
  const start = pts[n - 1].add(pts[0]).mul(0.5);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const mid = cur.add(pts[(i + 1) % n]).mul(0.5);
    ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
  }
  ctx.closePath();
}

function gridStep(scale: number): number {
  // Aim for grid lines roughly 60–120 px apart.
  const target = 80 / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= target) return pow * m;
  }
  return pow * 10;
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function shade(color: string, factor: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgb(${Math.round(rgb[0] * factor)},${Math.round(rgb[1] * factor)},${Math.round(rgb[2] * factor)})`;
}

function parseColor(color: string): [number, number, number] | null {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0], parts[1], parts[2]];
  }
  return null;
}
