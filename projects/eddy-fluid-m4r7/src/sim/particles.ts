// particles.ts — a passive tracer ensemble advected by the fluid velocity.
//
// These carry no mass and exert no force; they're pure flow visualisation. Each
// frame every tracer is moved along the (bilinearly sampled) velocity field —
// the same back-trace the solver uses — and recycled when it ages out, leaves
// the tank, or wanders into a wall. Drawn as short velocity-aligned streaks,
// they turn a still frame into a legible picture of motion (streaklines).

import { FluidSolver } from './fluid';

export class ParticleSystem {
  readonly capacity: number;
  x: Float32Array;
  y: Float32Array;
  private life: Float32Array;
  private N: number;
  private vel = { u: 0, v: 0 };

  constructor(capacity: number, N: number) {
    this.capacity = capacity;
    this.N = N;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
  }

  /** Scatter every tracer uniformly across the (fluid) interior. */
  seed(sim: FluidSolver): void {
    for (let k = 0; k < this.capacity; k++) this.spawn(sim, k);
  }

  private spawn(sim: FluidSolver, k: number): void {
    const N = this.N;
    for (let tries = 0; tries < 8; tries++) {
      const gx = 1 + Math.random() * (N - 1);
      const gy = 1 + Math.random() * (N - 1);
      if (!sim.isSolidAt(gx, gy)) {
        this.x[k] = gx;
        this.y[k] = gy;
        this.life[k] = 1.2 + Math.random() * 2.6;
        return;
      }
    }
    // Couldn't find open space quickly; place it anyway with a short life.
    this.x[k] = 1 + Math.random() * (N - 1);
    this.y[k] = 1 + Math.random() * (N - 1);
    this.life[k] = 0.4;
  }

  /** Advance every tracer one step and recycle the ones that have died. */
  update(sim: FluidSolver, dt: number): void {
    const N = this.N;
    const step = N * dt; // normalised velocity ~1 ⇒ one domain width / second
    for (let k = 0; k < this.capacity; k++) {
      sim.sampleVelocity(this.x[k], this.y[k], this.vel);
      const nx = this.x[k] + this.vel.u * step;
      const ny = this.y[k] + this.vel.v * step;
      this.life[k] -= dt;
      if (this.life[k] <= 0 || nx < 1 || nx > N || ny < 1 || ny > N || sim.isSolidAt(nx, ny)) {
        this.spawn(sim, k);
      } else {
        this.x[k] = nx;
        this.y[k] = ny;
      }
    }
  }
}
