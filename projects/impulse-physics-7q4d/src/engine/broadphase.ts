import { AABB } from './aabb';
import { Vec2 } from './math';

const NULL_NODE = -1;
/** Fat-AABB margin: proxies carry slack so small moves don't trigger reinsertion. */
const FAT_MARGIN = 0.1;
/** Predictive enlargement factor along the proxy's displacement. */
const PREDICT = 2;

interface TreeNode<T> {
  aabb: AABB;
  userData: T | null;
  parent: number;
  child1: number;
  child2: number;
  /** Node height for AVL-style balancing; 0 for leaves, -1 for free nodes. */
  height: number;
}

/**
 * A dynamic bounding-volume hierarchy of axis-aligned boxes — the same
 * structure Box2D uses for its broadphase. Leaves store fat AABBs; internal
 * nodes are chosen and rebalanced with a surface-area heuristic so the tree
 * stays cheap to query as hundreds of bodies move every frame.
 */
export class DynamicTree<T> {
  private nodes: TreeNode<T>[] = [];
  private root = NULL_NODE;
  private freeList = NULL_NODE;

  constructor() {
    this.expandCapacity(16);
  }

  get(id: number): T | null {
    return this.nodes[id].userData;
  }

  fatAABB(id: number): AABB {
    return this.nodes[id].aabb;
  }

  private expandCapacity(target: number): void {
    const start = this.nodes.length;
    for (let i = start; i < target; i++) {
      this.nodes.push({
        aabb: AABB.empty(),
        userData: null,
        parent: i + 1 < target ? i + 1 : NULL_NODE,
        child1: NULL_NODE,
        child2: NULL_NODE,
        height: -1,
      });
    }
    // Splice the new free nodes onto the front of the free list.
    if (this.freeList === NULL_NODE) {
      this.freeList = start;
    } else {
      this.nodes[target - 1].parent = this.freeList;
      this.freeList = start;
    }
  }

  private allocNode(): number {
    if (this.freeList === NULL_NODE) {
      this.expandCapacity(this.nodes.length * 2);
    }
    const id = this.freeList;
    this.freeList = this.nodes[id].parent;
    const node = this.nodes[id];
    node.parent = NULL_NODE;
    node.child1 = NULL_NODE;
    node.child2 = NULL_NODE;
    node.height = 0;
    node.userData = null;
    return id;
  }

  private freeNode(id: number): void {
    this.nodes[id].parent = this.freeList;
    this.nodes[id].height = -1;
    this.nodes[id].userData = null;
    this.freeList = id;
  }

  /** Insert a leaf for `aabb`; returns the proxy id. */
  createProxy(aabb: AABB, userData: T): number {
    const id = this.allocNode();
    this.nodes[id].aabb = aabb.expand(FAT_MARGIN);
    this.nodes[id].userData = userData;
    this.nodes[id].height = 0;
    this.insertLeaf(id);
    return id;
  }

  destroyProxy(id: number): void {
    this.removeLeaf(id);
    this.freeNode(id);
  }

  /**
   * Update a proxy if its tight AABB has escaped the fat AABB. Returns true when
   * the proxy was reinserted (and therefore may have new pairs).
   */
  moveProxy(id: number, aabb: AABB, displacement: Vec2): boolean {
    if (this.nodes[id].aabb.contains(aabb)) return false;
    this.removeLeaf(id);
    // Refatten, predicting motion so fast bodies keep their slack ahead of them.
    let fat = aabb.expand(FAT_MARGIN);
    const d = displacement.mul(PREDICT);
    const lower = fat.lower.add(new Vec2(Math.min(d.x, 0), Math.min(d.y, 0)));
    const upper = fat.upper.add(new Vec2(Math.max(d.x, 0), Math.max(d.y, 0)));
    fat = new AABB(lower, upper);
    this.nodes[id].aabb = fat;
    this.insertLeaf(id);
    return true;
  }

  private insertLeaf(leaf: number): void {
    if (this.root === NULL_NODE) {
      this.root = leaf;
      this.nodes[leaf].parent = NULL_NODE;
      return;
    }

    // Descend from the root, always toward the child whose subtree grows least
    // (surface-area heuristic) when the leaf's box is merged in.
    const leafAABB = this.nodes[leaf].aabb;
    let index = this.root;
    while (this.nodes[index].height > 0) {
      const child1 = this.nodes[index].child1;
      const child2 = this.nodes[index].child2;

      const area = this.nodes[index].aabb.perimeter();
      const combined = this.nodes[index].aabb.union(leafAABB).perimeter();
      const cost = 2 * combined;
      const inheritance = 2 * (combined - area);

      const cost1 = this.descentCost(child1, leafAABB, inheritance);
      const cost2 = this.descentCost(child2, leafAABB, inheritance);

      if (cost < cost1 && cost < cost2) break;
      index = cost1 < cost2 ? child1 : child2;
    }

    // Create a new parent for `index` and `leaf`.
    const sibling = index;
    const oldParent = this.nodes[sibling].parent;
    const newParent = this.allocNode();
    this.nodes[newParent].parent = oldParent;
    this.nodes[newParent].aabb = leafAABB.union(this.nodes[sibling].aabb);
    this.nodes[newParent].height = this.nodes[sibling].height + 1;
    this.nodes[newParent].child1 = sibling;
    this.nodes[newParent].child2 = leaf;
    this.nodes[sibling].parent = newParent;
    this.nodes[leaf].parent = newParent;

    if (oldParent === NULL_NODE) {
      this.root = newParent;
    } else if (this.nodes[oldParent].child1 === sibling) {
      this.nodes[oldParent].child1 = newParent;
    } else {
      this.nodes[oldParent].child2 = newParent;
    }

    // Walk back up refitting AABBs and rebalancing.
    let walk = this.nodes[leaf].parent;
    while (walk !== NULL_NODE) {
      walk = this.balance(walk);
      const c1 = this.nodes[walk].child1;
      const c2 = this.nodes[walk].child2;
      this.nodes[walk].height = 1 + Math.max(this.nodes[c1].height, this.nodes[c2].height);
      this.nodes[walk].aabb = this.nodes[c1].aabb.union(this.nodes[c2].aabb);
      walk = this.nodes[walk].parent;
    }
  }

  private descentCost(child: number, leafAABB: AABB, inheritance: number): number {
    const merged = leafAABB.union(this.nodes[child].aabb).perimeter();
    if (this.nodes[child].height === 0) {
      return merged + inheritance;
    }
    return merged - this.nodes[child].aabb.perimeter() + inheritance;
  }

  private removeLeaf(leaf: number): void {
    if (leaf === this.root) {
      this.root = NULL_NODE;
      return;
    }
    const parent = this.nodes[leaf].parent;
    const grandParent = this.nodes[parent].parent;
    const sibling =
      this.nodes[parent].child1 === leaf ? this.nodes[parent].child2 : this.nodes[parent].child1;

    if (grandParent === NULL_NODE) {
      this.root = sibling;
      this.nodes[sibling].parent = NULL_NODE;
      this.freeNode(parent);
      return;
    }

    if (this.nodes[grandParent].child1 === parent) {
      this.nodes[grandParent].child1 = sibling;
    } else {
      this.nodes[grandParent].child2 = sibling;
    }
    this.nodes[sibling].parent = grandParent;
    this.freeNode(parent);

    let walk = grandParent;
    while (walk !== NULL_NODE) {
      walk = this.balance(walk);
      const c1 = this.nodes[walk].child1;
      const c2 = this.nodes[walk].child2;
      this.nodes[walk].aabb = this.nodes[c1].aabb.union(this.nodes[c2].aabb);
      this.nodes[walk].height = 1 + Math.max(this.nodes[c1].height, this.nodes[c2].height);
      walk = this.nodes[walk].parent;
    }
  }

  /** AVL rotation: lift the taller grandchild of `iA` if it is out of balance. */
  private balance(iA: number): number {
    const A = this.nodes[iA];
    if (A.height < 2) return iA;

    const iB = A.child1;
    const iC = A.child2;
    const B = this.nodes[iB];
    const C = this.nodes[iC];
    const bal = C.height - B.height;

    if (bal > 1) return this.rotate(iA, iC, iB, true);
    if (bal < -1) return this.rotate(iA, iB, iC, false);
    return iA;
  }

  private rotate(iA: number, iPivot: number, iOther: number, pivotIsChild2: boolean): number {
    const A = this.nodes[iA];
    const P = this.nodes[iPivot];
    const iF = P.child1;
    const iG = P.child2;
    const F = this.nodes[iF];
    const G = this.nodes[iG];

    // Swap A and the pivot.
    P.child1 = iA;
    P.parent = A.parent;
    A.parent = iPivot;

    if (P.parent === NULL_NODE) {
      this.root = iPivot;
    } else if (this.nodes[P.parent].child1 === iA) {
      this.nodes[P.parent].child1 = iPivot;
    } else {
      this.nodes[P.parent].child2 = iPivot;
    }

    // Promote the taller of F/G to be the pivot's outer child.
    const promoteF = F.height > G.height;
    const iUp = promoteF ? iF : iG;
    const iDown = promoteF ? iG : iF;
    P.child2 = iUp;
    if (pivotIsChild2) A.child2 = iDown;
    else A.child1 = iDown;
    this.nodes[iDown].parent = iA;

    const O = this.nodes[iOther];
    A.aabb = O.aabb.union(this.nodes[iDown].aabb);
    P.aabb = A.aabb.union(this.nodes[iUp].aabb);
    A.height = 1 + Math.max(O.height, this.nodes[iDown].height);
    P.height = 1 + Math.max(A.height, this.nodes[iUp].height);

    return iPivot;
  }

  /** Invoke `cb` for every proxy whose fat AABB overlaps `aabb`. */
  query(aabb: AABB, cb: (id: number) => void): void {
    if (this.root === NULL_NODE) return;
    const stack: number[] = [this.root];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (id === NULL_NODE) continue;
      const node = this.nodes[id];
      if (!node.aabb.overlaps(aabb)) continue;
      if (node.height === 0) {
        cb(id);
      } else {
        stack.push(node.child1, node.child2);
      }
    }
  }

  /**
   * Cast a ray from `p1` to `p2`. `cb` returns a clip fraction in [0,1] to
   * shorten the ray (a hit) or a value ≥ current fraction to continue.
   */
  rayCast(p1: Vec2, p2: Vec2, cb: (id: number, a: Vec2, b: Vec2) => number): void {
    if (this.root === NULL_NODE) return;
    const d = p2.sub(p1);
    let maxFraction = 1;
    const stack: number[] = [this.root];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (id === NULL_NODE) continue;
      const node = this.nodes[id];
      const end = p1.add(d.mul(maxFraction));
      if (!segmentHitsAABB(p1, end, node.aabb)) continue;
      if (node.height === 0) {
        const f = cb(id, p1, p2);
        if (f === 0) return;
        if (f > 0) maxFraction = Math.min(maxFraction, f);
      } else {
        stack.push(node.child1, node.child2);
      }
    }
  }

  /** Max leaf depth, exposed for the debug overlay and verification. */
  height(): number {
    return this.root === NULL_NODE ? 0 : this.nodes[this.root].height;
  }

  rootId(): number {
    return this.root;
  }

  node(id: number): { aabb: AABB; leaf: boolean; child1: number; child2: number } {
    const n = this.nodes[id];
    return { aabb: n.aabb, leaf: n.height === 0, child1: n.child1, child2: n.child2 };
  }

  /** Visit every node depth-first (for the broadphase debug overlay). */
  traverse(cb: (aabb: AABB, leaf: boolean, depth: number) => void): void {
    if (this.root === NULL_NODE) return;
    const stack: Array<[number, number]> = [[this.root, 0]];
    while (stack.length > 0) {
      const [id, depth] = stack.pop() as [number, number];
      const n = this.nodes[id];
      cb(n.aabb, n.height === 0, depth);
      if (n.height > 0) {
        stack.push([n.child1, depth + 1], [n.child2, depth + 1]);
      }
    }
  }
}

function segmentHitsAABB(p1: Vec2, p2: Vec2, box: AABB): boolean {
  // Slab method against the segment's bounding box and the box.
  let tmin = 0;
  let tmax = 1;
  const d = p2.sub(p1);
  for (let axis = 0; axis < 2; axis++) {
    const start = axis === 0 ? p1.x : p1.y;
    const dir = axis === 0 ? d.x : d.y;
    const lo = axis === 0 ? box.lower.x : box.lower.y;
    const hi = axis === 0 ? box.upper.x : box.upper.y;
    if (Math.abs(dir) < 1e-12) {
      if (start < lo || start > hi) return false;
    } else {
      let t1 = (lo - start) / dir;
      let t2 = (hi - start) / dir;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

/** A candidate overlapping pair of proxy ids (a < b). */
export interface ProxyPair {
  a: number;
  b: number;
}

/**
 * Tracks proxies that moved this step and regenerates the set of candidate
 * overlapping pairs by querying each moved proxy against the tree.
 */
export class BroadPhase<T> {
  readonly tree = new DynamicTree<T>();
  private moved = new Set<number>();

  createProxy(aabb: AABB, userData: T): number {
    const id = this.tree.createProxy(aabb, userData);
    this.moved.add(id);
    return id;
  }

  destroyProxy(id: number): void {
    this.moved.delete(id);
    this.tree.destroyProxy(id);
  }

  moveProxy(id: number, aabb: AABB, displacement: Vec2): void {
    if (this.tree.moveProxy(id, aabb, displacement)) {
      this.moved.add(id);
    }
  }

  touch(id: number): void {
    this.moved.add(id);
  }

  /** Produce all unique overlapping pairs touching a moved proxy this step. */
  computePairs(): ProxyPair[] {
    const pairs: ProxyPair[] = [];
    const seen = new Set<number>();
    for (const id of this.moved) {
      const fat = this.tree.fatAABB(id);
      this.tree.query(fat, (other) => {
        if (other === id) return;
        const a = Math.min(id, other);
        const b = Math.max(id, other);
        const key = a * 0x100000 + b;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ a, b });
      });
    }
    this.moved.clear();
    return pairs;
  }
}
