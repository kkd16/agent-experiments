// The Pike VM — Thompson's NFA simulation, but tracking *capture groups*.
//
// The backtracking VM (vm.ts) runs the full grammar at the cost of worst-case
// exponential time. The DFA runs in guaranteed linear time but only decides
// membership — it can't tell you *where* the groups matched. The Pike VM is the
// third point of the triangle: it compiles the regex to a tiny bytecode and runs
// a breadth-first set of threads, so it keeps **linear-time guarantees** (no
// catastrophic backtracking — every input position is visited a bounded number
// of times) *and* reports submatches. This is the engine behind RE2, Go's
// `regexp`, and Rust's `regex` crate.
//
// The price: no backreferences (a backref makes the language non-regular, so no
// finite set of threads can track it) and no lookaround (it needs a recursive
// sub-match). When a pattern uses those, `compileProgram` throws and the UI
// shows the Pike engine as "n/a — needs the backtracker", which is itself the
// lesson: those are exactly the features that cost you the linear-time bound.

import type { RegexNode } from './ast';
import type { CharSet } from './charset';
import { WORD } from './charset';
import { toCodePoints } from './simulate';
import type { CaptureSpan, VMMatch } from './vm';

// --- Bytecode --------------------------------------------------------------

export type Inst =
  | { op: 'char'; set: CharSet } // consume one code point in `set`
  | { op: 'match' } // accept
  | { op: 'jmp'; x: number }
  | { op: 'split'; x: number; y: number } // try x first, then y (priority order)
  | { op: 'save'; slot: number } // record the current position into capture slot
  | { op: 'assert'; kind: 'bol' | 'eol' | 'wb' | 'nwb' }; // zero-width assertion

export class PikeUnsupported extends Error {}

export interface Program {
  insts: Inst[];
  nslots: number; // 2*(groupCount+1): slots 0/1 are the whole match
}

class Compiler {
  insts: Inst[] = [];

  private emit(i: Inst): number {
    this.insts.push(i);
    return this.insts.length - 1;
  }
  private here(): number {
    return this.insts.length;
  }

  compileTop(ast: RegexNode, groupCount: number): Program {
    this.emit({ op: 'save', slot: 0 });
    this.compile(ast);
    this.emit({ op: 'save', slot: 1 });
    this.emit({ op: 'match' });
    return { insts: this.insts, nslots: 2 * (groupCount + 1) };
  }

  private compile(node: RegexNode): void {
    switch (node.type) {
      case 'empty':
        return;
      case 'char':
        this.emit({ op: 'char', set: node.set });
        return;
      case 'concat':
        node.parts.forEach((p) => this.compile(p));
        return;
      case 'alt':
        this.compileAlt(node.options);
        return;
      case 'group':
        this.emit({ op: 'save', slot: 2 * node.index });
        this.compile(node.node);
        this.emit({ op: 'save', slot: 2 * node.index + 1 });
        return;
      case 'star':
        this.compileStar(node.node, node.lazy);
        return;
      case 'plus':
        this.compilePlus(node.node, node.lazy);
        return;
      case 'opt':
        this.compileOpt(node.node, node.lazy);
        return;
      case 'repeat':
        this.compileRepeat(node);
        return;
      case 'anchor':
        this.emit({ op: 'assert', kind: node.at === 'start' ? 'bol' : 'eol' });
        return;
      case 'boundary':
        this.emit({ op: 'assert', kind: node.negate ? 'nwb' : 'wb' });
        return;
      // The two things a finite thread set can't represent:
      case 'backref':
        throw new PikeUnsupported('backreferences are not regular — no NFA can track them');
      case 'look':
        throw new PikeUnsupported('lookaround needs a recursive sub-match');
    }
  }

  private compileAlt(options: RegexNode[]): void {
    if (options.length === 1) {
      this.compile(options[0]);
      return;
    }
    const endJumps: number[] = [];
    for (let i = 0; i < options.length; i++) {
      if (i < options.length - 1) {
        const s = this.emit({ op: 'split', x: 0, y: 0 });
        const body = this.here();
        this.compile(options[i]);
        endJumps.push(this.emit({ op: 'jmp', x: 0 }));
        const next = this.here();
        this.insts[s] = { op: 'split', x: body, y: next };
      } else {
        this.compile(options[i]);
      }
    }
    const end = this.here();
    for (const j of endJumps) this.insts[j] = { op: 'jmp', x: end };
  }

  private compileStar(inner: RegexNode, lazy: boolean): void {
    const l1 = this.emit({ op: 'split', x: 0, y: 0 });
    const body = this.here();
    this.compile(inner);
    this.emit({ op: 'jmp', x: l1 });
    const exit = this.here();
    this.insts[l1] = lazy ? { op: 'split', x: exit, y: body } : { op: 'split', x: body, y: exit };
  }

  private compilePlus(inner: RegexNode, lazy: boolean): void {
    const body = this.here();
    this.compile(inner);
    const s = this.emit({ op: 'split', x: 0, y: 0 });
    const exit = this.here();
    this.insts[s] = lazy ? { op: 'split', x: exit, y: body } : { op: 'split', x: body, y: exit };
  }

  private compileOpt(inner: RegexNode, lazy: boolean): void {
    const s = this.emit({ op: 'split', x: 0, y: 0 });
    const body = this.here();
    this.compile(inner);
    const exit = this.here();
    this.insts[s] = lazy ? { op: 'split', x: exit, y: body } : { op: 'split', x: body, y: exit };
  }

  private compileRepeat(node: Extract<RegexNode, { type: 'repeat' }>): void {
    for (let i = 0; i < node.min; i++) this.compile(node.node);
    if (node.max === null) {
      this.compileStar(node.node, node.lazy);
    } else {
      for (let i = node.min; i < node.max; i++) this.compileOpt(node.node, node.lazy);
    }
  }
}

export function compileProgram(ast: RegexNode, groupCount: number): Program {
  return new Compiler().compileTop(ast, groupCount);
}

// --- Disassembly (for the bytecode view) -----------------------------------

export interface DisasmLine {
  pc: number;
  op: Inst['op'];
  text: string; // the operand, rendered
  targets: number[]; // jump targets, for drawing control flow
  note: string; // a short human gloss
}

function slotName(slot: number): string {
  const g = slot >> 1;
  const side = slot % 2 === 0 ? 'start' : 'end';
  return g === 0 ? `match ${side}` : `group ${g} ${side}`;
}

export function disassemble(prog: Program): DisasmLine[] {
  return prog.insts.map((inst, pc) => {
    switch (inst.op) {
      case 'char':
        return { pc, op: inst.op, text: inst.set.label(), targets: [], note: 'consume one code point in this class' };
      case 'match':
        return { pc, op: inst.op, text: '', targets: [], note: 'accept — record the capture slots' };
      case 'jmp':
        return { pc, op: inst.op, text: `→ ${inst.x}`, targets: [inst.x], note: 'unconditional jump' };
      case 'split':
        return {
          pc,
          op: inst.op,
          text: `→ ${inst.x}, ${inst.y}`,
          targets: [inst.x, inst.y],
          note: `fork: try ${inst.x} first, else ${inst.y} (priority = greedy/lazy preference)`,
        };
      case 'save':
        return { pc, op: inst.op, text: `slot ${inst.slot}`, targets: [], note: `record position → ${slotName(inst.slot)}` };
      case 'assert':
        return { pc, op: inst.op, text: inst.kind, targets: [], note: zeroWidthNote(inst.kind) };
    }
  });
}

function zeroWidthNote(kind: 'bol' | 'eol' | 'wb' | 'nwb'): string {
  switch (kind) {
    case 'bol':
      return 'assert start-of-line (^)';
    case 'eol':
      return 'assert end-of-line ($)';
    case 'wb':
      return 'assert word boundary (\\b)';
    case 'nwb':
      return 'assert non-boundary (\\B)';
  }
}

// --- The thread-list simulator --------------------------------------------

interface Thread {
  pc: number;
  saved: Int32Array; // capture slots
}

class ThreadList {
  dense: Thread[] = [];
  private seen: Int32Array;
  private gen = 0;
  constructor(progLen: number) {
    this.seen = new Int32Array(progLen).fill(-1);
  }
  clear(): void {
    this.dense.length = 0;
    this.gen++;
  }
  has(pc: number): boolean {
    return this.seen[pc] === this.gen;
  }
  mark(pc: number): void {
    this.seen[pc] = this.gen;
  }
}

export interface PikeResult {
  match: VMMatch | null;
  steps: number; // thread·instruction visits — a linear-work proxy
  unsupported: string | null; // reason the Pike VM can't run this pattern
}

export interface PikeSearchResult {
  matches: VMMatch[];
  steps: number;
  unsupported: string | null;
}

class Runner {
  private readonly insts: Inst[];
  private readonly nslots: number;
  private readonly codes: number[];
  private readonly n: number;
  steps = 0;

  constructor(prog: Program, codes: number[]) {
    this.insts = prog.insts;
    this.nslots = prog.nslots;
    this.codes = codes;
    this.n = codes.length;
  }

  private isWord(i: number): boolean {
    return i >= 0 && i < this.n && WORD.contains(this.codes[i]);
  }

  private assertOk(kind: 'bol' | 'eol' | 'wb' | 'nwb', at: number): boolean {
    switch (kind) {
      case 'bol':
        return at === 0;
      case 'eol':
        return at === this.n;
      case 'wb':
        return this.isWord(at - 1) !== this.isWord(at);
      case 'nwb':
        return this.isWord(at - 1) === this.isWord(at);
    }
  }

  // Follow ε-instructions (split/jmp/save/assert) from `pc`, adding the reachable
  // char/match instructions to `list` in priority order, deduped per generation.
  private add(list: ThreadList, pc: number, at: number, saved: Int32Array): void {
    if (list.has(pc)) return;
    list.mark(pc);
    const inst = this.insts[pc];
    switch (inst.op) {
      case 'jmp':
        this.add(list, inst.x, at, saved);
        return;
      case 'split':
        this.add(list, inst.x, at, saved);
        this.add(list, inst.y, at, saved);
        return;
      case 'save': {
        const next = saved.slice();
        next[inst.slot] = at;
        this.add(list, pc + 1, at, next);
        return;
      }
      case 'assert':
        if (this.assertOk(inst.kind, at)) this.add(list, pc + 1, at, saved);
        return;
      case 'char':
      case 'match':
        list.dense.push({ pc, saved });
        return;
    }
  }

  // Leftmost match whose start index is ≥ `from`.
  findFrom(from: number): VMMatch | null {
    const progLen = this.insts.length;
    let clist = new ThreadList(progLen);
    let nlist = new ThreadList(progLen);
    clist.clear();
    let matched: Int32Array | null = null;

    for (let sp = from; sp <= this.n; sp++) {
      // Unanchored leftmost search: keep seeding a fresh start thread (lowest
      // priority) until something matches, so earlier starts win.
      if (matched === null) {
        const s0 = new Int32Array(this.nslots).fill(-1);
        this.add(clist, 0, sp, s0);
      }
      nlist.clear();
      for (let i = 0; i < clist.dense.length; i++) {
        this.steps++;
        const th = clist.dense[i];
        const inst = this.insts[th.pc];
        if (inst.op === 'char') {
          if (sp < this.n && inst.set.contains(this.codes[sp])) {
            this.add(nlist, th.pc + 1, sp + 1, th.saved);
          }
        } else if (inst.op === 'match') {
          matched = th.saved;
          break; // cut every lower-priority thread (leftmost-greedy semantics)
        }
      }
      const tmp = clist;
      clist = nlist;
      nlist = tmp;
    }
    return matched ? this.toMatch(matched) : null;
  }

  private toMatch(saved: Int32Array): VMMatch {
    const groupCount = this.nslots / 2 - 1;
    const groups: (CaptureSpan | null)[] = [];
    for (let g = 0; g <= groupCount; g++) {
      const a = saved[2 * g];
      const b = saved[2 * g + 1];
      groups.push(a >= 0 && b >= 0 ? { start: a, end: b } : null);
    }
    return { start: saved[0], end: saved[1], groups };
  }
}

export function runPike(ast: RegexNode, groupCount: number, text: string): PikeResult {
  let prog: Program;
  try {
    prog = compileProgram(ast, groupCount);
  } catch (e) {
    if (e instanceof PikeUnsupported) return { match: null, steps: 0, unsupported: e.message };
    throw e;
  }
  const runner = new Runner(prog, toCodePoints(text));
  return { match: runner.findFrom(0), steps: runner.steps, unsupported: null };
}

// All non-overlapping matches, left to right. Zero-width matches advance by one.
export function searchPike(ast: RegexNode, groupCount: number, text: string): PikeSearchResult {
  let prog: Program;
  try {
    prog = compileProgram(ast, groupCount);
  } catch (e) {
    if (e instanceof PikeUnsupported) return { matches: [], steps: 0, unsupported: e.message };
    throw e;
  }
  const codes = toCodePoints(text);
  const runner = new Runner(prog, codes);
  const matches: VMMatch[] = [];
  let i = 0;
  while (i <= codes.length) {
    const m = runner.findFrom(i);
    if (!m) break;
    if (m.end > m.start) {
      matches.push(m);
      i = m.end;
    } else {
      i = m.start + 1; // zero-width: step forward to make progress
    }
  }
  return { matches, steps: runner.steps, unsupported: null };
}
