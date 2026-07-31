// Tagged DFA (TDFA) — capture groups as a *deterministic automaton*, not a
// backtracker.
//
// The Pike VM (engine/pike.ts) reports capture groups by running a breadth-first
// set of NFA threads, each carrying its own copy of the capture slots. That is
// linear in the input but re-does the ε-closure and copies the slot array at
// every step. A **Tagged DFA** pushes all of that work to *compile time*: it
// determinises the tagged NFA once, into a machine that reads one character,
// follows one edge, and executes a handful of *register operations* — and never
// forks a thread or copies a slot array again. This is the construction behind
// re2c's submatch extraction and Ville Laurikari's 2000 thesis.
//
// The tagged NFA we determinise is exactly the Pike bytecode: a `save slot`
// instruction is a **tag** t (the position where a group boundary was crossed),
// `split` encodes thread **priority** (x before y = greedy preference), and the
// priority order of threads decides the leftmost-greedy (Perl/PCRE) parse. So we
// reuse `compileProgram` verbatim and inherit the exact semantics the rest of the
// studio already trusts.
//
// The subtle part is keeping the machine *finite*. Tag values are input
// positions, so a naive subset construction that stored them would have
// infinitely many states. The fix (Laurikari): a DFA state stores, per NFA
// configuration and per tag, a **register** — an abstract cell — rather than a
// concrete position. Two states are "the same" when they agree up to a renaming
// of registers; a transition into an existing state carries the **copy ops** that
// reconcile the two namings, and a tag crossed on a transition becomes a
// `set register ← current position` op. The registers are filled in at *run*
// time by executing the ops along the path — a single pass, no per-thread state.
//
// Correctness is not asserted, it is *checked*: `engine/tags/verify.ts` diffs
// this TDFA's captures against a transparent whole-string thread-list simulator
// (`simulateTagged`, below) and against the platform's own `RegExp` capture
// indices, over thousands of seeded random patterns and inputs.

import { CharSet } from '../charset';
import type { CaptureSpan } from '../vm';
import { compileProgram, PikeUnsupported, type Inst, type Program } from '../pike';
import type { RegexNode } from '../ast';

// --- Alphabet partition ----------------------------------------------------
// Cut the code-point line at every `char` class boundary so each atom is wholly
// inside or outside every instruction's set — the same trick subset construction
// uses (engine/dfa.ts), but over the Pike program's char instructions.

export interface TagAtom {
  set: CharSet;
  lo: number;
  hi: number;
}

export function partitionProgram(insts: Inst[]): TagAtom[] {
  const cuts = new Set<number>();
  const union: CharSet[] = [];
  for (const inst of insts) {
    if (inst.op !== 'char') continue;
    union.push(inst.set);
    for (const r of inst.set.ranges) {
      cuts.add(r.lo);
      cuts.add(r.hi + 1);
    }
  }
  if (union.length === 0) return [];
  const covered = CharSet.union(union);
  const points = [...cuts].sort((a, b) => a - b);
  const atoms: TagAtom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    if (covered.contains(lo)) atoms.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }
  return atoms;
}

export function atomIndexFor(atoms: TagAtom[], code: number): number {
  let lo = 0;
  let hi = atoms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = atoms[mid];
    if (code < at.lo) hi = mid - 1;
    else if (code > at.hi) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// --- The reference: a whole-string tagged thread-list simulator -------------
//
// This is the plain-as-possible oracle the determinised machine is checked
// against. It is the Pike thread-list, with two deliberate differences from
// engine/pike.ts: (1) it matches the *whole* string (accept only at end-of-input)
// so captures are well-defined for every parse, and (2) it does **not** cut lower-
// priority threads when a `match` is reached mid-string — a lower-priority thread
// may be the only one that reaches the end. Among the threads that do reach the
// end at `match`, the highest-priority one is the leftmost-greedy parse.

export class TdfaUnsupported extends Error {}

function assertRegular(insts: Inst[]): void {
  for (const inst of insts) {
    if (inst.op === 'assert') {
      throw new TdfaUnsupported('zero-width assertions (^ $ \\b) are position-dependent — outside the symbol-driven TDFA');
    }
  }
}

interface SimItem {
  pc: number;
  saved: Int32Array;
}

// ε-closure that walks split/jmp/save, collecting `char`/`match` pcs in priority
// order, deduped per generation. Saves record `at` into their slot.
function closeSim(insts: Inst[], out: SimItem[], seen: Int32Array, gen: number, pc: number, at: number, saved: Int32Array): void {
  if (seen[pc] === gen) return;
  seen[pc] = gen;
  const inst = insts[pc];
  switch (inst.op) {
    case 'jmp':
      closeSim(insts, out, seen, gen, inst.x, at, saved);
      return;
    case 'split':
      closeSim(insts, out, seen, gen, inst.x, at, saved);
      closeSim(insts, out, seen, gen, inst.y, at, saved);
      return;
    case 'save': {
      const next = saved.slice();
      next[inst.slot] = at;
      closeSim(insts, out, seen, gen, pc + 1, at, next);
      return;
    }
    case 'char':
    case 'match':
      out.push({ pc, saved });
      return;
    case 'assert':
      throw new TdfaUnsupported('assertions unsupported');
  }
}

function savedToGroups(saved: Int32Array, groupCount: number): (CaptureSpan | null)[] {
  const groups: (CaptureSpan | null)[] = [];
  for (let g = 0; g <= groupCount; g++) {
    const a = saved[2 * g];
    const b = saved[2 * g + 1];
    groups.push(a >= 0 && b >= 0 ? { start: a, end: b } : null);
  }
  return groups;
}

export interface TaggedMatch {
  groups: (CaptureSpan | null)[]; // index 0 = whole match; 1..groupCount = groups
}

// Whole-string capture via the reference thread list. Returns null if the pattern
// does not match the entire input.
export function simulateTagged(prog: Program, groupCount: number, codes: number[]): TaggedMatch | null {
  assertRegular(prog.insts);
  const insts = prog.insts;
  const n = codes.length;
  const seen = new Int32Array(insts.length).fill(-1);
  let gen = 0;

  let clist: SimItem[] = [];
  const s0 = new Int32Array(prog.nslots).fill(-1);
  closeSim(insts, clist, seen, gen, 0, 0, s0);

  for (let p = 0; p < n; p++) {
    const nlist: SimItem[] = [];
    gen++;
    for (const item of clist) {
      const inst = insts[item.pc];
      if (inst.op === 'char' && inst.set.contains(codes[p])) {
        closeSim(insts, nlist, seen, gen, item.pc + 1, p + 1, item.saved);
      }
    }
    clist = nlist;
  }

  for (const item of clist) {
    if (insts[item.pc].op === 'match') {
      return { groups: savedToGroups(item.saved, groupCount) };
    }
  }
  return null;
}

// --- The Tagged DFA ---------------------------------------------------------

// A register operation executed along a transition (or at machine start).
export type RegOp =
  | { kind: 'set'; reg: number } // reg ← current input position
  | { kind: 'copy'; dst: number; src: number }; // dst ← src

// A *semantic* register assignment on a transition: destination register ←
// current position (src === -1) or ← a source register. A transition is a
// parallel assignment of these; `scheduleAssign` turns it into a clobber-safe
// sequence of RegOps. Keeping the assignment separate from its schedule is what
// lets the minimiser renumber registers and re-schedule without redoing the
// determinisation.
export interface Assign {
  dest: number;
  src: number; // -1 ⇒ set from current position; otherwise copy from this register
}

// Sequence a parallel assignment so no write clobbers a source that is still
// needed. Any source register that is also a destination is first snapshotted
// into a fresh scratch register (allocated via `scratchId`), then read from there.
export function scheduleAssign(assign: Assign[], scratchId: (k: number) => number): { ops: RegOp[]; scratch: number } {
  const destSet = new Set(assign.map((a) => a.dest));
  const scratchOf = new Map<number, number>();
  let localScratch = 0;
  const pre: RegOp[] = [];
  const post: RegOp[] = [];
  for (const a of assign) {
    if (a.src === -1) {
      post.push({ kind: 'set', reg: a.dest });
      continue;
    }
    if (a.src === a.dest) continue; // identity — nothing to do
    let src = a.src;
    if (destSet.has(a.src)) {
      let sc = scratchOf.get(a.src);
      if (sc === undefined) {
        sc = scratchId(localScratch++);
        scratchOf.set(a.src, sc);
        pre.push({ kind: 'copy', dst: sc, src: a.src });
      }
      src = sc;
    }
    post.push({ kind: 'copy', dst: a.dest, src });
  }
  return { ops: [...pre, ...post], scratch: localScratch };
}

interface Config {
  pc: number;
  regs: Int32Array; // regs[slot] = register id holding that slot's value, or -1 (unset)
}

export interface TDFAState {
  id: number;
  configs: Config[]; // priority order, deduped by pc
  accept: boolean;
  acceptRegs: Int32Array | null; // regs of the highest-priority `match` config
  regByCanon: number[]; // canonical-index → materialised register id
}

export interface TDFA {
  prog: Program;
  atoms: TagAtom[];
  states: TDFAState[];
  start: number;
  initialOps: RegOp[]; // run once at position 0, before reading input
  initialAssign: Assign[]; // the semantic form of initialOps (for the minimiser)
  table: Int32Array[]; // table[state][atom] = next state id, or -1 for the dead sink
  edgeOps: RegOp[][][]; // edgeOps[state][atom] = ops for that transition
  edgeAssign: Assign[][][]; // the semantic form of edgeOps
  regCount: number; // total registers, including the scratch pool
  matRegCount: number; // materialised (non-scratch) registers
  slotCount: number; // = prog.nslots
  groupCount: number;
  truncated: boolean; // hit the state / register budget
  buildSteps: number; // configurations expanded — a build-work proxy
  minimizedFrom: number | null; // if this machine came from register minimisation, the original matRegCount
}

// A saved-slot in a candidate config points to one of:
//   -1            : unset
//   [0, TEMP_BASE): a carried register (materialised in the source state)
//   >= TEMP_BASE  : a "set to current position" marker for this transition
const TEMP_BASE = 1 << 28;

export interface TdfaOptions {
  maxStates?: number;
  maxRegs?: number;
}

export function buildTDFA(prog: Program, groupCount: number, opts: TdfaOptions = {}): TDFA {
  assertRegular(prog.insts);
  const insts = prog.insts;
  const maxStates = opts.maxStates ?? 4000;
  const maxRegs = opts.maxRegs ?? 200_000;
  const atoms = partitionProgram(insts);

  const states: TDFAState[] = [];
  const stateByKey = new Map<string, number>();
  let regCount = 0; // materialised registers (scratch is appended after the build)
  let maxScratch = 0; // widest per-edge scratch need — scratch cells are reused across edges
  let truncated = false;
  let buildSteps = 0;
  const allocReg = (): number => regCount++;
  // Scratch registers are encoded as negative placeholders during the build and
  // remapped to a shared pool above the materialised range once regCount is final.
  const scratchPlaceholder = (k: number): number => -(k + 1);

  // Close a set of seed configs into the ordered char/match config list, marking
  // saved slots with temp markers (one per distinct slot saved this closure).
  function closure(seeds: Config[]): Config[] {
    const out: Config[] = [];
    const seen = new Int32Array(insts.length).fill(-1);
    const gen = 0;
    // one temp marker per distinct slot saved anywhere in this closure
    const tempForSlot = new Map<number, number>();
    let nextTemp = TEMP_BASE;

    const walk = (pc: number, regs: Int32Array): void => {
      if (seen[pc] === gen) return;
      seen[pc] = gen;
      buildSteps++;
      const inst = insts[pc];
      switch (inst.op) {
        case 'jmp':
          walk(inst.x, regs);
          return;
        case 'split':
          walk(inst.x, regs);
          walk(inst.y, regs);
          return;
        case 'save': {
          let t = tempForSlot.get(inst.slot);
          if (t === undefined) {
            t = nextTemp++;
            tempForSlot.set(inst.slot, t);
          }
          const next = regs.slice();
          next[inst.slot] = t;
          walk(pc + 1, next);
          return;
        }
        case 'char':
        case 'match':
          out.push({ pc, regs });
          return;
        case 'assert':
          throw new TdfaUnsupported('assertions unsupported');
      }
    };
    for (const seed of seeds) walk(seed.pc, seed.regs);
    return out;
  }

  // Canonicalise a candidate config list: assign each distinct register value
  // (carried reg or temp marker; -1 excluded) a canonical index by first
  // appearance, scanning configs in priority order and slots low→high. Returns
  // the key, the ordered distinct values, and a per-value "is this a temp?" flag.
  function canonicalise(configs: Config[]): {
    key: string;
    values: number[]; // canonical-index → original candidate value (carried reg or temp marker)
    canonOf: Map<number, number>;
  } {
    const canonOf = new Map<number, number>();
    const values: number[] = [];
    const rows: string[] = [];
    for (const cfg of configs) {
      const cells: number[] = [];
      for (let slot = 0; slot < cfg.regs.length; slot++) {
        const v = cfg.regs[slot];
        if (v === -1) {
          cells.push(-1);
          continue;
        }
        let ci = canonOf.get(v);
        if (ci === undefined) {
          ci = values.length;
          canonOf.set(v, ci);
          values.push(v);
        }
        cells.push(ci);
      }
      rows.push(cfg.pc + ':' + cells.join(','));
    }
    return { key: rows.join('|'), values, canonOf };
  }

  // Turn a candidate config list into a destination state (existing or new) and
  // the semantic register assignment that establishes that state's registers
  // from the source's.
  function resolve(configs: Config[]): { id: number; assign: Assign[] } | null {
    const { key, values, canonOf } = canonicalise(configs);
    let dest = stateByKey.get(key);

    if (dest === undefined) {
      if (states.length >= maxStates || regCount + values.length > maxRegs) {
        truncated = true;
        return null;
      }
      // Allocate one fresh materialised register per canonical index.
      const regByCanon = values.map(() => allocReg());
      const matConfigs: Config[] = configs.map((cfg) => {
        const regs = new Int32Array(cfg.regs.length);
        for (let slot = 0; slot < cfg.regs.length; slot++) {
          const v = cfg.regs[slot];
          regs[slot] = v === -1 ? -1 : regByCanon[canonOf.get(v)!];
        }
        return { pc: cfg.pc, regs };
      });
      let accept = false;
      let acceptRegs: Int32Array | null = null;
      for (const cfg of matConfigs) {
        if (insts[cfg.pc].op === 'match') {
          accept = true;
          acceptRegs = cfg.regs;
          break; // highest-priority match config
        }
      }
      const id = states.length;
      states.push({ id, configs: matConfigs, accept, acceptRegs, regByCanon });
      stateByKey.set(key, id);
      dest = id;
    }

    // The semantic assignment: every canonical register of `dest` ← either the
    // current position (a tag crossed on this edge) or a carried source register.
    const targets = states[dest].regByCanon; // canon-index → dest reg
    const assign: Assign[] = [];
    for (let ci = 0; ci < values.length; ci++) {
      const v = values[ci];
      assign.push({ dest: targets[ci], src: v >= TEMP_BASE ? -1 : v });
    }
    return { id: dest, assign };
  }

  const table: Int32Array[] = [];
  const edgeAssign: Assign[][][] = [];
  const ensureRows = (id: number): void => {
    while (table.length <= id) {
      table.push(new Int32Array(atoms.length).fill(-1));
      edgeAssign.push(atoms.map(() => [] as Assign[]));
    }
  };

  // Initial state: closure from pc 0 with all slots unset.
  const initSeed: Config = { pc: 0, regs: new Int32Array(prog.nslots).fill(-1) };
  const initResolved = resolve(closure([initSeed]));
  const emptyTdfa = (): TDFA => ({
    prog,
    atoms,
    states,
    start: 0,
    initialOps: [],
    initialAssign: [],
    table: [],
    edgeOps: [],
    edgeAssign: [],
    regCount,
    matRegCount: regCount,
    slotCount: prog.nslots,
    groupCount,
    truncated: true,
    buildSteps,
    minimizedFrom: null,
  });
  if (!initResolved) return emptyTdfa();
  const start = initResolved.id;
  const initialAssign = initResolved.assign;
  ensureRows(start);

  const queue = [start];
  const processed = new Set<number>();
  while (queue.length && !truncated) {
    const from = queue.shift()!;
    if (processed.has(from)) continue;
    processed.add(from);
    const src = states[from];
    for (let a = 0; a < atoms.length; a++) {
      const sample = atoms[a].lo;
      // configs that consume this atom, advanced one instruction, regs carried
      const seeds: Config[] = [];
      for (const cfg of src.configs) {
        const inst = insts[cfg.pc];
        if (inst.op === 'char' && inst.set.contains(sample)) {
          seeds.push({ pc: cfg.pc + 1, regs: cfg.regs });
        }
      }
      if (seeds.length === 0) continue;
      const before = states.length;
      const resolved = resolve(closure(seeds));
      if (!resolved) break;
      ensureRows(Math.max(resolved.id, from));
      table[from][a] = resolved.id;
      edgeAssign[from][a] = resolved.assign;
      if (resolved.id === before) queue.push(resolved.id);
      else if (!processed.has(resolved.id) && !queue.includes(resolved.id)) queue.push(resolved.id);
    }
  }
  // Make sure every reachable state has table rows (states with no out-edges).
  for (const st of states) ensureRows(st.id);
  const matRegCount = regCount;

  // Schedule every assignment into clobber-safe ops, using placeholder scratch
  // registers (negative) that are remapped to a shared pool above the materialised
  // range — scratch cells are live only within a single transition, so all edges
  // reuse the same `maxScratch` cells.
  const schedule = (assign: Assign[]): RegOp[] => {
    const r = scheduleAssign(assign, scratchPlaceholder);
    if (r.scratch > maxScratch) maxScratch = r.scratch;
    return r.ops;
  };
  const initialOps = schedule(initialAssign);
  const edgeOps: RegOp[][][] = edgeAssign.map((row) => row.map(schedule));

  const scratchBase = regCount;
  const fixReg = (r: number): number => (r < 0 ? scratchBase + (-r - 1) : r);
  const fixOps = (ops: RegOp[]): void => {
    for (const op of ops) {
      if (op.kind === 'set') op.reg = fixReg(op.reg);
      else {
        op.dst = fixReg(op.dst);
        op.src = fixReg(op.src);
      }
    }
  };
  fixOps(initialOps);
  for (const row of edgeOps) for (const ops of row) fixOps(ops);
  regCount += maxScratch;

  return {
    prog,
    atoms,
    states,
    start,
    initialOps,
    initialAssign,
    table,
    edgeOps,
    edgeAssign,
    regCount,
    matRegCount,
    slotCount: prog.nslots,
    groupCount,
    truncated,
    buildSteps,
    minimizedFrom: null,
  };
}

// --- Running the TDFA -------------------------------------------------------

export interface TdfaRunStep {
  pos: number; // input position *after* this step (boundary index)
  code: number | null; // the code point consumed to get here (null for the initial step)
  atom: number | null; // atom index taken
  fromState: number;
  toState: number;
  ops: RegOp[];
}

export interface TdfaRun {
  match: TaggedMatch | null; // whole-string capture, or null if no full match
  steps: TdfaRunStep[]; // one per input character, plus the initial seed step
  regFile: Int32Array; // final register file (for inspection)
  deadAt: number | null; // input index where the machine fell off the table, if any
}

function applyOps(regFile: Int32Array, ops: RegOp[], pos: number): void {
  for (const op of ops) {
    if (op.kind === 'set') regFile[op.reg] = pos;
    else regFile[op.dst] = regFile[op.src];
  }
}

export function runTDFA(tdfa: TDFA, codes: number[]): TdfaRun {
  const regFile = new Int32Array(tdfa.regCount).fill(-1);
  const steps: TdfaRunStep[] = [];
  applyOps(regFile, tdfa.initialOps, 0);
  steps.push({ pos: 0, code: null, atom: null, fromState: tdfa.start, toState: tdfa.start, ops: tdfa.initialOps });

  let state = tdfa.start;
  let deadAt: number | null = null;
  for (let p = 0; p < codes.length; p++) {
    const a = atomIndexFor(tdfa.atoms, codes[p]);
    const to = a < 0 ? -1 : tdfa.table[state][a];
    if (to < 0) {
      deadAt = p;
      break;
    }
    const ops = tdfa.edgeOps[state][a];
    applyOps(regFile, ops, p + 1);
    steps.push({ pos: p + 1, code: codes[p], atom: a, fromState: state, toState: to, ops });
    state = to;
  }

  let match: TaggedMatch | null = null;
  if (deadAt === null) {
    const st = tdfa.states[state];
    if (st.accept && st.acceptRegs) {
      const groups: (CaptureSpan | null)[] = [];
      for (let g = 0; g <= tdfa.groupCount; g++) {
        const ra = st.acceptRegs[2 * g];
        const rb = st.acceptRegs[2 * g + 1];
        const a = ra >= 0 ? regFile[ra] : -1;
        const b = rb >= 0 ? regFile[rb] : -1;
        groups.push(a >= 0 && b >= 0 ? { start: a, end: b } : null);
      }
      match = { groups };
    }
  }
  return { match, steps, regFile, deadAt };
}

// --- Convenience: compile a regular AST straight to a TDFA ------------------

export function astToTDFA(ast: RegexNode, groupCount: number, opts?: TdfaOptions): TDFA {
  let prog: Program;
  try {
    prog = compileProgram(ast, groupCount);
  } catch (e) {
    if (e instanceof PikeUnsupported) throw new TdfaUnsupported(e.message);
    throw e;
  }
  return buildTDFA(prog, groupCount, opts);
}

// --- Register minimisation --------------------------------------------------
//
// In a TDFA built by `buildTDFA`, every materialised register is written by the
// edges *entering* its home state and read only by the edges *leaving* that state
// (plus that state's accept read) — no register value survives a transition
// un-rewritten, because every incoming edge redefines the whole destination state.
// So a register's live range is a single state, and registers homed in different
// states never conflict. That makes a correct, near-optimal reallocation cheap:
// drop registers that are never read at all, then renumber each state's live
// registers into a small pool that is *reused* across every state. Each edge is
// re-scheduled (clobber-safe) under the new numbering.
//
// The result is verified the same way as the machine itself — see
// `engine/tags/verify.ts`, which runs the minimised TDFA through the differential
// harness alongside the original.
export function minimizeRegisters(tdfa: TDFA): TDFA {
  if (tdfa.truncated || tdfa.states.length === 0) return tdfa;
  const N = tdfa.matRegCount;

  // 1. Liveness: a register is read as some edge's source, or at an accept.
  const live = new Uint8Array(N);
  for (const row of tdfa.edgeAssign) for (const assign of row) for (const a of assign) if (a.src >= 0) live[a.src] = 1;
  for (const st of tdfa.states) if (st.accept && st.acceptRegs) for (const r of st.acceptRegs) if (r >= 0) live[r] = 1;

  // 2. Renumber each state's live registers into cells reused across states.
  const newId = new Int32Array(N).fill(-1);
  let pool = 0;
  for (const st of tdfa.states) {
    let cell = 0;
    for (const r of st.regByCanon) if (r >= 0 && live[r]) newId[r] = cell++;
    if (cell > pool) pool = cell;
  }
  const mapReg = (r: number): number => (r < 0 ? -1 : newId[r]);

  // 3. Rebuild states (configs, acceptRegs, regByCanon) under the new numbering.
  const states: TDFAState[] = tdfa.states.map((st) => {
    const configs = st.configs.map((c) => {
      const regs = new Int32Array(c.regs.length);
      for (let s = 0; s < c.regs.length; s++) regs[s] = mapReg(c.regs[s]);
      return { pc: c.pc, regs };
    });
    let acceptRegs: Int32Array | null = null;
    if (st.acceptRegs) {
      acceptRegs = new Int32Array(st.acceptRegs.length);
      for (let s = 0; s < st.acceptRegs.length; s++) acceptRegs[s] = mapReg(st.acceptRegs[s]);
    }
    return { id: st.id, configs, accept: st.accept, acceptRegs, regByCanon: st.regByCanon.map(mapReg).filter((r) => r >= 0) };
  });

  // 4. Remap + re-schedule assignments, dropping writes to dead destinations.
  let maxScratch = 0;
  const remapAssign = (assign: Assign[]): Assign[] =>
    assign.filter((a) => live[a.dest]).map((a) => ({ dest: newId[a.dest], src: a.src < 0 ? -1 : newId[a.src] }));
  const schedule = (assign: Assign[]): RegOp[] => {
    const r = scheduleAssign(remapAssign(assign), (k) => pool + k);
    if (r.scratch > maxScratch) maxScratch = r.scratch;
    return r.ops;
  };
  const initialOps = schedule(tdfa.initialAssign);
  const edgeOps = tdfa.edgeAssign.map((row) => row.map(schedule));

  return {
    ...tdfa,
    states,
    initialOps,
    edgeOps,
    matRegCount: pool,
    regCount: pool + maxScratch,
    minimizedFrom: tdfa.matRegCount,
  };
}

// --- C code generation ------------------------------------------------------
//
// The endpoint of the whole construction: emit the TDFA as a self-contained C
// matcher — a `state` switch, per-state range dispatch, an integer register file,
// the `set`/`copy` ops inlined, and a capture read-out at accept. This is (a small
// version of) what re2c generates. The function reads a code-point array so it is
// Unicode-correct without a decoder; `caps` receives 2·(groups+1) slot values
// (−1 = did not participate). Returns 1 on a whole-string match, else 0.
export function emitC(tdfa: TDFA, patternLabel: string, fnName = 'tdfa_match'): string {
  const L: string[] = [];
  const opC = (op: RegOp): string => (op.kind === 'set' ? `r[${op.reg}] = p + 1;` : `r[${op.dst}] = r[${op.src}];`);
  // Sanitise anything that could prematurely close the C comment ("*/" or a stray
  // apostrophe warning), including the case where the pattern ends in '*'.
  const safeLabel = patternLabel.replace(/\*\//g, '* /').replace(/\*(\s*)$/, '* ');
  L.push(`/* Generated by Regex Studio — Tagged DFA for pattern:  ${safeLabel}`);
  L.push(` * ${tdfa.states.length} states, ${tdfa.matRegCount} registers, ${tdfa.atoms.length} input classes.`);
  L.push(` * caps[] has ${tdfa.slotCount} slots: [2g, 2g+1) = group g [start, end) code-point indices`);
  L.push(` * (group 0 = whole match); a slot is -1 when that group did not participate. */`);
  L.push(`int ${fnName}(const int *cp, int n, int *caps) {`);
  L.push(`  int r[${Math.max(1, tdfa.regCount)}];`);
  L.push(`  for (int i = 0; i < ${Math.max(1, tdfa.regCount)}; i++) r[i] = -1;`);
  L.push(`  int p = -1; (void)p;`); // p referenced by initial `set` as p+1 == 0
  // Initial ops run at position 0 (p + 1 with p = -1).
  for (const op of tdfa.initialOps) L.push(`  ${opC(op)}`);
  L.push(`  int st = ${tdfa.start};`);
  L.push(`  for (p = 0; p < n; p++) {`);
  L.push(`    int c = cp[p];`);
  L.push(`    switch (st) {`);
  for (let s = 0; s < tdfa.states.length; s++) {
    L.push(`      case ${s}:`);
    const row = tdfa.table[s];
    let first = true;
    for (let a = 0; a < row.length; a++) {
      const to = row[a];
      if (to < 0) continue;
      const at = tdfa.atoms[a];
      const cond = `c >= ${at.lo} && c <= ${at.hi}`;
      L.push(`        ${first ? 'if' : 'else if'} (${cond}) {`);
      for (const op of tdfa.edgeOps[s][a]) L.push(`          ${opC(op)}`);
      L.push(`          st = ${to};`);
      L.push(`        }`);
      first = false;
    }
    L.push(`        ${first ? '' : 'else '}return 0; /* no transition — not a whole-string match */`);
    L.push(`        break;`);
  }
  L.push(`      default: return 0;`);
  L.push(`    }`);
  L.push(`  }`);
  // Accept: read captures from the accepting state's registers.
  L.push(`  switch (st) {`);
  for (const st of tdfa.states) {
    if (!st.accept || !st.acceptRegs) continue;
    L.push(`    case ${st.id}:`);
    for (let slot = 0; slot < tdfa.slotCount; slot++) {
      const reg = st.acceptRegs[slot];
      L.push(`      caps[${slot}] = ${reg >= 0 ? `r[${reg}]` : '-1'};`);
    }
    L.push(`      return 1;`);
  }
  L.push(`    default: return 0;`);
  L.push(`  }`);
  L.push(`}`);
  return L.join('\n');
}

// --- Presentation helpers (for the UI) -------------------------------------

// A human name for a capture slot: 0/1 = whole match, 2g/2g+1 = group g.
export function slotLabel(slot: number): string {
  const g = slot >> 1;
  const side = slot % 2 === 0 ? 'start' : 'end';
  return g === 0 ? `match.${side}` : `g${g}.${side}`;
}

export function formatRegOp(op: RegOp): string {
  return op.kind === 'set' ? `r${op.reg} ← pos` : `r${op.dst} ← r${op.src}`;
}

// For a given state, which capture slots each materialised register currently
// backs (a register may back several slots across configs). Used to annotate the
// live register file with meaning ("r5 = g1.end").
export function registerRoles(state: TDFAState, slotCount: number): Map<number, Set<number>> {
  const roles = new Map<number, Set<number>>();
  for (const cfg of state.configs) {
    for (let slot = 0; slot < slotCount; slot++) {
      const r = cfg.regs[slot];
      if (r < 0) continue;
      let set = roles.get(r);
      if (!set) {
        set = new Set();
        roles.set(r, set);
      }
      set.add(slot);
    }
  }
  return roles;
}

export interface TdfaGraph {
  nodes: { id: number; label: string }[];
  edges: { from: number; to: number; label: string; epsilon: boolean }[];
  start: number;
  accepts: Set<number>;
}

// Build a layout-ready graph. One edge per atom (the layout merges parallel
// from→to edges and joins their labels), so each edge is labelled by its input
// class; register ops are shown in the stepper, not on the edges.
export function tdfaGraph(tdfa: TDFA): TdfaGraph {
  const nodes = tdfa.states.map((s) => ({ id: s.id, label: `s${s.id}` }));
  const edges: { from: number; to: number; label: string; epsilon: boolean }[] = [];
  const accepts = new Set<number>();
  for (const s of tdfa.states) if (s.accept) accepts.add(s.id);
  for (let from = 0; from < tdfa.table.length; from++) {
    const row = tdfa.table[from];
    for (let a = 0; a < row.length; a++) {
      const to = row[a];
      if (to < 0) continue;
      edges.push({ from, to, label: tdfa.atoms[a].set.label(), epsilon: false });
    }
  }
  return { nodes, edges, start: tdfa.start, accepts };
}
