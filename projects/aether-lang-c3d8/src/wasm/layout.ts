// Aether — WebAssembly heap layout
//
// The single source of truth for how Aether `Value`s are represented as cells in
// WebAssembly linear memory. Both sides of the boundary depend on it: `codegen.ts`
// emits WASM that *builds* these cells, and `bridge.ts` (running in JS) *reads and
// writes* them to format output, compare structurally, and pass values to imports.
//
// Every value is an `i32` pointer to a cell. Word 0 is always the tag. The
// allocator keeps cells 8-byte aligned, so the one `f64` field (a float's value)
// lands on an 8-byte boundary.

export const TAG = {
  INT: 1,
  FLOAT: 2,
  BOOL: 3,
  UNIT: 4,
  NIL: 5,
  CONS: 6,
  TUPLE: 7,
  DATA: 8,
  RECORD: 9,
  CLOSURE: 10,
  NATIVE: 11,
  CTOR: 12,
  STR: 13,
} as const

// Field byte-offsets within a cell (word 0 is the tag).
export const OFF = {
  TAG: 0,
  INT_VAL: 4,
  BOOL_VAL: 4,
  FLOAT_VAL: 8, // f64, 8-aligned
  STR_ID: 4,
  CONS_HEAD: 4,
  CONS_TAIL: 8,
  TUPLE_LEN: 4,
  TUPLE_ITEMS: 8,
  DATA_NAME: 4,
  DATA_ARGC: 8,
  DATA_ARGS: 12,
  RECORD_COUNT: 4,
  RECORD_PAIRS: 8, // (labelId, valuePtr) pairs, 8 bytes each
  CLOSURE_FUNC: 4,
  CLOSURE_NFREE: 8,
  CLOSURE_ENV: 12,
  PAP_ID: 4, // native id / ctor name id
  PAP_ARITY: 8,
  PAP_COLLECTED: 12,
  PAP_ARGS: 16,
} as const

// Fixed cell sizes (variable-size cells computed at the use site).
export const SIZE = {
  INT: 8,
  FLOAT: 16,
  BOOL: 8,
  UNIT: 8,
  NIL: 8,
  CONS: 16,
  STR: 8,
} as const

export const tupleSize = (len: number): number => OFF.TUPLE_ITEMS + 4 * len
export const dataSize = (argc: number): number => OFF.DATA_ARGS + 4 * argc
export const recordSize = (count: number): number => OFF.RECORD_PAIRS + 8 * count
export const closureSize = (nfree: number): number => OFF.CLOSURE_ENV + 4 * nfree
export const papSize = (arity: number): number => OFF.PAP_ARGS + 4 * arity

// — small-integer cache —
//
// `boxInt` boxed a fresh cell for *every* integer; arithmetic-heavy programs churn
// the heap doing it. We pre-build one shared `INT` cell per value in a small range
// at the very start of memory and have `boxInt` return the shared cell for in-range
// values. Aether is pure and every value is compared *structurally* (never by
// pointer), so sharing is invisible to results — only the allocation count drops.
export const SMALLINT_LO = -256
export const SMALLINT_HI = 1024 // exclusive
export const SMALLINT_COUNT = SMALLINT_HI - SMALLINT_LO

/** The cached `INT` cells sit at the base of memory (cell `i` ⇒ value `LO + i`). */
export const CACHE_BASE = 16
export const CACHE_BYTES = SMALLINT_COUNT * SIZE.INT

/** Where the heap bump pointer starts — just past the small-int cache (0 stays an invalid/null pointer). */
export const HEAP_BASE = CACHE_BASE + CACHE_BYTES
