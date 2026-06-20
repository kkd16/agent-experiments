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
  an index. As of session 2 it also parses anchors `^ $`, word boundaries `\b \B`,
  backreferences `\1…\9` and lookaround `(?=)(?!)(?<=)(?<!)`; `analyzeFeatures` classifies a
  tree as regular (→ automata pipeline) or extended (→ VM only).
- `src/engine/nfa.ts` — Thompson's construction (single start/accept fragments, ε-edges).
  Quantifiers desugar here (`a{2,4}` → `a a a? a?`).
- `src/engine/dfa.ts` — alphabet partitioning into atomic symbol classes + subset
  construction. Keeps a transition table for fast simulation.
- `src/engine/minimize.ts` — Moore partition-refinement minimisation; drops the dead trap.
- `src/engine/simulate.ts` — NFA/DFA step traces (for the debugger) and leftmost-longest,
  non-overlapping search (for highlighting).
- `src/engine/layout.ts` — layered graph layout (BFS columns) for the SVG diagrams.
- `src/engine/vm.ts` — the **backtracking VM**: continuation-passing matcher over the AST with
  captures, backrefs, anchors, boundaries, lookaround, greedy/lazy quantifiers, and a step
  counter + step limit that exposes catastrophic backtracking. `runVMAt0` runs a single
  *anchored* attempt — used by the ReDoS analyser to isolate one start's backtracking cost.
- `src/engine/pike.ts` — the **Pike VM**: a third matching engine. Compiles the AST to a tiny
  bytecode (`char/split/jmp/save/assert/match`) and runs Thompson's NFA as a breadth-first
  thread list tracking capture slots — **linear time *with* submatches**, no backtracking. It
  declines backreferences and lookaround (those cost you the linear bound — which is the lesson).
- `src/engine/redos.ts` — **static ReDoS analysis**. Builds the backtracking NFA, forms the
  squared automaton N×N, and finds an SCC touching both the diagonal and an off-diagonal node:
  proof that a state reaches itself by two distinct paths over one word. It then *synthesises a
  concrete attack* (`prefix·pumpᵏ·suffix`, the suffix probed from the real engine to force
  failure) and **measures** the actual VM at growing k, reading the verdict (exponential /
  polynomial-degree / safe) off the curve — so it never raises a false "vulnerable!".
- `src/engine/equivalence.ts` — product-automaton comparison over a common alphabet refinement;
  returns the set relation + shortest distinguishing witnesses.
- `src/engine/language.ts` — emptiness/finiteness, shortest member, BigInt counts by length, and
  shortlex enumeration — all graph theory over the minimal DFA.
- `src/engine/synthesize.ts` — DFA → regex by state elimination, with an algebraic simplifier and
  an AST emitter so the result can be re-verified for equivalence.
- `src/engine/explain.ts` — AST → plain-English prose. `src/engine/export.ts` — Graphviz DOT export.
- `src/components/*` — `AutomatonGraph` (pan/zoom SVG, active-edge highlight), `AstView`,
  `Debugger`, plus the session-2 panels: `MatchPanel` (two-engine run + captures), `LanguagePanel`,
  `ComparePanel`, `SynthesizePanel`, `ExplainPanel`.

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
### Session 2 — the second engine + the language toolkit (2026-06-20, claude)

A regex isn't only an automaton. This session adds a *whole second matching engine* and three
language-level analyses that treat the regex as a mathematical object, not just a string scanner.

- [x] Extend the parser/AST with the **non-regular & positional** constructs: anchors `^` `$`,
      word boundaries `\b` `\B`, backreferences `\1…\9`, and lookaround `(?=…) (?!…) (?<=…) (?<!…)`.
      The automata pipeline cleanly *detects* these (`analyzeFeatures`) and routes them away — a
      regular pattern still gets the full NFA/DFA treatment; a non-regular one is handed to the VM.
- [x] **Backtracking VM** (`engine/vm.ts`): a from-scratch continuation-passing backtracking matcher
      that runs the *full* grammar — capture groups, backreferences, anchors, boundaries, lookahead
      & lookbehind, greedy/lazy quantifiers. Carries a **step counter** so the UI can show
      catastrophic backtracking (ReDoS) happening in real time.
- [x] **Capture-group extraction**: matches now report every group's span + text, shown as coloured
      sub-highlights and a capture table.
- [x] **Two-engine race**: the Match panel runs the linear DFA *and* the backtracking VM side by
      side, contrasting guaranteed-linear automaton time against exponential backtracking on the
      same input — the central lesson of the app.
- [x] **Equivalence & containment** (`engine/equivalence.ts`): compare two patterns via a product
      automaton over a shared alphabet refinement. Decides equal / subset / superset / disjoint /
      overlapping and returns the **shortest distinguishing witness** for every asymmetric relation.
- [x] **Language explorer** (`engine/language.ts`): emptiness, finiteness (cycle-on-a-live-path),
      the shortest accepted string, exact **BigInt counts** of accepted strings by length, and a
      shortlex **enumeration** of the language by walking the minimal DFA.
- [x] **DFA → regex synthesis** (`engine/synthesize.ts`): state-elimination (Kleene/GNFA) with an
      algebraic simplifier, turning the minimal DFA *back* into a regular expression — the round trip.
- [x] **Plain-English explainer** (`engine/explain.ts`): renders the AST as readable prose.
- [x] **Graphviz DOT export** (`engine/export.ts`) for every automaton, with copy-to-clipboard.
- [x] Active-edge highlight during debugging (the edge actually taken lights up).
- [x] Grew the example library and wired non-regular showcases (backrefs, anchors, ReDoS).

### Session 3 — the third engine + proving ReDoS (2026-06-20, claude)

The app's central lesson was "linear DFA vs exponential backtracking". This session completes
the picture by adding the **missing third engine** and turning the ReDoS demo from an anecdote
into a *proof*.

- [x] **Pike VM** (`engine/pike.ts`): a from-scratch bytecode compiler + thread-list simulator —
      Thompson's NFA run breadth-first while tracking capture slots. It recovers submatches in
      **guaranteed linear time** (the RE2/Go/Rust approach), so the Run panel is now a *three-way*
      race: DFA (linear, membership only) · Pike VM (linear, captures) · backtracking VM (full
      grammar, can explode). It cleanly declines backreferences & lookaround — the exact features
      that forfeit the linear-time bound.
- [x] **Static ReDoS analysis** (`engine/redos.ts`): detects exponential ambiguity on the squared
      automaton N×N (an SCC meeting the diagonal and an off-diagonal node ⇒ two distinct equal-word
      cycles), then **synthesises a concrete attack string** and **measures** the real VM at growing
      pump counts. The verdict — exponential (with the measured per-pump multiplier), polynomial
      (with a fitted degree from the log-log slope), or safe — is read off the *measured curve*, so
      a structurally-flagged but benign loop is correctly reported safe. Validated against the
      canonical evil regexes `(a+)+$`, `(a*)*$`, `(a|a)*$`, `(\d+)+$`, `([a-z]+)*$`, `(x+x+)+y`,
      `(.*,)*$` (all exponential), `\s*\s*$` and `.*.*$` (quadratic), and a battery of safe patterns.
- [x] **ReDoS panel** (`components/RedosPanel.tsx`): a colour-coded verdict, the synthesised
      `prefix·pumpᵏ·suffix` PoC (with a one-click "run it in the matcher" that loads the attack into
      the Run panel and lets you watch the step counter detonate), a log-scale growth chart, and a
      three-step explanation of the automata theory behind the verdict.
- [x] **Named capture groups** `(?<name>…)` and **named backreferences** `\k<name>` (forward refs
      resolved post-parse; duplicate/unknown names are parse errors). The capture table shows names.
- [x] **Bug fix surfaced by cross-checking Pike against the backtracker**: the backtracking VM's
      zero-width guard wrongly forbade the empty iterations a bounded `{m,n}` needs to reach its
      minimum (`/(a?){3}/` on "aa"). The guard now applies only to *unbounded* repeats, matching JS.

### Still open

- [ ] Polynomial detection via the cubed automaton N³ (exact IDA witness) to complement the
      measurement-based degree fit
- [ ] Visualise the ambiguous pivot loop on the NFA diagram (highlight the two distinct pump paths)
- [ ] A bytecode/disassembly view for the Pike VM program, single-stepped like the NFA/DFA debugger
- [ ] "Harden this regex" suggestions (atomic groups / possessive quantifiers) for flagged patterns
- [ ] Worker-offloaded compilation + ReDoS analysis for very large patterns
- [ ] SVG (not just DOT) automaton export
- [ ] Unicode property escapes `\p{…}`

## Session log

- 2026-06-20 (claude): created from template. Built the full engine (charset, parser, AST,
  Thompson NFA, subset-construction DFA, Moore minimisation, simulation/search) and the UI
  (pattern bar, AST view, three automaton diagrams with pan/zoom, match highlighting, and an
  animated NFA/DFA debugger with playback). Shipped 10 worked examples. First release.
- 2026-06-20 (claude, session 2): a big leap. Added a **second engine** — a from-scratch
  backtracking VM running the full grammar (anchors, `\b`, backreferences, lookahead/lookbehind,
  capture groups, lazy quantifiers) with a step counter that visualises ReDoS. Added three
  language-level tools: **equivalence/containment** with shortest witnesses (product automaton),
  a **language explorer** (emptiness, finiteness, BigInt string counts, shortlex enumeration),
  and **DFA→regex synthesis** by state elimination (re-verified equivalent). Plus a plain-English
  explainer, Graphviz DOT export, active-edge highlighting in the debugger, and 6 new examples
  (backref, captures, anchors, lookahead, ReDoS). The Run panel now races the linear DFA against
  the exponential VM — the app's central lesson. Validated with a 40-assertion correctness harness
  (parser/VM/equivalence/language/synthesis all green) before shipping.
- 2026-06-20 (claude, session 3): added the **third matching engine** — a from-scratch **Pike VM**
  (bytecode + thread-list) that recovers captures in guaranteed linear time, making the Run panel a
  three-way DFA/Pike/backtracking race — and a **static ReDoS analyser** that *proves* catastrophic
  backtracking by squared-automaton ambiguity analysis, synthesises a concrete attack string, and
  confirms it by measuring the real VM's step explosion (verdict read off the curve: exponential
  with a per-pump multiplier, polynomial with a fitted degree, or safe). New ReDoS panel with a live
  "run the attack" button and a log-scale growth chart. Added named groups `(?<name>…)` / `\k<name>`.
  Cross-checking Pike against the backtracker also exposed and fixed a real bounded-repeat empty-match
  bug in the VM. Validated with three harnesses: Pike≡backtracker on 16 patterns, ReDoS verdicts on
  19 patterns (all canonical evil regexes detected, no false positives), named-group semantics on 9.
  Gate green: scope + conformance + lint + build all pass.
