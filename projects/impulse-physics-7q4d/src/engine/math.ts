/**
 * Core 2D math for the Impulse physics engine.
 *
 * The engine uses an immutable {@link Vec2} value type with a small set of free
 * functions for the cross products that show up everywhere in 2D rigid-body
 * dynamics. Keeping vectors immutable trades a few allocations for code that is
 * dramatically easier to reason about (and to verify) than the in-place,
 * aliasing-prone style typical of C++ physics engines.
 */

export const EPSILON = 1e-9;

/** Clamp `x` into the inclusive range [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** An immutable 2D vector. All methods return fresh vectors. */
export class Vec2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static readonly ZERO = new Vec2(0, 0);

  static of(x: number, y: number): Vec2 {
    return new Vec2(x, y);
  }

  add(v: Vec2): Vec2 {
    return new Vec2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vec2): Vec2 {
    return new Vec2(this.x - v.x, this.y - v.y);
  }

  /** Scalar multiply. */
  mul(s: number): Vec2 {
    return new Vec2(this.x * s, this.y * s);
  }

  /** Component-wise multiply (Hadamard product). */
  mulV(v: Vec2): Vec2 {
    return new Vec2(this.x * v.x, this.y * v.y);
  }

  neg(): Vec2 {
    return new Vec2(-this.x, -this.y);
  }

  dot(v: Vec2): number {
    return this.x * v.x + this.y * v.y;
  }

  /** 2D scalar cross product: `this × v`. */
  cross(v: Vec2): number {
    return this.x * v.y - this.y * v.x;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  distanceTo(v: Vec2): number {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  /** Unit vector; returns the zero vector when the length is ~0. */
  normalize(): Vec2 {
    const len = this.length();
    if (len < EPSILON) return Vec2.ZERO;
    return new Vec2(this.x / len, this.y / len);
  }

  /** Left-hand perpendicular: rotate +90°. Equal to `cross(1, this)`. */
  perp(): Vec2 {
    return new Vec2(-this.y, this.x);
  }

  /** Rotate this vector by an angle (radians) about the origin. */
  rotate(radians: number): Vec2 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Vec2(c * this.x - s * this.y, s * this.x + c * this.y);
  }

  lerp(v: Vec2, t: number): Vec2 {
    return new Vec2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
  }

  min(v: Vec2): Vec2 {
    return new Vec2(Math.min(this.x, v.x), Math.min(this.y, v.y));
  }

  max(v: Vec2): Vec2 {
    return new Vec2(Math.max(this.x, v.x), Math.max(this.y, v.y));
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  equals(v: Vec2, tol = EPSILON): boolean {
    return Math.abs(this.x - v.x) <= tol && Math.abs(this.y - v.y) <= tol;
  }

  toString(): string {
    return `(${this.x.toFixed(3)}, ${this.y.toFixed(3)})`;
  }
}

/**
 * Cross product of a vector and a scalar, `v × s`, producing a vector.
 * Equivalent to rotating `v` by -90° and scaling by `s`.
 */
export function crossVS(v: Vec2, s: number): Vec2 {
  return new Vec2(s * v.y, -s * v.x);
}

/**
 * Cross product of a scalar and a vector, `s × v`, producing a vector.
 * Equivalent to rotating `v` by +90° and scaling by `s`.
 */
export function crossSV(s: number, v: Vec2): Vec2 {
  return new Vec2(-s * v.y, s * v.x);
}

/** A 2D rotation stored as sine/cosine (a unit complex number). */
export class Rot {
  readonly s: number;
  readonly c: number;

  constructor(s = 0, c = 1) {
    this.s = s;
    this.c = c;
  }

  static fromAngle(radians: number): Rot {
    return new Rot(Math.sin(radians), Math.cos(radians));
  }

  angle(): number {
    return Math.atan2(this.s, this.c);
  }

  /** Rotate a vector from local space into world space. */
  apply(v: Vec2): Vec2 {
    return new Vec2(this.c * v.x - this.s * v.y, this.s * v.x + this.c * v.y);
  }

  /** Inverse-rotate a vector from world space into local space. */
  applyT(v: Vec2): Vec2 {
    return new Vec2(this.c * v.x + this.s * v.y, -this.s * v.x + this.c * v.y);
  }

  /** Local x-axis (first column of the rotation matrix). */
  xAxis(): Vec2 {
    return new Vec2(this.c, this.s);
  }

  /** Local y-axis (second column of the rotation matrix). */
  yAxis(): Vec2 {
    return new Vec2(-this.s, this.c);
  }
}

/**
 * A rigid transform (rotation + translation). Maps a point in body-local space
 * to world space via `p_world = q · p_local + position`.
 */
export class Transform {
  readonly position: Vec2;
  readonly q: Rot;

  constructor(position: Vec2 = Vec2.ZERO, q: Rot = new Rot()) {
    this.position = position;
    this.q = q;
  }

  /** Transform a local point into world space. */
  apply(p: Vec2): Vec2 {
    return this.q.apply(p).add(this.position);
  }

  /** Transform a world point into local space. */
  applyInv(p: Vec2): Vec2 {
    return this.q.applyT(p.sub(this.position));
  }
}

/** A symmetric 2×2 matrix used for the effective-mass of 2-DOF constraints. */
export class Mat22 {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;

  constructor(a = 0, b = 0, c = 0, d = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  mulV(v: Vec2): Vec2 {
    return new Vec2(this.a * v.x + this.b * v.y, this.c * v.x + this.d * v.y);
  }

  /** Solve `M·x = rhs` for x using Cramer's rule. */
  solve(rhs: Vec2): Vec2 {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < EPSILON) return Vec2.ZERO;
    const inv = 1 / det;
    return new Vec2(
      inv * (this.d * rhs.x - this.b * rhs.y),
      inv * (this.a * rhs.y - this.c * rhs.x),
    );
  }

  invert(): Mat22 {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < EPSILON) return new Mat22();
    const inv = 1 / det;
    return new Mat22(inv * this.d, -inv * this.b, -inv * this.c, inv * this.a);
  }
}

/** Linear interpolation of scalars. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
