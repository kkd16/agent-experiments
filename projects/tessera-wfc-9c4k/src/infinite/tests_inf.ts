// Infinite Proof Lab — an in-app verification suite for the "Boundless" engine, in the house style
// of the 2D/3D Proof Labs. It runs the *real* world generator and proves the properties the
// endless renderer relies on, deterministically:
//
//   1. Coordinate algebra — the plane is partitioned into exactly one category per cell, and the
//      (chunk index, offset) decomposition round-trips for any sign of coordinate.
//   2. Ground & seams — every offered set has a self-compatible ground tile; each generated seam is
//      a valid 1-D adjacency chain pinned to its junction endpoints; junctions are deterministic.
//   3. Chunks — a chunk's border ring comes out exactly equal to the shared seams/junctions, the
//      interior fully collapses, and the fallback path never fires for an offered set.
//   4. The headline — over a block of chunks, *every* cross-cell adjacency (within chunks, across
//      seams, around junctions) is valid, re-checked the long way against the raw socket rule
//      (`fits` on edge codes), sharing no code with the support-counter tensor that produced it;
//      and the whole world is order-independent (any visit order, any fresh instance → identical
//      tiles) yet seed-sensitive.

import { fits, opposite, type Dir } from '../wfc/edges';
import { compile } from '../wfc/tiles';
import { tilesetByKey } from '../wfc/tilesets/index';
import type { CompiledTileset } from '../wfc/types';
import { classify, floorDiv, mod, subSeed } from './coords';
import { INFINITE_TILESET_KEYS } from './sets';
import { findGround, InfiniteWorld } from './world';

export type TestResult = { name: string; pass: boolean; detail: string };
export type TestGroup = { group: string; results: TestResult[] };

// Compile every offered set once (canvas is available in-app).
const SETS: { key: string; set: CompiledTileset }[] = INFINITE_TILESET_KEYS.map((key) => ({
  key,
  set: compile(tilesetByKey(key)),
}));

/** The socket rule, evaluated straight from edge codes — independent of the compiled `allowed`. */
function fitsRaw(set: CompiledTileset, a: number, b: number, d: Dir): boolean {
  return fits(set.variants[a].edges, set.variants[b].edges, d);
}

// ---- 1. coordinate algebra -------------------------------------------------

function coordTests(): TestResult[] {
  const out: TestResult[] = [];
  const G = 7;
  let partitionFail = 0;
  let roundTripFail = 0;
  const kinds = { junction: 0, vseam: 0, hseam: 0, interior: 0 };
  for (let gy = -20; gy <= 20; gy++) {
    for (let gx = -20; gx <= 20; gx++) {
      const a = classify(gx, gy, G);
      kinds[a.kind]++;
      // reconstruct the global cell from (chunk index, offset)
      if (a.jx * G + a.rx !== gx || a.jy * G + a.ry !== gy) roundTripFail++;
      // category must match the offset definition exactly (the partition is unambiguous)
      const rx = mod(gx, G);
      const ry = mod(gy, G);
      const expect =
        rx === 0 && ry === 0 ? 'junction' : rx === 0 ? 'vseam' : ry === 0 ? 'hseam' : 'interior';
      if (a.kind !== expect) partitionFail++;
    }
  }
  out.push({
    name: 'every cell has exactly one category',
    pass: partitionFail === 0,
    detail: partitionFail === 0 ? `41² cells, 4 kinds` : `${partitionFail} miscategorised`,
  });
  out.push({
    name: '(chunk, offset) round-trips for any sign',
    pass: roundTripFail === 0,
    detail: roundTripFail === 0 ? 'incl. negatives' : `${roundTripFail} mismatches`,
  });
  out.push({
    name: 'floorDiv / mod correct on negatives',
    pass: floorDiv(-1, 7) === -1 && mod(-1, 7) === 6 && floorDiv(-7, 7) === -1 && mod(-7, 7) === 0,
    detail: `⌊-1/7⌋=${floorDiv(-1, 7)}, -1 mod 7=${mod(-1, 7)}`,
  });
  const s1 = subSeed('m', 'C', 3, -4);
  const s2 = subSeed('m', 'C', 3, -4);
  const s3 = subSeed('m', 'V', 3, -4);
  out.push({
    name: 'sub-seed is deterministic + tag-separated',
    pass: s1 === s2 && s1 !== s3,
    detail: s1,
  });
  return out;
}

// ---- 2. ground & seams -----------------------------------------------------

function groundSeamTests(): TestResult[] {
  const out: TestResult[] = [];
  let noGround = 0;
  for (const { set } of SETS) if (findGround(set) < 0) noGround++;
  out.push({
    name: 'every offered set has a ground tile',
    pass: noGround === 0,
    detail: noGround === 0 ? `${SETS.length} sets, self-compatible ⁴` : `${noGround} without ground`,
  });

  // seams are valid 1-D chains pinned to their junctions
  let seamBad = 0;
  let pinBad = 0;
  let seamCount = 0;
  for (const { set } of SETS) {
    const w = new InfiniteWorld({ set, seed: 'seam-probe', chunkSize: 10 });
    for (let j = -1; j <= 1; j++) {
      const v = w.vseam(0, j);
      const h = w.hseam(j, 0);
      seamCount += 2;
      // endpoints must equal the shared junctions
      if (v[0] !== w.junctionAt(0, j) || v[v.length - 1] !== w.junctionAt(0, j + 1)) pinBad++;
      if (h[0] !== w.junctionAt(j, 0) || h[h.length - 1] !== w.junctionAt(j + 1, 0)) pinBad++;
      // consecutive cells must satisfy the raw socket rule (vertical for v, horizontal for h)
      for (let i = 0; i + 1 < v.length; i++) if (!fitsRaw(set, v[i], v[i + 1], 2 as Dir)) seamBad++;
      for (let i = 0; i + 1 < h.length; i++) if (!fitsRaw(set, h[i], h[i + 1], 1 as Dir)) seamBad++;
    }
  }
  out.push({
    name: 'seams are valid 1-D adjacency chains',
    pass: seamBad === 0,
    detail: seamBad === 0 ? `${seamCount} seams, raw socket rule` : `${seamBad} broken links`,
  });
  out.push({
    name: 'seam endpoints honour their junctions',
    pass: pinBad === 0,
    detail: pinBad === 0 ? 'pinned to shared corners' : `${pinBad} mismatched ends`,
  });

  // junction determinism across independent instances
  let juncBad = 0;
  for (const { set } of SETS) {
    const a = new InfiniteWorld({ set, seed: 'jx', chunkSize: 9 });
    const b = new InfiniteWorld({ set, seed: 'jx', chunkSize: 9 });
    for (let jy = -2; jy <= 2; jy++)
      for (let jx = -2; jx <= 2; jx++)
        if (a.junctionAt(jx, jy) !== b.junctionAt(jx, jy)) juncBad++;
  }
  out.push({
    name: 'junctions are deterministic from (seed, x, y)',
    pass: juncBad === 0,
    detail: juncBad === 0 ? 'identical across instances' : `${juncBad} differ`,
  });
  return out;
}

// ---- 3. chunk solves -------------------------------------------------------

function chunkTests(): TestResult[] {
  const out: TestResult[] = [];
  let borderBad = 0;
  let interiorBad = 0;
  let determBad = 0;
  let fallbacks = 0;
  let chunks = 0;
  const G = 10;
  const W = G + 1;
  for (const { set } of SETS) {
    const w = new InfiniteWorld({ set, seed: 'chunk-probe', chunkSize: G });
    const w2 = new InfiniteWorld({ set, seed: 'chunk-probe', chunkSize: G });
    for (let cy = -1; cy <= 1; cy++) {
      for (let cx = -1; cx <= 1; cx++) {
        const grid = w.chunk(cx, cy);
        chunks++;
        // every cell collapsed (no -1 sentinel)
        for (let i = 0; i < grid.length; i++) if (grid[i] < 0) interiorBad++;
        // border equals the shared seams/junctions read independently
        const top = w.hseam(cx, cy);
        const bottom = w.hseam(cx, cy + 1);
        const left = w.vseam(cx, cy);
        const right = w.vseam(cx + 1, cy);
        for (let x = 0; x <= G; x++) {
          if (grid[x] !== top[x]) borderBad++;
          if (grid[G * W + x] !== bottom[x]) borderBad++;
        }
        for (let y = 1; y < G; y++) {
          if (grid[y * W] !== left[y]) borderBad++;
          if (grid[y * W + G] !== right[y]) borderBad++;
        }
        // determinism: a fresh instance produces the same chunk
        const grid2 = w2.chunk(cx, cy);
        for (let i = 0; i < grid.length; i++) if (grid[i] !== grid2[i]) determBad++;
      }
    }
    fallbacks += w.fallbacks;
  }
  out.push({ name: 'chunk interiors fully collapse', pass: interiorBad === 0, detail: interiorBad === 0 ? `${chunks} chunks` : `${interiorBad} blank cells` });
  out.push({ name: 'chunk border = shared seams/junctions', pass: borderBad === 0, detail: borderBad === 0 ? 'ring honoured' : `${borderBad} desynced` });
  out.push({ name: 'chunks are deterministic', pass: determBad === 0, detail: determBad === 0 ? 'fresh instance identical' : `${determBad} differ` });
  out.push({ name: 'fallback never fires for offered sets', pass: fallbacks === 0, detail: `${fallbacks} fallbacks / ${chunks} chunks` });
  return out;
}

// ---- 4. the headline -------------------------------------------------------

function planeTests(): TestResult[] {
  const out: TestResult[] = [];
  const G = 9;
  let viol = 0;
  let pairs = 0;
  let orderMism = 0;
  let seedDiff = 0;
  let seedSame = 0;
  for (const { set } of SETS) {
    const w = new InfiniteWorld({ set, seed: 'plane', chunkSize: G });
    const lo = -G - 1;
    const hi = 2 * G + 1;
    const tile = (x: number, y: number) => w.tileAt(x, y);
    for (let gy = lo; gy <= hi; gy++) {
      for (let gx = lo; gx <= hi; gx++) {
        const a = tile(gx, gy);
        // East + South neighbour, both directions of the raw socket rule
        for (const d of [1, 2] as Dir[]) {
          const nx = gx + (d === 1 ? 1 : 0);
          const ny = gy + (d === 2 ? 1 : 0);
          const b = tile(nx, ny);
          pairs++;
          if (!fitsRaw(set, a, b, d) || !fitsRaw(set, b, a, opposite(d))) viol++;
        }
      }
    }
    // order-independence: a fresh instance scanned in reverse must agree everywhere
    const w2 = new InfiniteWorld({ set, seed: 'plane', chunkSize: G });
    for (let gy = hi; gy >= lo; gy--)
      for (let gx = hi; gx >= lo; gx--) if (w2.tileAt(gx, gy) !== tile(gx, gy)) orderMism++;
    // seed-sensitivity: a different master seed yields a different world (somewhere)
    const w3 = new InfiniteWorld({ set, seed: 'plane#2', chunkSize: G });
    let diff = 0;
    for (let gy = lo; gy <= hi; gy++) for (let gx = lo; gx <= hi; gx++) if (w3.tileAt(gx, gy) !== tile(gx, gy)) diff++;
    if (diff > 0) seedDiff++;
    else seedSame++;
  }
  out.push({
    name: 'every adjacency on the plane is valid',
    pass: viol === 0,
    detail: viol === 0 ? `${pairs.toLocaleString()} pairs, raw socket rule` : `${viol} violations`,
  });
  out.push({
    name: 'the world is order-independent',
    pass: orderMism === 0,
    detail: orderMism === 0 ? 'reverse scan + fresh instance identical' : `${orderMism} differ`,
  });
  out.push({
    name: 'the world is seed-sensitive',
    pass: seedSame === 0,
    detail: seedSame === 0 ? `${seedDiff}/${SETS.length} sets diverge on a new seed` : `${seedSame} unchanged`,
  });
  return out;
}

export function runAllTestsInf(): TestGroup[] {
  return [
    { group: 'Coordinate algebra', results: coordTests() },
    { group: 'Ground & seams', results: groundSeamTests() },
    { group: 'Chunk solves', results: chunkTests() },
    { group: 'The infinite plane', results: planeTests() },
  ];
}

export function testCountInf(groups: TestGroup[]): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const g of groups) for (const r of g.results) {
    total++;
    if (r.pass) passed++;
  }
  return { passed, total };
}
