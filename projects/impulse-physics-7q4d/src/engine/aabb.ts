import { Vec2 } from './math';

/** An axis-aligned bounding box. Used by the broadphase and ray casting. */
export class AABB {
  readonly lower: Vec2;
  readonly upper: Vec2;

  constructor(lower: Vec2, upper: Vec2) {
    this.lower = lower;
    this.upper = upper;
  }

  static empty(): AABB {
    return new AABB(
      new Vec2(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      new Vec2(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
    );
  }

  /** The smallest AABB containing all of `points`. */
  static fromPoints(points: readonly Vec2[]): AABB {
    let lo = points[0];
    let hi = points[0];
    for (let i = 1; i < points.length; i++) {
      lo = lo.min(points[i]);
      hi = hi.max(points[i]);
    }
    return new AABB(lo, hi);
  }

  width(): number {
    return this.upper.x - this.lower.x;
  }

  height(): number {
    return this.upper.y - this.lower.y;
  }

  center(): Vec2 {
    return this.lower.add(this.upper).mul(0.5);
  }

  extents(): Vec2 {
    return this.upper.sub(this.lower).mul(0.5);
  }

  /** Surface "area" — perimeter in 2D — the SAH cost used by the AABB tree. */
  perimeter(): number {
    return 2 * (this.width() + this.height());
  }

  /** Grow the box outward by `margin` on every side. */
  expand(margin: number): AABB {
    const m = new Vec2(margin, margin);
    return new AABB(this.lower.sub(m), this.upper.add(m));
  }

  /** Smallest box containing both `this` and `other`. */
  union(other: AABB): AABB {
    return new AABB(this.lower.min(other.lower), this.upper.max(other.upper));
  }

  contains(other: AABB): boolean {
    return (
      this.lower.x <= other.lower.x &&
      this.lower.y <= other.lower.y &&
      other.upper.x <= this.upper.x &&
      other.upper.y <= this.upper.y
    );
  }

  overlaps(other: AABB): boolean {
    return (
      this.lower.x <= other.upper.x &&
      other.lower.x <= this.upper.x &&
      this.lower.y <= other.upper.y &&
      other.lower.y <= this.upper.y
    );
  }

  containsPoint(p: Vec2): boolean {
    return (
      p.x >= this.lower.x &&
      p.x <= this.upper.x &&
      p.y >= this.lower.y &&
      p.y <= this.upper.y
    );
  }
}
