import { type Vector2D } from './math';

export interface PointData<T> {
  position: Vector2D;
  data: T;
}

export class Rectangle {
  x: number;
  y: number;
  w: number;
  h: number;

  constructor(x: number, y: number, w: number, h: number) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  contains(point: Vector2D): boolean {
    return (
      point.x >= this.x - this.w &&
      point.x <= this.x + this.w &&
      point.y >= this.y - this.h &&
      point.y <= this.y + this.h
    );
  }

  intersects(range: Rectangle): boolean {
    return !(
      range.x - range.w > this.x + this.w ||
      range.x + range.w < this.x - this.w ||
      range.y - range.h > this.y + this.h ||
      range.y + range.h < this.y - this.h
    );
  }
}

export class QuadTree<T> {
  boundary: Rectangle;
  capacity: number;
  points: PointData<T>[];
  divided: boolean;

  northeast: QuadTree<T> | null;
  northwest: QuadTree<T> | null;
  southeast: QuadTree<T> | null;
  southwest: QuadTree<T> | null;

  constructor(boundary: Rectangle, capacity: number) {
    this.boundary = boundary;
    this.capacity = capacity;
    this.points = [];
    this.divided = false;

    this.northeast = null;
    this.northwest = null;
    this.southeast = null;
    this.southwest = null;
  }

  insert(point: PointData<T>): boolean {
    if (!this.boundary.contains(point.position)) {
      return false;
    }

    if (this.points.length < this.capacity) {
      this.points.push(point);
      return true;
    }

    if (!this.divided) {
      this.subdivide();
    }

    return (
      this.northeast!.insert(point) ||
      this.northwest!.insert(point) ||
      this.southeast!.insert(point) ||
      this.southwest!.insert(point)
    );
  }

  subdivide() {
    const x = this.boundary.x;
    const y = this.boundary.y;
    const w = this.boundary.w / 2;
    const h = this.boundary.h / 2;

    const ne = new Rectangle(x + w, y - h, w, h);
    this.northeast = new QuadTree<T>(ne, this.capacity);
    const nw = new Rectangle(x - w, y - h, w, h);
    this.northwest = new QuadTree<T>(nw, this.capacity);
    const se = new Rectangle(x + w, y + h, w, h);
    this.southeast = new QuadTree<T>(se, this.capacity);
    const sw = new Rectangle(x - w, y + h, w, h);
    this.southwest = new QuadTree<T>(sw, this.capacity);

    this.divided = true;
  }

  query(range: Rectangle, found?: PointData<T>[]): PointData<T>[] {
    if (!found) {
      found = [];
    }

    if (!this.boundary.intersects(range)) {
      return found;
    }

    for (const p of this.points) {
      if (range.contains(p.position)) {
        found.push(p);
      }
    }

    if (this.divided) {
      this.northwest!.query(range, found);
      this.northeast!.query(range, found);
      this.southwest!.query(range, found);
      this.southeast!.query(range, found);
    }

    return found;
  }
}
