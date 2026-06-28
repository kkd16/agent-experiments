import type { ClassId } from "./complexity";

/**
 * Per-challenge *input scaling* recipes for the complexity profiler.
 *
 * The profiler can only chart how a solution scales if it can manufacture a
 * valid input of any requested size n and know what growth rate to expect. Each
 * entry here supplies:
 *
 *   - `gen`        a self-contained generator `function genInput(n){…}` (kept as
 *                  a *string* so it can be shipped into the sandbox worker
 *                  alongside the user's code). It returns the positional
 *                  argument array for the entry function and may call the shared
 *                  PRNG/helpers in `PREAMBLE` (see profiler.ts): `rnd`, `ri`,
 *                  `arr`, `shuffle`, `lower`, `baltree`.
 *   - `sizes`      the geometric schedule of n to attempt (the worker stops
 *                  early once a single call gets slow, so generous ceilings are
 *                  safe).
 *   - `sizeLabel`  what "n" means for this problem, shown on the chart's x-axis.
 *   - `targetClass`the *optimal* growth class when this variable is scaled — what
 *                  a great solution should achieve (compared against the user's
 *                  measured class).
 *   - `mutates`    true when an idiomatic solution rewrites its input in place
 *                  (so the worker must hand each call a fresh deep copy instead
 *                  of reusing one).
 *   - `note`       an optional caveat shown under the verdict.
 *
 * Inputs are engineered toward the *worst case* (e.g. a target with no answer,
 * so a search scans the whole structure) so the measured curve reflects the
 * solution's true asymptotics rather than a lucky early return.
 */

export interface ScalingRecipe {
  sizeLabel: string;
  targetClass: ClassId;
  sizes: number[];
  gen: string;
  mutates?: boolean;
  note?: string;
}

/** Geometric size schedule: `count` roughly-log-spaced integers in [min, max]. */
function geo(min: number, max: number, count = 11): number[] {
  const out: number[] = [];
  const ratio = Math.pow(max / min, 1 / (count - 1));
  let prev = -1;
  for (let i = 0; i < count; i++) {
    const v = Math.round(min * Math.pow(ratio, i));
    if (v > prev) {
      out.push(v);
      prev = v;
    }
  }
  return out;
}

export const SCALING: Record<string, ScalingRecipe> = {
  // ----------------------------------------------------------- arrays-hashing
  "two-sum": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    note: "Inputs have no valid pair, so a hash solution scans once while brute force checks every pair.",
    gen: "function genInput(n){ var a = shuffle(arr(n, function(i){ return i+1; })); return [a, -1]; }",
  },
  "contains-duplicate": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    note: "All elements are distinct, forcing a full scan.",
    gen: "function genInput(n){ return [shuffle(arr(n, function(i){ return i; }))]; }",
  },
  "group-anagrams": {
    sizeLabel: "number of strings n",
    targetClass: "linear",
    sizes: geo(1000, 120000),
    note: "Word length is fixed, so cost grows linearly in the number of words.",
    gen: "function genInput(n){ return [arr(n, function(){ return lower(6); })]; }",
  },

  // ------------------------------------------------------------- two-pointers
  "valid-palindrome": {
    sizeLabel: "string length n",
    targetClass: "linear",
    sizes: geo(2000, 400000),
    note: "A true palindrome makes the two pointers walk all the way to the middle.",
    gen: "function genInput(n){ var h = lower(Math.floor(n/2)); var r = h.split('').reverse().join(''); return [h + r]; }",
  },
  "two-sum-ii": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 400000),
    note: "A sorted array of even numbers with an odd target has no pair, so the pointers traverse fully.",
    gen: "function genInput(n){ return [arr(n, function(i){ return i*2; }), 1]; }",
  },

  // ------------------------------------------------------------ sliding-window
  "best-time-stock": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ var p = 1000, a = new Array(n); for (var i=0;i<n;i++){ p += ri(-5,5); if (p<1) p=1; a[i]=p; } return [a]; }",
  },
  "longest-substring": {
    sizeLabel: "string length n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    note: "A small alphabet forces the window to keep sliding, exercising the full pass.",
    gen: "function genInput(n){ var s=''; for (var i=0;i<n;i++) s += String.fromCharCode(97 + Math.floor(rnd()*8)); return [s]; }",
  },

  // -------------------------------------------------------------------- stack
  "valid-parentheses": {
    sizeLabel: "string length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    note: "A fully nested, balanced string fills the stack to depth n/2.",
    gen: "function genInput(n){ var h = Math.floor(n/2); var s=''; for (var i=0;i<h;i++) s+='('; for (var j=0;j<h;j++) s+=')'; return [s]; }",
  },
  "daily-temperatures": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    gen: "function genInput(n){ return [arr(n, function(){ return ri(30, 100); })]; }",
  },

  // ------------------------------------------------------------- binary-search
  "binary-search": {
    sizeLabel: "array length n",
    targetClass: "log",
    sizes: geo(2048, 2000000),
    note: "The target is absent, so the search halves the range all the way down.",
    gen: "function genInput(n){ return [arr(n, function(i){ return i*2; }), -1]; }",
  },
  "search-rotated": {
    sizeLabel: "array length n",
    targetClass: "log",
    sizes: geo(2048, 2000000),
    note: "A rotated sorted array with an absent target drives the full logarithmic descent.",
    gen: "function genInput(n){ var k = Math.floor(n/3); var a = new Array(n); for (var i=0;i<n;i++) a[i] = ((i + k) % n) * 2; return [a, -1]; }",
  },

  // -------------------------------------------------------------- linked-list
  "reverse-list": {
    sizeLabel: "list length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ return [arr(n, function(i){ return i; })]; }",
  },
  "merge-two-lists": {
    sizeLabel: "total length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ var h = Math.floor(n/2); return [arr(h, function(i){ return i*2; }), arr(h, function(i){ return i*2+1; })]; }",
  },

  // -------------------------------------------------------------------- trees
  "max-depth": {
    sizeLabel: "node count n",
    targetClass: "linear",
    sizes: geo(1000, 200000),
    note: "A balanced tree of n nodes is visited in full.",
    gen: "function genInput(n){ return [baltree(0, n-1)]; }",
  },
  "inorder-traversal": {
    sizeLabel: "node count n",
    targetClass: "linear",
    sizes: geo(1000, 200000),
    gen: "function genInput(n){ return [baltree(0, n-1)]; }",
  },

  // -------------------------------------------------------- heap-priority-queue
  "kth-largest": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    note: "k is fixed, so a size-k heap is O(n); a full sort would be O(n log n).",
    gen: "function genInput(n){ return [shuffle(arr(n, function(i){ return i; })), 5]; }",
  },
  "last-stone-weight": {
    sizeLabel: "array length n",
    targetClass: "linearithmic",
    sizes: geo(500, 30000),
    note: "Optimal is a heap, O(n log n); a re-sort-each-step solution is closer to O(n²).",
    gen: "function genInput(n){ return [arr(n, function(){ return ri(1, 1000); })]; }",
  },

  // ------------------------------------------------------------- backtracking
  subsets: {
    sizeLabel: "element count n",
    targetClass: "exp",
    sizes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    note: "There are 2ⁿ subsets, so the work — and the output — doubles with every element.",
    gen: "function genInput(n){ return [arr(n, function(i){ return i; })]; }",
  },
  permutations: {
    sizeLabel: "element count n",
    targetClass: "exp",
    sizes: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    note: "n! permutations grow even faster than 2ⁿ — the curve rockets up past n ≈ 9.",
    gen: "function genInput(n){ return [arr(n, function(i){ return i; })]; }",
  },

  // ------------------------------------------------------------------- graphs
  "num-islands": {
    sizeLabel: "grid cells n",
    targetClass: "linear",
    sizes: geo(400, 160000),
    mutates: true,
    note: "Every cell is visited once; many solutions sink islands in place, so each run gets a fresh grid.",
    gen: "function genInput(n){ var side = Math.max(1, Math.round(Math.sqrt(n))); var g = new Array(side); for (var r=0;r<side;r++){ var row = new Array(side); for (var c=0;c<side;c++) row[c] = rnd() < 0.55 ? '1' : '0'; g[r]=row; } return [g]; }",
  },
  "course-schedule": {
    sizeLabel: "course count n",
    targetClass: "linear",
    sizes: geo(1000, 150000),
    note: "A solvable DAG with O(n) edges is fully explored once (O(V + E)).",
    gen: "function genInput(n){ var e = []; for (var i=1;i<n;i++){ e.push([i, i-1]); if (rnd() < 0.5 && i >= 2) e.push([i, ri(0, i-2)]); } return [n, e]; }",
  },

  // ---------------------------------------------------------- advanced-graphs
  "network-delay": {
    sizeLabel: "node count n",
    targetClass: "linearithmic",
    sizes: geo(500, 60000),
    note: "Dijkstra over a connected graph with O(n) edges runs in O(E log V).",
    gen: "function genInput(n){ var e = []; for (var v=2;v<=n;v++){ e.push([ri(1, v-1), v, ri(1, 20)]); } for (var k=0;k<n;k++){ var a=ri(1,n), b=ri(1,n); if (a!==b) e.push([a, b, ri(1, 20)]); } return [e, n, 1]; }",
  },

  // -------------------------------------------------------------------- dp-1d
  "climb-stairs": {
    sizeLabel: "n (the integer)",
    targetClass: "linear",
    sizes: geo(2000, 2000000),
    gen: "function genInput(n){ return [n]; }",
  },
  "house-robber": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ return [arr(n, function(){ return ri(0, 400); })]; }",
  },
  "coin-change": {
    sizeLabel: "target amount n",
    targetClass: "linear",
    sizes: geo(1000, 120000),
    note: "With a fixed coin set, the DP table is O(amount).",
    gen: "function genInput(n){ return [[1, 2, 5, 10, 25], n]; }",
  },

  // -------------------------------------------------------------------- dp-2d
  "unique-paths": {
    sizeLabel: "grid side n",
    targetClass: "quadratic",
    sizes: geo(40, 1500),
    note: "An n×n grid fills an O(n²) table.",
    gen: "function genInput(n){ return [n, n]; }",
  },
  lcs: {
    sizeLabel: "string length n",
    targetClass: "quadratic",
    sizes: geo(40, 1200),
    note: "Two length-n strings fill an n×n DP table.",
    gen: "function genInput(n){ var f = function(){ var s=''; for (var i=0;i<n;i++) s += String.fromCharCode(97 + Math.floor(rnd()*4)); return s; }; return [f(), f()]; }",
  },

  // ------------------------------------------------------------------- greedy
  "max-subarray": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ return [arr(n, function(){ return ri(-50, 50); })]; }",
  },
  "jump-game": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    note: "Every cell allows at least one step, so the greedy reach sweeps the whole array.",
    gen: "function genInput(n){ var a = arr(n, function(){ return ri(1, 4); }); a[n-1] = 0; return [a]; }",
  },

  // ---------------------------------------------------------------- intervals
  "merge-intervals": {
    sizeLabel: "interval count n",
    targetClass: "linearithmic",
    sizes: geo(1000, 150000),
    mutates: true,
    note: "The sort dominates at O(n log n); inputs are shuffled so the sort does real work.",
    gen: "function genInput(n){ var iv = arr(n, function(i){ var s = i*3; return [s, s + ri(1, 4)]; }); return [shuffle(iv)]; }",
  },
  "insert-interval": {
    sizeLabel: "interval count n",
    targetClass: "linear",
    sizes: geo(2000, 200000),
    note: "Sorted, disjoint intervals with a new interval spanning the middle — a single linear pass.",
    gen: "function genInput(n){ var iv = arr(n, function(i){ var s = i*4; return [s, s+2]; }); var mid = Math.floor(n/2)*4; return [iv, [mid - 8, mid + 8]]; }",
  },

  // ------------------------------------------------------------- math-geometry
  "rotate-image": {
    sizeLabel: "matrix side n",
    targetClass: "quadratic",
    sizes: geo(20, 700),
    mutates: true,
    note: "Every one of the n² cells is moved; the in-place rotation is profiled on a fresh matrix each run.",
    gen: "function genInput(n){ var m = new Array(n); for (var r=0;r<n;r++){ var row = new Array(n); for (var c=0;c<n;c++) row[c] = ri(0, 1000); m[r]=row; } return [m]; }",
  },
  "spiral-order": {
    sizeLabel: "matrix side n",
    targetClass: "quadratic",
    sizes: geo(20, 1000),
    note: "An n×n matrix is read cell by cell, O(n²).",
    gen: "function genInput(n){ var m = new Array(n); var v = 0; for (var r=0;r<n;r++){ var row = new Array(n); for (var c=0;c<n;c++) row[c] = v++; m[r]=row; } return [m]; }",
  },
  "powx-n": {
    sizeLabel: "exponent n",
    targetClass: "log",
    sizes: geo(1024, 1000000000),
    note: "Fast exponentiation squares its way up in O(log n) multiplications.",
    gen: "function genInput(n){ return [1.0000000001, n]; }",
  },

  // -------------------------------------------------------------- bit-manip
  "single-number": {
    sizeLabel: "array length n",
    targetClass: "linear",
    sizes: geo(2000, 300000),
    gen: "function genInput(n){ var pairs = Math.floor((n-1)/2); var a = []; for (var i=0;i<pairs;i++){ a.push(i+1); a.push(i+1); } a.push(-7); return [shuffle(a)]; }",
  },
  "counting-bits": {
    sizeLabel: "n (the integer)",
    targetClass: "linear",
    sizes: geo(2000, 2000000),
    gen: "function genInput(n){ return [n]; }",
  },
};

export function scalingFor(id: string): ScalingRecipe | undefined {
  return SCALING[id];
}

export function isProfilable(id: string): boolean {
  return id in SCALING;
}
