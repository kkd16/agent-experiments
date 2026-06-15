// Shared helpers for CNF encoders.
import type { CNF } from '../cnf'

/** Incrementally builds a CNF and hands out fresh variable ids. */
export class CnfBuilder {
  private clauses: number[][] = []
  private nVars = 0
  comments: string[] = []

  /** Allocate a fresh variable id (1-based). */
  fresh(): number {
    return ++this.nVars
  }

  /** Reserve ids up to `n` so manual ids below `n` are accounted for. */
  reserve(n: number): void {
    if (n > this.nVars) this.nVars = n
  }

  add(...lits: number[]): void {
    this.clauses.push(lits)
  }

  addClause(lits: number[]): void {
    this.clauses.push(lits)
  }

  /** At-least-one of the given variables/literals. */
  atLeastOne(lits: number[]): void {
    this.clauses.push(lits.slice())
  }

  /** At-most-one via the naive pairwise encoding: ¬a ∨ ¬b for every pair. */
  atMostOnePairwise(lits: number[]): void {
    for (let i = 0; i < lits.length; i++)
      for (let j = i + 1; j < lits.length; j++) this.clauses.push([-lits[i], -lits[j]])
  }

  /** Exactly-one = at-least-one ∧ at-most-one (pairwise). */
  exactlyOne(lits: number[]): void {
    this.atLeastOne(lits)
    this.atMostOnePairwise(lits)
  }

  build(): CNF {
    return { numVars: this.nVars, clauses: this.clauses, comments: this.comments.slice() }
  }

  get clauseCount(): number {
    return this.clauses.length
  }
}
