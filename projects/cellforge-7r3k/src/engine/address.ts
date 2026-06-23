// Cell-address algebra: the bridge between the "A1" notation users type and the
// zero-based {row, col} coordinates the engine computes on. Also handles the `$`
// absolute anchors that decide how a reference is rewritten when filled or pasted.

export interface Coord {
  readonly row: number // 0-based
  readonly col: number // 0-based
}

export interface CellRef {
  readonly row: number
  readonly col: number
  readonly rowAbs: boolean // had a `$` before the row number
  readonly colAbs: boolean // had a `$` before the column letters
  /** Sheet name this reference is qualified to (`Sheet2!A1`), or undefined for "this sheet". */
  readonly sheet?: string
}

export const coordKey = (row: number, col: number): string => `${row},${col}`
export const keyToCoord = (key: string): Coord => {
  const [r, c] = key.split(',')
  return { row: Number(r), col: Number(c) }
}

/** Column index (0 = A, 25 = Z, 26 = AA, ...) to its letter label. */
export function colToLetters(col: number): string {
  let n = col + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Column letters ("A", "AZ") to a 0-based index. Returns -1 on bad input. */
export function lettersToCol(letters: string): number {
  if (!letters) return -1
  let n = 0
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) return -1
    n = n * 26 + (code - 64)
  }
  return n - 1
}

/** "A1" style label for a coordinate. */
export function coordToA1(row: number, col: number): string {
  return `${colToLetters(col)}${row + 1}`
}

const REF_RE = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/

/** Parse a single reference like `A1`, `$B$2`, `C$10` into a CellRef. */
export function parseRef(text: string): CellRef | null {
  const m = REF_RE.exec(text.trim())
  if (!m) return null
  const col = lettersToCol(m[2])
  const row = Number(m[4]) - 1
  if (col < 0 || row < 0 || !Number.isFinite(row)) return null
  return { row, col, colAbs: m[1] === '$', rowAbs: m[3] === '$' }
}

/** Render a CellRef back to text, honoring its `$` anchors. */
export function formatRef(ref: CellRef): string {
  return `${ref.colAbs ? '$' : ''}${colToLetters(ref.col)}${ref.rowAbs ? '$' : ''}${ref.row + 1}`
}

export const refToCoord = (ref: CellRef): Coord => ({ row: ref.row, col: ref.col })

export interface RangeBox {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

/** Normalize two corners into an inclusive, top-left/bottom-right box. */
export function boxOf(a: Coord, b: Coord): RangeBox {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  }
}

/** Every coordinate inside a box, row-major. */
export function* iterateBox(box: RangeBox): Generator<Coord> {
  for (let row = box.top; row <= box.bottom; row++) {
    for (let col = box.left; col <= box.right; col++) {
      yield { row, col }
    }
  }
}

export const boxContains = (box: RangeBox, c: Coord): boolean =>
  c.row >= box.top && c.row <= box.bottom && c.col >= box.left && c.col <= box.right

/**
 * Shift a reference by (dRow, dCol), but only along axes that are *relative*.
 * This is exactly the rule a spreadsheet uses when you fill or paste a formula:
 * `$A$1` never moves, `A1` moves on both axes, `$A1` moves only vertically.
 */
export function offsetRef(ref: CellRef, dRow: number, dCol: number): CellRef {
  return {
    ...ref,
    row: ref.rowAbs ? ref.row : ref.row + dRow,
    col: ref.colAbs ? ref.col : ref.col + dCol,
  }
}
