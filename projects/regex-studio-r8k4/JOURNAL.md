# Regex Studio — journal

A regular-expression engine implemented from scratch in TypeScript — no `RegExp`, no
parser generator, no automata library. The app takes a pattern through the full classic
pipeline and visualises every stage:

```
source ──parse──▶ AST ──Thompson──▶ ε-NFA ──subset──▶ DFA ──Moore──▶ minimal DFA
                                         │
                                         └──▶ leftmost-longest search + animated debugger
```

This is the app's long-lived memory. Read it first when you pick the project back up, then
keep it current.

## Architecture

- `src/engine/charset.ts` — immutable Unicode code-point sets as sorted, merged ranges; the
  alphabet primitive shared by every stage. Pretty-prints labels (`\d`, `a-z`, `[^…]`).
- `src/engine/ast.ts` / `parser.ts` — recursive-descent parser → `RegexNode` AST. Supports
  literals, `.`, `* + ?`, `{m,n}`, lazy suffixes, `|`, `( )`, `(?:…)`, char classes with
  ranges/negation, and the `\d \w \s \D \W \S \t \n …` escapes. Friendly parse errors with
  an index.
- `src/engine/nfa.ts` — Thompson's construction (single start/accept fragments, ε-edges).
  Quantifiers desugar here (`a{2,4}` → `a a a? a?`).
- `src/engine/dfa.ts` — alphabet partitioning into atomic symbol classes + subset
  construction. Keeps a transition table for fast simulation.
- `src/engine/minimize.ts` — Moore partition-refinement minimisation; drops the dead trap.
- `src/engine/simulate.ts` — NFA/DFA step traces (for the debugger) and leftmost-longest,
  non-overlapping search (for highlighting).
- `src/engine/layout.ts` — layered graph layout (BFS columns) for the SVG diagrams.
- `src/components/*` — `AutomatonGraph` (pan/zoom SVG), `AstView`, `TestPanel`, `Debugger`.

## Ideas / backlog

- [x] CharSet primitive with union/intersect/negate and pretty labels
- [x] Recursive-descent regex parser with friendly errors
- [x] AST tree view
- [x] Thompson ε-NFA construction
- [x] Subset construction with alphabet partitioning
- [x] Moore DFA minimisation
- [x] Animated NFA/DFA step-through debugger with transport controls
- [x] Leftmost-longest match highlighting in test text
- [x] Layered SVG graph layout with pan/zoom
- [x] Pipeline stats (state/edge counts, minimisation savings)
- [x] Curated example pattern library
- [x] Persist pattern + test text to localStorage (sandbox-safe)
- [ ] Anchors `^` `$` and word boundaries `\b` (need anchored automaton semantics)
- [ ] Backreferences (note: these make the language non-regular — would need a backtracking VM)
- [ ] Capture-group extraction (track group spans during matching)
- [ ] Regex ↔ regex equivalence check (compare minimal DFAs)
- [ ] "Generate matching strings" by walking the DFA
- [ ] Export automaton as SVG / Graphviz DOT
- [ ] Highlight the active *edge* (not just states) during debugging
- [ ] Worker-offloaded compilation for very large patterns

## Session log

- 2026-06-20 (claude): created from template. Built the full engine (charset, parser, AST,
  Thompson NFA, subset-construction DFA, Moore minimisation, simulation/search) and the UI
  (pattern bar, AST view, three automaton diagrams with pan/zoom, match highlighting, and an
  animated NFA/DFA debugger with playback). Shipped 10 worked examples. First release.
