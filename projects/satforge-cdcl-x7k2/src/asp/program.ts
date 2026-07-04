// Answer Set Programming — the ground data model.
//
// A *ground* logic program is what both the native stable-model solver
// (`solve.ts`) and the independent brute-force oracle (`reduct.ts`) consume, so
// this file is the single source of truth for the shape of a program after
// grounding. Atoms are interned to integer ids `1..numAtoms`; `atomNames[i]` is
// the printable name of atom `i` (index 0 is unused so ids line up with the
// SAT solver's 1-based variables).
//
// Three rule shapes cover the whole language the grounder targets:
//
//   - `normal`     h :- pos, not neg.        (a definite/Horn rule with default negation)
//   - `constraint` :- pos, not neg.          (an integrity constraint — the body must not hold)
//   - `choice`     lo { heads } hi :- body.  (each head may be freely true/false when the body holds,
//                                             subject to the optional cardinality bounds lo..hi)
//
// A *fact* is just a `normal` rule with empty `pos`/`neg`. Everything downstream
// — Clark's completion, the unfounded-set check, the Gelfond–Lifschitz reduct —
// is defined over exactly these three shapes.

export type Rule =
  | { kind: 'normal'; head: number; pos: number[]; neg: number[] }
  | { kind: 'constraint'; pos: number[]; neg: number[] }
  | {
      kind: 'choice'
      heads: number[]
      /** lower cardinality bound (inclusive), or null for none. */
      lo: number | null
      /** upper cardinality bound (inclusive), or null for none. */
      hi: number | null
      pos: number[]
      neg: number[]
    }

export interface GroundProgram {
  /** Atoms are ids 1..numAtoms. */
  numAtoms: number
  /** atomNames[i] is the printable name of atom i (index 0 unused). */
  atomNames: string[]
  rules: Rule[]
}

/** A single answer set: the sorted ids of the atoms that are true. */
export type AnswerSet = number[]

/** Build an interner that maps atom names to stable 1-based ids. */
export function makeAtomTable() {
  const names: string[] = ['']
  const index = new Map<string, number>()
  return {
    /** Intern `name`, returning its id (creating one on first sight). */
    id(name: string): number {
      let id = index.get(name)
      if (id === undefined) {
        id = names.length
        names.push(name)
        index.set(name, id)
      }
      return id
    },
    /** The id of `name` if it has been interned, else undefined. */
    peek(name: string): number | undefined {
      return index.get(name)
    },
    get count(): number {
      return names.length - 1
    },
    names,
  }
}

/** Pretty-print an answer set as `{ a, b, c }` using the program's atom names. */
export function formatAnswerSet(prog: GroundProgram, set: AnswerSet): string {
  if (set.length === 0) return '{ }'
  return '{ ' + set.map((a) => prog.atomNames[a]).join(', ') + ' }'
}

/** Canonical string key for an answer set (for de-duplication in sets/maps). */
export function answerSetKey(set: AnswerSet): string {
  return set.join(',')
}

/** Every atom that appears anywhere in a rule (head or body). */
export function ruleAtoms(r: Rule): number[] {
  if (r.kind === 'normal') return [r.head, ...r.pos, ...r.neg]
  if (r.kind === 'constraint') return [...r.pos, ...r.neg]
  return [...r.heads, ...r.pos, ...r.neg]
}
