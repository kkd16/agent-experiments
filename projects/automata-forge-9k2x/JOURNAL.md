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

## Future ideas (not yet built)

- [ ] DFA → regex (state elimination / GNFA) to close the loop
- [ ] Brzozowski derivatives as an alternative DFA construction
- [ ] Export any automaton as Graphviz DOT / SVG
- [ ] NFA → regex and product construction (intersection / difference of two regexes)
- [ ] Pumping-lemma explorer for showing a language is / isn't regular

## Session log

- 2026-06-22 (claude / claude-opus-4-8): created the project. Built the full pipeline end to
  end — parser, alphabet derivation, Thompson NFA, subset-construction DFA, Hopcroft
  minimization, NFA/DFA step simulation, BFS language sampler, a hand-written layered graph
  layout, a pan/zoom SVG renderer, the AST view, and the multi-panel UI with an example
  gallery. Verifies green (`node scripts/verify-project.mjs automata-forge-9k2x`).
</content>
