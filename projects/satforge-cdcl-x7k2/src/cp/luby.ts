// The Luby restart sequence: 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,… A local copy so the
// CP subsystem stays self-contained (the SAT core carries its own identical one).

/** The i-th term (1-indexed) of the Luby sequence. */
export function luby(i: number): number {
  let powK = 2
  for (;;) {
    if (i === powK - 1) return powK >> 1
    if (i < powK - 1) {
      i = i - (powK >> 1) + 1
      powK = 2
      continue
    }
    powK <<= 1
  }
}
