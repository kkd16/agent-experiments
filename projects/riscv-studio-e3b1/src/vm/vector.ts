// The RISC-V "V" vector extension (RVV 1.0 subset): the encoding source of truth.
//
// This module is to the vector engine what `fp.ts` is to the float engine and `mmu.ts` is to the
// MMU: pure encoding/decoding data + helpers, no machine state. The assembler calls
// `assembleVector` to turn a vector mnemonic + operands into a fully-resolved 32-bit word (vector
// instructions reference no labels, so they encode entirely at parse time); the decoder calls
// `decodeVectorMnemonic` to render them back; the interpreter (`cpu.ts`) switches on the resolved
// mnemonic in its own `executeVector`. Keeping all three in lock-step here is the same
// single-source-of-truth discipline the rest of the project follows.
//
// Model parameters (all legal RVV implementation choices, documented in the journal):
//   VLEN = 128, VLENB = 16, ELEN = 32  → SEW ∈ {8,16,32}; SEW = 64 ⇒ vill.
//   LMUL ∈ {1,2,4,8, 1/2,1/4,1/8} with register grouping and the SEW ≤ LMUL·ELEN legality rule.
//   Tail + masked-off elements are left UNDISTURBED (an always-legal realization of ta/ma
//   "agnostic"), so behaviour is deterministic and time-travel is exact. vstart is always 0.

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const VLEN = 128; // bits per vector register
export const VLENB = VLEN / 8; // 16 bytes per vector register
export const ELEN = 32; // widest supported element
export const VREG_COUNT = 32;

/** OP-V major opcode (vector arithmetic + the vset configuration ops). */
export const OPV = 0x57;
/** Vector loads/stores share the FP load/store opcodes, disambiguated by the width field. */
export const VLOAD = 0x07;
export const VSTORE = 0x27;

/** OP-V funct3 "category" selectors. */
export const OPIVV = 0;
export const OPFVV = 1;
export const OPMVV = 2;
export const OPIVI = 3;
export const OPIVX = 4;
export const OPFVF = 5;
export const OPMVX = 6;
export const OPCFG = 7;

// Vector-CSR addresses.
export const VCSR = {
  vstart: 0x008,
  vxsat: 0x009,
  vxrm: 0x00a,
  vcsr: 0x00f,
  vl: 0xc20,
  vtype: 0xc21,
  vlenb: 0xc22,
} as const;

// ---------------------------------------------------------------------------
// vtype decoding
// ---------------------------------------------------------------------------

export const VTYPE_VILL = 0x8000_0000;

export interface VType {
  sew: number; // element width in bits (8/16/32) — only valid when !vill
  lmulNum: number; // LMUL numerator
  lmulDen: number; // LMUL denominator
  ta: boolean; // tail-agnostic
  ma: boolean; // mask-agnostic
  vill: boolean; // illegal configuration
}

/** Decode a raw vtype value into its fields, applying the studio's legality rules. */
export function decodeVtype(vtype: number): VType {
  const v = vtype >>> 0;
  if (v & VTYPE_VILL) return { sew: 0, lmulNum: 0, lmulDen: 1, ta: false, ma: false, vill: true };
  const vlmul = v & 0x7;
  const vsew = (v >>> 3) & 0x7;
  const ta = ((v >>> 6) & 1) === 1;
  const ma = ((v >>> 7) & 1) === 1;
  // Reserved bits above vma set ⇒ illegal.
  if (v & ~0xff) return illegal();
  // SEW: 0→8,1→16,2→32,3→64(unsupported). Anything else reserved.
  const sew = [8, 16, 32, 64][vsew] ?? 0;
  if (sew === 0 || sew === 64) return illegal();
  // LMUL: 000→1,001→2,010→4,011→8, 100 reserved, 101→1/8,110→1/4,111→1/2.
  const LMUL: Record<number, [number, number]> = {
    0: [1, 1], 1: [2, 1], 2: [4, 1], 3: [8, 1], 5: [1, 8], 6: [1, 4], 7: [1, 2],
  };
  const lm = LMUL[vlmul];
  if (!lm) return illegal();
  const [lmulNum, lmulDen] = lm;
  // Legality: SEW ≤ ELEN·LMUL  (fractional LMUL can make a SEW impossible).
  if (sew * lmulDen > ELEN * lmulNum) return illegal();
  return { sew, lmulNum, lmulDen, ta, ma, vill: false };

  function illegal(): VType {
    return { sew: 0, lmulNum: 0, lmulDen: 1, ta: false, ma: false, vill: true };
  }
}

/** VLMAX = ⌊VLEN · LMUL / SEW⌋ for a (legal) vtype. */
export function vlmaxOf(vt: VType): number {
  if (vt.vill) return 0;
  return Math.floor((VLEN * vt.lmulNum) / (vt.sew * vt.lmulDen));
}

/** How many registers a vector register group spans (⌈LMUL⌉, min 1). */
export function emulRegs(vt: VType): number {
  if (vt.vill) return 1;
  const r = (vt.lmulNum * 1) / vt.lmulDen;
  return r < 1 ? 1 : r;
}

/** Human-readable LMUL ("m1", "mf2", …) and a full vtype description for the inspector. */
export function lmulLabel(vt: VType): string {
  if (vt.lmulDen === 1) return `m${vt.lmulNum}`;
  return `mf${vt.lmulDen}`;
}

export function describeVtype(vtype: number): string {
  const vt = decodeVtype(vtype);
  if (vt.vill) return 'vill (illegal)';
  return `e${vt.sew}, ${lmulLabel(vt)}, ${vt.ta ? 'ta' : 'tu'}, ${vt.ma ? 'ma' : 'mu'}`;
}

// ---------------------------------------------------------------------------
// vtype-immediate parsing (the `e32, m1, ta, ma` token list on vset{i}vli)
// ---------------------------------------------------------------------------

const SEW_TOK: Record<string, number> = { e8: 0, e16: 1, e32: 2, e64: 3 };
const LMUL_TOK: Record<string, number> = {
  m1: 0, m2: 1, m4: 2, m8: 3, mf8: 5, mf4: 6, mf2: 7,
};

/** Parse `e32, m1, [ta|tu], [ma|mu]` (the tail/mask tokens optional, default tu/mu) → vtype. */
export function parseVtypeTokens(tokens: string[], fail: (m: string) => never): number {
  let vsew = -1;
  let vlmul = -1;
  let vta = 0;
  let vma = 0;
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    if (t in SEW_TOK) vsew = SEW_TOK[t];
    else if (t in LMUL_TOK) vlmul = LMUL_TOK[t];
    else if (t === 'ta') vta = 1;
    else if (t === 'tu') vta = 0;
    else if (t === 'ma') vma = 1;
    else if (t === 'mu') vma = 0;
    else fail(`unknown vtype token '${raw}'`);
  }
  if (vsew < 0) fail('vtype is missing an element width (e8/e16/e32)');
  if (vlmul < 0) fail('vtype is missing an LMUL (m1/m2/.../mf2)');
  return (vma << 7) | (vta << 6) | (vsew << 3) | vlmul;
}

/** Render a vtype value as its `e32, m1, ta, ma` token list (for disassembly). */
export function vtypeTokens(vtype: number): string {
  const v = vtype >>> 0;
  if (v & VTYPE_VILL) return `0x${v.toString(16)}`;
  const sew = ['e8', 'e16', 'e32', 'e64'][(v >>> 3) & 7] ?? '?';
  const lmulName = Object.entries(LMUL_TOK).find(([, code]) => code === (v & 7))?.[0] ?? '?';
  const ta = (v >>> 6) & 1 ? 'ta' : 'tu';
  const ma = (v >>> 7) & 1 ? 'ma' : 'mu';
  return `${sew}, ${lmulName}, ${ta}, ${ma}`;
}

// ---------------------------------------------------------------------------
// Arithmetic / permute instruction table (OP-V opcode)
// ---------------------------------------------------------------------------

/** How an OP-V instruction lays out its operands (drives parse, encode and disassembly). */
export type VForm =
  | 'vv' | 'vx' | 'vi' // standard 3-operand (vector / scalar-x / imm)
  | 'macvv' | 'macvx' // multiply-accumulate: asm order is (vd, vs1, vs2) — reversed
  | 'vviu' // vi with an *unsigned* 5-bit immediate (shifts/slides/gather)
  | 'vvm' | 'vxm' | 'vim' // vmerge (always masked; explicit trailing v0)
  | 'movv' | 'movx' | 'movi' // vmv.v.{v,x,i} (vm=1, vs2=0)
  | 'vs' // reduction: vd, vs2, vs1
  | 'mm' // mask logical: vd, vs2, vs1 (vm=1)
  | 'wxs' // vmv.x.s: rd(x), vs2
  | 'wsx' // vmv.s.x: vd, rs1(x)
  | 'pop' // vcpop.m / vfirst.m: rd(x), vs2 [,v0.t]
  | 'vid' // vid.v: vd [,v0.t]
  | 'mvs2'; // viota.m / vmsbf.m / vmsif.m / vmsof.m: vd, vs2 [,v0.t]

export interface VecSpec {
  funct6: number;
  cat: number; // funct3 category
  form: VForm;
  /** Fixed 5-bit selector that rides in the rs1/vs1 field (the unary "vXunary0" groups). */
  sel?: number;
}

function vspec(funct6: number, cat: number, form: VForm, sel?: number): VecSpec {
  return { funct6, cat, form, sel };
}

/** Every supported OP-V arithmetic/permute mnemonic → its encoding. */
export const VEC_SPECS: Record<string, VecSpec> = {
  // ---- integer add/sub (OPIVV/OPIVX/OPIVI) ----
  'vadd.vv': vspec(0x00, OPIVV, 'vv'), 'vadd.vx': vspec(0x00, OPIVX, 'vx'), 'vadd.vi': vspec(0x00, OPIVI, 'vi'),
  'vsub.vv': vspec(0x02, OPIVV, 'vv'), 'vsub.vx': vspec(0x02, OPIVX, 'vx'),
  'vrsub.vx': vspec(0x03, OPIVX, 'vx'), 'vrsub.vi': vspec(0x03, OPIVI, 'vi'),

  // ---- min/max ----
  'vminu.vv': vspec(0x04, OPIVV, 'vv'), 'vminu.vx': vspec(0x04, OPIVX, 'vx'),
  'vmin.vv': vspec(0x05, OPIVV, 'vv'), 'vmin.vx': vspec(0x05, OPIVX, 'vx'),
  'vmaxu.vv': vspec(0x06, OPIVV, 'vv'), 'vmaxu.vx': vspec(0x06, OPIVX, 'vx'),
  'vmax.vv': vspec(0x07, OPIVV, 'vv'), 'vmax.vx': vspec(0x07, OPIVX, 'vx'),

  // ---- bitwise logical ----
  'vand.vv': vspec(0x09, OPIVV, 'vv'), 'vand.vx': vspec(0x09, OPIVX, 'vx'), 'vand.vi': vspec(0x09, OPIVI, 'vi'),
  'vor.vv': vspec(0x0a, OPIVV, 'vv'), 'vor.vx': vspec(0x0a, OPIVX, 'vx'), 'vor.vi': vspec(0x0a, OPIVI, 'vi'),
  'vxor.vv': vspec(0x0b, OPIVV, 'vv'), 'vxor.vx': vspec(0x0b, OPIVX, 'vx'), 'vxor.vi': vspec(0x0b, OPIVI, 'vi'),

  // ---- shifts (immediate forms use an unsigned 5-bit shamt) ----
  'vsll.vv': vspec(0x25, OPIVV, 'vv'), 'vsll.vx': vspec(0x25, OPIVX, 'vx'), 'vsll.vi': vspec(0x25, OPIVI, 'vviu'),
  'vsrl.vv': vspec(0x28, OPIVV, 'vv'), 'vsrl.vx': vspec(0x28, OPIVX, 'vx'), 'vsrl.vi': vspec(0x28, OPIVI, 'vviu'),
  'vsra.vv': vspec(0x29, OPIVV, 'vv'), 'vsra.vx': vspec(0x29, OPIVX, 'vx'), 'vsra.vi': vspec(0x29, OPIVI, 'vviu'),

  // ---- gather + slides (OPIVV/OPIVX/OPIVI) ----
  'vrgather.vv': vspec(0x0c, OPIVV, 'vv'), 'vrgather.vx': vspec(0x0c, OPIVX, 'vx'), 'vrgather.vi': vspec(0x0c, OPIVI, 'vviu'),
  'vslideup.vx': vspec(0x0e, OPIVX, 'vx'), 'vslideup.vi': vspec(0x0e, OPIVI, 'vviu'),
  'vslidedown.vx': vspec(0x0f, OPIVX, 'vx'), 'vslidedown.vi': vspec(0x0f, OPIVI, 'vviu'),
  'vslide1up.vx': vspec(0x0e, OPMVX, 'vx'), 'vslide1down.vx': vspec(0x0f, OPMVX, 'vx'),

  // ---- merge / move ----
  'vmerge.vvm': vspec(0x17, OPIVV, 'vvm'), 'vmerge.vxm': vspec(0x17, OPIVX, 'vxm'), 'vmerge.vim': vspec(0x17, OPIVI, 'vim'),
  'vmv.v.v': vspec(0x17, OPIVV, 'movv'), 'vmv.v.x': vspec(0x17, OPIVX, 'movx'), 'vmv.v.i': vspec(0x17, OPIVI, 'movi'),

  // ---- integer compares → a mask register (OPIVV/OPIVX/OPIVI) ----
  'vmseq.vv': vspec(0x18, OPIVV, 'vv'), 'vmseq.vx': vspec(0x18, OPIVX, 'vx'), 'vmseq.vi': vspec(0x18, OPIVI, 'vi'),
  'vmsne.vv': vspec(0x19, OPIVV, 'vv'), 'vmsne.vx': vspec(0x19, OPIVX, 'vx'), 'vmsne.vi': vspec(0x19, OPIVI, 'vi'),
  'vmsltu.vv': vspec(0x1a, OPIVV, 'vv'), 'vmsltu.vx': vspec(0x1a, OPIVX, 'vx'),
  'vmslt.vv': vspec(0x1b, OPIVV, 'vv'), 'vmslt.vx': vspec(0x1b, OPIVX, 'vx'),
  'vmsleu.vv': vspec(0x1c, OPIVV, 'vv'), 'vmsleu.vx': vspec(0x1c, OPIVX, 'vx'), 'vmsleu.vi': vspec(0x1c, OPIVI, 'vi'),
  'vmsle.vv': vspec(0x1d, OPIVV, 'vv'), 'vmsle.vx': vspec(0x1d, OPIVX, 'vx'), 'vmsle.vi': vspec(0x1d, OPIVI, 'vi'),
  'vmsgtu.vx': vspec(0x1e, OPIVX, 'vx'), 'vmsgtu.vi': vspec(0x1e, OPIVI, 'vi'),
  'vmsgt.vx': vspec(0x1f, OPIVX, 'vx'), 'vmsgt.vi': vspec(0x1f, OPIVI, 'vi'),

  // ---- reductions (OPMVV) ----
  'vredsum.vs': vspec(0x00, OPMVV, 'vs'), 'vredand.vs': vspec(0x01, OPMVV, 'vs'),
  'vredor.vs': vspec(0x02, OPMVV, 'vs'), 'vredxor.vs': vspec(0x03, OPMVV, 'vs'),
  'vredminu.vs': vspec(0x04, OPMVV, 'vs'), 'vredmin.vs': vspec(0x05, OPMVV, 'vs'),
  'vredmaxu.vs': vspec(0x06, OPMVV, 'vs'), 'vredmax.vs': vspec(0x07, OPMVV, 'vs'),

  // ---- mask-register logical (OPMVV) ----
  'vmand.mm': vspec(0x19, OPMVV, 'mm'), 'vmnand.mm': vspec(0x1d, OPMVV, 'mm'),
  'vmandn.mm': vspec(0x18, OPMVV, 'mm'), 'vmxor.mm': vspec(0x1b, OPMVV, 'mm'),
  'vmor.mm': vspec(0x1a, OPMVV, 'mm'), 'vmnor.mm': vspec(0x1e, OPMVV, 'mm'),
  'vmorn.mm': vspec(0x1c, OPMVV, 'mm'), 'vmxnor.mm': vspec(0x1f, OPMVV, 'mm'),

  // ---- integer multiply / divide (OPMVV/OPMVX) ----
  'vmulhu.vv': vspec(0x24, OPMVV, 'vv'), 'vmulhu.vx': vspec(0x24, OPMVX, 'vx'),
  'vmul.vv': vspec(0x25, OPMVV, 'vv'), 'vmul.vx': vspec(0x25, OPMVX, 'vx'),
  'vmulhsu.vv': vspec(0x26, OPMVV, 'vv'), 'vmulhsu.vx': vspec(0x26, OPMVX, 'vx'),
  'vmulh.vv': vspec(0x27, OPMVV, 'vv'), 'vmulh.vx': vspec(0x27, OPMVX, 'vx'),
  'vdivu.vv': vspec(0x20, OPMVV, 'vv'), 'vdivu.vx': vspec(0x20, OPMVX, 'vx'),
  'vdiv.vv': vspec(0x21, OPMVV, 'vv'), 'vdiv.vx': vspec(0x21, OPMVX, 'vx'),
  'vremu.vv': vspec(0x22, OPMVV, 'vv'), 'vremu.vx': vspec(0x22, OPMVX, 'vx'),
  'vrem.vv': vspec(0x23, OPMVV, 'vv'), 'vrem.vx': vspec(0x23, OPMVX, 'vx'),

  // ---- multiply-accumulate (OPMVV/OPMVX) — asm operand order is (vd, vs1, vs2) ----
  'vmacc.vv': vspec(0x2d, OPMVV, 'macvv'), 'vmacc.vx': vspec(0x2d, OPMVX, 'macvx'),
  'vnmsac.vv': vspec(0x2f, OPMVV, 'macvv'), 'vnmsac.vx': vspec(0x2f, OPMVX, 'macvx'),
  'vmadd.vv': vspec(0x29, OPMVV, 'macvv'), 'vmadd.vx': vspec(0x29, OPMVX, 'macvx'),
  'vnmsub.vv': vspec(0x2b, OPMVV, 'macvv'), 'vnmsub.vx': vspec(0x2b, OPMVX, 'macvx'),

  // ---- element ↔ scalar + mask population (the vXunary0 / vmunary0 groups) ----
  'vmv.x.s': vspec(0x10, OPMVV, 'wxs', 0x00),
  'vcpop.m': vspec(0x10, OPMVV, 'pop', 0x10),
  'vfirst.m': vspec(0x10, OPMVV, 'pop', 0x11),
  'vmv.s.x': vspec(0x10, OPMVX, 'wsx', 0x00),
  'vid.v': vspec(0x14, OPMVV, 'vid', 0x11),
  'viota.m': vspec(0x14, OPMVV, 'mvs2', 0x10),
  'vmsbf.m': vspec(0x14, OPMVV, 'mvs2', 0x01),
  'vmsof.m': vspec(0x14, OPMVV, 'mvs2', 0x02),
  'vmsif.m': vspec(0x14, OPMVV, 'mvs2', 0x03),
};

// ---------------------------------------------------------------------------
// Load / store instruction table (FP load/store opcodes, width-disambiguated)
// ---------------------------------------------------------------------------

/** width field (funct3) → element-width-in-bytes for vector mem ops. */
const WIDTH_BYTES: Record<number, number> = { 0: 1, 5: 2, 6: 4 };
const BYTES_WIDTH: Record<number, number> = { 1: 0, 2: 5, 4: 6 };

export type VMemKind = 'unit' | 'strided' | 'indexed' | 'mask';

export interface VMemSpec {
  store: boolean;
  kind: VMemKind;
  eew: number; // element width in bytes (data EEW for unit/strided, index EEW for indexed)
  ordered: boolean; // indexed-ordered vs unordered (behaviourally identical in our in-order core)
}

/** Resolve a vector load/store mnemonic to its spec, or null if it isn't one. */
export function vmemSpec(m: string): VMemSpec | null {
  // mask load/store: vlm.v / vsm.v (EEW=8, evl = ⌈vl/8⌉ bytes)
  if (m === 'vlm.v') return { store: false, kind: 'mask', eew: 1, ordered: false };
  if (m === 'vsm.v') return { store: true, kind: 'mask', eew: 1, ordered: false };
  // unit-stride  vle{8,16,32}.v / vse…
  let mm = /^v([ls])e(8|16|32)\.v$/.exec(m);
  if (mm) return { store: mm[1] === 's', kind: 'unit', eew: Number(mm[2]) / 8, ordered: false };
  // strided  vlse… / vsse…
  mm = /^v([ls])se(8|16|32)\.v$/.exec(m);
  if (mm) return { store: mm[1] === 's', kind: 'strided', eew: Number(mm[2]) / 8, ordered: false };
  // indexed  vl{u,o}xei… / vs{u,o}xei…
  mm = /^v([ls])([uo])xei(8|16|32)\.v$/.exec(m);
  if (mm) {
    return { store: mm[1] === 's', kind: 'indexed', eew: Number(mm[3]) / 8, ordered: mm[2] === 'o' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The set of every vector mnemonic (for the assembler dispatch + the highlighter)
// ---------------------------------------------------------------------------

const VMEM_MNEMONICS: string[] = (() => {
  const out = ['vlm.v', 'vsm.v'];
  for (const w of [8, 16, 32]) {
    out.push(`vle${w}.v`, `vse${w}.v`, `vlse${w}.v`, `vsse${w}.v`);
    out.push(`vluxei${w}.v`, `vsuxei${w}.v`, `vloxei${w}.v`, `vsoxei${w}.v`);
  }
  return out;
})();

export const V_MNEMONICS: ReadonlySet<string> = new Set([
  'vsetvli', 'vsetivli', 'vsetvl',
  ...Object.keys(VEC_SPECS),
  ...VMEM_MNEMONICS,
]);

export function isVectorMnemonic(m: string): boolean {
  return V_MNEMONICS.has(m);
}

/** True if a decoded opcode (with its funct3 width) belongs to the V extension. */
export function isVectorOpcode(opcode: number, funct3: number): boolean {
  if (opcode === OPV) return true;
  // A vector load/store rides the FP load/store opcode with a vector width field (0/5/6/7);
  // scalar flw/fsw use width 2 (single) / 3 (double), so the two never collide.
  if (opcode === VLOAD || opcode === VSTORE) return funct3 === 0 || funct3 === 5 || funct3 === 6 || funct3 === 7;
  return false;
}

// ---------------------------------------------------------------------------
// Encoding (assembler side)
// ---------------------------------------------------------------------------

export interface VecAsmCtx {
  /** Parse an integer (x) register token → 0..31. */
  xreg(tok: string): number;
  /** Parse an immediate token (honouring assembler constants). */
  imm(tok: string): number;
  fail(msg: string): never;
}

function parseVReg(tok: string, fail: (m: string) => never): number {
  const t = tok.trim().toLowerCase();
  const m = /^v(\d{1,2})$/.exec(t);
  if (!m) fail(`expected a vector register (v0..v31), got '${tok}'`);
  const n = Number(m![1]);
  if (n > 31) fail(`vector register out of range: '${tok}'`);
  return n;
}

function arith(funct6: number, vm: number, vs2: number, s1: number, cat: number, vd: number): number {
  return (
    ((funct6 & 0x3f) << 26) |
    ((vm & 1) << 25) |
    ((vs2 & 0x1f) << 20) |
    ((s1 & 0x1f) << 15) |
    ((cat & 7) << 12) |
    ((vd & 0x1f) << 7) |
    OPV
  ) >>> 0;
}

/** Strip an optional trailing `v0.t` mask token, returning vm (0 = masked) + the trimmed list. */
function peelMask(ops: string[]): { vm: number; ops: string[] } {
  if (ops.length && ops[ops.length - 1].trim().toLowerCase() === 'v0.t') {
    return { vm: 0, ops: ops.slice(0, -1) };
  }
  return { vm: 1, ops };
}

function need(ops: string[], n: number, ctx: VecAsmCtx, op: string): void {
  if (ops.length !== n) ctx.fail(`${op}: expected ${n} operand(s), got ${ops.length}`);
}

/** Assemble a vector mnemonic + operand tokens into a 32-bit word. */
export function assembleVector(op: string, ops0: string[], ctx: VecAsmCtx): number {
  // ---- configuration: vsetvli / vsetivli / vsetvl --------------------------
  if (op === 'vsetvli') {
    if (ops0.length < 3) ctx.fail('vsetvli: expected rd, rs1, e<sew>, m<lmul>[, ta/tu][, ma/mu]');
    const rd = ctx.xreg(ops0[0]);
    const rs1 = ctx.xreg(ops0[1]);
    const vtype = parseVtypeTokens(ops0.slice(2), ctx.fail);
    return (((vtype & 0x7ff) << 20) | (rs1 << 15) | (OPCFG << 12) | (rd << 7) | OPV) >>> 0;
  }
  if (op === 'vsetivli') {
    if (ops0.length < 3) ctx.fail('vsetivli: expected rd, uimm, e<sew>, m<lmul>[, ta/tu][, ma/mu]');
    const rd = ctx.xreg(ops0[0]);
    const avl = ctx.imm(ops0[1]) & 0x1f;
    const vtype = parseVtypeTokens(ops0.slice(2), ctx.fail);
    return ((0b11 << 30) | ((vtype & 0x3ff) << 20) | (avl << 15) | (OPCFG << 12) | (rd << 7) | OPV) >>> 0;
  }
  if (op === 'vsetvl') {
    need(ops0, 3, ctx, op);
    const rd = ctx.xreg(ops0[0]);
    const rs1 = ctx.xreg(ops0[1]);
    const rs2 = ctx.xreg(ops0[2]);
    return ((0x40 << 25) | (rs2 << 20) | (rs1 << 15) | (OPCFG << 12) | (rd << 7) | OPV) >>> 0;
  }

  // ---- loads / stores ------------------------------------------------------
  const mem = vmemSpec(op);
  if (mem) return encodeVMem(op, mem, ops0, ctx);

  // ---- arithmetic / permute ------------------------------------------------
  const spec = VEC_SPECS[op];
  if (!spec) ctx.fail(`unknown vector instruction '${op}'`);
  return encodeVecArith(op, spec, ops0, ctx);
}

function encodeVMem(op: string, mem: VMemSpec, ops0: string[], ctx: VecAsmCtx): number {
  const { vm, ops } = peelMask(ops0);
  const width = BYTES_WIDTH[mem.eew];
  const opcode = mem.store ? VSTORE : VLOAD;
  // The data/index register sits in the rd field for loads and the rs2-of-store position for
  // stores — in RVV both are simply the `vd` field of the encoding.
  const parseAddr = (tok: string): number => {
    const m = /^\(\s*([^)]+?)\s*\)$/.exec(tok.trim());
    if (!m) ctx.fail(`${op}: expected a base address '(rs1)', got '${tok}'`);
    return ctx.xreg(m![1]);
  };
  let vd: number, rs1: number, mop: number;
  let rs2 = 0, lumop = 0;
  if (mem.kind === 'unit' || mem.kind === 'mask') {
    need(ops, 2, ctx, op);
    vd = parseVReg(ops[0], ctx.fail);
    rs1 = parseAddr(ops[1]);
    mop = 0;
    lumop = mem.kind === 'mask' ? 0x0b : 0x00;
  } else if (mem.kind === 'strided') {
    need(ops, 3, ctx, op);
    vd = parseVReg(ops[0], ctx.fail);
    rs1 = parseAddr(ops[1]);
    rs2 = ctx.xreg(ops[2]);
    mop = 0b10;
  } else {
    // indexed: vd, (rs1), vs2(index vector)
    need(ops, 3, ctx, op);
    vd = parseVReg(ops[0], ctx.fail);
    rs1 = parseAddr(ops[1]);
    rs2 = parseVReg(ops[2], ctx.fail);
    mop = mem.ordered ? 0b11 : 0b01;
  }
  const mew = 0;
  const nf = 0;
  return (
    ((nf & 0x7) << 29) |
    (mew << 28) |
    ((mop & 3) << 26) |
    ((vm & 1) << 25) |
    (((mem.kind === 'unit' || mem.kind === 'mask' ? lumop : rs2) & 0x1f) << 20) |
    ((rs1 & 0x1f) << 15) |
    ((width & 7) << 12) |
    ((vd & 0x1f) << 7) |
    opcode
  ) >>> 0;
}

function encodeVecArith(op: string, spec: VecSpec, ops0: string[], ctx: VecAsmCtx): number {
  const { funct6, cat, form, sel } = spec;
  const I5 = (tok: string): number => ctx.imm(tok) & 0x1f;

  switch (form) {
    case 'vv': case 'vs': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 3, ctx, op);
      return arith(funct6, vm, parseVReg(ops[1], ctx.fail), parseVReg(ops[2], ctx.fail), cat, parseVReg(ops[0], ctx.fail));
    }
    case 'vx': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 3, ctx, op);
      return arith(funct6, vm, parseVReg(ops[1], ctx.fail), ctx.xreg(ops[2]), cat, parseVReg(ops[0], ctx.fail));
    }
    case 'vi': case 'vviu': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 3, ctx, op);
      return arith(funct6, vm, parseVReg(ops[1], ctx.fail), I5(ops[2]), cat, parseVReg(ops[0], ctx.fail));
    }
    case 'macvv': {
      // vmacc/vmadd/… vd, vs1, vs2  → vs1 field = ops[1], vs2 field = ops[2].
      const { vm, ops } = peelMask(ops0);
      need(ops, 3, ctx, op);
      return arith(funct6, vm, parseVReg(ops[2], ctx.fail), parseVReg(ops[1], ctx.fail), cat, parseVReg(ops[0], ctx.fail));
    }
    case 'macvx': {
      // vmacc.vx … vd, rs1, vs2  → rs1 in the s1 field, vs2 field = ops[2].
      const { vm, ops } = peelMask(ops0);
      need(ops, 3, ctx, op);
      return arith(funct6, vm, parseVReg(ops[2], ctx.fail), ctx.xreg(ops[1]), cat, parseVReg(ops[0], ctx.fail));
    }
    case 'mm': {
      need(ops0, 3, ctx, op);
      return arith(funct6, 1, parseVReg(ops0[1], ctx.fail), parseVReg(ops0[2], ctx.fail), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'vvm': {
      need(ops0, 4, ctx, op);
      return arith(funct6, 0, parseVReg(ops0[1], ctx.fail), parseVReg(ops0[2], ctx.fail), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'vxm': {
      need(ops0, 4, ctx, op);
      return arith(funct6, 0, parseVReg(ops0[1], ctx.fail), ctx.xreg(ops0[2]), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'vim': {
      need(ops0, 4, ctx, op);
      return arith(funct6, 0, parseVReg(ops0[1], ctx.fail), I5(ops0[2]), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'movv': {
      need(ops0, 2, ctx, op);
      return arith(funct6, 1, 0, parseVReg(ops0[1], ctx.fail), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'movx': {
      need(ops0, 2, ctx, op);
      return arith(funct6, 1, 0, ctx.xreg(ops0[1]), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'movi': {
      need(ops0, 2, ctx, op);
      return arith(funct6, 1, 0, I5(ops0[1]), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'wxs': {
      need(ops0, 2, ctx, op);
      return arith(funct6, 1, parseVReg(ops0[1], ctx.fail), sel ?? 0, cat, ctx.xreg(ops0[0]));
    }
    case 'wsx': {
      need(ops0, 2, ctx, op);
      return arith(funct6, 1, 0, ctx.xreg(ops0[1]), cat, parseVReg(ops0[0], ctx.fail));
    }
    case 'pop': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 2, ctx, op);
      return arith(funct6, vm, parseVReg(ops[1], ctx.fail), sel ?? 0, cat, ctx.xreg(ops[0]));
    }
    case 'vid': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 1, ctx, op);
      return arith(funct6, vm, 0, sel ?? 0, cat, parseVReg(ops[0], ctx.fail));
    }
    case 'mvs2': {
      const { vm, ops } = peelMask(ops0);
      need(ops, 2, ctx, op);
      return arith(funct6, vm, parseVReg(ops[1], ctx.fail), sel ?? 0, cat, parseVReg(ops[0], ctx.fail));
    }
  }
}

// ---------------------------------------------------------------------------
// Decoding (decoder/disassembler side)
// ---------------------------------------------------------------------------

// Reverse map for the arithmetic ops that are uniquely keyed by (cat, funct6).
const VEC_BY_KEY: Map<number, string> = (() => {
  const m = new Map<number, string>();
  for (const [name, s] of Object.entries(VEC_SPECS)) {
    if (s.form === 'movv' || s.form === 'movx' || s.form === 'movi') continue; // share key with vmerge
    if (s.funct6 === 0x10 || s.funct6 === 0x14) continue; // unary groups: decoded by selector
    m.set(s.cat * 64 + s.funct6, name);
  }
  return m;
})();

/** Resolve a raw vector word back to its mnemonic. */
export function decodeVectorMnemonic(raw: number): string {
  const w = raw >>> 0;
  const opcode = w & 0x7f;
  const funct3 = (w >>> 12) & 7;

  if (opcode === VLOAD || opcode === VSTORE) {
    const width = funct3;
    const eew = WIDTH_BYTES[width];
    if (eew === undefined) return 'unknown';
    const store = opcode === VSTORE;
    const mop = (w >>> 26) & 3;
    const ls = store ? 's' : 'l';
    if (mop === 0) {
      const lumop = (w >>> 20) & 0x1f;
      if (lumop === 0x0b) return store ? 'vsm.v' : 'vlm.v';
      return `v${ls}e${eew * 8}.v`;
    }
    if (mop === 2) return `v${ls}se${eew * 8}.v`;
    const o = mop === 3 ? 'o' : 'u';
    return `v${ls}${o}xei${eew * 8}.v`;
  }

  // OP-V
  if (funct3 === OPCFG) {
    if ((w >>> 31) === 0) return 'vsetvli';
    if ((w >>> 30) === 0b11) return 'vsetivli';
    return 'vsetvl';
  }
  const funct6 = (w >>> 26) & 0x3f;
  const vs2 = (w >>> 20) & 0x1f;
  const s1 = (w >>> 15) & 0x1f;
  const vm = (w >>> 25) & 1;

  // The merge/move group (funct6 = 0x17): vm distinguishes vmerge (0) from vmv.v.* (1).
  if (funct6 === 0x17) {
    if (vm === 1) return funct3 === OPIVV ? 'vmv.v.v' : funct3 === OPIVX ? 'vmv.v.x' : 'vmv.v.i';
    return funct3 === OPIVV ? 'vmerge.vvm' : funct3 === OPIVX ? 'vmerge.vxm' : 'vmerge.vim';
  }
  // vXunary0 (funct6 = 0x10): selector in the s1 field.
  if (funct6 === 0x10) {
    // vwxunary0 (OPMVV): the source is vs2 and the variant rides in the s1 field.
    if (funct3 === OPMVV) {
      if (s1 === 0x00) return 'vmv.x.s';
      if (s1 === 0x10) return 'vcpop.m';
      if (s1 === 0x11) return 'vfirst.m';
    }
    // vrxunary0 (OPMVX): only vmv.s.x — the scalar rides in the s1 field, vs2 must be 0.
    if (funct3 === OPMVX && vs2 === 0x00) return 'vmv.s.x';
  }
  // vmunary0 (funct6 = 0x14): selector in the s1 field.
  if (funct6 === 0x14 && funct3 === OPMVV) {
    if (vs2 === 0 && s1 === 0x11) return 'vid.v';
    if (s1 === 0x10) return 'viota.m';
    if (s1 === 0x01) return 'vmsbf.m';
    if (s1 === 0x02) return 'vmsof.m';
    if (s1 === 0x03) return 'vmsif.m';
  }

  return VEC_BY_KEY.get(funct3 * 64 + funct6) ?? 'unknown';
}
