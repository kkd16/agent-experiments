// Uniform random 3-SAT generator. The clause-to-variable ratio controls
// hardness: instances near α ≈ 4.26 sit at the SAT/UNSAT phase transition and
// are notoriously hard, while α ≪ 4.26 is almost always SAT.
import type { CNF } from '../cnf'

export function randomKSat(numVars: number, ratio: number, k = 3, seed = 1): CNF {
  let s = seed >>> 0
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
  const numClauses = Math.round(numVars * ratio)
  const clauses: number[][] = []
  for (let i = 0; i < numClauses; i++) {
    const chosen = new Set<number>()
    const clause: number[] = []
    while (clause.length < Math.min(k, numVars)) {
      const v = 1 + Math.floor(rand() * numVars)
      if (chosen.has(v)) continue
      chosen.add(v)
      clause.push(rand() < 0.5 ? v : -v)
    }
    clauses.push(clause)
  }
  return {
    numVars,
    clauses,
    comments: [`Random ${k}-SAT: ${numVars} vars, ${numClauses} clauses (α = ${ratio})`],
  }
}
