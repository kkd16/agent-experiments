// The Luby restart sequence: 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...
// Used to schedule restarts in modern CDCL solvers. The conflict budget for
// restart i is `unit * luby(i)`.

/** Return the i-th term (1-indexed) of the Luby sequence. */
export function luby(i: number): number {
  // Knuth's iterative form: collapse `i` into the smallest block 2^k - 1.
  let powK = 2 // 2^k
  for (;;) {
    if (i === powK - 1) return powK >> 1
    if (i < powK - 1) {
      // Recurse into the left half of the current block.
      i = i - (powK >> 1) + 1
      powK = 2
      continue
    }
    powK <<= 1
  }
}

/** Build the first `n` Luby terms as an array. */
export function lubySequence(n: number): number[] {
  const out: number[] = []
  for (let i = 1; i <= n; i++) out.push(luby(i))
  return out
}
