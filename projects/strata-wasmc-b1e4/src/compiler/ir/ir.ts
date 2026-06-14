// The mid-level intermediate representation. After type checking, the program is
// lowered into a control-flow graph of basic blocks in pure SSA form: every
// value has exactly one definition, and control-flow merges are reconciled by
// phi nodes. Optimizations and the WebAssembly backend both operate on this IR.
//
// A single compact instruction shape (`Inst`) is used for every operation. The
// `kind` selects the family and `sub` the specific opcode; this keeps the
// optimizer's rewriting code small and uniform.

export type IRType = 'i32' | 'f64';
export type RetType = IRType | 'void';

export type Operand =
  | { tag: 'val'; id: number }
  | { tag: 'const'; ty: IRType; num: number };

export const valOp = (id: number): Operand => ({ tag: 'val', id });
export const constI32 = (num: number): Operand => ({ tag: 'const', ty: 'i32', num: num | 0 });
export const constF64 = (num: number): Operand => ({ tag: 'const', ty: 'f64', num });

export type IntBin = 'add' | 'sub' | 'mul' | 'div_s' | 'rem_s' | 'and' | 'or' | 'xor' | 'shl' | 'shr_s';
export type FloatBin = 'add' | 'sub' | 'mul' | 'div';
export type ICmp = 'eq' | 'ne' | 'lt_s' | 'le_s' | 'gt_s' | 'ge_s';
export type FCmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type InstKind =
  | 'ibin'
  | 'fbin'
  | 'icmp'
  | 'fcmp'
  | 'cast'
  | 'select'
  | 'call'
  | 'print'
  | 'gget'
  | 'gset'
  | 'load'
  | 'store'
  | 'copy';

export interface Inst {
  res: number | null; // SSA value id defined, or null for void/side-effect-only ops
  ty: RetType; // type of `res`
  kind: InstKind;
  sub: string; // opcode within the family (see header)
  args: Operand[];
}

export interface Phi {
  res: number;
  ty: IRType;
  incomings: { pred: number; val: Operand }[];
}

export type Term =
  | { op: 'br'; target: number }
  | { op: 'condbr'; cond: Operand; t: number; f: number }
  | { op: 'ret'; value: Operand | null }
  | { op: 'unreachable' };

export interface Block {
  id: number;
  phis: Phi[];
  insts: Inst[];
  term: Term;
  preds: number[];
}

export interface IRFunc {
  name: string;
  params: { name: string; ty: IRType }[];
  retTy: RetType;
  blocks: Block[]; // in reverse-postorder after construction
  entry: number;
  valueType: Map<number, IRType>;
  exported: boolean;
}

export interface IRGlobal {
  name: string;
  ty: IRType;
  init: number;
  mutable: boolean;
}

export interface IRModule {
  funcs: IRFunc[];
  globals: IRGlobal[];
  usesMemory: boolean;
  memPages: number;
  /** Static read-only data (string literals) copied into linear memory at startup. */
  staticData?: { offset: number; bytes: number[] };
}

// --- helpers ---------------------------------------------------------------

export function operandType(fn: IRFunc, op: Operand): IRType {
  if (op.tag === 'const') return op.ty;
  const t = fn.valueType.get(op.id);
  if (!t) throw new Error(`unknown value type for v${op.id}`);
  return t;
}

export function blockById(fn: IRFunc, id: number): Block {
  const b = fn.blocks.find((x) => x.id === id);
  if (!b) throw new Error(`no block b${id}`);
  return b;
}

/** Instructions whose removal would change observable behavior. */
export function hasSideEffect(inst: Inst): boolean {
  return inst.kind === 'print' || inst.kind === 'gset' || inst.kind === 'store' || inst.kind === 'call';
}

/** Pure value-producing instructions that GVN/CSE may deduplicate. */
export function isPureValue(inst: Inst): boolean {
  switch (inst.kind) {
    case 'ibin':
    case 'fbin':
    case 'icmp':
    case 'fcmp':
    case 'cast':
    case 'select':
    case 'copy':
      return true;
    // loads and gget read mutable state; calls/prints/stores have effects.
    default:
      return false;
  }
}

export function successors(term: Term): number[] {
  switch (term.op) {
    case 'br':
      return [term.target];
    case 'condbr':
      return term.t === term.f ? [term.t] : [term.t, term.f];
    default:
      return [];
  }
}

/** Apply `f` to every operand slot of an instruction, replacing in place. */
export function mapInstOperands(inst: Inst, f: (o: Operand) => Operand): void {
  for (let i = 0; i < inst.args.length; i++) inst.args[i] = f(inst.args[i]);
}

export function eachOperand(b: Block, f: (o: Operand, set: (n: Operand) => void) => void): void {
  for (const phi of b.phis) {
    for (const inc of phi.incomings) f(inc.val, (n) => (inc.val = n));
  }
  for (const inst of b.insts) {
    for (let i = 0; i < inst.args.length; i++) {
      const idx = i;
      f(inst.args[idx], (n) => (inst.args[idx] = n));
    }
  }
  if (b.term.op === 'condbr') f(b.term.cond, (n) => ((b.term as { cond: Operand }).cond = n));
  else if (b.term.op === 'ret' && b.term.value) f(b.term.value, (n) => ((b.term as { value: Operand | null }).value = n));
}
