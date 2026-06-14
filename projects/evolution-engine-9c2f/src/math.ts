export class Vector2D {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  add(v: Vector2D): Vector2D {
    return new Vector2D(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2D): Vector2D {
    return new Vector2D(this.x - v.x, this.y - v.y);
  }

  mult(n: number): Vector2D {
    return new Vector2D(this.x * n, this.y * n);
  }

  div(n: number): Vector2D {
    return new Vector2D(this.x / n, this.y / n);
  }

  mag(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  magSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): Vector2D {
    const m = this.mag();
    if (m !== 0) {
      return this.div(m);
    }
    return new Vector2D(0, 0);
  }

  limit(max: number): Vector2D {
    if (this.magSq() > max * max) {
      return this.normalize().mult(max);
    }
    return new Vector2D(this.x, this.y);
  }

  dist(v: Vector2D): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  clone(): Vector2D {
      return new Vector2D(this.x, this.y);
  }

  static random2D(): Vector2D {
    const angle = Math.random() * Math.PI * 2;
    return new Vector2D(Math.cos(angle), Math.sin(angle));
  }
}

export function random(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

// Utility to limit values
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
