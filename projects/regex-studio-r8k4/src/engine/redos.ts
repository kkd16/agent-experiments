// Static ReDoS analysis — proving (or ruling out) catastrophic backtracking.
//
// The backtracking VM can take exponential time on some patterns ("ReDoS").
// Rather than just *observing* a slow run, this module *proves* the risk by
// analysing the NFA's ambiguity, then *synthesises a concrete attack string*
// and confirms the blow-up empirically.
//
// The theory (Book: "general algorithms for testing ambiguity of finite
// automata", Allauzen–Mohri–Rastogi):
//
//   • EXPONENTIAL ambiguity (the scary kind) ⇔ there is a state q and a word w
//     with two *distinct* paths q ──w──▶ q. A backtracker forced to fail after
//     such a loop must try all 2^k ways of splitting wᵏ → time doubles per pump.
//     We detect it on the squared automaton N×N: an SCC that touches both the
//     diagonal (q,q) and an off-diagonal node (a,b≠a) gives exactly such a w.
//
// From that witness we synthesise  prefix · pumpᵏ · suffix  — the prefix drives
// the NFA to the pivot, the pump is the ambiguous loop word, and the suffix is a
// character (found by probing the real engine) that forces the match to FAIL,
// so the backtracker must explore every decomposition.
//
// Crucially we never trust the structural guess alone: we *run the real VM* at
// growing k and read the verdict off the measured curve — a constant per-pump
// multiplier means exponential, a fixed log-log slope means polynomial (degree =
// the slope), and flat/linear growth means the candidate was a false alarm and
// the pattern is safe. Measuring keeps the tool honest: no false "vulnerable!".

import type { AstFeatures, RegexNode } from './ast';
import { CharSet } from './charset';
import { runVMAt0 } from './vm';

// --- A backtracking-faithful NFA (anchors/boundaries become ε) --------------

interface Edge {
  to: number;
  set: CharSet | null; // null = ε
}

interface BtNFA {
  start: number;
  accept: number;
  count: number;
  out: Edge[][]; // adjacency
}

class NfaBuilder {
  out: Edge[][] = [];
  private add(): number {
    this.out.push([]);
    return this.out.length - 1;
  }
  private eps(from: number, to: number): void {
    this.out[from].push({ to, set: null });
  }
  private sym(from: number, to: number, set: CharSet): void {
    this.out[from].push({ to, set });
  }

  build(node: RegexNode): { start: number; end: number } {
    switch (node.type) {
      case 'empty':
      case 'anchor': // positional assertions are zero-width: ε for path structure
      case 'boundary': {
        const s = this.add();
        const e = this.add();
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'char': {
        const s = this.add();
        const e = this.add();
        this.sym(s, e, node.set);
        return { start: s, end: e };
      }
      case 'group':
        return this.build(node.node);
      case 'concat': {
        if (node.parts.length === 0) return this.build({ type: 'empty' });
        const frags = node.parts.map((p) => this.build(p));
        for (let i = 0; i < frags.length - 1; i++) this.eps(frags[i].end, frags[i + 1].start);
        return { start: frags[0].start, end: frags[frags.length - 1].end };
      }
      case 'alt': {
        const s = this.add();
        const e = this.add();
        for (const opt of node.options) {
          const f = this.build(opt);
          this.eps(s, f.start);
          this.eps(f.end, e);
        }
        return { start: s, end: e };
      }
      case 'star': {
        const s = this.add();
        const e = this.add();
        const f = this.build(node.node);
        this.eps(s, f.start);
        this.eps(f.end, e);
        this.eps(f.end, f.start);
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'plus': {
        const f = this.build(node.node);
        const e = this.add();
        this.eps(f.end, f.start);
        this.eps(f.end, e);
        return { start: f.start, end: e };
      }
      case 'opt': {
        const s = this.add();
        const e = this.add();
        const f = this.build(node.node);
        this.eps(s, f.start);
        this.eps(f.end, e);
        this.eps(s, e);
        return { start: s, end: e };
      }
      case 'repeat': {
        const frags: { start: number; end: number }[] = [];
        for (let i = 0; i < node.min; i++) frags.push(this.build(node.node));
        if (node.max === null) {
          frags.push(this.build({ type: 'star', node: node.node, lazy: false }));
        } else {
          for (let i = node.min; i < node.max; i++) frags.push(this.build({ type: 'opt', node: node.node, lazy: false }));
        }
        if (frags.length === 0) return this.build({ type: 'empty' });
        for (let i = 0; i < frags.length - 1; i++) this.eps(frags[i].end, frags[i + 1].start);
        return { start: frags[0].start, end: frags[frags.length - 1].end };
      }
      // backref / look can't appear here — analyzeRedos refuses those patterns.
      default:
        throw new Error(`unanalyzable node ${node.type}`);
    }
  }
}

function buildBtNFA(ast: RegexNode): BtNFA {
  const b = new NfaBuilder();
  const frag = b.build(ast);
  return { start: frag.start, accept: frag.end, count: b.out.length, out: b.out };
}

// Trim to *useful* states: reachable from start AND able to reach accept. An
// ambiguous loop in a dead branch never runs, so it can't cause backtracking.
function usefulStates(nfa: BtNFA): boolean[] {
  const fwd = new Array(nfa.count).fill(false);
  const stack = [nfa.start];
  fwd[nfa.start] = true;
  while (stack.length) {
    const s = stack.pop()!;
    for (const e of nfa.out[s])
      if (!fwd[e.to]) {
        fwd[e.to] = true;
        stack.push(e.to);
      }
  }
  const back = new Array(nfa.count).fill(false);
  const rev: number[][] = Array.from({ length: nfa.count }, () => []);
  for (let s = 0; s < nfa.count; s++) for (const e of nfa.out[s]) rev[e.to].push(s);
  const st2 = [nfa.accept];
  back[nfa.accept] = true;
  while (st2.length) {
    const s = st2.pop()!;
    for (const p of rev[s])
      if (!back[p]) {
        back[p] = true;
        st2.push(p);
      }
  }
  return fwd.map((f, i) => f && back[i]);
}

// --- The product (squared) automaton over a shared alphabet -----------------

interface ProdEdge {
  to: number; // encoded pair
  char: number | null; // sample code point for a symbol step; null for ε
}

export interface RedosPoint {
  k: number; // pump repetitions
  length: number; // attack-string length (code points)
  steps: number; // backtracking steps the VM consumed (anchored at index 0)
  aborted: boolean; // hit the step limit
}

export interface RedosReport {
  status: 'safe' | 'exponential' | 'polynomial' | 'unknown';
  reason: string;
  prefix?: string;
  pump?: string;
  suffix?: string;
  attackExample?: string; // prefix · pump^k0 · suffix, a ready-to-paste PoC
  exploitable?: boolean; // a failing suffix exists (the loop can be made to fail)
  empirical?: RedosPoint[];
  degree?: number; // fitted polynomial degree (status === 'polynomial')
  ratio?: number; // mean step-multiplier per extra pump (status === 'exponential')
}

const MAX_STATES_EDA = 240; // squared product stays ≤ 240² nodes

export function analyzeRedos(ast: RegexNode, groupCount: number, features: AstFeatures): RedosReport {
  if (features.backrefs || features.lookaround) {
    return {
      status: 'unknown',
      reason:
        'This pattern uses ' +
        (features.backrefs ? 'backreferences' : 'lookaround') +
        ', which change the matcher’s structure — static NFA ambiguity analysis is unsound here. (Backreferences are a classic ReDoS source even so — try the example library’s “doubled word”.)',
    };
  }
  const full = buildBtNFA(ast);
  if (full.count > MAX_STATES_EDA) {
    return { status: 'unknown', reason: `Pattern compiles to ${full.count} NFA states — above the analysis budget.` };
  }
  const useful = usefulStates(full);
  // The squared automaton finds *candidate* ambiguous loops. We never trust the
  // structural guess alone: we synthesise the attack and *measure* the real VM.
  const cand = findEDA(full, useful);
  if (!cand) {
    return {
      status: 'safe',
      reason:
        'No ambiguous loop: in the squared automaton no state reaches itself by two distinct paths over one word, so the backtracker never has a fork to explore. Matching is linear.',
    };
  }
  return finishReport(ast, groupCount, full, cand);
}

interface Witness {
  pivotPrefixTarget: number; // NFA state to reach with the prefix
  pumpStart: number; // encoded product node to start the pump from (the diagonal pivot)
  pumpGoalCheck: (enc: number) => boolean; // reached when the pump closes the loop
  k: 2 | 3;
  count: number;
  loopChars: number[]; // sample chars the ambiguous loop can consume (for richer pumps)
}

// Encode/decode k-tuples of states.
const enc2 = (a: number, b: number, n: number) => a * n + b;
const enc3 = (a: number, b: number, c: number, n: number) => (a * n + b) * n + c;

// Generic one-step successors of a product node over k synchronized tracks.
function productSucc(nfa: BtNFA, useful: boolean[], tracks: number[]): { tracks: number[]; char: number | null }[] {
  const out: { tracks: number[]; char: number | null }[] = [];
  // ε-move on a single track.
  for (let i = 0; i < tracks.length; i++) {
    for (const e of nfa.out[tracks[i]]) {
      if (e.set !== null || !useful[e.to]) continue;
      const nt = tracks.slice();
      nt[i] = e.to;
      out.push({ tracks: nt, char: null });
    }
  }
  // Symbol-move on *all* tracks over a common, non-empty character class.
  const choices = tracks.map((s) => nfa.out[s].filter((e) => e.set !== null && useful[e.to]));
  const recurse = (i: number, picked: Edge[], inter: CharSet | null): void => {
    if (i === tracks.length) {
      const c = (inter as CharSet).samplePrintable();
      if (c === null) return;
      out.push({ tracks: picked.map((e) => e.to), char: c });
      return;
    }
    for (const e of choices[i]) {
      const ni = inter === null ? (e.set as CharSet) : inter.intersect(e.set as CharSet);
      if (ni.isEmpty()) continue;
      recurse(i + 1, [...picked, e], ni);
    }
  };
  recurse(0, [], null);
  return out;
}

// --- EDA: squared product + SCC analysis ------------------------------------

function findEDA(nfa: BtNFA, useful: boolean[]): Witness | null {
  const n = nfa.count;
  if (!useful[nfa.start]) return null;
  const adj = new Map<number, ProdEdge[]>();
  const order: number[] = [];
  const startEnc = enc2(nfa.start, nfa.start, n);
  const seen = new Set<number>([startEnc]);
  const queue = [startEnc];
  while (queue.length) {
    const cur = queue.shift()!;
    const a = Math.floor(cur / n);
    const b = cur % n;
    const succ = productSucc(nfa, useful, [a, b]).map((s) => ({ to: enc2(s.tracks[0], s.tracks[1], n), char: s.char }));
    adj.set(cur, succ);
    order.push(cur);
    for (const e of succ)
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
  }
  // Tarjan SCC over the reachable product graph.
  const comp = tarjan(order, adj);
  // Group nodes + whether each component has an internal symbol edge.
  const members = new Map<number, number[]>();
  const hasSym = new Map<number, boolean>();
  for (const node of order) {
    const c = comp.get(node)!;
    (members.get(c) ?? members.set(c, []).get(c)!).push(node);
    for (const e of adj.get(node)!) {
      if (e.char !== null && comp.get(e.to) === c) hasSym.set(c, true);
    }
  }
  for (const [c, nodes] of members) {
    if (nodes.length < 1 || !hasSym.get(c)) continue;
    let diag = -1;
    let offDiag = false;
    for (const node of nodes) {
      const a = Math.floor(node / n);
      const b = node % n;
      if (a === b) diag = node;
      else offDiag = true;
    }
    if (diag >= 0 && offDiag) {
      // Chars the ambiguous loop can consume — used to build richer pump strings
      // (the minimal cycle may be a benign delimiter; exercising loop *content*
      // is what triggers the blow-up, e.g. "a," not "," for /(.*,)*/).
      const loopChars = new Set<number>();
      for (const node of nodes) {
        for (const e of adj.get(node)!) {
          if (e.char !== null && comp.get(e.to) === c) loopChars.add(e.char);
        }
      }
      return {
        pivotPrefixTarget: Math.floor(diag / n),
        pumpStart: diag,
        pumpGoalCheck: (enc) => enc === diag,
        k: 2,
        count: n,
        loopChars: [...loopChars].slice(0, 4),
      };
    }
  }
  return null;
}

// --- Tarjan's SCC (iterative) ----------------------------------------------

function tarjan(order: number[], adj: Map<number, ProdEdge[]>): Map<number, number> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const comp = new Map<number, number>();
  let idx = 0;
  let nextComp = 0;
  for (const root of order) {
    if (index.has(root)) continue;
    const work: { node: number; ei: number }[] = [{ node: root, ei: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.node;
      if (frame.ei === 0) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
      }
      const edges = adj.get(v)!;
      if (frame.ei < edges.length) {
        const w = edges[frame.ei].to;
        frame.ei++;
        if (!index.has(w)) {
          work.push({ node: w, ei: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      } else {
        if (low.get(v) === index.get(v)) {
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, nextComp);
            if (w === v) break;
          }
          nextComp++;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }
  return comp;
}

// --- Witness → concrete attack string + empirical confirmation --------------

const STEP_LIMIT = 5_000_000;

// Probe characters used to *discover* a suffix that forces the match to fail.
const SUFFIX_PROBES = '!#;:=<>?/%~^.,-_@ \n\tZqQ09abx'.split('');

function measureCurve(ast: RegexNode, groupCount: number, prefix: string, pump: string, suffix: string): RedosPoint[] {
  // Arithmetic series ⇒ input length grows linearly, so exponential work shows a
  // constant per-row multiplier while polynomial work shows a fixed log-log slope.
  const out: RedosPoint[] = [];
  for (let k = 2; k <= 28; k += 2) {
    const attack = prefix + pump.repeat(k) + suffix;
    const r = runVMAt0(ast, groupCount, attack, { stepLimit: STEP_LIMIT });
    out.push({ k, length: Array.from(attack).length, steps: r.steps, aborted: r.aborted });
    if (r.aborted) break;
  }
  return out;
}

// A suffix that makes `prefix·pump^k·suffix` *fail* to match — that failure is
// exactly what forces the backtracker to try every decomposition. Found by
// running the real engine: any probe char yielding no match qualifies.
function findFailingSuffix(ast: RegexNode, groupCount: number, prefix: string, pump: string): string | null {
  const base = prefix + pump.repeat(6);
  for (const c of SUFFIX_PROBES) {
    const r = runVMAt0(ast, groupCount, base + c, { stepLimit: STEP_LIMIT });
    if (r.match === null || r.aborted) return c; // no match (or already blowing up) ⇒ failure forced
  }
  return null;
}

function rank(g: Growth): number {
  return g.kind === 'exponential' ? 3 : g.kind === 'polynomial' ? 2 : 1;
}

function finishReport(ast: RegexNode, groupCount: number, nfa: BtNFA, w: Witness): RedosReport {
  const prefix = shortestWordTo(nfa, w.pivotPrefixTarget);
  const minPump = pumpWord(nfa, usefulStates(nfa), w);

  if (minPump === null || minPump.length === 0) {
    return { status: 'safe', reason: 'A loop is structurally ambiguous, but only over the empty string, so no input can pump it.' };
  }

  // Candidate pumps: the minimal cycle, plus variants that prepend a unit of loop
  // *content* — the minimal cycle is often a benign delimiter, while content is
  // what creates redistributable ambiguity (the /(.*,)*/ family).
  const candidates = new Set<string>([minPump]);
  for (const code of w.loopChars) {
    const ch = String.fromCodePoint(code);
    candidates.add(ch + minPump);
    candidates.add(ch);
  }

  let best: { pump: string; suffix: string; empirical: RedosPoint[]; verdict: Growth } | null = null;
  let bestExploitable = false;
  for (const pump of candidates) {
    const suffix = findFailingSuffix(ast, groupCount, prefix, pump);
    if (suffix === null) continue; // can't be forced to fail with this pump
    bestExploitable = true;
    const empirical = measureCurve(ast, groupCount, prefix, pump, suffix);
    const verdict = classifyGrowth(empirical);
    if (!best || rank(verdict) > rank(best.verdict)) best = { pump, suffix, empirical, verdict };
    if (verdict.kind === 'exponential') break; // can't do worse than exponential
  }

  if (!best) {
    return {
      status: 'safe',
      reason: 'A loop is ambiguous, but the match can’t be forced to fail (the pattern consumes every character, e.g. /.*.*/), so there is no decomposition for the engine to backtrack over.',
      prefix,
      pump: minPump,
      exploitable: bestExploitable,
    };
  }

  const { pump, suffix, empirical, verdict } = best;
  const k0 = 6;
  const attackExample = prefix + pump.repeat(k0) + suffix;

  if (verdict.kind === 'safe') {
    return {
      status: 'safe',
      reason: 'The squared automaton flagged a candidate loop, but measuring the real engine on the synthesised attack shows the work stays linear — this pattern is safe.',
      prefix,
      pump,
      suffix,
      exploitable: true,
      attackExample,
      empirical,
    };
  }
  if (verdict.kind === 'exponential') {
    return {
      status: 'exponential',
      reason: `Exponential backtracking confirmed. The loop has two distinct ways to consume the pump “${shorten(pump)}”, so after k copies the engine tries ~${verdict.ratio.toFixed(1)}ᵏ decompositions before the trailing “${suffix}” forces failure. A few dozen characters can hang a server.`,
      prefix,
      pump,
      suffix,
      exploitable: true,
      attackExample,
      empirical,
      ratio: verdict.ratio,
    };
  }
  return {
    status: 'polynomial',
    reason: `Polynomial backtracking confirmed (degree ≈ ${verdict.degree}). Work grows like n^${verdict.degree} in the input length — fast enough to be a denial-of-service risk on long inputs, though not as explosive as the exponential case.`,
    prefix,
    pump,
    suffix,
    exploitable: true,
    attackExample,
    empirical,
    degree: verdict.degree,
  };
}

type Growth =
  | { kind: 'safe' }
  | { kind: 'exponential'; ratio: number }
  | { kind: 'polynomial'; degree: number };

// Classify from the measured curve. Exponential ⇒ steps multiply by a roughly
// constant factor for each equal increment of k (and usually abort early).
// Otherwise fit a log-log slope of steps vs input length: slope ≈ degree.
function classifyGrowth(data: RedosPoint[]): Growth {
  const pts = data.filter((p) => p.steps > 0);
  if (pts.length < 3) return { kind: 'safe' };
  const aborted = data.some((p) => p.aborted);

  // Geometric-mean step ratio across consecutive (arithmetic-k) rows.
  let logSum = 0;
  let cnt = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].steps > 0) {
      logSum += Math.log(pts[i].steps / pts[i - 1].steps);
      cnt++;
    }
  }
  const ratio = Math.exp(logSum / Math.max(cnt, 1));
  // k grows by +2 each row; a constant per-row multiplier ≥ ~1.35 (≈ 2 per +1)
  // means exponential. Aborting early reinforces it.
  if (ratio >= 1.35 && (aborted || ratio >= 1.6)) {
    return { kind: 'exponential', ratio: Math.sqrt(ratio) }; // per +1 pump
  }

  // Log-log slope of steps vs length (least squares).
  const xs = pts.map((p) => Math.log(p.length));
  const ys = pts.map((p) => Math.log(p.steps));
  const slope = leastSquaresSlope(xs, ys);
  if (slope >= 1.6) return { kind: 'polynomial', degree: Math.max(2, Math.round(slope)) };
  return { kind: 'safe' };
}

function leastSquaresSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function shorten(s: string): string {
  return s.length > 16 ? s.slice(0, 16) + '…' : s;
}

// Shortest concrete string that drives the NFA from start to `target`.
function shortestWordTo(nfa: BtNFA, target: number): string {
  if (target === nfa.start) return '';
  const prev = new Map<number, { from: number; ch: number | null }>();
  const seen = new Set<number>([nfa.start]);
  const queue = [nfa.start];
  while (queue.length) {
    const s = queue.shift()!;
    if (s === target) break;
    for (const e of nfa.out[s]) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: s, ch: e.set === null ? null : e.set.samplePrintable() });
      queue.push(e.to);
    }
  }
  if (!prev.has(target)) return '';
  const chars: number[] = [];
  let cur = target;
  while (cur !== nfa.start) {
    const p = prev.get(cur)!;
    if (p.ch !== null) chars.push(p.ch);
    cur = p.from;
  }
  chars.reverse();
  return String.fromCodePoint(...chars);
}

// A pump word: a non-empty string that closes the ambiguous loop while passing
// through an off-diagonal node (so the two coordinate-paths genuinely differ).
function pumpWord(nfa: BtNFA, useful: boolean[], w: Witness): string | null {
  const n = nfa.count;
  // Augmented BFS over (productNode, sawOffDiagonal, sawSymbol).
  type Key = number; // node*4 + sawOff*2 + sawSym
  const decodeNode = (enc: number): number[] => {
    if (w.k === 2) return [Math.floor(enc / n), enc % n];
    return [Math.floor(enc / (n * n)), Math.floor(enc / n) % n, enc % n];
  };
  const isOff = (enc: number): boolean => {
    const t = decodeNode(enc);
    return !t.every((x) => x === t[0]);
  };
  const startKey: Key = w.pumpStart * 4 + (isOff(w.pumpStart) ? 2 : 0) + 0;
  const prev = new Map<Key, { from: Key; ch: number | null }>();
  const seen = new Set<Key>([startKey]);
  const queue: Key[] = [startKey];
  let goalKey: Key | null = null;
  while (queue.length) {
    const cur = queue.shift()!;
    const node = Math.floor(cur / 4);
    const sawOff = (cur & 2) !== 0;
    const sawSym = (cur & 1) !== 0;
    if (sawOff && sawSym && cur !== startKey && w.pumpGoalCheck(node)) {
      goalKey = cur;
      break;
    }
    const tracks = decodeNode(node);
    for (const s of productSucc(nfa, useful, tracks)) {
      const enc = w.k === 2 ? enc2(s.tracks[0], s.tracks[1], n) : enc3(s.tracks[0], s.tracks[1], s.tracks[2], n);
      const off2 = sawOff || isOff(enc);
      const sym2 = sawSym || s.char !== null;
      const key: Key = enc * 4 + (off2 ? 2 : 0) + (sym2 ? 1 : 0);
      if (!seen.has(key)) {
        seen.add(key);
        prev.set(key, { from: cur, ch: s.char });
        queue.push(key);
      }
    }
  }
  if (goalKey === null) return null;
  const chars: number[] = [];
  let cur: Key = goalKey;
  while (cur !== startKey) {
    const p = prev.get(cur)!;
    if (p.ch !== null) chars.push(p.ch);
    cur = p.from;
  }
  chars.reverse();
  return chars.length ? String.fromCodePoint(...chars) : null;
}

