// Two classic applications of the sum-check protocol (see sumcheck.ts) that need
// no circuit machinery — they show the protocol's power directly:
//
//   1. Verified matrix multiplication (Thaler, "Proofs, Args & ZK" §4.4). To
//      check C = A·B for n×n matrices, the verifier picks random r,s and confirms
//      C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s) by one sum-check. The sum-check itself costs the
//      verifier O(log n) field work instead of the O(n³) of redoing the product.
//
//   2. Triangle counting. The number of triangles in a graph with adjacency matrix
//      A is (1/6)·Σ_{x,y,z} A(x,y)A(y,z)A(z,x). Sum-check proves that exponential
//      sum with the verifier evaluating Ã at just three points.
//
// Both run over the Goldilocks field with a Fiat–Shamir transcript, exact BigInt.

import { add, mul, fp } from './goldilocks'
import { Transcript } from './transcript'
import {
  eqEval,
  mleEval,
  productClaim,
  productOracle,
  sumcheckProve,
  sumcheckVerify,
  type SumcheckRound,
} from './sumcheck'
import { bitsOf, log2exact } from './gkr'

// ── Matrix multiplication ──

/** Row-major n×n product C = A·B over the field. */
export function matMul(A: bigint[], B: bigint[], n: number): bigint[] {
  const C = new Array<bigint>(n * n).fill(0n)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let acc = 0n
      for (let k = 0; k < n; k++) acc = add(acc, mul(A[i * n + k], B[k * n + j]))
      C[i * n + j] = acc
    }
  return C
}

/** The 2ᵏ eq-weights eq(p, bits(i)) for i = 0…n−1. */
function eqWeights(p: bigint[], n: number, k: number): bigint[] {
  const w = new Array<bigint>(n)
  for (let i = 0; i < n; i++) w[i] = eqEval(p, bitsOf(i, k))
  return w
}

/** fA[x] = Ã(r, x) = Σ_i A[i,x]·eq(r, i): A's MLE with its row bound to r. */
function bindRow(A: bigint[], r: bigint[], n: number, k: number): bigint[] {
  const wr = eqWeights(r, n, k)
  const out = new Array<bigint>(n).fill(0n)
  for (let x = 0; x < n; x++) {
    let acc = 0n
    for (let i = 0; i < n; i++) acc = add(acc, mul(A[i * n + x], wr[i]))
    out[x] = acc
  }
  return out
}

/** fB[x] = B̃(x, s) = Σ_j B[x,j]·eq(s, j): B's MLE with its column bound to s. */
function bindCol(B: bigint[], s: bigint[], n: number, k: number): bigint[] {
  const ws = eqWeights(s, n, k)
  const out = new Array<bigint>(n).fill(0n)
  for (let x = 0; x < n; x++) {
    let acc = 0n
    for (let j = 0; j < n; j++) acc = add(acc, mul(B[x * n + j], ws[j]))
    out[x] = acc
  }
  return out
}

/** C̃(r,s) = Σ_{i,j} C[i,j]·eq(r,i)·eq(s,j): a matrix MLE at (r,s). */
export function matrixMleEval(M: bigint[], r: bigint[], s: bigint[], n: number, k: number): bigint {
  const wr = eqWeights(r, n, k)
  const ws = eqWeights(s, n, k)
  let acc = 0n
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) acc = add(acc, mul(M[i * n + j], mul(wr[i], ws[j])))
  return acc
}

export interface MatMulProof {
  C: bigint[]
  r: bigint[]
  s: bigint[]
  rounds: SumcheckRound[]
  claimedEval: bigint
}

/** Prove C = A·B: derive r,s from the transcript, then sum-check Σ_x Ã(r,x)B̃(x,s). */
export function matmulProve(A: bigint[], B: bigint[], n: number): MatMulProof {
  const k = log2exact(n)
  const C = matMul(A, B, n)
  const tr = new Transcript('matmul')
  for (const v of A) tr.absorbField(v)
  for (const v of B) tr.absorbField(v)
  for (const v of C) tr.absorbField(v)
  const r = Array.from({ length: k }, () => tr.challengeField())
  const s = Array.from({ length: k }, () => tr.challengeField())
  const fA = bindRow(A, r, n, k)
  const fB = bindCol(B, s, n, k)
  const proof = sumcheckProve(productClaim([fA, fB], k), tr)
  return { C, r, s, rounds: proof.rounds, claimedEval: proof.claimedSum }
}

export interface MatMulVerdict {
  ok: boolean
  reason: string
  /** C̃(r,s) the verifier computed from the claimed product. */
  claimEval: bigint
}

/**
 * Verify a claimed product. The verifier re-derives r,s (binding the *claimed* C),
 * evaluates the boundary MLEs Ã(r,·) and B̃(·,s) itself, and checks the sum-check —
 * confirming the whole product from O(log n) interaction plus a handful of MLE
 * evaluations. A forged C shifts r,s and the transcript diverges, so it is caught.
 */
export function matmulVerify(A: bigint[], B: bigint[], claimedC: bigint[], n: number, proof: MatMulProof): MatMulVerdict {
  const k = log2exact(n)
  const tr = new Transcript('matmul')
  for (const v of A) tr.absorbField(v)
  for (const v of B) tr.absorbField(v)
  for (const v of claimedC) tr.absorbField(v)
  const r = Array.from({ length: k }, () => tr.challengeField())
  const s = Array.from({ length: k }, () => tr.challengeField())
  const fA = bindRow(A, r, n, k)
  const fB = bindCol(B, s, n, k)
  const claimEval = matrixMleEval(claimedC, r, s, n, k)
  const vd = sumcheckVerify(k, 2, claimEval, proof.rounds, productOracle([fA, fB]), tr)
  return {
    ok: vd.ok,
    reason: vd.ok
      ? 'C̃(r,s) = Σ_x Ã(r,x)·B̃(x,s) certified by sum-check'
      : vd.failedRound >= k
        ? 'final oracle check failed — claimed product is wrong'
        : `sum-check identity failed at round ${vd.failedRound + 1}`,
    claimEval,
  }
}

// ── Triangle counting ──

/** Count triangles by brute force: (1/6)·Σ A[i,j]A[j,k]A[k,i]. */
export function countTriangles(Adj: number[], N: number): number {
  let s = 0
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++) s += Adj[i * N + j] * Adj[j * N + k] * Adj[k * N + i]
  return s / 6
}

export interface TriangleProof {
  count: number
  sum: bigint // 6·count as a field element
  rounds: SumcheckRound[]
}

/** Build the 2^{2k} adjacency table Ã (index = i + (j<<k)) as field 0/1 values. */
function adjTable(Adj: number[], N: number, k: number): bigint[] {
  const t = new Array<bigint>(N * N)
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) t[i + (j << k)] = BigInt(Adj[i * N + j])
  return t
}

/** Prove the triangle count via sum-check over Σ_{x,y,z} Ã(x,y)Ã(y,z)Ã(z,x). */
export function trianglesProve(Adj: number[], N: number): TriangleProof {
  const k = log2exact(N)
  const at = adjTable(Adj, N, k)
  const size = 1 << (3 * k)
  const mask = (1 << k) - 1
  // Three multilinear factors over the 3k variables (x,y,z).
  const T1 = new Array<bigint>(size)
  const T2 = new Array<bigint>(size)
  const T3 = new Array<bigint>(size)
  for (let idx = 0; idx < size; idx++) {
    const x = idx & mask
    const y = (idx >> k) & mask
    const z = (idx >> (2 * k)) & mask
    T1[idx] = at[x + (y << k)] // A(x,y)
    T2[idx] = at[y + (z << k)] // A(y,z)
    T3[idx] = at[z + (x << k)] // A(z,x)
  }
  const tr = new Transcript('triangles')
  const proof = sumcheckProve(productClaim([T1, T2, T3], 3 * k), tr)
  return { count: Number(proof.claimedSum / 6n), sum: proof.claimedSum, rounds: proof.rounds }
}

export interface TriangleVerdict {
  ok: boolean
  reason: string
}

/**
 * Verify a claimed triangle count. The verifier's oracle evaluates Ã at only three
 * points (x,y),(y,z),(z,x) — not the full O(N³) triple sum.
 */
export function trianglesVerify(Adj: number[], N: number, claimedCount: number, proof: TriangleProof): TriangleVerdict {
  const k = log2exact(N)
  const at = adjTable(Adj, N, k)
  const claim = fp(6n * BigInt(claimedCount))
  const oracle = (point: bigint[]) => {
    const rx = point.slice(0, k)
    const ry = point.slice(k, 2 * k)
    const rz = point.slice(2 * k, 3 * k)
    const axy = mleEval(at, [...rx, ...ry])
    const ayz = mleEval(at, [...ry, ...rz])
    const azx = mleEval(at, [...rz, ...rx])
    return mul(axy, mul(ayz, azx))
  }
  const tr = new Transcript('triangles')
  const vd = sumcheckVerify(3 * k, 3, claim, proof.rounds, oracle, tr)
  return {
    ok: vd.ok,
    reason: vd.ok
      ? `6·${claimedCount} = Σ Ã(x,y)Ã(y,z)Ã(z,x) certified`
      : `rejected — claimed count is inconsistent with the graph (round ${vd.failedRound + 1})`,
  }
}
