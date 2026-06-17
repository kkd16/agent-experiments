// Branch direction predictors + a branch-target buffer (BTB).
//
// Each predictor is a tiny, exact, table-driven state machine. A control instruction is
// "correctly predicted" only when both its *direction* (taken / not-taken) and, when taken,
// its *target* (from the BTB) are right — exactly the two ways a real front-end mispredicts.
// The structures are deliberately small and deterministic so the results are reproducible and
// unit-testable.

export type PredictorKind = 'not-taken' | 'taken' | 'one-bit' | 'two-bit' | 'gshare';

/** A single control event distilled from the retired trace. */
export interface BranchEvent {
  pc: number;
  /** True for jal/jalr (architecturally always taken); false for a conditional branch. */
  isJump: boolean;
  taken: boolean;
  target: number;
}

export interface PredictResult {
  /** Direction the front-end guessed. */
  predictedTaken: boolean;
  /** Target the front-end guessed (from the BTB) when it predicted taken; else 0. */
  predictedTarget: number;
  /** True when direction AND (if taken) target both matched the real outcome. */
  correct: boolean;
}

/** A direct-mapped branch-target buffer: pc → last taken target. */
class Btb {
  private readonly mask: number;
  private readonly tag: Int32Array;
  private readonly target: Int32Array;
  constructor(sets: number) {
    const n = 1 << Math.ceil(Math.log2(Math.max(1, sets)));
    this.mask = n - 1;
    this.tag = new Int32Array(n).fill(-1);
    this.target = new Int32Array(n);
  }
  private idx(pc: number): number {
    return (pc >>> 1) & this.mask;
  }
  /** The predicted target for `pc`, or null on a BTB miss. */
  lookup(pc: number): number | null {
    const i = this.idx(pc);
    return this.tag[i] === (pc | 0) ? this.target[i] >>> 0 : null;
  }
  update(pc: number, target: number): void {
    const i = this.idx(pc);
    this.tag[i] = pc | 0;
    this.target[i] = target | 0;
  }
}

/** The common shape of every direction predictor. */
interface DirectionPredictor {
  /** Predict taken/not-taken for a control instruction at `pc`. */
  predict(pc: number, isJump: boolean): boolean;
  /** Learn from the real outcome. */
  update(pc: number, taken: boolean): void;
}

// Jumps are architecturally always taken; a sensible front-end always predicts them taken and
// only needs the BTB for the target. Conditional branches go through the table below.

class StaticPredictor implements DirectionPredictor {
  private readonly always: boolean;
  constructor(always: boolean) {
    this.always = always;
  }
  predict(_pc: number, isJump: boolean): boolean {
    return isJump || this.always;
  }
  update(): void {
    /* stateless */
  }
}

/** Index bits derived from a power-of-two table size. */
function tableMask(entries: number): number {
  const n = 1 << Math.ceil(Math.log2(Math.max(2, entries)));
  return n - 1;
}

class OneBitPredictor implements DirectionPredictor {
  private readonly mask: number;
  private readonly bit: Uint8Array;
  constructor(entries: number) {
    this.mask = tableMask(entries);
    this.bit = new Uint8Array(this.mask + 1); // 0 = not-taken, 1 = taken
  }
  private idx(pc: number): number {
    return (pc >>> 1) & this.mask;
  }
  predict(pc: number, isJump: boolean): boolean {
    return isJump || this.bit[this.idx(pc)] === 1;
  }
  update(pc: number, taken: boolean): void {
    this.bit[this.idx(pc)] = taken ? 1 : 0;
  }
}

/** A 2-bit saturating counter (00,01 = not-taken; 10,11 = taken), seeded weakly-taken. */
class TwoBitPredictor implements DirectionPredictor {
  protected readonly mask: number;
  protected readonly ctr: Uint8Array;
  constructor(entries: number) {
    this.mask = tableMask(entries);
    this.ctr = new Uint8Array(this.mask + 1).fill(1); // weakly not-taken
  }
  protected idx(pc: number): number {
    return (pc >>> 1) & this.mask;
  }
  predict(pc: number, isJump: boolean): boolean {
    return isJump || this.ctr[this.idx(pc)] >= 2;
  }
  update(pc: number, taken: boolean): void {
    const i = this.idx(pc);
    const c = this.ctr[i];
    this.ctr[i] = taken ? Math.min(3, c + 1) : Math.max(0, c - 1);
  }
}

/** gshare: index a 2-bit counter table by (PC ⊕ global-history-register). */
class GsharePredictor implements DirectionPredictor {
  private readonly mask: number;
  private readonly ctr: Uint8Array;
  private readonly histMask: number;
  private ghr = 0;
  constructor(entries: number, histBits: number) {
    this.mask = tableMask(entries);
    this.ctr = new Uint8Array(this.mask + 1).fill(1);
    this.histMask = (1 << Math.max(1, histBits)) - 1;
  }
  private idx(pc: number): number {
    return ((pc >>> 1) ^ this.ghr) & this.mask;
  }
  predict(pc: number, isJump: boolean): boolean {
    return isJump || this.ctr[this.idx(pc)] >= 2;
  }
  update(pc: number, taken: boolean): void {
    const i = this.idx(pc);
    const c = this.ctr[i];
    this.ctr[i] = taken ? Math.min(3, c + 1) : Math.max(0, c - 1);
    this.ghr = ((this.ghr << 1) | (taken ? 1 : 0)) & this.histMask;
  }
}

function makeDirection(kind: PredictorKind, entries: number, histBits: number): DirectionPredictor {
  switch (kind) {
    case 'not-taken':
      return new StaticPredictor(false);
    case 'taken':
      return new StaticPredictor(true);
    case 'one-bit':
      return new OneBitPredictor(entries);
    case 'two-bit':
      return new TwoBitPredictor(entries);
    case 'gshare':
      return new GsharePredictor(entries, histBits);
  }
}

/** A full front-end branch predictor = a direction predictor + a BTB for taken targets. */
export class BranchPredictor {
  private readonly dir: DirectionPredictor;
  private readonly btb: Btb;
  hits = 0;
  misses = 0;
  /** Mispredictions split by cause, for the UI. */
  directionMisses = 0;
  targetMisses = 0;
  readonly kind: PredictorKind;

  constructor(kind: PredictorKind, entries = 1024, histBits = 8, btbSets = 256) {
    this.kind = kind;
    this.dir = makeDirection(kind, entries, histBits);
    this.btb = new Btb(btbSets);
  }

  /** Predict, score, and learn from one control event. */
  step(e: BranchEvent): PredictResult {
    const predictedTaken = this.dir.predict(e.pc, e.isJump);
    const btbTarget = this.btb.lookup(e.pc);
    const predictedTarget = predictedTaken ? btbTarget ?? 0 : 0;

    let correct: boolean;
    if (predictedTaken !== e.taken) {
      correct = false;
      this.directionMisses++;
    } else if (e.taken && predictedTarget !== (e.target >>> 0)) {
      // Right direction, wrong (or unknown) target — still a front-end redirect.
      correct = false;
      this.targetMisses++;
    } else {
      correct = true;
    }

    if (correct) this.hits++;
    else this.misses++;

    // Learn: update the direction predictor, and cache the target on a taken transfer.
    this.dir.update(e.pc, e.taken);
    if (e.taken) this.btb.update(e.pc, e.target);

    return { predictedTaken, predictedTarget, correct };
  }

  get total(): number {
    return this.hits + this.misses;
  }
  get accuracy(): number {
    return this.total === 0 ? 1 : this.hits / this.total;
  }
}
