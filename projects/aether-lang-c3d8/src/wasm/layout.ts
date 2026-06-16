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
  // A swept (dead) heap cell, re-headed as a free-list node {tag, size, next}.
  // Distinct from every value tag and small enough to live in the tag word's
  // low byte alongside the mark bit.
  FREE: 100,
} as const

// — garbage collector bookkeeping bits —
//
// The collector is *non-moving* mark-sweep. The mark bit is stolen from the high
// bits of the tag word (value tags are tiny, so bit 30 is always free); the real
// tag is recovered by masking it off. Because nothing moves, the pointers already
// sitting in wasm locals / on the operand stack stay valid across a collection —
// the shadow stack exists only to keep reachable objects *marked*.
export const MARK = 0x40000000 // bit 30 of word 0 ⇒ "reachable this cycle"
export const TAG_MASK = 0x3fffffff // strip the mark bit to read the real tag

// Free-list node fields (overlaid on a swept cell; a cell is ≥ MIN_CELL bytes so
// these three words always fit).
export const FREE_OFF = {
  SIZE: 4, // total block size in bytes (already 8-rounded)
  NEXT: 8, // next free block, or 0
} as const

/** Every heap cell is rounded up to an 8-aligned size of at least this many bytes,
 *  so a freed cell can always hold a {tag, size, next} free-list node. */
export const MIN_CELL = 16

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

// — the shadow stack —
//
// The garbage collector's root finder. WebAssembly hides the operand stack and
// locals from running code, so a tracing collector cannot see the live pointers
// there. Codegen instead mirrors exactly those pointers into this second stack in
// linear memory (`gcPush` / per-function frame pop), and the marker scans it. It
// sits between the int cache and the heap; a push past its end traps (a clean
// "shadow-stack overflow") rather than corrupting the heap above it.
export const SHADOW_BASE = CACHE_BASE + CACHE_BYTES
export const SHADOW_BYTES = 1024 * 1024 // 256K root slots — deeper than the wasm call stack
export const SHADOW_END = SHADOW_BASE + SHADOW_BYTES

/** Where the heap (the only GC-managed region) starts — just past the shadow stack. */
export const HEAP_BASE = SHADOW_END

/** Initial linear-memory size, in 64KiB pages, covering the cache + shadow stack
 *  with headroom for the heap before the first `memory.grow`. */
export const INITIAL_PAGES = Math.ceil((HEAP_BASE + 64 * 1024) / 65536)

/** Round a requested cell size up to the allocator's granularity (8-aligned, ≥ MIN_CELL). */
export const allocSize = (n: number): number => {
  const r = (n + 7) & ~7
  return r < MIN_CELL ? MIN_CELL : r
}
