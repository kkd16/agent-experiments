// The pigeonhole principle PHP(n): can n+1 pigeons fit into n holes with no two
// pigeons sharing a hole? It cannot — PHP is the textbook family of formulas
// that is UNSAT yet requires exponential-size resolution proofs, so it makes a
// great stress test for a CDCL solver's conflict analysis.
import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export function encodePigeonhole(n: number): { cnf: CNF } {
  const b = new CnfBuilder()
  const pigeons = n + 1
  const holes = n
  // x(p,h): pigeon p sits in hole h.
  const v = (p: number, h: number) => p * holes + h + 1
  b.reserve(pigeons * holes)
  b.comments.push(`Pigeonhole PHP(${n}): ${pigeons} pigeons into ${holes} holes (UNSAT)`)

  // Every pigeon occupies at least one hole.
  for (let p = 0; p < pigeons; p++) {
    const opts: number[] = []
    for (let h = 0; h < holes; h++) opts.push(v(p, h))
    b.atLeastOne(opts)
  }
  // No hole holds two pigeons.
  for (let h = 0; h < holes; h++)
    for (let p1 = 0; p1 < pigeons; p1++)
      for (let p2 = p1 + 1; p2 < pigeons; p2++) b.add(-v(p1, h), -v(p2, h))

  return { cnf: b.build() }
}
