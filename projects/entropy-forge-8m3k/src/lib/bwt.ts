// bwt.ts — the Burrows–Wheeler transform and the bzip2-style pipeline around it.
//
// BWT (1994) is not a compressor — it is a reversible *permutation* that clusters
// like symbols together (turning "the...the...the" into long runs), after which
// cheap local models finish the job. The classic bzip2 stack is BWT → MTF → RLE →
// entropy coder, and each stage here is exactly invertible. The magic is the
// inverse BWT: from the single transformed column plus one index, the original
// ordering is reconstructed by the LF-mapping — no rotations stored.

// Forward BWT via suffix-array sort of all rotations. We append a unique sentinel
// implicitly by sorting rotations of the raw bytes and remembering the primary
// index, which is the standard index-based (not sentinel-based) formulation.
export interface BwtResult {
  transformed: Uint8Array
  primaryIndex: number
}

export function bwtEncode(data: Uint8Array): BwtResult {
  const n = data.length
  if (n === 0) return { transformed: new Uint8Array(0), primaryIndex: 0 }
  // Sort rotation start indices by the rotation they represent (comparing the
  // cyclic string). O(n^2 log n) worst case but clear and correct for the lab.
  const idx = new Array<number>(n)
  for (let i = 0; i < n; i++) idx[i] = i
  const cmp = (a: number, b: number): number => {
    for (let k = 0; k < n; k++) {
      const ca = data[(a + k) % n]
      const cb = data[(b + k) % n]
      if (ca !== cb) return ca - cb
    }
    return a - b // stable tie-break
  }
  idx.sort(cmp)
  const transformed = new Uint8Array(n)
  let primaryIndex = 0
  for (let i = 0; i < n; i++) {
    const start = idx[i]
    transformed[i] = data[(start + n - 1) % n] // last column = char before rotation start
    if (start === 0) primaryIndex = i
  }
  return { transformed, primaryIndex }
}

// Inverse BWT via the LF-mapping. Given the last column L and the primary index,
// reconstruct the original. This is the part that looks like sorcery.
export function bwtDecode(transformed: Uint8Array, primaryIndex: number): Uint8Array {
  const n = transformed.length
  if (n === 0) return new Uint8Array(0)
  // count[c] = number of bytes < c  (start of each symbol's block in the first column)
  const count = new Array<number>(256).fill(0)
  for (const b of transformed) count[b]++
  let sum = 0
  const start = new Array<number>(256).fill(0)
  for (let c = 0; c < 256; c++) {
    start[c] = sum
    sum += count[c]
  }
  // next[i] = index in L of the row that precedes row i in the original order.
  const next = new Array<number>(n)
  const occ = new Array<number>(256).fill(0)
  for (let i = 0; i < n; i++) {
    const c = transformed[i]
    next[start[c] + occ[c]] = i
    occ[c]++
  }
  const out = new Uint8Array(n)
  let p = next[primaryIndex]
  for (let i = 0; i < n; i++) {
    out[i] = transformed[p]
    p = next[p]
  }
  return out
}

// ---- Move-to-front: turns BWT's clustered runs into lots of small numbers ----
export function mtfEncode(data: Uint8Array): Uint8Array {
  const table = Array.from({ length: 256 }, (_, i) => i)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const b = data[i]
    const rank = table.indexOf(b)
    out[i] = rank
    table.splice(rank, 1)
    table.unshift(b)
  }
  return out
}

export function mtfDecode(data: Uint8Array): Uint8Array {
  const table = Array.from({ length: 256 }, (_, i) => i)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const rank = data[i]
    const b = table[rank]
    out[i] = b
    table.splice(rank, 1)
    table.unshift(b)
  }
  return out
}

// ---- Byte-oriented run-length encoding (escape form) ----
// Encoded as: literal bytes, but a run of >=4 identical bytes b is written as
// b,b,b,b,(count-4) where count fits in a byte; runs longer than 259 split. The
// 4-byte trigger means normal text is untouched, matching bzip2's RLE1 spirit.
export function rleEncode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const b = data[i]
    let run = 1
    while (i + run < data.length && data[i + run] === b && run < 259) run++
    if (run >= 4) {
      out.push(b, b, b, b, run - 4)
      i += run
    } else {
      out.push(b)
      i++
    }
  }
  return Uint8Array.from(out)
}

export function rleDecode(data: Uint8Array): Uint8Array {
  // Mirror the encoder by counting *emitted* consecutive equal bytes. Once four
  // in a row have been emitted, the next stream byte is the extra count; we then
  // reset the run so a count byte that happens to equal the run symbol (or the
  // following block) can never be mistaken for a fifth run byte.
  const out: number[] = []
  let i = 0
  let prev = -1
  let run = 0
  while (i < data.length) {
    const b = data[i++]
    out.push(b)
    run = b === prev ? run + 1 : 1
    prev = b
    if (run === 4) {
      const extra = data[i++] ?? 0
      for (let k = 0; k < extra; k++) out.push(b)
      run = 0
      prev = -1
    }
  }
  return Uint8Array.from(out)
}
