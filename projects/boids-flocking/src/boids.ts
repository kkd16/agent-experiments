export class Vector {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  add(v: Vector): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  sub(v: Vector): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  mult(n: number): this {
    this.x *= n;
    this.y *= n;
    return this;
  }

  div(n: number): this {
    if (n !== 0) {
      this.x /= n;
      this.y /= n;
    }
    return this;
  }

  mag(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  normalize(): this {
    const m = this.mag();
    if (m !== 0) {
      this.div(m);
    }
    return this;
  }

  limit(max: number): this {
    const m = this.mag();
    if (m > max) {
      this.normalize();
      this.mult(max);
    }
    return this;
  }

  heading(): number {
    return Math.atan2(this.y, this.x);
  }

  static sub(v1: Vector, v2: Vector): Vector {
    return new Vector(v1.x - v2.x, v1.y - v2.y);
  }

  static dist(v1: Vector, v2: Vector): number {
    const dx = v1.x - v2.x;
    const dy = v1.y - v2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export interface BoidParams {
  separation: number;
  alignment: number;
  cohesion: number;
  visualRange: number;
  maxSpeed: number;
  maxForce: number;
  mouseInteraction: 'none' | 'attract' | 'repel';
  mouseRadius: number;
}

export class Boid {
  position: Vector;
  velocity: Vector;
  acceleration: Vector;
  width: number;
  height: number;
  color: string;
  size: number;

  constructor(x: number, y: number, width: number, height: number) {
    this.position = new Vector(x, y);
    this.velocity = new Vector((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    this.acceleration = new Vector(0, 0);
    this.width = width;
    this.height = height;
    this.size = 3 + Math.random() * 2;

    // Nice gradient of colors based on initial velocity
    const hue = Math.floor(Math.random() * 360);
    this.color = `hsl(${hue}, 80%, 60%)`;
  }

  update(params: BoidParams) {
    this.velocity.add(this.acceleration);
    this.velocity.limit(params.maxSpeed);
    this.position.add(this.velocity);
    this.acceleration.mult(0); // Reset acceleration each frame
    this.edges();
  }

  applyForce(force: Vector) {
    this.acceleration.add(force);
  }

  flock(boids: Boid[], params: BoidParams, mousePos: { x: number; y: number } | null = null) {
    const sep = this.separate(boids, params.visualRange / 2); // Separation distance is usually smaller
    const ali = this.align(boids, params.visualRange);
    const coh = this.cohere(boids, params.visualRange);

    sep.mult(params.separation);
    ali.mult(params.alignment);
    coh.mult(params.cohesion);

    this.applyForce(sep);
    this.applyForce(ali);
    this.applyForce(coh);

    if (mousePos && params.mouseInteraction !== 'none') {
      const mouseVec = new Vector(mousePos.x, mousePos.y);
      const d = Vector.dist(this.position, mouseVec);
      if (d < params.mouseRadius) {
        let mouseForce: Vector;
        if (params.mouseInteraction === 'attract') {
          mouseForce = this.seek(mouseVec, params.maxSpeed, params.maxForce);
        } else {
          mouseForce = this.flee(mouseVec, params.maxSpeed, params.maxForce);
        }

        // Weight the mouse force based on distance (stronger when closer)
        const weight = 1 - (d / params.mouseRadius);
        mouseForce.mult(weight * 2); // Multiplier for interaction strength
        this.applyForce(mouseForce);
      }
    }
  }

  // Separation
  separate(boids: Boid[], desiredSeparation: number): Vector {
    const steer = new Vector(0, 0);
    let count = 0;

    for (const other of boids) {
      const d = Vector.dist(this.position, other.position);
      if (d > 0 && d < desiredSeparation) {
        const diff = Vector.sub(this.position, other.position);
        diff.normalize();
        diff.div(d); // Weight by distance
        steer.add(diff);
        count++;
      }
    }

    if (count > 0) {
      steer.div(count);
    }

    if (steer.mag() > 0) {
      steer.normalize();
      steer.mult(5); // Arbitrary max speed for steering
      steer.sub(this.velocity);
      steer.limit(0.05); // Max force
    }

    return steer;
  }

  // Alignment
  align(boids: Boid[], neighborDist: number): Vector {
    const sum = new Vector(0, 0);
    let count = 0;

    for (const other of boids) {
      const d = Vector.dist(this.position, other.position);
      if (d > 0 && d < neighborDist) {
        sum.add(other.velocity);
        count++;
      }
    }

    if (count > 0) {
      sum.div(count);
      sum.normalize();
      sum.mult(5); // Arbitrary max speed
      const steer = Vector.sub(sum, this.velocity);
      steer.limit(0.05);
      return steer;
    }

    return new Vector(0, 0);
  }

  // Cohesion
  cohere(boids: Boid[], neighborDist: number): Vector {
    const sum = new Vector(0, 0);
    let count = 0;

    for (const other of boids) {
      const d = Vector.dist(this.position, other.position);
      if (d > 0 && d < neighborDist) {
        sum.add(other.position);
        count++;
      }
    }

    if (count > 0) {
      sum.div(count);
      return this.seek(sum);
    }

    return new Vector(0, 0);
  }

  seek(target: Vector, maxSpeed: number = 5, maxForce: number = 0.05): Vector {
    const desired = Vector.sub(target, this.position);
    desired.normalize();
    desired.mult(maxSpeed);
    const steer = Vector.sub(desired, this.velocity);
    steer.limit(maxForce);
    return steer;
  }

  flee(target: Vector, maxSpeed: number = 5, maxForce: number = 0.05): Vector {
    const desired = Vector.sub(this.position, target);
    desired.normalize();
    desired.mult(maxSpeed);
    const steer = Vector.sub(desired, this.velocity);
    steer.limit(maxForce);
    return steer;
  }

  edges() {
    if (this.position.x > this.width + this.size) this.position.x = -this.size;
    else if (this.position.x < -this.size) this.position.x = this.width + this.size;

    if (this.position.y > this.height + this.size) this.position.y = -this.size;
    else if (this.position.y < -this.size) this.position.y = this.height + this.size;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const theta = this.velocity.heading() + Math.PI / 2;
    ctx.save();
    ctx.translate(this.position.x, this.position.y);
    ctx.rotate(theta);
    ctx.beginPath();
    ctx.moveTo(0, -this.size * 2);
    ctx.lineTo(-this.size, this.size * 2);
    ctx.lineTo(this.size, this.size * 2);
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}
