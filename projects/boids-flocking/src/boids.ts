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
  mouseInteraction: 'none' | 'attract' | 'repel' | 'obstacle';
  mouseRadius: number;
  edgeBehavior: 'wrap' | 'bounce';
  predatorAvoidance: number;
  predatorVisualRange: number;
  windX: number;
  windY: number;
  boidShape: 'triangle' | 'circle' | 'arrow';

  gravity: number;
  showTrails: boolean;
  showGrid: boolean;
  windVariation: boolean;
  nightMode: boolean;
  trailDecay: number;
  cameraFollow: boolean;
  glowEffect: boolean;
}



export interface Obstacle {
  x: number;
  y: number;
  radius: number;
}

export class Grid {
  cellSize: number;
  width: number;
  height: number;
  cells: Map<string, Boid[]>;

  constructor(width: number, height: number, cellSize: number) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  clear() {
    this.cells.clear();
  }

  getKey(x: number, y: number): string {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    return `${col},${row}`;
  }

  insert(boid: Boid) {
    const key = this.getKey(boid.position.x, boid.position.y);
    if (!this.cells.has(key)) {
      this.cells.set(key, []);
    }
    this.cells.get(key)!.push(boid);
  }

  query(x: number, y: number, radius: number): Boid[] {
    const found: Boid[] = [];
    const minCol = Math.floor((x - radius) / this.cellSize);
    const maxCol = Math.floor((x + radius) / this.cellSize);
    const minRow = Math.floor((y - radius) / this.cellSize);
    const maxRow = Math.floor((y + radius) / this.cellSize);

    for (let col = minCol; col <= maxCol; col++) {
      for (let row = minRow; row <= maxRow; row++) {
        const key = `${col},${row}`;
        const cell = this.cells.get(key);
        if (cell) {
          for (const boid of cell) {
            found.push(boid);
          }
        }
      }
    }
    return found;
  }
}

export class Boid {
  position: Vector;
  velocity: Vector;
  acceleration: Vector;
  width: number;
  height: number;
  color: string;
  size: number;
  baseMaxSpeedMultiplier: number;
  baseSizeMultiplier: number;
  history: Vector[];

  constructor(x: number, y: number, width: number, height: number) {
    this.position = new Vector(x, y);
    this.velocity = new Vector((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    this.acceleration = new Vector(0, 0);
    this.width = width;
    this.height = height;
    this.baseSizeMultiplier = 0.5 + Math.random(); // 0.5x to 1.5x size
    this.size = (3 + Math.random() * 2) * this.baseSizeMultiplier;
    this.baseMaxSpeedMultiplier = 0.8 + Math.random() * 0.4; // 0.8x to 1.2x speed
    this.history = [];

    // Nice gradient of colors based on initial velocity
    const hue = Math.floor(Math.random() * 360);
    this.color = `hsl(${hue}, 80%, 60%)`;
  }

  update(params: BoidParams) {
    this.acceleration.add(new Vector(params.windX, params.windY));
    this.acceleration.add(new Vector(0, params.gravity)); // Add gravity
    this.velocity.add(this.acceleration);
    this.velocity.limit(params.maxSpeed * this.baseMaxSpeedMultiplier);
    this.position.add(this.velocity);
    this.acceleration.mult(0); // Reset acceleration each frame
    this.edges(params.edgeBehavior);

    // Track history for trails
    if (params.showTrails) {
      this.history.push(new Vector(this.position.x, this.position.y));
      if (this.history.length > 20) { // Limit trail length
        this.history.shift();
      }
    } else if (this.history.length > 0) {
      this.history = [];
    }
  }

  applyForce(force: Vector) {
    this.acceleration.add(force);
  }

  flock(grid: Grid, predators: Predator[], obstacles: Obstacle[], params: BoidParams, mousePos: { x: number; y: number } | null = null) {
    const nearbyBoids = grid.query(this.position.x, this.position.y, Math.max(params.visualRange, params.visualRange / 2));
    const sep = this.separate(nearbyBoids, params.visualRange / 2);
    const ali = this.align(nearbyBoids, params.visualRange);
    const coh = this.cohere(nearbyBoids, params.visualRange);
    const avoid = this.avoidPredators(predators, params.predatorVisualRange);


    const avoidObs = this.avoidObstacles(obstacles);

    sep.mult(params.separation);
    avoidObs.mult(3.0); // Strong priority to avoid obstacles
    ali.mult(params.alignment);
    coh.mult(params.cohesion);
    avoid.mult(params.predatorAvoidance);

    this.applyForce(sep);
    this.applyForce(ali);
    this.applyForce(coh);
    this.applyForce(avoid);
    this.applyForce(avoidObs);

    if (mousePos && params.mouseInteraction !== 'none') {
      const mouseVec = new Vector(mousePos.x, mousePos.y);
      const d = Vector.dist(this.position, mouseVec);
      if (d < params.mouseRadius) {
        let mouseForce: Vector;
        if (params.mouseInteraction === 'attract') {
          mouseForce = this.seek(mouseVec, (params.maxSpeed * this.baseMaxSpeedMultiplier), params.maxForce);
        } else {
          mouseForce = this.flee(mouseVec, (params.maxSpeed * this.baseMaxSpeedMultiplier), params.maxForce);
        }

        // Weight the mouse force based on distance (stronger when closer)
        const weight = 1 - (d / params.mouseRadius);
        mouseForce.mult(weight * 2); // Multiplier for interaction strength
        this.applyForce(mouseForce);
      }
    }
  }

  // Flee from predators
  avoidObstacles(obstacles: Obstacle[]): Vector {
    const steer = new Vector(0, 0);
    let count = 0;
    const avoidDist = 50; // How far ahead to look

    for (const obs of obstacles) {
      const d = Vector.dist(this.position, new Vector(obs.x, obs.y));
      // Bounding box / distance check
      if (d > 0 && d < obs.radius + avoidDist) {
        const diff = Vector.sub(this.position, new Vector(obs.x, obs.y));
        diff.normalize();
        diff.div(d); // Weight by distance
        steer.add(diff);
        count++;
      }
    }

    if (count > 0) {
      steer.div(count);
      steer.normalize();
      steer.mult(5); // Arbitrary max speed
      steer.sub(this.velocity);
      steer.limit(0.15); // Max force
    }

    return steer;
  }

  avoidPredators(predators: Predator[], visualRange: number): Vector {
    const steer = new Vector(0, 0);
    let count = 0;

    for (const pred of predators) {
      const d = Vector.dist(this.position, pred.position);
      if (d > 0 && d < visualRange) {
        const diff = Vector.sub(this.position, pred.position);
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
      steer.mult(5); // Arbitrary max speed
      steer.sub(this.velocity);
      steer.limit(0.1); // Max force (stronger than regular steering)
    }

    return steer;
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

  edges(behavior: 'wrap' | 'bounce' = 'wrap') {
    if (behavior === 'wrap') {
      if (this.position.x > this.width + this.size) this.position.x = -this.size;
      else if (this.position.x < -this.size) this.position.x = this.width + this.size;

      if (this.position.y > this.height + this.size) this.position.y = -this.size;
      else if (this.position.y < -this.size) this.position.y = this.height + this.size;
    } else {
      // Bounce
      const margin = 50; // Distance from edge to start turning
      const turnFactor = 0.5;

      if (this.position.x < margin) {
        this.velocity.x += turnFactor;
      } else if (this.position.x > this.width - margin) {
        this.velocity.x -= turnFactor;
      }

      if (this.position.y < margin) {
        this.velocity.y += turnFactor;
      } else if (this.position.y > this.height - margin) {
        this.velocity.y -= turnFactor;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, params: BoidParams) {
    if (params.glowEffect) {
      ctx.shadowBlur = 10;
      ctx.shadowColor = this.color;
    } else {
      ctx.shadowBlur = 0;
    }
    if (params.showTrails && this.history.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.history[0].x, this.history[0].y);
      for (let i = 1; i < this.history.length; i++) {
        // Handle wrap-around discontinuities in trails
        const d = Vector.dist(this.history[i-1], this.history[i]);
        if (d > 100) {
           ctx.moveTo(this.history[i].x, this.history[i].y);
        } else {
           ctx.lineTo(this.history[i].x, this.history[i].y);
        }
      }
      ctx.strokeStyle = this.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    const theta = this.velocity.heading() + Math.PI / 2;
    ctx.save();
    ctx.translate(this.position.x, this.position.y);
    ctx.rotate(theta);

    ctx.beginPath();
    if (params.boidShape === 'circle') {
      ctx.arc(0, 0, this.size * 1.5, 0, Math.PI * 2);
    } else if (params.boidShape === 'arrow') {
      ctx.moveTo(0, -this.size * 2);
      ctx.lineTo(-this.size, this.size);
      ctx.lineTo(0, 0);
      ctx.lineTo(this.size, this.size);
    } else {
      // Default triangle
      ctx.moveTo(0, -this.size * 2);
      ctx.lineTo(-this.size, this.size * 2);
      ctx.lineTo(this.size, this.size * 2);
    }

    if (params.boidShape !== 'circle') {
      ctx.closePath();
    }

    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}

export class Predator extends Boid {
  constructor(x: number, y: number, width: number, height: number) {
    super(x, y, width, height);
    this.size = 8;
    this.color = '#ef4444'; // Red
    this.velocity = new Vector((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15);
  }

  hunt(grid: Grid, params: BoidParams) {
    const nearbyBoids = grid.query(this.position.x, this.position.y, params.visualRange * 2);
    // Find closest boid
    let closestDist = Infinity;
    let closestBoid: Boid | null = null;

    for (const boid of nearbyBoids) {
      const d = Vector.dist(this.position, boid.position);
      if (d < closestDist) {
        closestDist = d;
        closestBoid = boid;
      }
    }

    if (closestBoid && closestDist < params.visualRange * 2) {
      const steer = this.seek(closestBoid.position, (params.maxSpeed * this.baseMaxSpeedMultiplier) * 1.2, params.maxForce * 1.5);
      this.applyForce(steer);
    } else {
      // Wander if no boids nearby
      const wander = new Vector((Math.random() - 0.5), (Math.random() - 0.5));
      wander.normalize();
      wander.mult(params.maxForce);
      this.applyForce(wander);
    }
  }

  draw(ctx: CanvasRenderingContext2D, params: BoidParams) {
    if (params.glowEffect) {
      ctx.shadowBlur = 15;
      ctx.shadowColor = this.color;
    } else {
      ctx.shadowBlur = 0;
    }

    const theta = this.velocity.heading() + Math.PI / 2;
    ctx.save();
    ctx.translate(this.position.x, this.position.y);
    ctx.rotate(theta);

    ctx.beginPath();
    if (params.boidShape === 'circle') {
      ctx.arc(0, 0, this.size * 1.5, 0, Math.PI * 2);
    } else if (params.boidShape === 'arrow') {
      ctx.moveTo(0, -this.size * 2);
      ctx.lineTo(-this.size, this.size);
      ctx.lineTo(0, 0);
      ctx.lineTo(this.size, this.size);
    } else {
      // Default triangle
      ctx.moveTo(0, -this.size * 2);
      ctx.lineTo(-this.size, this.size * 2);
      ctx.lineTo(this.size, this.size * 2);
    }

    if (params.boidShape !== 'circle') {
      ctx.closePath();
    }

    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}
