export interface Vector2D {
  x: number;
  y: number;
}

export interface Particle {
  id: string;
  position: Vector2D;
  velocity: Vector2D;
  acceleration: Vector2D;
  mass: number;
  radius: number;
  color: string;
}

export interface EngineState {
  particles: Particle[];
  width: number;
  height: number;
  gravity: Vector2D;
  friction: number;
}

export class Engine {
  public state: EngineState;

  constructor(width: number, height: number) {
    this.state = {
      particles: [],
      width,
      height,
      gravity: { x: 0, y: 0.1 },
      friction: 0.99,
    };
  }

  addParticle(p: Omit<Particle, 'id'>) {
    this.state.particles.push({ ...p, id: Math.random().toString(36).substring(2, 9) });
  }

  update(deltaTime: number) {
    // Basic update loop
    for (const p of this.state.particles) {
      // Apply gravity (scaled by mass for visual effect, though technically Galilean gravity is constant accel)
      p.acceleration.x += this.state.gravity.x;
      p.acceleration.y += this.state.gravity.y;

      // Update velocity
      p.velocity.x += p.acceleration.x * deltaTime;
      p.velocity.y += p.acceleration.y * deltaTime;

      // Apply friction
      p.velocity.x *= this.state.friction;
      p.velocity.y *= this.state.friction;

      // Update position
      p.position.x += p.velocity.x * deltaTime;
      p.position.y += p.velocity.y * deltaTime;

      // Reset acceleration for next frame
      p.acceleration.x = 0;
      p.acceleration.y = 0;

      // Boundary Checks with dampening (restitution)
      const restitution = 0.8;

      if (p.position.x - p.radius < 0) {
        p.position.x = p.radius;
        p.velocity.x *= -restitution;
      }
      if (p.position.x + p.radius > this.state.width) {
        p.position.x = this.state.width - p.radius;
        p.velocity.x *= -restitution;
      }
      if (p.position.y - p.radius < 0) {
        p.position.y = p.radius;
        p.velocity.y *= -restitution;
      }
      if (p.position.y + p.radius > this.state.height) {
        p.position.y = this.state.height - p.radius;
        p.velocity.y *= -restitution;
      }

      // Enforce a maximum velocity to prevent simulation explosion
      const maxVel = 50;
      const speedSq = p.velocity.x * p.velocity.x + p.velocity.y * p.velocity.y;
      if (speedSq > maxVel * maxVel) {
         const speed = Math.sqrt(speedSq);
         p.velocity.x = (p.velocity.x / speed) * maxVel;
         p.velocity.y = (p.velocity.y / speed) * maxVel;
      }
    }
  }
}
