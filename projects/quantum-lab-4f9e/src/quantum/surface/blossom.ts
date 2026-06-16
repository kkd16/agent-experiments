// Edmonds' Blossom algorithm — general-graph maximum-weight matching, from scratch.
//
// This is the engine behind Minimum-Weight Perfect Matching (MWPM), the standard
// decoder for the surface code. There is no polynomial reduction of general-graph
// matching to bipartite matching or flow: blossoms (odd alternating cycles) must be
// contracted on the fly. This is a faithful TypeScript port of Galil's O(V³)
// primal-dual formulation (the classic Joris van Rantwijk / NetworkX implementation),
// which maintains a feasible dual solution and complementary slackness throughout.
//
// All weights here are integers or half-integers (exactly representable in float64),
// so the `slack <= 0` / `dualvar == 0` comparisons the algorithm relies on are exact
// and termination is guaranteed.

export type Edge = [number, number, number]; // [vertex i, vertex j, weight]

/**
 * Maximum-weight matching of a general undirected graph.
 * @param edges  list of [i, j, weight]; i ≠ j, vertices are 0..n-1 (n inferred).
 * @param maxcardinality if true, restrict to matchings of maximum cardinality.
 * @returns mate[] where mate[v] is the vertex matched to v, or -1 if unmatched.
 */
export function maxWeightMatching(edges: Edge[], maxcardinality = false): number[] {
  if (edges.length === 0) return [];

  const nedge = edges.length;
  let nvertex = 0;
  let maxweight = 0;
  for (const [i, j, w] of edges) {
    if (i + 1 > nvertex) nvertex = i + 1;
    if (j + 1 > nvertex) nvertex = j + 1;
    if (w > maxweight) maxweight = w;
  }

  // endpoint[p] = the vertex at endpoint p; edge k has endpoints 2k and 2k+1.
  const endpoint: number[] = new Array(2 * nedge);
  for (let p = 0; p < 2 * nedge; p++) endpoint[p] = edges[(p / 2) | 0][p % 2];

  // neighbend[v] = list of remote endpoints of edges incident to v.
  const neighbend: number[][] = Array.from({ length: nvertex }, () => []);
  for (let k = 0; k < nedge; k++) {
    const [i, j] = edges[k];
    neighbend[i].push(2 * k + 1);
    neighbend[j].push(2 * k);
  }

  const mate: number[] = new Array(nvertex).fill(-1);

  // label[b]: 0 = free, 1 = S-vertex/blossom, 2 = T-vertex/blossom, 5 = scratch.
  const label: number[] = new Array(2 * nvertex).fill(0);
  const labelend: number[] = new Array(2 * nvertex).fill(-1);
  const inblossom: number[] = Array.from({ length: nvertex }, (_, v) => v);
  const blossomparent: number[] = new Array(2 * nvertex).fill(-1);
  const blossomchilds: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const blossombase: number[] = Array.from({ length: 2 * nvertex }, (_, v) => (v < nvertex ? v : -1));
  const blossomendps: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const bestedge: number[] = new Array(2 * nvertex).fill(-1);
  const blossombestedges: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const unusedblossoms: number[] = [];
  for (let b = nvertex; b < 2 * nvertex; b++) unusedblossoms.push(b);
  const dualvar: number[] = new Array(2 * nvertex).fill(0);
  for (let v = 0; v < nvertex; v++) dualvar[v] = maxweight;
  const allowedge: boolean[] = new Array(nedge).fill(false);
  let queue: number[] = [];

  const slack = (k: number): number => {
    const [i, j, w] = edges[k];
    return dualvar[i] + dualvar[j] - 2 * w;
  };

  const blossomLeaves = (b: number): number[] => {
    if (b < nvertex) return [b];
    const out: number[] = [];
    const stack = [...(blossomchilds[b] as number[])];
    while (stack.length) {
      const t = stack.shift() as number;
      if (t < nvertex) out.push(t);
      else for (const c of blossomchilds[t] as number[]) stack.unshift(c);
    }
    return out;
  };

  const assignLabel = (w: number, t: number, p: number): void => {
    const b = inblossom[w];
    label[w] = label[b] = t;
    labelend[w] = labelend[b] = p;
    bestedge[w] = bestedge[b] = -1;
    if (t === 1) {
      queue.push(...blossomLeaves(b));
    } else if (t === 2) {
      const base = blossombase[b];
      assignLabel(endpoint[mate[base]], 1, mate[base] ^ 1);
    }
  };

  const scanBlossom = (v0: number, w0: number): number => {
    let v = v0, w = w0;
    const path: number[] = [];
    let base = -1;
    while (v !== -1 || w !== -1) {
      let b = inblossom[v];
      if (label[b] & 4) { base = blossombase[b]; break; }
      path.push(b);
      label[b] = 5;
      if (labelend[b] === -1) {
        v = -1;
      } else {
        v = endpoint[labelend[b]];
        b = inblossom[v];
        v = endpoint[labelend[b]];
      }
      if (w !== -1) { const tmp = v; v = w; w = tmp; }
    }
    for (const b of path) label[b] = 1;
    return base;
  };

  const addBlossom = (base: number, k: number): void => {
    let [v, w] = edges[k];
    const bb = inblossom[base];
    let bv = inblossom[v];
    let bw = inblossom[w];
    const b = unusedblossoms.pop() as number;
    blossombase[b] = base;
    blossomparent[b] = -1;
    blossomparent[bb] = b;
    const path: number[] = [];
    const endps: number[] = [];
    blossomchilds[b] = path;
    blossomendps[b] = endps;
    while (bv !== bb) {
      blossomparent[bv] = b;
      path.push(bv);
      endps.push(labelend[bv]);
      v = endpoint[labelend[bv]];
      bv = inblossom[v];
    }
    path.push(bb);
    path.reverse();
    endps.reverse();
    endps.push(2 * k);
    while (bw !== bb) {
      blossomparent[bw] = b;
      path.push(bw);
      endps.push(labelend[bw] ^ 1);
      w = endpoint[labelend[bw]];
      bw = inblossom[w];
    }
    label[b] = 1;
    labelend[b] = labelend[bb];
    dualvar[b] = 0;
    for (const leaf of blossomLeaves(b)) {
      if (label[inblossom[leaf]] === 2) queue.push(leaf);
      inblossom[leaf] = b;
    }
    const bestedgeto: number[] = new Array(2 * nvertex).fill(-1);
    for (const bvv of path) {
      let nblists: number[][];
      if (blossombestedges[bvv] === null) {
        nblists = blossomLeaves(bvv).map((vv) => neighbend[vv].map((p) => (p / 2) | 0));
      } else {
        nblists = [blossombestedges[bvv] as number[]];
      }
      for (const nblist of nblists) {
        for (const kk of nblist) {
          let [, jj] = edges[kk];
          if (inblossom[jj] === b) jj = edges[kk][0];
          const bj = inblossom[jj];
          if (bj !== b && label[bj] === 1 && (bestedgeto[bj] === -1 || slack(kk) < slack(bestedgeto[bj]))) {
            bestedgeto[bj] = kk;
          }
        }
      }
      blossombestedges[bvv] = null;
      bestedge[bvv] = -1;
    }
    const best: number[] = [];
    for (const kk of bestedgeto) if (kk !== -1) best.push(kk);
    blossombestedges[b] = best;
    bestedge[b] = -1;
    for (const kk of best) if (bestedge[b] === -1 || slack(kk) < slack(bestedge[b])) bestedge[b] = kk;
  };

  const expandBlossom = (b: number, endstage: boolean): void => {
    for (const s of blossomchilds[b] as number[]) {
      blossomparent[s] = -1;
      if (s < nvertex) inblossom[s] = s;
      else if (endstage && dualvar[s] === 0) expandBlossom(s, endstage);
      else for (const vv of blossomLeaves(s)) inblossom[vv] = s;
    }
    if (!endstage && label[b] === 2) {
      const entrychild = inblossom[endpoint[labelend[b] ^ 1]];
      const childs = blossomchilds[b] as number[];
      const endps = blossomendps[b] as number[];
      const L = childs.length;
      // Python-style negative-index wrap: childs[j] / endps[j] for possibly-negative j.
      const ch = (x: number): number => childs[((x % L) + L) % L];
      const ep = (x: number): number => endps[((x % L) + L) % L];
      let j = childs.indexOf(entrychild);
      let jstep: number, endptrick: number;
      if (j & 1) { j -= L; jstep = 1; endptrick = 0; }
      else { jstep = -1; endptrick = 1; }
      let p = labelend[b];
      while (j !== 0) {
        label[endpoint[p ^ 1]] = 0;
        label[endpoint[ep(j - endptrick) ^ endptrick ^ 1]] = 0;
        assignLabel(endpoint[p ^ 1], 2, p);
        allowedge[(ep(j - endptrick) / 2) | 0] = true;
        j += jstep;
        p = ep(j - endptrick) ^ endptrick;
        allowedge[(p / 2) | 0] = true;
        j += jstep;
      }
      let bv = ch(j);
      label[endpoint[p ^ 1]] = label[bv] = 2;
      labelend[endpoint[p ^ 1]] = labelend[bv] = p;
      bestedge[bv] = -1;
      j += jstep;
      while (ch(j) !== entrychild) {
        bv = ch(j);
        if (label[bv] === 1) { j += jstep; continue; }
        let vv = -1;
        for (const cand of blossomLeaves(bv)) { vv = cand; if (label[cand] !== 0) break; }
        if (label[vv] !== 0) {
          label[vv] = 0;
          label[endpoint[mate[blossombase[bv]]]] = 0;
          assignLabel(vv, 2, labelend[vv]);
        }
        j += jstep;
      }
    }
    label[b] = labelend[b] = -1;
    blossomchilds[b] = blossomendps[b] = null;
    blossombase[b] = -1;
    blossombestedges[b] = null;
    bestedge[b] = -1;
    unusedblossoms.push(b);
  };

  const augmentBlossom = (b: number, v: number): void => {
    let t = v;
    while (blossomparent[t] !== b) t = blossomparent[t];
    if (t >= nvertex) augmentBlossom(t, v);
    const childs = blossomchilds[b] as number[];
    const endps = blossomendps[b] as number[];
    const L = childs.length;
    const ch = (x: number): number => childs[((x % L) + L) % L];
    const ep = (x: number): number => endps[((x % L) + L) % L];
    const i = childs.indexOf(t);
    let j = i;
    let jstep: number, endptrick: number;
    if (i & 1) { j -= L; jstep = 1; endptrick = 0; }
    else { jstep = -1; endptrick = 1; }
    while (j !== 0) {
      j += jstep;
      t = ch(j);
      const p = ep(j - endptrick) ^ endptrick;
      if (t >= nvertex) augmentBlossom(t, endpoint[p]);
      j += jstep;
      t = ch(j);
      if (t >= nvertex) augmentBlossom(t, endpoint[p ^ 1]);
      mate[endpoint[p]] = p ^ 1;
      mate[endpoint[p ^ 1]] = p;
    }
    blossomchilds[b] = childs.slice(i).concat(childs.slice(0, i));
    blossomendps[b] = endps.slice(i).concat(endps.slice(0, i));
    blossombase[b] = blossombase[(blossomchilds[b] as number[])[0]];
  };

  const augmentMatching = (k: number): void => {
    const [v0, w0] = edges[k];
    for (const [s0, p0] of [[v0, 2 * k + 1], [w0, 2 * k]] as [number, number][]) {
      let s = s0, p = p0;
      for (;;) {
        const bs = inblossom[s];
        if (bs >= nvertex) augmentBlossom(bs, s);
        mate[s] = p;
        if (labelend[bs] === -1) break;
        const t = endpoint[labelend[bs]];
        const bt = inblossom[t];
        s = endpoint[labelend[bt]];
        const j = endpoint[labelend[bt] ^ 1];
        if (bt >= nvertex) augmentBlossom(bt, j);
        mate[j] = labelend[bt];
        p = labelend[bt] ^ 1;
      }
    }
  };

  for (let t = 0; t < nvertex; t++) {
    label.fill(0);
    bestedge.fill(-1);
    for (let b = nvertex; b < 2 * nvertex; b++) if (blossombase[b] >= 0) blossombestedges[b] = null;
    allowedge.fill(false);
    queue = [];
    for (let v = 0; v < nvertex; v++) {
      if (mate[v] === -1 && label[inblossom[v]] === 0) assignLabel(v, 1, -1);
    }

    let augmented = false;
    for (;;) {
      while (queue.length && !augmented) {
        const v = queue.pop() as number;
        for (const p of neighbend[v]) {
          const k = (p / 2) | 0;
          const w = endpoint[p];
          if (inblossom[v] === inblossom[w]) continue;
          let kslack = 0;
          if (!allowedge[k]) {
            kslack = slack(k);
            if (kslack <= 0) allowedge[k] = true;
          }
          if (allowedge[k]) {
            if (label[inblossom[w]] === 0) {
              assignLabel(w, 2, p ^ 1);
            } else if (label[inblossom[w]] === 1) {
              const base = scanBlossom(v, w);
              if (base >= 0) addBlossom(base, k);
              else { augmentMatching(k); augmented = true; break; }
            } else if (label[w] === 0) {
              label[w] = 2;
              labelend[w] = p ^ 1;
            }
          } else if (label[inblossom[w]] === 1) {
            const b = inblossom[v];
            if (bestedge[b] === -1 || kslack < slack(bestedge[b])) bestedge[b] = k;
          } else if (label[w] === 0) {
            if (bestedge[w] === -1 || kslack < slack(bestedge[w])) bestedge[w] = k;
          }
        }
      }
      if (augmented) break;

      let deltatype = -1;
      let delta = 0;
      let deltaedge = -1;
      let deltablossom = -1;

      if (!maxcardinality) {
        deltatype = 1;
        delta = dualvar[0];
        for (let v = 1; v < nvertex; v++) if (dualvar[v] < delta) delta = dualvar[v];
      }
      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]] === 0 && bestedge[v] !== -1) {
          const d = slack(bestedge[v]);
          if (deltatype === -1 || d < delta) { delta = d; deltatype = 2; deltaedge = bestedge[v]; }
        }
      }
      for (let b = 0; b < 2 * nvertex; b++) {
        if (blossomparent[b] === -1 && label[b] === 1 && bestedge[b] !== -1) {
          const d = slack(bestedge[b]) / 2;
          if (deltatype === -1 || d < delta) { delta = d; deltatype = 3; deltaedge = bestedge[b]; }
        }
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b] >= 0 && blossomparent[b] === -1 && label[b] === 2 && (deltatype === -1 || dualvar[b] < delta)) {
          delta = dualvar[b]; deltatype = 4; deltablossom = b;
        }
      }
      if (deltatype === -1) {
        // No further dual progress possible (maxcardinality with no S-vertices left):
        // delta = max(0, min over single-vertex duals), then end the stage.
        deltatype = 1;
        let mn = dualvar[0];
        for (let v = 1; v < nvertex; v++) if (dualvar[v] < mn) mn = dualvar[v];
        delta = Math.max(0, mn);
      }

      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]] === 1) dualvar[v] -= delta;
        else if (label[inblossom[v]] === 2) dualvar[v] += delta;
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b] >= 0 && blossomparent[b] === -1) {
          if (label[b] === 1) dualvar[b] += delta;
          else if (label[b] === 2) dualvar[b] -= delta;
        }
      }

      if (deltatype === 1) break;
      else if (deltatype === 2) {
        allowedge[deltaedge] = true;
        const [i, j] = edges[deltaedge];
        // enter the S-vertex endpoint of this newly-allowed edge into the queue
        queue.push(label[inblossom[i]] === 0 ? j : i);
      } else if (deltatype === 3) {
        allowedge[deltaedge] = true;
        queue.push(edges[deltaedge][0]);
      } else if (deltatype === 4) {
        expandBlossom(deltablossom, false);
      }
    }

    if (!augmented) break;

    for (let b = nvertex; b < 2 * nvertex; b++) {
      if (blossomparent[b] === -1 && blossombase[b] >= 0 && label[b] === 1 && dualvar[b] === 0) {
        expandBlossom(b, true);
      }
    }
  }

  // mate[v] currently holds an *endpoint* index; convert it to the matched vertex.
  for (let v = 0; v < nvertex; v++) if (mate[v] >= 0) mate[v] = endpoint[mate[v]];

  return mate;
}

/**
 * Minimum-weight perfect matching via reduction to maximum-weight matching.
 * Requires the graph to admit a perfect matching (caller guarantees this — the
 * surface-code decoder always adds boundary nodes so one exists). Weights are
 * negated against a constant so that a maximum-cardinality max-weight matching
 * is exactly the minimum-weight perfect matching.
 */
export function minWeightPerfectMatching(nNodes: number, edges: Edge[]): number[] {
  if (nNodes === 0) return [];
  let maxw = 0;
  for (const [, , w] of edges) if (w > maxw) maxw = w;
  const offset = maxw + 1;
  const transformed: Edge[] = edges.map(([i, j, w]) => [i, j, offset - w]);
  return maxWeightMatching(transformed, true);
}
