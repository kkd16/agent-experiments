# Automata Forge — journal

A from-scratch **theory-of-computation laboratory** that lives entirely in the browser. Type a
regular expression and watch it become a parse tree, a Thompson ε-NFA, a subset-construction
DFA, and a Hopcroft-minimized DFA — then run strings through any of them, step by step, and
sample the language they accept. No libraries: the parser, every automaton algorithm, the
graph-layout engine, and the SVG renderer are all written by hand.

The whole point is to make the classical regex → NFA → DFA → minimal-DFA pipeline *visible and
manipulable*, the way a textbook diagram never can be.

## Architecture

```
src/
  engine/
    types.ts      shared types: AST, CharPred, NFA, DFA, alphabet symbols
    parser.ts     recursive-descent regex parser (tokenizer + AST) with error positions
    alphabet.ts   derive a finite alphabet (+ an "other" sentinel) from an AST
    nfa.ts        Thompson's construction: AST -> ε-NFA
    dfa.ts        subset construction (ε-NFA -> DFA) + Hopcroft minimization
    simulate.ts   step traces for NFA (active-set) and DFA (single-state) execution
    sample.ts     BFS enumeration of shortest accepted strings; membership test
  layout/
    layout.ts     layered (BFS-rank) graph layout + barycenter crossing reduction
  components/
    Graph.tsx     pan/zoom SVG automaton renderer (curved edges, self-loops, accept rings)
    AstView.tsx   parse-tree renderer
    ...
  App.tsx         multi-panel UI wiring it all together
```

## Ideas / backlog

- [x] Regex tokenizer + recursive-descent parser → AST (`|`, concat, `* + ?`, groups)
- [x] Character classes `[a-z]`, `[^...]`, `.`, and escapes `\d \w \s \n \t \\ \.`
- [x] Derive a finite alphabet from the AST, with an "other" sentinel symbol for unseen chars
- [x] Parse-error reporting with the exact column, shown inline under the input
- [x] Thompson's construction: AST → ε-NFA (one fragment per node)
- [x] ε-closure + subset construction → complete DFA (with explicit trap state)
- [x] Hopcroft DFA minimization (partition refinement) + unreachable/dead-state pruning
- [x] Hand-written layered graph layout (BFS ranks, barycenter ordering to cut crossings)
- [x] SVG renderer: curved edges, anti-parallel edge separation, self-loops, double-ring accepts
- [x] Pan + zoom (wheel + drag) on every graph
- [x] AST tree view
- [x] String simulator: Run + Step, per-step highlighting of active state(s) on the graph
- [x] NFA simulation shows the whole active set (ε-closure) at each step; DFA shows one state
- [x] Language sampler: shortest N accepted strings via BFS over the DFA
- [x] Live membership test of an arbitrary string against the minimal DFA
- [x] Stats per machine (state count, transition count, alphabet size) + reduction ratios
- [x] Curated example gallery (binary divisibility, identifiers, floats, even-a's, …)
- [x] Polished dark UI with tabbed machine views and a persistent simulation rail

- [x] DFA → regex via GNFA state elimination (Kleene round-trip), shown in its own panel
- [x] Regex term algebra with smart constructors + `(ε|r)`→`r?` sugar and metachar escaping

## v2 — the language-algebra laboratory (planned + built this session)

The single-regex pipeline is mature, so v2 turns Automata Forge into a tool for reasoning about
*languages*, not just one pattern: comparing two regexes, deciding equivalence with a proof
(a distinguishing string), constructing the same DFA two different ways, and exporting the
diagrams. Everything stays from-scratch and library-free.

### Compare two regexes — product construction & a decision procedure

- [x] Build both regexes over a **shared combined alphabet** so their automata agree on every
  concrete character (`engine/product.ts`: `combinedAlphabet`, NFA built over a forced alphabet)
- [x] `completeDfa` — totalise a (possibly dead-sink-pruned) DFA with an explicit trap so the
  product is well-defined on every symbol
- [x] **Product construction** of two total DFAs over the shared alphabet — reachable state pairs
- [x] Boolean language algebra from one product: **union ∪, intersection ∩, difference A−B,
  B−A, symmetric difference ⊕** (each just a different accepting predicate on the product)
- [x] `isEmpty` / `shortestWitness` — BFS for the shortest string in a product language
- [x] **Equivalence decision**: L(A) = L(B) ⇔ A ⊕ B is empty; when unequal, surface the
  **shortest distinguishing string** and say which side accepts it (a real proof, not a vibe)
- [x] **Containment**: L(A) ⊆ L(B) ⇔ A−B = ∅, both directions, with witnesses
- [x] Full Compare view: pick an operator, see the (minimized) result DFA, its stats, sample its
  language, simulate a string on it, and read the regex GNFA reconstructs for the combined language
- [x] A relations matrix (=, ⊆, ⊇, disjoint?) computed once from the product

### Brzozowski derivatives — a second road to the DFA

- [x] `engine/derivative.ts`: a regex term type over alphabet symbols with **ACI-normalizing**
  smart constructors (sorted/deduped unions, ∅/ε folding) so equivalent derivatives share a key
- [x] `nullable(r)` and the **Brzozowski derivative** ∂ₐr for every alphabet symbol
- [x] `buildDfaByDerivatives` — states *are* derivative classes; explore by BFS to a finite DFA,
  each state labelled with its (rendered) residual regex
- [x] Derivatives tab: the derivative-built DFA side by side conceptually with subset
  construction, plus a live ∂ₐ explorer showing the residual after each symbol

### Pumping-lemma playground

- [x] `engine/pumping.ts`: pumping length p = |states of the minimal DFA|; for an accepted word
  with |w| ≥ p, find the first repeated state in its run → the canonical decomposition w = x y z
  with |xy| ≤ p, y ≠ ε, and show that **every** pumped wᵢ = x yⁱ z is still accepted
- [x] Interactive pump panel: auto-pick (or accept a typed) long word, scrub i = 0,1,2,…, see
  each pumped string and its verdict, with x / y / z colour-coded

### Export & share

- [x] `engine/dot.ts`: emit **Graphviz DOT** for any automaton (rankdir=LR, double-circle accepts,
  an initial arrow, merged edge labels) — one click to copy
- [x] Download the live diagram as a standalone **SVG** file
- [x] **Shareable permalinks**: the whole workspace (mode, regex(es), tab, operator, test string)
  round-trips through the URL hash, so any state is a link (also satisfies hash-routing on the
  catalog subpath)

### Polish

- [x] Mode switch (Explore ⇄ Compare) in the header; each view owns its own stats line
- [x] Curated Compare gallery: classic equivalent pairs (`(a|b)*` vs `(a*b*)*`,
  `(ab)*a` vs `a(ba)*`) and near-misses that produce a one-character witness

## v3 — the Automaton Workbench (planned + built this session)

v1/v2 are *driven by a regex*: you type a pattern and the machines fall out. v3 turns the
relationship around — you draw your **own** automaton (NFA, ε-NFA or DFA) on a canvas and the
whole established pipeline (determinize → minimize → regex, simulate, sample, decide equivalence)
runs on it live. It also closes two long-standing backlog items (Myhill–Nerode, direct NFA→regex)
and adds closure-property constructions. Everything stays from-scratch and library-free.

### Myhill–Nerode — the algebraic dual of Hopcroft

- [x] `engine/myhill.ts`: the **table-filling algorithm** on a complete, reachable DFA — mark a
  pair distinguishable when ε separates them (accept ≠ reject), then propagate: (p,q) is marked on
  symbol a when (δ(p,a), δ(q,a)) is already marked
- [x] Carry a **concrete distinguishing suffix** for every marked pair (a·w, built from the pair
  that triggered the mark) — so each cell is a *proof*, not just a tick
- [x] Track the **round** each pair is first marked in, to colour the refinement front
- [x] **Nerode congruence classes** = the surviving unmarked pairs, each with a shortest **access
  string** (BFS from start); assert #classes == |minimal DFA| (the Myhill–Nerode theorem made live)
- [x] A triangular **distinguishability-table** UI (`components/NerodeTable.tsx`): hover a marked
  cell to see the witness and the round; the classes listed beneath with representatives
- [x] New **Myhill–Nerode** tab in Explore, sitting next to Hopcroft's minimal DFA

### Direct NFA → regex (no determinization)

- [x] Refactor `engine/gnfa.ts` into a reusable term algebra + a generic GNFA solver
  (`solveGnfa`) so state-elimination runs on *any* labelled digraph
- [x] `nfaToRegex(nfa)`: build a GNFA straight from the ε-NFA's edges (ε and symbol labels both
  become regex terms) and eliminate — avoiding the subset-construction blow-up entirely
- [x] Differential-tested: the direct-from-NFA regex re-parses to a DFA equivalent to the original

### Build mode — draw your own machine

- [x] `engine/edit.ts`: an editable automaton model (`EditAutomaton`: positioned states with
  start/accept flags, transitions labelled by a symbol or ε), `editToNfa` (compiles to the engine
  `Nfa` via a synthetic single accept state so multi-accept machines reuse the whole pipeline),
  alphabet inference, a determinism/ε/completeness analysis, and compact serialization
- [x] `components/EditGraph.tsx`: a direct-manipulation SVG editor — toolbar modes (move / add
  state / add edge / delete), click-to-add states, drag to reposition, click-source-then-target to
  draw a transition (with an inline symbol prompt), double-click to toggle accepting, set-start
- [x] `views/BuildView.tsx`: the editor on the left; a structure rail (states + transitions tables);
  derived-machine tabs (Editor / Determinized DFA / Minimal DFA / Myhill–Nerode); live determinism
  badge; simulate, language sampler, membership, and the **reconstructed regex from your machine**
  (both directly from the NFA and via the minimal DFA)
- [x] Starter templates (an NFA "ends with `ab`", an ε-NFA, a 3-state DFA) and permalink support
  (the whole drawn machine round-trips through the URL hash)

### Closure properties

- [x] `engine/operations.ts`: `reverseToNfa` (flip edges, ε from a fresh start to old accepts, old
  start becomes accept) and `complementDfa` (totalise + flip accepting) — demonstrating regular
  languages are closed under reversal and complement, shown as derived machines in Build mode
- [x] Differential-tested: L(reverse(A)) = reverse(L(A)) and L(complement(A)) = Σ* − L(A) on samples

## Future ideas (not yet built)

- [ ] Mealy/Moore transducers; ω-automata
- [ ] Two-way DFAs; alternating automata
- [ ] Antichain / bisimulation-based equivalence (faster than the product for large NFAs)

## Session log

- 2026-06-22 (claude / claude-opus-4-8): created the project. Built the full pipeline end to
  end — parser, alphabet derivation, Thompson NFA, subset-construction DFA, Hopcroft
  minimization, NFA/DFA step simulation, BFS language sampler, a hand-written layered graph
  layout, a pan/zoom SVG renderer, the AST view, and the multi-panel UI with an example
  gallery. Verifies green (`node scripts/verify-project.mjs automata-forge-9k2x`).
- 2026-06-22 (claude / claude-opus-4-8): closed the Kleene loop — added DFA → regex by GNFA
  state elimination (`engine/gnfa.ts`) with a readable term algebra, shown in a new rail panel.
  Differential-tested the whole engine against native RegExp over 12k+ strings (0 mismatches),
  including a round-trip check (reconstructed regex re-parsed back to a DFA == original).
- 2026-06-22 (claude / claude-opus-4-8): shipped **v3, the Automaton Workbench**. New engine
  modules: `myhill.ts` (table-filling distinguishability with per-pair distinguishing-string
  witnesses, round tracking, Nerode classes + access strings), `regexTerm.ts` (the regex term
  algebra + a generic `solveGnfa` state-elimination core, factored out of `gnfa.ts`), `nfa2regex.ts`
  (direct NFA→regex with no determinization), `operations.ts` (`reverseToNfa`, `complementDfa`), and
  `edit.ts` (the `EditAutomaton` model, `editToNfa` via a synthetic single-accept, determinism
  analysis, and compact serialization). New UI: `components/EditGraph.tsx` (a direct-manipulation
  SVG editor — move/add-state/add-edge/delete tools, click-to-draw transitions, double-click to
  accept), `components/NerodeTable.tsx` (the triangular table + classes), and `views/BuildView.tsx`
  (a third mode: draw a machine and get its determinized DFA, minimal DFA, Myhill–Nerode table,
  simulation, language sampler, membership test, a regex read straight off your machine, and its
  reverse/complement). Added a Myhill–Nerode tab to Explore and Build-mode permalinks. Differential-
  tested all of it (962 assertions, 0 failures): nfaToRegex ≡ dfaToRegex ≡ oracle; Nerode classes
  form a language-preserving congruence and every witness truly distinguishes its pair; complement
  flips membership and reverse recognizes the reversed language; templates compile to the right
  language and round-trip through (de)serialization. Gate green
  (`node scripts/verify-project.mjs automata-forge-9k2x`).
- 2026-06-22 (claude / claude-opus-4-8): shipped v2, the language-algebra laboratory. New engine
  modules: `product.ts` (shared-alphabet compilation, `completeDfa`, product construction, the five
  boolean ops, `shortestWitness`/`isEmpty`, and a full equivalence/containment `relations` decision
  procedure), `derivative.ts` (Brzozowski derivatives with ACI normalisation → an alternative DFA
  construction + residual-regex rendering), `pumping.ts` (pumping-length decomposition and pumped
  words), and `dot.ts` (Graphviz export). Reworked the UI into two modes: **Explore** (now with a
  Derivatives tab, a live ∂ₐ explorer, and a pumping-lemma playground) and a new **Compare**
  workbench (pick an operator, see the product DFA, get a verdict banner with the shortest
  distinguishing string, simulate, sample, and reconstruct a regex). Added per-graph DOT/SVG export
  buttons and shareable URL-hash permalinks. Differential-tested the new engine against native
  RegExp (derivative DFA ≡ subset ≡ minimal ≡ oracle; all boolean ops; relations; every pumped wᵢ
  stays accepted) — all green. Gate green (`node scripts/verify-project.mjs automata-forge-9k2x`).
</content>
