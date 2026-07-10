/**
 * Minimal linear algebra over the field GF(2) = {0, 1} with arithmetic mod 2 (add = XOR,
 * mul = AND). Vectors are plain `number[]` of 0/1 entries; matrices are arrays of such rows.
 *
 * Everything a stabilizer code needs — the symplectic check matrix, the normaliser (a null
 * space), membership of a Pauli in the stabilizer group (row-space membership), and solving
 * for logical operators — is GF(2) linear algebra. There is no floating point anywhere in the
 * code-analysis path, so every reported number ([[n, k, d]], a syndrome, a coset leader) is
 * exact by construction.
 */

/** Row-reduce `rows` to reduced row-echelon form in place (a copy is made). Returns the RREF
 *  matrix together with the pivot column of each surviving (non-zero) row. */
export function rref(rows: number[][]): { R: number[][]; pivots: number[] } {
  const R = rows.map((r) => r.slice());
  const cols = R.length === 0 ? 0 : R[0].length;
  const pivots: number[] = [];
  let pr = 0;
  for (let c = 0; c < cols && pr < R.length; c++) {
    // Find a row at or below pr with a 1 in column c.
    let sel = -1;
    for (let i = pr; i < R.length; i++) if (R[i][c]) { sel = i; break; }
    if (sel < 0) continue;
    [R[pr], R[sel]] = [R[sel], R[pr]];
    // Clear column c in every other row.
    for (let i = 0; i < R.length; i++) {
      if (i !== pr && R[i][c]) for (let j = 0; j < cols; j++) R[i][j] ^= R[pr][j];
    }
    pivots.push(c);
    pr++;
  }
  // Drop trailing all-zero rows for a clean basis.
  const R2 = R.slice(0, pivots.length);
  return { R: R2, pivots };
}

/** Rank over GF(2). */
export function rank(rows: number[][]): number {
  return rref(rows).pivots.length;
}

/** A basis for the null space { v : M·v = 0 } of an m×n matrix `M` over GF(2). */
export function nullspace(M: number[][], nCols: number): number[][] {
  if (M.length === 0) {
    // Everything is in the null space: the standard basis.
    return Array.from({ length: nCols }, (_, i) => {
      const v = new Array(nCols).fill(0); v[i] = 1; return v;
    });
  }
  const { R, pivots } = rref(M);
  const pivotSet = new Set(pivots);
  const free: number[] = [];
  for (let c = 0; c < nCols; c++) if (!pivotSet.has(c)) free.push(c);
  const basis: number[][] = [];
  for (const f of free) {
    const v = new Array(nCols).fill(0);
    v[f] = 1;
    // Back-substitute: each pivot row fixes its pivot variable in terms of the free ones.
    for (let i = 0; i < pivots.length; i++) {
      const pc = pivots[i];
      // R[i] · v must be 0 ⇒ v[pc] = Σ_{c≠pc} R[i][c] v[c].
      let s = 0;
      for (let c = 0; c < nCols; c++) if (c !== pc) s ^= R[i][c] & v[c];
      v[pc] = s;
    }
    basis.push(v);
  }
  return basis;
}

/** Reduce `v` against the RREF basis `R` (with the given `pivots`); returns the residue.
 *  `v` is in the row space iff the residue is all-zero. */
export function reduceVec(v: number[], R: number[][], pivots: number[]): number[] {
  const out = v.slice();
  for (let i = 0; i < R.length; i++) {
    if (out[pivots[i]]) for (let j = 0; j < out.length; j++) out[j] ^= R[i][j];
  }
  return out;
}

/** True iff `v` lies in the GF(2) row space of `rows`. */
export function inRowSpace(v: number[], rows: number[][]): boolean {
  const { R, pivots } = rref(rows);
  return reduceVec(v, R, pivots).every((b) => b === 0);
}

/** True iff the rows are linearly independent over GF(2). */
export function independent(rows: number[][]): boolean {
  return rank(rows) === rows.length;
}
