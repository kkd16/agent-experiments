// An INDEPENDENT, from-scratch move generator built on magic bitboards.
//
// The rest of the engine (search, eval, tablebases, NNUE, MCTS) stands on the
// 0x88 mailbox generator in `movegen.ts`. That generator is perft-clean — but it
// is the *only* witness to its own correctness. This module is a second, wholly
// independent witness: a different board representation (twelve 64-bit `bigint`
// piece boards), a different algorithm (fully-LEGAL generation via king-danger
// maps, check masks and absolute-pin rays — never "make a move to see if it was
// legal"), and its own FEN parser. When two engines that share no code reproduce
// the same perft node counts — and the published reference numbers — the move
// layer is trustworthy.
//
// Bitboards use `bigint` for exact 64-bit semantics (JS `number` bitwise ops are
// 32-bit). This is the reference/oracle path, not the speed path; correctness and
// clarity win over raw throughput here. Square index = rank*8 + file, a1 = 0,
// h1 = 7, a8 = 56, h8 = 63; the least-significant bit is a1.

// ---------------------------------------------------------------------------
// 64-bit bitboard primitives
// ---------------------------------------------------------------------------

export type BB = bigint

export const MASK64: BB = (1n << 64n) - 1n
const ONE: BB = 1n

export function bit(sq: number): BB {
  return ONE << BigInt(sq)
}

// Index of the least-significant set bit, computed via 32-bit halves so it never
// touches Number's 2^53 precision ceiling.
export function lsb(bb: BB): number {
  const lo = Number(bb & 0xffffffffn)
  if (lo !== 0) return 31 - Math.clz32(lo & -lo)
  const hi = Number((bb >> 32n) & 0xffffffffn)
  return 32 + (31 - Math.clz32(hi & -hi))
}

export function popcount(bb: BB): number {
  let lo = Number(bb & 0xffffffffn)
  let hi = Number((bb >> 32n) & 0xffffffffn)
  // SWAR popcount on each 32-bit half.
  lo = lo - ((lo >>> 1) & 0x55555555)
  lo = (lo & 0x33333333) + ((lo >>> 2) & 0x33333333)
  lo = (((lo + (lo >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  hi = hi - ((hi >>> 1) & 0x55555555)
  hi = (hi & 0x33333333) + ((hi >>> 2) & 0x33333333)
  hi = (((hi + (hi >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  return lo + hi
}

// Iterate the set-bit indices of a bitboard.
export function* bits(bb: BB): Generator<number> {
  let b = bb
  while (b) {
    yield lsb(b)
    b &= b - ONE
  }
}

export function squareName(sq: number): string {
  return 'abcdefgh'[sq & 7] + (1 + (sq >> 3))
}

// Render a bitboard as an 8-rank string (rank 8 on top), for debugging.
export function prettyBB(bb: BB): string {
  let out = ''
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) out += (bb >> BigInt(r * 8 + f)) & ONE ? '1 ' : '. '
    out += '\n'
  }
  return out
}

// ---------------------------------------------------------------------------
// Colours, pieces, move encoding
// ---------------------------------------------------------------------------

export const WHITE = 0
export const BLACK = 1

// Piece-board indices: white P,N,B,R,Q,K = 0..5, black = 6..11.
export const PAWN = 0
export const KNIGHT = 1
export const BISHOP = 2
export const ROOK = 3
export const QUEEN = 4
export const KING = 5
export function pieceIdx(color: number, type: number): number {
  return color * 6 + type
}

// Castling-right bits.
export const CR_WK = 1
export const CR_WQ = 2
export const CR_BK = 4
export const CR_BQ = 8

// A move packs into one 32-bit number: from(6) | to(6) | promo(3) | flag(3).
// `promo` is a piece TYPE (KNIGHT..QUEEN) or 0. flags below.
export const FLAG_NORMAL = 0
export const FLAG_DOUBLE = 1 // double pawn push (sets the ep square)
export const FLAG_EP = 2 // en-passant capture
export const FLAG_CASTLE = 3 // king two-square castle

export type BBMove = number
export function encodeMove(from: number, to: number, promo: number, flag: number): BBMove {
  return from | (to << 6) | (promo << 12) | (flag << 15)
}
export function mvFrom(m: BBMove): number {
  return m & 63
}
export function mvTo(m: BBMove): number {
  return (m >> 6) & 63
}
export function mvPromo(m: BBMove): number {
  return (m >> 12) & 7
}
export function mvFlag(m: BBMove): number {
  return (m >> 15) & 7
}

export function moveToUci(m: BBMove): string {
  const promo = mvPromo(m) // piece type: KNIGHT=1 .. QUEEN=4
  return squareName(mvFrom(m)) + squareName(mvTo(m)) + (promo ? 'nbrq'[promo - 1] : '')
}

// ---------------------------------------------------------------------------
// Precomputed leaper attacks + ray geometry
// ---------------------------------------------------------------------------

const KNIGHT_ATT: BB[] = new Array(64)
const KING_ATT: BB[] = new Array(64)
const PAWN_ATT: BB[][] = [new Array(64), new Array(64)] // [color][sq]

// Squares strictly between a and b if they share a rank/file/diagonal, else 0.
const BETWEEN: BB[][] = Array.from({ length: 64 }, () => new Array<BB>(64).fill(0n))
// The full line through a and b (all squares of that rank/file/diagonal), else 0.
const LINE: BB[][] = Array.from({ length: 64 }, () => new Array<BB>(64).fill(0n))

function onBoard(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8
}

;(function initLeapers() {
  const kn = [
    [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ]
  const kg = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ]
  for (let s = 0; s < 64; s++) {
    const f = s & 7
    const r = s >> 3
    let n = 0n
    let k = 0n
    for (const [df, dr] of kn) if (onBoard(f + df, r + dr)) n |= bit((r + dr) * 8 + (f + df))
    for (const [df, dr] of kg) if (onBoard(f + df, r + dr)) k |= bit((r + dr) * 8 + (f + df))
    KNIGHT_ATT[s] = n
    KING_ATT[s] = k
    // Pawn attacks: white attacks the two squares one rank up; black one rank down.
    let wp = 0n
    let bp = 0n
    if (onBoard(f - 1, r + 1)) wp |= bit((r + 1) * 8 + (f - 1))
    if (onBoard(f + 1, r + 1)) wp |= bit((r + 1) * 8 + (f + 1))
    if (onBoard(f - 1, r - 1)) bp |= bit((r - 1) * 8 + (f - 1))
    if (onBoard(f + 1, r - 1)) bp |= bit((r - 1) * 8 + (f + 1))
    PAWN_ATT[WHITE][s] = wp
    PAWN_ATT[BLACK][s] = bp
  }
})()

const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
]
;(function initRays() {
  for (let a = 0; a < 64; a++) {
    const af = a & 7
    const ar = a >> 3
    for (const [df, dr] of DIRS8) {
      let f = af + df
      let r = ar + dr
      let between = 0n
      const path: number[] = []
      while (onBoard(f, r)) {
        const s = r * 8 + f
        path.push(s)
        f += df
        r += dr
      }
      // Fill BETWEEN/LINE for every square b reachable from a along this ray.
      for (let i = 0; i < path.length; i++) {
        const b = path[i]
        BETWEEN[a][b] = between
        // LINE = the whole bidirectional line through a and b.
        let line = bit(a) | bit(b)
        // extend forward from b
        let ff = (b & 7) + df
        let rr = (b >> 3) + dr
        while (onBoard(ff, rr)) { line |= bit(rr * 8 + ff); ff += df; rr += dr }
        // extend backward from a
        ff = af - df
        rr = ar - dr
        while (onBoard(ff, rr)) { line |= bit(rr * 8 + ff); ff -= df; rr -= dr }
        // include the between squares
        line |= between | bit(b)
        LINE[a][b] = line
        between |= bit(b)
      }
    }
  }
})()

export function betweenBB(a: number, b: number): BB {
  return BETWEEN[a][b]
}
export function lineBB(a: number, b: number): BB {
  return LINE[a][b]
}

// ---------------------------------------------------------------------------
// Sliding attacks + magic bitboards
// ---------------------------------------------------------------------------

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BISHOP_DIRS = [[1, 1], [-1, -1], [1, -1], [-1, 1]]

// Blocker-aware ray attacks: walk each direction, stop AFTER including the first
// occupied square. This is the exact ground truth the magic tables reproduce.
function slideAttacks(sq: number, occ: BB, dirs: number[][]): BB {
  const f0 = sq & 7
  const r0 = sq >> 3
  let att = 0n
  for (const [df, dr] of dirs) {
    let f = f0 + df
    let r = r0 + dr
    while (onBoard(f, r)) {
      const s = r * 8 + f
      att |= bit(s)
      if ((occ >> BigInt(s)) & ONE) break
      f += df
      r += dr
    }
  }
  return att
}

// Relevant-occupancy mask: the ray squares that can block, excluding the board
// edge on each ray (a blocker on the edge never changes what lies beyond it).
function rayMask(sq: number, dirs: number[][]): BB {
  const f0 = sq & 7
  const r0 = sq >> 3
  let m = 0n
  for (const [df, dr] of dirs) {
    let f = f0 + df
    let r = r0 + dr
    while (onBoard(f + df, r + dr)) {
      m |= bit(r * 8 + f)
      f += df
      r += dr
    }
  }
  return m
}

interface Magic {
  mask: BB
  magic: BB
  shift: bigint
  table: BB[]
}

const ROOK_MAGIC: Magic[] = new Array(64)
const BISHOP_MAGIC: Magic[] = new Array(64)

// Deterministic 64-bit PRNG (splitmix64) so magic search is reproducible.
function makeRng(seed: bigint) {
  let x = seed & MASK64
  return () => {
    x = (x + 0x9e3779b97f4a7c15n) & MASK64
    let z = x
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
    return (z ^ (z >> 31n)) & MASK64
  }
}

// Enumerate every subset of `mask` via the carry-rippler trick.
function enumerateSubsets(mask: BB): BB[] {
  const out: BB[] = []
  let sub = 0n
  do {
    out.push(sub)
    sub = (sub - mask) & mask
  } while (sub)
  return out
}

// Find a magic multiplier for one square: a 64-bit constant that hashes every
// relevant-occupancy subset to a table slot with no *destructive* collision (two
// subsets may share a slot only if they yield the same attack set).
function findMagic(sq: number, dirs: number[][], rng: () => bigint): Magic {
  const mask = rayMask(sq, dirs)
  const nbits = popcount(mask)
  const shift = BigInt(64 - nbits)
  const subsets = enumerateSubsets(mask)
  const attacks = subsets.map((occ) => slideAttacks(sq, occ, dirs))
  const size = 1 << nbits
  for (;;) {
    const magic = rng() & rng() & rng() // sparse candidate (few set bits)
    // A quick reject used by every reference implementation.
    if (popcount((mask * magic) & 0xff00000000000000n) < 6) continue
    const table = new Array<BB>(size).fill(-1n)
    let ok = true
    for (let i = 0; i < subsets.length; i++) {
      const idx = Number(((subsets[i] * magic) & MASK64) >> shift)
      if (table[idx] === -1n) table[idx] = attacks[i]
      else if (table[idx] !== attacks[i]) {
        ok = false
        break
      }
    }
    if (ok) return { mask, magic, shift, table }
  }
}

// Magic multipliers found by the seeded search above (run once, offline, via
// `tools/bb-dump-magics.ts`). Embedding them means init only has to build the
// attack tables — no search — so it finishes in a few ms instead of ~18 s.
// `initMagics` re-verifies every one for destructive collisions at build time,
// and the perft self-test is the ultimate check, so a bad constant fails loudly.
const ROOK_MAGICS: BB[] = [
  0x4800086a050c000n, 0xc440002000100446n, 0x8100100840200102n, 0x200044008220010n,
  0x100021100040800n, 0x900320814004100n, 0xb80058001004600n, 0x8200008021004204n,
  0x8000c0016c80n, 0x2220401000200040n, 0x884802002801000n, 0x4800800100080n,
  0x1201800400811800n, 0x600808004000200n, 0xa02808003000200n, 0x20002048c0153n,
  0x100228000400080n, 0x904484010002000n, 0x910420010802200n, 0x422848008011000n,
  0x2a08028004008008n, 0xc818002001400n, 0x8840c0008321001n, 0x8220000408124n,
  0x2480400080008020n, 0x41008300400021n, 0x820080040401000n, 0x208080080100080n,
  0x12000a00200410n, 0x80040080800200n, 0x4549000100020004n, 0xc84a00008104n,
  0x8401020800488n, 0x40002000804088n, 0x7a0001000808020n, 0xc480801000800800n,
  0x206800800800400n, 0x1002000452003008n, 0x430500114001208n, 0x200010082000054n,
  0x8000204000948000n, 0x18100440200a4000n, 0x100200041030014n, 0x20410200a020040n,
  0x448000805010010n, 0x5052000824060010n, 0x502000108020004n, 0x5002008400420001n,
  0x20400080002080n, 0x828860054210200n, 0x1002000401100n, 0x292100220c100100n,
  0x20040008008080n, 0xa004010040020040n, 0x2000801040200n, 0x404041040040a200n,
  0x809081020408202n, 0x840160280422102n, 0x8808e00010090145n, 0x400100101042009n,
  0x10a012050480442n, 0x9000804000201n, 0x40c0010082100804n, 0x200c0020904102n,
]
const BISHOP_MAGICS: BB[] = [
  0x8040010102020040n, 0x4a0110204810200n, 0x281000ca00400010n, 0xc040408800a0000n,
  0x204c10c440040582n, 0x1010840000800n, 0x1100451c20602814n, 0x8040820509014020n,
  0x4800200421080110n, 0x281002107200a100n, 0x29000404408a0080n, 0xa4a4040a800820n,
  0x680811040080000n, 0x201010120100002n, 0xc000088c8808c020n, 0x2000408041101000n,
  0x402c205010908108n, 0x110211401980111n, 0x70000801819010n, 0x4204202020040n,
  0x1011000290402000n, 0x88a059100420200n, 0x6014a0086482000n, 0x212000122011440n,
  0x218200024245010n, 0xc002302002902221n, 0x114220510040044n, 0x5802002248008020n,
  0x200848014002000n, 0x2048050892008220n, 0x810c410a0820800n, 0x268410000410808n,
  0x100805408a1000n, 0x2148380464420400n, 0x4002080204110205n, 0x20c020084880080n,
  0x1240008020020020n, 0x4000901100008080n, 0x818421000c0100n, 0x2040440002200n,
  0x200a26010012028n, 0x241c211108513009n, 0x22010248080108n, 0x12011080800n,
  0x4142280901108400n, 0x240080080224102n, 0x22088805000085n, 0x828020052100443n,
  0x2410440404400000n, 0x520a4908084808n, 0x2400202201101608n, 0x84010841109002n,
  0x402021120220098n, 0xd1086208020804n, 0x210600801006200n, 0x41044004083c0n,
  0x20e60208a00810n, 0xc0c0110128020205n, 0xc403400242024102n, 0x80510c00a0842400n,
  0x106e080012202a00n, 0x8000004008012104n, 0x20600a20a310n, 0x6040052800a109c0n,
]

// Build one square's attack table from a known-good magic, asserting there is no
// destructive collision along the way.
function buildMagic(sq: number, dirs: number[][], magic: BB): Magic {
  const mask = rayMask(sq, dirs)
  const nbits = popcount(mask)
  const shift = BigInt(64 - nbits)
  const table = new Array<BB>(1 << nbits).fill(-1n)
  for (const occ of enumerateSubsets(mask)) {
    const att = slideAttacks(sq, occ, dirs)
    const idx = Number(((occ * magic) & MASK64) >> shift)
    if (table[idx] === -1n) table[idx] = att
    else if (table[idx] !== att) throw new Error(`bitboard: destructive magic collision at square ${sq}`)
  }
  return { mask, magic, shift, table }
}

// Re-run the seeded search from scratch (used by the offline dump tool and
// available for the curious). Not called at init — that uses the embedded set.
export function searchMagics(): { rook: BB[]; bishop: BB[] } {
  const rng = makeRng(0xc0ffee1234567890n)
  const rook: BB[] = []
  const bishop: BB[] = []
  for (let s = 0; s < 64; s++) rook.push(findMagic(s, ROOK_DIRS, rng).magic)
  for (let s = 0; s < 64; s++) bishop.push(findMagic(s, BISHOP_DIRS, rng).magic)
  return { rook, bishop }
}

let magicsReady = false
export function initMagics(): void {
  if (magicsReady) return
  for (let s = 0; s < 64; s++) ROOK_MAGIC[s] = buildMagic(s, ROOK_DIRS, ROOK_MAGICS[s])
  for (let s = 0; s < 64; s++) BISHOP_MAGIC[s] = buildMagic(s, BISHOP_DIRS, BISHOP_MAGICS[s])
  magicsReady = true
}

function magicIndex(m: Magic, occ: BB): number {
  return Number((((occ & m.mask) * m.magic) & MASK64) >> m.shift)
}

export function rookAttacks(sq: number, occ: BB): BB {
  const m = ROOK_MAGIC[sq]
  return m.table[magicIndex(m, occ)]
}
export function bishopAttacks(sq: number, occ: BB): BB {
  const m = BISHOP_MAGIC[sq]
  return m.table[magicIndex(m, occ)]
}
export function queenAttacks(sq: number, occ: BB): BB {
  return rookAttacks(sq, occ) | bishopAttacks(sq, occ)
}
export function knightAttacks(sq: number): BB {
  return KNIGHT_ATT[sq]
}
export function kingAttacks(sq: number): BB {
  return KING_ATT[sq]
}
export function pawnAttacks(color: number, sq: number): BB {
  return PAWN_ATT[color][sq]
}

// Live magic-hash breakdown for the explorer UI: the relevant occupancy, the
// 64-bit product, the shift, and the resulting table index.
export interface MagicProbe {
  mask: BB
  relevant: BB
  magic: BB
  product: BB
  shift: number
  bits: number
  index: number
  attacks: BB
}
export function probeMagic(piece: 'rook' | 'bishop', sq: number, occ: BB): MagicProbe {
  const m = piece === 'rook' ? ROOK_MAGIC[sq] : BISHOP_MAGIC[sq]
  const relevant = occ & m.mask
  const product = (relevant * m.magic) & MASK64
  return {
    mask: m.mask,
    relevant,
    magic: m.magic,
    product,
    shift: Number(m.shift),
    bits: 64 - Number(m.shift),
    index: magicIndex(m, occ),
    attacks: m.table[magicIndex(m, occ)],
  }
}

// ---------------------------------------------------------------------------
// Bitboard position state + FEN
// ---------------------------------------------------------------------------

export interface BBState {
  pieces: BB[] // 12 piece boards (see pieceIdx)
  side: number // WHITE | BLACK
  ep: number // en-passant target square, or -1
  castle: number // CR_* bitmask
}

const FEN_PIECE: Record<string, number> = {
  P: pieceIdx(WHITE, PAWN), N: pieceIdx(WHITE, KNIGHT), B: pieceIdx(WHITE, BISHOP),
  R: pieceIdx(WHITE, ROOK), Q: pieceIdx(WHITE, QUEEN), K: pieceIdx(WHITE, KING),
  p: pieceIdx(BLACK, PAWN), n: pieceIdx(BLACK, KNIGHT), b: pieceIdx(BLACK, BISHOP),
  r: pieceIdx(BLACK, ROOK), q: pieceIdx(BLACK, QUEEN), k: pieceIdx(BLACK, KING),
}
const PIECE_GLYPH = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']

export function parseFenBB(fen: string): BBState {
  const [placement, turn = 'w', castling = '-', ep = '-'] = fen.trim().split(/\s+/)
  const pieces: BB[] = new Array(12).fill(0n)
  let rank = 7
  let file = 0
  for (const ch of placement) {
    if (ch === '/') {
      rank--
      file = 0
    } else if (ch >= '1' && ch <= '8') {
      file += ch.charCodeAt(0) - 48
    } else {
      pieces[FEN_PIECE[ch]] |= bit(rank * 8 + file)
      file++
    }
  }
  let castle = 0
  if (castling.includes('K')) castle |= CR_WK
  if (castling.includes('Q')) castle |= CR_WQ
  if (castling.includes('k')) castle |= CR_BK
  if (castling.includes('q')) castle |= CR_BQ
  let epSq = -1
  if (ep !== '-' && ep.length === 2) epSq = (ep.charCodeAt(1) - 49) * 8 + (ep.charCodeAt(0) - 97)
  return { pieces, side: turn === 'b' ? BLACK : WHITE, ep: epSq, castle }
}

export function pieceGlyphAt(st: BBState, sq: number): string | null {
  const b = bit(sq)
  for (let i = 0; i < 12; i++) if (st.pieces[i] & b) return PIECE_GLYPH[i]
  return null
}

function occupancy(st: BBState, color: number): BB {
  const o = color * 6
  return st.pieces[o] | st.pieces[o + 1] | st.pieces[o + 2] | st.pieces[o + 3] | st.pieces[o + 4] | st.pieces[o + 5]
}

// All occupied squares (both colours).
export function occupied(st: BBState): BB {
  return occupancy(st, WHITE) | occupancy(st, BLACK)
}

// The piece on a square, as { color, type }, or null.
export function pieceAt(st: BBState, sq: number): { color: number; type: number } | null {
  const b = bit(sq)
  for (let i = 0; i < 12; i++) if (st.pieces[i] & b) return { color: i < 6 ? WHITE : BLACK, type: i % 6 }
  return null
}

// The attack set of the piece on `sq` given the current occupancy (magic lookup
// for sliders). Empty if the square is empty.
export function attacksFrom(st: BBState, sq: number): BB {
  const p = pieceAt(st, sq)
  if (!p) return 0n
  const occ = occupied(st)
  switch (p.type) {
    case PAWN: return pawnAttacks(p.color, sq)
    case KNIGHT: return knightAttacks(sq)
    case BISHOP: return bishopAttacks(sq, occ)
    case ROOK: return rookAttacks(sq, occ)
    case QUEEN: return queenAttacks(sq, occ)
    case KING: return kingAttacks(sq)
    default: return 0n
  }
}

// ---------------------------------------------------------------------------
// Fully-legal move generation
// ---------------------------------------------------------------------------

// Every square the `by` side attacks, computed against `occ` (pass the board with
// OUR king removed to get the true king-danger map: the king cannot flee along a
// slider's ray, because the ray would otherwise stop at the king itself).
function attacksBy(st: BBState, by: number, occ: BB): BB {
  const o = by * 6
  let att = 0n
  for (const s of bits(st.pieces[o + PAWN])) att |= PAWN_ATT[by][s]
  for (const s of bits(st.pieces[o + KNIGHT])) att |= KNIGHT_ATT[s]
  for (const s of bits(st.pieces[o + BISHOP])) att |= bishopAttacks(s, occ)
  for (const s of bits(st.pieces[o + ROOK])) att |= rookAttacks(s, occ)
  for (const s of bits(st.pieces[o + QUEEN])) att |= queenAttacks(s, occ)
  att |= KING_ATT[lsb(st.pieces[o + KING])]
  return att
}

// Enemy pieces that attack `sq` (used for checker detection).
function attackersTo(st: BBState, sq: number, bySide: number, occ: BB): BB {
  const o = bySide * 6
  let a = 0n
  a |= PAWN_ATT[bySide ^ 1][sq] & st.pieces[o + PAWN]
  a |= KNIGHT_ATT[sq] & st.pieces[o + KNIGHT]
  a |= KING_ATT[sq] & st.pieces[o + KING]
  a |= bishopAttacks(sq, occ) & (st.pieces[o + BISHOP] | st.pieces[o + QUEEN])
  a |= rookAttacks(sq, occ) & (st.pieces[o + ROOK] | st.pieces[o + QUEEN])
  return a
}

const RANK_2 = 0x000000000000ff00n
const RANK_7 = 0x00ff000000000000n
const PROMO_TYPES = [QUEEN, ROOK, BISHOP, KNIGHT]

// Push a pawn move, expanding to four moves if it lands on the back rank.
function addPawnMove(out: BBMove[], from: number, to: number, flag: number): void {
  const toRank = to >> 3
  if (toRank === 0 || toRank === 7) {
    for (const pt of PROMO_TYPES) out.push(encodeMove(from, to, pt, FLAG_NORMAL))
  } else {
    out.push(encodeMove(from, to, 0, flag))
  }
}

// Generate all fully-legal moves for the side to move.
export function generateLegalBB(st: BBState): BBMove[] {
  const out: BBMove[] = []
  const us = st.side
  const them = us ^ 1
  const uo = us * 6
  const ourOcc = occupancy(st, us)
  const theirOcc = occupancy(st, them)
  const occ = ourOcc | theirOcc
  const ksq = lsb(st.pieces[uo + KING])

  // King-danger map: enemy attacks with our king removed from the occupancy.
  const occNoKing = occ ^ bit(ksq)
  const danger = attacksBy(st, them, occNoKing)

  // King moves: to any square not occupied by us and not attacked.
  const kingTargets = KING_ATT[ksq] & ~ourOcc & ~danger
  for (const to of bits(kingTargets)) out.push(encodeMove(ksq, to, 0, FLAG_NORMAL))

  // Checkers and the check mask.
  const checkers = attackersTo(st, ksq, them, occ)
  const numCheckers = popcount(checkers)

  if (numCheckers >= 2) {
    // Double check: only the king can move; castling is impossible.
    return out
  }

  // Target mask for non-king pieces: unrestricted, unless in single check, in
  // which case a move must capture the checker or block the check ray.
  let checkMask = MASK64
  if (numCheckers === 1) {
    const csq = lsb(checkers)
    checkMask = checkers | BETWEEN[ksq][csq]
  }

  // Absolute pins: an enemy slider whose ray to our king passes through exactly
  // one of our pieces pins that piece to the king's line.
  const enemyRQ = st.pieces[them * 6 + ROOK] | st.pieces[them * 6 + QUEEN]
  const enemyBQ = st.pieces[them * 6 + BISHOP] | st.pieces[them * 6 + QUEEN]
  const pinRay: BB[] = [] // pinRay[square] present only for pinned pieces
  let pinned = 0n
  const snipers =
    (rookAttacks(ksq, theirOcc) & enemyRQ) | (bishopAttacks(ksq, theirOcc) & enemyBQ)
  for (const s of bits(snipers)) {
    const between = BETWEEN[ksq][s] & occ
    if (popcount(between) === 1 && (between & ourOcc)) {
      const psq = lsb(between)
      pinned |= between
      pinRay[psq] = LINE[ksq][s]
    }
  }

  const notOur = ~ourOcc

  // Knights (a pinned knight can never move).
  for (const s of bits(st.pieces[uo + KNIGHT] & ~pinned)) {
    for (const to of bits(KNIGHT_ATT[s] & notOur & checkMask)) out.push(encodeMove(s, to, 0, FLAG_NORMAL))
  }
  // Bishops.
  for (const s of bits(st.pieces[uo + BISHOP])) {
    let t = bishopAttacks(s, occ) & notOur & checkMask
    if (pinned & bit(s)) t &= pinRay[s]
    for (const to of bits(t)) out.push(encodeMove(s, to, 0, FLAG_NORMAL))
  }
  // Rooks.
  for (const s of bits(st.pieces[uo + ROOK])) {
    let t = rookAttacks(s, occ) & notOur & checkMask
    if (pinned & bit(s)) t &= pinRay[s]
    for (const to of bits(t)) out.push(encodeMove(s, to, 0, FLAG_NORMAL))
  }
  // Queens.
  for (const s of bits(st.pieces[uo + QUEEN])) {
    let t = queenAttacks(s, occ) & notOur & checkMask
    if (pinned & bit(s)) t &= pinRay[s]
    for (const to of bits(t)) out.push(encodeMove(s, to, 0, FLAG_NORMAL))
  }

  // Pawns.
  const forward = us === WHITE ? 8 : -8
  const startRank = us === WHITE ? RANK_2 : RANK_7
  for (const s of bits(st.pieces[uo + PAWN])) {
    const restrict = pinned & bit(s) ? pinRay[s] : MASK64
    // Single / double push.
    const one = s + forward
    if (!((occ >> BigInt(one)) & ONE)) {
      if ((bit(one) & checkMask & restrict) !== 0n) addPawnMove(out, s, one, FLAG_NORMAL)
      // Double push from the start rank, if the intermediate square is empty.
      if (bit(s) & startRank) {
        const two = one + forward
        if (!((occ >> BigInt(two)) & ONE) && (bit(two) & checkMask & restrict) !== 0n) {
          out.push(encodeMove(s, two, 0, FLAG_DOUBLE))
        }
      }
    }
    // Captures.
    for (const to of bits(PAWN_ATT[us][s] & theirOcc & checkMask & restrict)) {
      addPawnMove(out, s, to, FLAG_NORMAL)
    }
    // En passant — validated by a full king-safety simulation, which also covers
    // the notorious horizontal discovered-check case (capturing removes two pawns
    // from the king's rank at once).
    if (st.ep >= 0 && PAWN_ATT[us][s] & bit(st.ep)) {
      const capSq = st.ep - forward
      const occAfter = (occ ^ bit(s) ^ bit(capSq)) | bit(st.ep)
      const rookLike = st.pieces[them * 6 + ROOK] | st.pieces[them * 6 + QUEEN]
      const bishopLike = st.pieces[them * 6 + BISHOP] | st.pieces[them * 6 + QUEEN]
      const attacked =
        (rookAttacks(ksq, occAfter) & rookLike) !== 0n ||
        (bishopAttacks(ksq, occAfter) & bishopLike) !== 0n ||
        (KNIGHT_ATT[ksq] & st.pieces[them * 6 + KNIGHT]) !== 0n ||
        (PAWN_ATT[us][ksq] & (st.pieces[them * 6 + PAWN] ^ bit(capSq))) !== 0n
      if (!attacked) out.push(encodeMove(s, st.ep, 0, FLAG_EP))
    }
  }

  // Castling (standard chess). King must be on its home square, not in check, and
  // the king's path squares must be empty and unattacked.
  if (numCheckers === 0) {
    if (us === WHITE && ksq === 4) {
      if (st.castle & CR_WK && !(occ & 0x60n) && !(danger & 0x60n) && st.pieces[uo + ROOK] & bit(7))
        out.push(encodeMove(4, 6, 0, FLAG_CASTLE))
      if (st.castle & CR_WQ && !(occ & 0x0en) && !(danger & 0x0cn) && st.pieces[uo + ROOK] & bit(0))
        out.push(encodeMove(4, 2, 0, FLAG_CASTLE))
    } else if (us === BLACK && ksq === 60) {
      if (st.castle & CR_BK && !(occ & 0x6000000000000000n) && !(danger & 0x6000000000000000n) && st.pieces[uo + ROOK] & bit(63))
        out.push(encodeMove(60, 62, 0, FLAG_CASTLE))
      if (st.castle & CR_BQ && !(occ & 0x0e00000000000000n) && !(danger & 0x0c00000000000000n) && st.pieces[uo + ROOK] & bit(56))
        out.push(encodeMove(60, 58, 0, FLAG_CASTLE))
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Copy-make + perft
// ---------------------------------------------------------------------------

// Per-square castling-right mask: a move touching one of these squares (as from
// or to) voids the listed rights. Default 15 (all rights preserved).
const CASTLE_MASK = new Array<number>(64).fill(15)
CASTLE_MASK[0] = 15 & ~CR_WQ // a1 rook
CASTLE_MASK[7] = 15 & ~CR_WK // h1 rook
CASTLE_MASK[4] = 15 & ~(CR_WK | CR_WQ) // e1 king
CASTLE_MASK[56] = 15 & ~CR_BQ // a8 rook
CASTLE_MASK[63] = 15 & ~CR_BK // h8 rook
CASTLE_MASK[60] = 15 & ~(CR_BK | CR_BQ) // e8 king

function pieceIndexAt(pieces: BB[], sq: number): number {
  const b = bit(sq)
  for (let i = 0; i < 12; i++) if (pieces[i] & b) return i
  return -1
}

// Apply a move, returning a fresh state (copy-make keeps the generator immutable
// and eliminates a whole class of unmake bugs — perft speed is not the goal here).
export function makeMoveBB(st: BBState, m: BBMove): BBState {
  const from = mvFrom(m)
  const to = mvTo(m)
  const flag = mvFlag(m)
  const promo = mvPromo(m)
  const us = st.side
  const them = us ^ 1
  const uo = us * 6
  const pieces = st.pieces.slice()
  const moving = pieceIndexAt(pieces, from)
  let ep = -1
  const castle = st.castle & CASTLE_MASK[from] & CASTLE_MASK[to]

  // Remove any captured piece.
  if (flag === FLAG_EP) {
    const capSq = to - (us === WHITE ? 8 : -8)
    pieces[them * 6 + PAWN] &= ~bit(capSq)
  } else {
    const captured = pieceIndexAt(pieces, to)
    if (captured >= 0) pieces[captured] &= ~bit(to)
  }

  // Move the piece (promotion swaps the type on arrival).
  pieces[moving] &= ~bit(from)
  if (promo) pieces[uo + promo] |= bit(to)
  else pieces[moving] |= bit(to)

  if (flag === FLAG_DOUBLE) ep = (from + to) >> 1

  if (flag === FLAG_CASTLE) {
    // King already moved from `from` to `to`; relocate the rook.
    if (to === 6) { pieces[uo + ROOK] &= ~bit(7); pieces[uo + ROOK] |= bit(5) }
    else if (to === 2) { pieces[uo + ROOK] &= ~bit(0); pieces[uo + ROOK] |= bit(3) }
    else if (to === 62) { pieces[uo + ROOK] &= ~bit(63); pieces[uo + ROOK] |= bit(61) }
    else if (to === 58) { pieces[uo + ROOK] &= ~bit(56); pieces[uo + ROOK] |= bit(59) }
  }

  return { pieces, side: them, ep, castle }
}

export function bbPerft(st: BBState, depth: number): number {
  if (depth === 0) return 1
  const moves = generateLegalBB(st)
  if (depth === 1) return moves.length
  let nodes = 0
  for (const m of moves) nodes += bbPerft(makeMoveBB(st, m), depth - 1)
  return nodes
}

export interface DivideEntry {
  uci: string
  nodes: number
}
export function bbPerftDivide(st: BBState, depth: number): DivideEntry[] {
  const moves = generateLegalBB(st)
  const rows: DivideEntry[] = []
  for (const m of moves) {
    const nodes = depth <= 1 ? 1 : bbPerft(makeMoveBB(st, m), depth - 1)
    rows.push({ uci: moveToUci(m), nodes })
  }
  rows.sort((a, b) => (a.uci < b.uci ? -1 : 1))
  return rows
}

// ---------------------------------------------------------------------------
// Self-test: the published perft numbers, reproduced by this independent engine.
// ---------------------------------------------------------------------------

export interface PerftRef {
  name: string
  fen: string
  // counts[d] = the published perft node count to depth d (counts[0] = 1). These
  // are the Chess Programming Wiki reference numbers — the independent ground truth
  // both this generator and the mailbox generator must reproduce exactly.
  counts: number[]
}

export const PERFT_REF: PerftRef[] = [
  {
    name: 'Starting position',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    counts: [1, 20, 400, 8902, 197281, 4865609, 119060324],
  },
  {
    name: 'Kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [1, 48, 2039, 97862, 4085603, 193690690],
  },
  {
    name: 'Position 3',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [1, 14, 191, 2812, 43238, 674624, 11030083],
  },
  {
    name: 'Position 4',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [1, 6, 264, 9467, 422333, 15833292],
  },
  {
    name: 'Position 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [1, 44, 1486, 62379, 2103487, 89941194],
  },
  {
    name: 'Position 6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    counts: [1, 46, 2079, 89890, 3894594, 164075551],
  },
]

// The deepest reference depth that stays under a node budget — used to pick a
// browser-friendly default per position.
export function refDepthUnder(ref: PerftRef, maxNodes: number): number {
  let d = 1
  while (d + 1 < ref.counts.length && ref.counts[d + 1] <= maxNodes) d++
  return d
}

export interface BBSelftestResult {
  name: string
  depth: number
  expected: number
  got: number
  ms: number
  pass: boolean
}

// Reproduce the PUBLISHED perft numbers (a genuine known-answer test — never the
// engine checking itself against itself). Depth per position is the deepest that
// stays under `maxNodes` so a headless/CI run stays quick.
export function bitboardSelftest(maxNodes = 1_000_000): BBSelftestResult[] {
  initMagics()
  const results: BBSelftestResult[] = []
  for (const ref of PERFT_REF) {
    const depth = refDepthUnder(ref, maxNodes)
    const expected = ref.counts[depth]
    const st = parseFenBB(ref.fen)
    const t0 = Date.now()
    const got = bbPerft(st, depth)
    const ms = Date.now() - t0
    results.push({ name: ref.name, depth, expected, got, ms, pass: got === expected })
  }
  return results
}
