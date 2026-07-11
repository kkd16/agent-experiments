// And-Inverter Graphs — the canonical substrate of modern hardware logic-synthesis
// and equivalence-checking tools (ABC, and every industrial SAT-based CEC flow).
//
// The whole of combinational logic is expressed with a single gate — the 2-input
// AND — and a single edge attribute — a 1-bit *complement* (an inverter folded onto
// the wire). Everything else (OR, XOR, MUX, …) is a De-Morgan/Boolean identity over
// those two primitives, so the representation is astonishingly uniform: a node is a
// pair of *literals*, and a literal is `node·2 + invertedBit`.
//
//   literal 0  = constant FALSE          litNode(l) = l >> 1
//   literal 1  = constant TRUE           litInv(l)  = l & 1
//   node 0     = the constant node       litNot(l)  = l ^ 1     (flip the inverter)
//
// Two structural invariants make the rest of the engine cheap:
//
//   1. **Topological by construction.** A node's fanins are literals of *earlier*
//      nodes (they must already exist to be AND-ed), so iterating nodes in index
//      order is a valid topological order — no separate sort is ever needed.
//   2. **Structural hashing (strashing).** `mkAnd` canonicalizes its two inputs,
//      applies the seven trivial-case rewrites (constant folding, idempotence,
//      complementation), and looks the pair up in a hash-cons table, so two
//      syntactically identical AND gates are physically the *same* node. This is
//      the first, free layer of logic optimization — the SAT sweeper (`fraig`)
//      then merges the *functionally* equal nodes that strashing can't see.

/** A literal: `node * 2 + inverted`. */
export type Lit = number

/** The constant-FALSE literal (node 0, not inverted). */
export const CONST0: Lit = 0
/** The constant-TRUE literal (node 0, inverted). */
export const CONST1: Lit = 1

/** Build a literal from a node index and an inversion bit. */
export const mkLit = (node: number, inv: 0 | 1 | boolean): Lit => (node << 1) | (inv ? 1 : 0)
/** The node a literal points at. */
export const litNode = (l: Lit): number => l >> 1
/** Whether a literal carries an inverter. */
export const litInv = (l: Lit): number => l & 1
/** Flip a literal's inverter — the *only* way negation is ever represented. */
export const litNot = (l: Lit): Lit => l ^ 1

/**
 * A hash-consed And-Inverter Graph. Node 0 is the constant; nodes are either
 * primary inputs (no fanins) or 2-input AND gates whose fanins are literals of
 * strictly-earlier nodes. Outputs are named literals into the graph.
 */
export class Aig {
  /** Fanin-0 literal per node (`-1` for the constant node and primary inputs). */
  readonly fanin0: number[] = [-1]
  /** Fanin-1 literal per node. */
  readonly fanin1: number[] = [-1]
  /** `true` for primary-input nodes. */
  readonly isPI: boolean[] = [false]
  /** Node indices of the primary inputs, in declaration order. */
  readonly inputs: number[] = []
  /** Human-readable name per primary input (parallel to {@link inputs}). */
  readonly inputNames: string[] = []
  /** Named output literals. */
  readonly outputs: { name: string; lit: Lit }[] = []

  // Strash table: "min,max" of the two fanin literals → node index.
  private strash = new Map<string, number>()

  /** Total node count (including the constant node at index 0). */
  get numNodes(): number {
    return this.fanin0.length
  }

  /** Number of AND gates (excludes the constant and the primary inputs). */
  get numAnds(): number {
    let n = 0
    for (let i = 1; i < this.fanin0.length; i++) if (!this.isPI[i]) n++
    return n
  }

  /** Declare a fresh primary input; returns its (non-inverted) literal. */
  addInput(name: string): Lit {
    const idx = this.fanin0.length
    this.fanin0.push(-1)
    this.fanin1.push(-1)
    this.isPI.push(true)
    this.inputs.push(idx)
    this.inputNames.push(name)
    return mkLit(idx, 0)
  }

  /** The AND of two literals, with hash-consing and the trivial-case rewrites. */
  mkAnd(a: Lit, b: Lit): Lit {
    // Constant folding & idempotence — the rewrites that keep the graph small.
    if (a === CONST0 || b === CONST0) return CONST0 // x·0 = 0
    if (a === CONST1) return b // 1·x = x
    if (b === CONST1) return a // x·1 = x
    if (a === b) return a // x·x = x
    if (a === litNot(b)) return CONST0 // x·¬x = 0

    let x = a
    let y = b
    if (x > y) {
      const t = x
      x = y
      y = t
    }
    const key = x + ',' + y
    const hit = this.strash.get(key)
    if (hit !== undefined) return mkLit(hit, 0)

    const idx = this.fanin0.length
    this.fanin0.push(x)
    this.fanin1.push(y)
    this.isPI.push(false)
    this.strash.set(key, idx)
    return mkLit(idx, 0)
  }

  /** De-Morgan OR: ¬(¬a·¬b). */
  mkOr(a: Lit, b: Lit): Lit {
    return litNot(this.mkAnd(litNot(a), litNot(b)))
  }

  /** XOR = (a·¬b) + (¬a·b). */
  mkXor(a: Lit, b: Lit): Lit {
    return this.mkOr(this.mkAnd(a, litNot(b)), this.mkAnd(litNot(a), b))
  }

  /** XNOR = ¬(a⊕b). */
  mkXnor(a: Lit, b: Lit): Lit {
    return litNot(this.mkXor(a, b))
  }

  /** 2:1 multiplexer: s ? t : e. */
  mkMux(s: Lit, t: Lit, e: Lit): Lit {
    return this.mkOr(this.mkAnd(s, t), this.mkAnd(litNot(s), e))
  }

  /** AND of a list (empty ⇒ constant TRUE). */
  mkAndList(lits: Lit[]): Lit {
    let acc: Lit = CONST1
    for (const l of lits) acc = this.mkAnd(acc, l)
    return acc
  }

  /** OR of a list (empty ⇒ constant FALSE). */
  mkOrList(lits: Lit[]): Lit {
    let acc: Lit = CONST0
    for (const l of lits) acc = this.mkOr(acc, l)
    return acc
  }

  /** Register a named output literal. */
  addOutput(name: string, lit: Lit): void {
    this.outputs.push({ name, lit })
  }

  /** Per-node combinational level (constant & inputs are level 0). */
  levels(): Int32Array {
    const lvl = new Int32Array(this.numNodes)
    for (let i = 1; i < this.numNodes; i++) {
      if (this.isPI[i]) continue
      const a = lvl[litNode(this.fanin0[i])]
      const b = lvl[litNode(this.fanin1[i])]
      lvl[i] = 1 + Math.max(a, b)
    }
    return lvl
  }

  /** The deepest output logic level — the circuit's combinational depth. */
  get depth(): number {
    const lvl = this.levels()
    let d = 0
    for (const o of this.outputs) d = Math.max(d, lvl[litNode(o.lit)])
    return d
  }
}
