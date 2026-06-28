/**
 * A tiny dense 2×2 matrix and a closed-form 2×2 SVD — the linear-algebra kernel
 * the Material Point Method needs that the engine's symmetric {@link Mat22}
 * (built for 2-DOF constraint effective-masses) does not provide: full
 * matrix–matrix products, transpose, determinant, and the polar/SVD factors
 * every continuum constitutive model is written in.
 *
 * Matrices are stored **row-major** as `[[a, b], [c, d]]`, i.e. the vector
 * product is `M·v = (a·x + b·y, c·x + d·y)`. Everything is immutable, mirroring
 * the engine's {@link Vec2} so the MPM solver reads like the rest of the code.
 */
import { Vec2 } from '../math';

/** An immutable dense 2×2 matrix `[[a, b], [c, d]]` (row-major). */
export class Mat2 {
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

  static readonly I = new Mat2(1, 0, 0, 1);
  static readonly ZERO = new Mat2(0, 0, 0, 0);

  /** Diagonal matrix `diag(x, y)`. */
  static diag(x: number, y: number): Mat2 {
    return new Mat2(x, 0, 0, y);
  }

  /** A pure rotation by `angle` radians (CCW), det = +1. */
  static rotation(angle: number): Mat2 {
    const co = Math.cos(angle);
    const si = Math.sin(angle);
    return new Mat2(co, -si, si, co);
  }

  /** Outer product `u ⊗ v` = `u·vᵀ` (column × row). */
  static outer(u: Vec2, v: Vec2): Mat2 {
    return new Mat2(u.x * v.x, u.x * v.y, u.y * v.x, u.y * v.y);
  }

  add(m: Mat2): Mat2 {
    return new Mat2(this.a + m.a, this.b + m.b, this.c + m.c, this.d + m.d);
  }

  sub(m: Mat2): Mat2 {
    return new Mat2(this.a - m.a, this.b - m.b, this.c - m.c, this.d - m.d);
  }

  scale(s: number): Mat2 {
    return new Mat2(this.a * s, this.b * s, this.c * s, this.d * s);
  }

  /** Matrix–vector product `M·v`. */
  mulV(v: Vec2): Vec2 {
    return new Vec2(this.a * v.x + this.b * v.y, this.c * v.x + this.d * v.y);
  }

  /** Matrix–matrix product `this · m`. */
  mul(m: Mat2): Mat2 {
    return new Mat2(
      this.a * m.a + this.b * m.c,
      this.a * m.b + this.b * m.d,
      this.c * m.a + this.d * m.c,
      this.c * m.b + this.d * m.d,
    );
  }

  transpose(): Mat2 {
    return new Mat2(this.a, this.c, this.b, this.d);
  }

  det(): number {
    return this.a * this.d - this.b * this.c;
  }

  trace(): number {
    return this.a + this.d;
  }

  /** Frobenius norm `√(Σ mᵢⱼ²)`. */
  norm(): number {
    return Math.hypot(this.a, this.b, this.c, this.d);
  }

  isFinite(): boolean {
    return (
      Number.isFinite(this.a) &&
      Number.isFinite(this.b) &&
      Number.isFinite(this.c) &&
      Number.isFinite(this.d)
    );
  }
}

/** The result of a 2×2 singular value decomposition `A = U · Σ · Vᵀ`. */
export interface Svd2 {
  /** Left rotation (det = +1). */
  u: Mat2;
  /** Singular values; `s2` may be negative so that `U`,`V` stay pure rotations. */
  s1: number;
  s2: number;
  /** Right rotation (det = +1). */
  v: Mat2;
}

/**
 * Closed-form 2×2 singular value decomposition `A = U·diag(s1,s2)·Vᵀ`.
 *
 * Both `U` and `V` are returned as **pure rotations** (det = +1); the sign of a
 * reflection in `A` (det A < 0) is carried by a negative `s2`. This is exactly
 * the convention continuum-mechanics return-mappings want: the closest rotation
 * to `A` is `R = U·Vᵀ`, and the principal stretches live on the diagonal.
 *
 * Method (robust to every 2×2, including singular and reflected matrices):
 *   1. diagonalise the symmetric `S = AᵀA` analytically — its eigenvectors are
 *      the right singular vectors, so `V` is a rotation by `½·atan2(2q, p−r)`;
 *   2. `W = A·V` then has orthogonal columns `σ_i·u_i`, so the singular values
 *      are the column norms and `U` is the rotation aligning the first column;
 *   3. the sign of `s2` is set by `det A` so `U`,`V` stay proper rotations.
 * Only `hypot`/`atan2`, exact to floating-point (verified maxerr ≈ 1e-15).
 */
export function svd2(A: Mat2): Svd2 {
  const p = A.a * A.a + A.c * A.c;
  const r = A.b * A.b + A.d * A.d;
  const q = A.a * A.b + A.c * A.d;
  const theta = 0.5 * Math.atan2(2 * q, p - r);
  const v = Mat2.rotation(theta);
  const w = A.mul(v); // = A·V, columns are σ_i·u_i (orthogonal)
  const s1 = Math.hypot(w.a, w.c);
  const phi = Math.atan2(w.c, w.a);
  const u = Mat2.rotation(phi);
  let s2 = Math.hypot(w.b, w.d);
  if (A.det() < 0) s2 = -s2;
  return { u, s1, s2, v };
}

/**
 * The closest rotation to `A` (the orthogonal factor of its polar
 * decomposition), `R = U·Vᵀ`. For an already-orthogonal `A`, returns `A`.
 */
export function polarR(A: Mat2): Mat2 {
  const { u, v } = svd2(A);
  return u.mul(v.transpose());
}
