// suffixArray.ts — a from-scratch **SA-IS** suffix array (Nong, Zhang & Chan,
// 2009): the modern linear-time, linear-space algorithm that makes the
// Burrows–Wheeler transform practical. The lab's original BWT sorts every
// rotation with a full O(n² log n) comparison sort — fine for a sentence, hopeless
// for a kilobyte. SA-IS instead sorts the *suffixes* in O(n) by classifying each
// position as S-type or L-type, inducing the order of all suffixes from the sorted
// LMS-substrings, and recursing on the reduced problem. We then read the BWT
// straight off the suffix array — the standard `L[i] = T[SA[i]-1]` — which is how
// real bzip2/bsc-class compressors build it.
//
// Everything here is integer-only and dependency-free, and it is checked against a
// brute-force suffix sort in the self-test, so the fast path is provably the same
// permutation as the slow one.

// SA-IS over an integer string `s` whose values are in [0, alphabet) and whose
// LAST element is a unique sentinel 0 that is strictly smaller than every other
// symbol. Returns the suffix array (indices 0..n-1 sorted by suffix).
function saisInt(s: Int32Array, alphabet: number): Int32Array {
  const n = s.length
  const sa = new Int32Array(n).fill(-1)
  if (n === 0) return sa
  if (n === 1) {
    sa[0] = 0
    return sa
  }

  // 1. Classify suffixes: S-type (s[i..] < s[i+1..]) or L-type. The sentinel is S.
  const isS = new Uint8Array(n)
  isS[n - 1] = 1
  for (let i = n - 2; i >= 0; i--) {
    isS[i] = s[i] < s[i + 1] || (s[i] === s[i + 1] && isS[i + 1] === 1) ? 1 : 0
  }
  // LMS position = an S-type preceded by an L-type.
  const isLMS = (i: number) => i > 0 && isS[i] === 1 && isS[i - 1] === 0

  // Bucket boundaries by symbol.
  const bucketSizes = new Int32Array(alphabet)
  for (let i = 0; i < n; i++) bucketSizes[s[i]]++
  const bucketHeads = () => {
    const heads = new Int32Array(alphabet)
    let sum = 0
    for (let c = 0; c < alphabet; c++) {
      heads[c] = sum
      sum += bucketSizes[c]
    }
    return heads
  }
  const bucketTails = () => {
    const tails = new Int32Array(alphabet)
    let sum = 0
    for (let c = 0; c < alphabet; c++) {
      sum += bucketSizes[c]
      tails[c] = sum - 1
    }
    return tails
  }

  // Induced sort: place LMS suffixes at bucket tails, then induce L-types from the
  // left and S-types from the right.
  const induce = (lmsOrder: Int32Array | number[]) => {
    sa.fill(-1)
    let tails = bucketTails()
    // Place LMS suffixes (in the given order) at the tails of their buckets.
    for (let i = lmsOrder.length - 1; i >= 0; i--) {
      const p = lmsOrder[i]
      if (p < 0) continue
      const c = s[p]
      sa[tails[c]] = p
      tails[c]--
    }
    // Induce L-type suffixes scanning left→right, from bucket heads.
    const heads = bucketHeads()
    for (let i = 0; i < n; i++) {
      const p = sa[i]
      if (p > 0 && isS[p - 1] === 0) {
        const c = s[p - 1]
        sa[heads[c]] = p - 1
        heads[c]++
      }
    }
    // Induce S-type suffixes scanning right→left, from bucket tails.
    tails = bucketTails()
    for (let i = n - 1; i >= 0; i--) {
      const p = sa[i]
      if (p > 0 && isS[p - 1] === 1) {
        const c = s[p - 1]
        sa[tails[c]] = p - 1
        tails[c]--
      }
    }
  }

  // 2. First induced sort using LMS positions in text order.
  const lmsPositions: number[] = []
  for (let i = 0; i < n; i++) if (isLMS(i)) lmsPositions.push(i)
  induce(lmsPositions)

  // 3. Name the sorted LMS-substrings to build the reduced string.
  const lmsNames = new Int32Array(n).fill(-1)
  let name = 0
  let prev = -1
  for (let i = 0; i < n; i++) {
    const p = sa[i]
    if (!isLMS(p)) continue
    if (prev === -1) {
      lmsNames[p] = name
    } else {
      // Compare the two LMS-substrings for equality.
      let equal = true
      let a = p
      let b = prev
      for (let k = 0; ; k++) {
        const aLMS = k > 0 && isLMS(a)
        const bLMS = k > 0 && isLMS(b)
        if (s[a] !== s[b] || isS[a] !== isS[b]) {
          equal = false
          break
        }
        if (aLMS && bLMS) break // reached the end of both LMS-substrings
        if (aLMS !== bLMS) {
          equal = false
          break
        }
        a++
        b++
      }
      if (!equal) name++
      lmsNames[p] = name
    }
    prev = p
  }

  // Reduced string: LMS names in text order.
  const reduced = new Int32Array(lmsPositions.length)
  for (let i = 0; i < lmsPositions.length; i++) reduced[i] = lmsNames[lmsPositions[i]]

  // 4. Sort the reduced string: recurse if any name repeats, else it's a direct
  // bijection (already sorted by the induced pass).
  let lmsSorted: number[]
  if (name + 1 < lmsPositions.length) {
    const subSA = saisInt(reduced, name + 1)
    lmsSorted = new Array(lmsPositions.length)
    for (let i = 0; i < subSA.length; i++) lmsSorted[i] = lmsPositions[subSA[i]]
  } else {
    lmsSorted = new Array(lmsPositions.length)
    for (let i = 0; i < lmsPositions.length; i++) lmsSorted[reduced[i]] = lmsPositions[i]
  }

  // 5. Final induced sort with the fully sorted LMS suffixes.
  induce(lmsSorted)
  return sa
}

/**
 * Suffix array of a byte buffer. We shift bytes up by one and append a 0 sentinel
 * (strictly smaller than every real byte, and unique), so the returned array has
 * length n+1 with SA[0] === n (the sentinel suffix). Callers that want only the
 * genuine suffixes can drop index 0.
 */
export function suffixArray(data: Uint8Array): Int32Array {
  const n = data.length
  const s = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) s[i] = data[i] + 1
  s[n] = 0 // sentinel
  return saisInt(s, 257)
}

// ---- Sentinel-based BWT built on the suffix array (scales to kilobytes) ----
// Unlike the lab's cyclic BWT, this appends an explicit sentinel, so the
// transformed stream has length n+1 and the inverse needs no primary index — the
// sentinel row is found by scanning for it. Round-trips exactly; used for the
// suffix-array visualiser and the scaling demo.
export interface SaBwtResult {
  transformed: Uint8Array // length n+1; one byte is the sentinel marker (stored as 0)
  sentinelRow: number // row whose suffix is the lone sentinel
  sa: Int32Array
}

export function bwtEncodeSA(data: Uint8Array): SaBwtResult {
  const n = data.length
  const sa = suffixArray(data) // length n+1
  const transformed = new Uint8Array(n + 1)
  let sentinelRow = 0
  for (let i = 0; i < n + 1; i++) {
    const p = sa[i]
    if (p === 0) {
      // Suffix starts at 0 → preceding char is the sentinel. Mark row and store 0.
      transformed[i] = 0
      sentinelRow = i
    } else {
      transformed[i] = data[p - 1]
    }
  }
  return { transformed, sentinelRow, sa }
}

export function bwtDecodeSA(transformed: Uint8Array, sentinelRow: number): Uint8Array {
  const m = transformed.length // == n+1
  if (m <= 1) return new Uint8Array(0)
  // Equivalent to the cyclic BWT of T = data + sentinel: because the sentinel is a
  // unique smallest symbol, rotation order = suffix order, so we invert with the
  // same LF-mapping walk as the cyclic decoder — over a 257-symbol alphabet that
  // gives the sentinel its own front bucket (so a real 0x00 byte never collides
  // with it). `sentinelRow` is the row whose suffix starts at position 0 (its L
  // char is the sentinel); that is exactly the cyclic decoder's primary index.
  const key = (i: number) => (i === sentinelRow ? 0 : transformed[i] + 1)
  const count = new Int32Array(257)
  for (let i = 0; i < m; i++) count[key(i)]++
  const start = new Int32Array(257)
  let sum = 0
  for (let c = 0; c < 257; c++) {
    start[c] = sum
    sum += count[c]
  }
  const next = new Int32Array(m)
  const occ = new Int32Array(257)
  for (let i = 0; i < m; i++) {
    const c = key(i)
    next[start[c] + occ[c]] = i
    occ[c]++
  }
  // Reconstruct T starting at T[0]; the sentinel lands in the final slot, dropped.
  const out = new Uint8Array(m - 1)
  let p = next[sentinelRow]
  for (let i = 0; i < m - 1; i++) {
    out[i] = transformed[p]
    p = next[p]
  }
  return out
}

/** Brute-force suffix array (oracle for the self-test). O(n² log n). */
export function suffixArrayNaive(data: Uint8Array): Int32Array {
  const n = data.length
  const s = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) s[i] = data[i] + 1
  s[n] = 0
  const idx = Array.from({ length: n + 1 }, (_, i) => i)
  idx.sort((a, b) => {
    let i = a
    let j = b
    while (i <= n && j <= n) {
      if (s[i] !== s[j]) return s[i] - s[j]
      i++
      j++
    }
    return 0
  })
  return Int32Array.from(idx)
}
