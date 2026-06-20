// The mid-level intermediate representation. After type checking, the program is
// lowered into a control-flow graph of basic blocks in pure SSA form: every
// value has exactly one definition, and control-flow merges are reconciled by
// phi nodes. Optimizations and the WebAssembly backend both operate on this IR.
//
// A single compact instruction shape (`Inst`) is used for every operation. The
// `kind` selects the family and `sub` the specific opcode; this keeps the
// optimizer's rewriting code small and uniform.

export type IRType = 'i32' | 'i64' | 'f64' | 'f32' | 'v128';
export type RetType = IRType | 'void';

// Constant payloads are `number` for i32/f64/f32 and `bigint` for i64. The `ty`
// discriminator tells consumers which to expect; helpers below build the right
// shape so callers never have to remember the rule. (An f32 const carries its
// `Math.fround`-rounded value, so it survives a round-trip through the encoder.)
export type ConstNum = number | bigint;

export type Operand =
  | { tag: 'val'; id: number }
  | { tag: 'const'; ty: IRType; num: ConstNum };

export const valOp = (id: number): Operand => ({ tag: 'val', id });
export const constI32 = (num: number): Operand => ({ tag: 'const', ty: 'i32', num: num | 0 });
export const constI64 = (num: bigint): Operand => ({ tag: 'const', ty: 'i64', num: BigInt.asIntN(64, num) });
export const constF64 = (num: number): Operand => ({ tag: 'const', ty: 'f64', num });
export const constF32 = (num: number): Operand => ({ tag: 'const', ty: 'f32', num: Math.fround(num) });

/** The additive-identity constant of a value type (`0n` for i64, else `0`). */
export const zeroOf = (ty: IRType): ConstNum => (ty === 'i64' ? 0n : 0);
export const zeroConst = (ty: IRType): Operand => ({ tag: 'const', ty, num: zeroOf(ty) });

export type IntBin = 'add' | 'sub' | 'mul' | 'div_s' | 'rem_s' | 'and' | 'or' | 'xor' | 'shl' | 'shr_s';
export type FloatBin = 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'copysign';
export type ICmp = 'eq' | 'ne' | 'lt_s' | 'le_s' | 'gt_s' | 'ge_s';
export type FCmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type InstKind =
  | 'ibin'
  | 'iunary'
  | 'fbin'
  | 'icmp'
  | 'fcmp'
  | 'cast'
  | 'select'
  | 'call'
  // Materialize a function's table slot as an i32 (`sub` = function name). Pure.
  | 'funcaddr'
  // `call_indirect` through the function table: `args[0]` is the table slot, the
  // rest are call arguments; `sub` is the signature key (`p1,p2->ret`). Effectful.
  | 'callind'
  | 'print'
  | 'gget'
  | 'gset'
  // Reserve a fresh, distinct block of linear memory and yield its base address
  // as an i32 (`args[0]` is the byte size). Each `alloc` produces an address that
  // aliases no other allocation — the property escape analysis (`opt/sroa.ts`)
  // exploits to scalarize non-escaping records. Lowered to the bump-allocator
  // sequence (`gget`/`add`/`gset`) just before codegen, so the backend never sees
  // it. Bumping the heap pointer is not observable in a user program (the pointer
  // is never read back), so a dead `alloc` is freely removable.
  | 'alloc'
  | 'load'
  | 'store'
  // --- 128-bit SIMD families. Each is a pure, never-trapping value op that
  // lowers to one wasm SIMD instruction (0xfd-prefixed). `sub` carries the full
  // wasm mnemonic so the backend builds the opcode by lookup; lane-indexed ops
  // append `:K` (the constant lane). They are GVN-able by (kind, sub, args).
  // `vbin`  — (v128, v128) -> v128   (e.g. `f32x4.add`, `v128.and`)
  // `vunary`— (v128) -> v128         (e.g. `f32x4.neg`, `f32x4.sqrt`, `v128.not`)
  // `vsplat`— (scalar) -> v128       (`sub` is the lane shape, e.g. `i32x4`)
  // `vextract` — (v128) -> scalar    (`sub` = `f32x4.extract_lane:2`)
  // `vreplace` — (v128, scalar) -> v128 (`sub` = `f32x4.replace_lane:2`)
  | 'vbin'
  | 'vunary'
  | 'vsplat'
  | 'vextract'
  | 'vreplace'
  // `vselect` — (v128 a, v128 b, v128 mask) -> v128: lanewise `mask ? a : b`,
  // lowered to wasm `v128.bitselect` (bitwise, so a non-canonical mask blends
  // per bit, exactly like the hardware).
  | 'vselect'
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
  init: ConstNum;
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
  return inst.kind === 'print' || inst.kind === 'gset' || inst.kind === 'store' || inst.kind === 'call' || inst.kind === 'callind';
}

/** Pure value-producing instructions that GVN/CSE may deduplicate. */
export function isPureValue(inst: Inst): boolean {
  switch (inst.kind) {
    case 'ibin':
    case 'iunary':
    case 'fbin':
    case 'icmp':
    case 'fcmp':
    case 'cast':
    case 'select':
    case 'copy':
    case 'funcaddr':
    case 'vbin':
    case 'vunary':
    case 'vsplat':
    case 'vextract':
    case 'vreplace':
    case 'vselect':
      // The pure value families. A funcaddr is a pure, constant i32 (a function's
      // table slot): GVN-able and freely duplicable, like a constant. The SIMD
      // families (vbin…vselect) are pure and never trap — no SIMD integer divide
      // exists — so GVN/CSE may deduplicate them and DCE may drop a dead one.
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
