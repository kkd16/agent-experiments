# Regex Studio — journal

A regular-expression engine implemented from scratch in TypeScript — no `RegExp`, no
parser generator, no automata library. The app takes a pattern through the full classic
pipeline and visualises every stage:

```
source ──parse──▶ AST ──Thompson──▶ ε-NFA ──subset──▶ DFA ─┐
                   │                                        ├─Moore──▶ minimal DFA
                   └────── Brzozowski derivatives ──────────▶ DFA ─┘   (two roads, one machine)
                                         │
                                         └──▶ leftmost-longest search + animated debugger
```

Four matching engines (DFA · derivative DFA · Pike VM · backtracking VM) plus the platform's own
`RegExp` are cross-checked by a seeded **differential fuzzer**. Everything is hand-written — no
`RegExp` in the engine, no parser generator, no automata library.

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
- `src/engine/derivatives.ts` — **Brzozowski derivatives**: the app's *fourth* engine and a second,
  independent road from a regex to a DFA. A canonicalised derivative algebra (`DReg`) with similarity
  smart constructors (ACI alternation, identity/associative concatenation, idempotent star) keeps the
  derivative set finite; `nullable`/`derivative` give a streaming matcher (`accepts`), and `buildDerivDFA`
  BFS-walks the derivatives into the *same* `DFA` structure subset construction produces — so it flows
  into the graph / language / minimise views unchanged. The two DFAs differ before minimisation but
  minimise to the same machine. `derivativeChain` exposes the residual-per-character trace; `dsize`/state
  caps bound pathological blow-ups.
- `src/engine/fuzz.ts` — **differential fuzzer**. A seeded PRNG draws random *regular* patterns and
  strings and asks all six engines the same membership question — subset DFA, derivative DFA, streaming
  derivatives, Pike VM, backtracking VM, and the platform's own `RegExp` as an external oracle — failing
  loudly with a reproducible counterexample on any disagreement. It restricts itself to the subset where
  our semantics and JS agree, skips backtracking-VM step-limit aborts (ReDoS, not a wrong answer), and
  immediately earned its keep by catching a real backtracking-VM bug (see Session 4).
- `src/engine/explain.ts` — AST → plain-English prose. `src/engine/export.ts` — Graphviz **DOT** *and*
  standalone **SVG** export (`toSvg`), the latter built straight from the laid-out graph.
- `src/components/*` — `AutomatonGraph` (pan/zoom SVG, active-edge highlight), `AstView`,
  `Debugger`, plus the panels: `MatchPanel` (three-engine run + captures), `LanguagePanel`,
  `ComparePanel`, `SynthesizePanel`, `ExplainPanel`, `PikePanel`, `RedosPanel`, and the session-4
  `DerivativesPanel` (derivative DFA + residual chain) and `FuzzPanel` (the differential-testing console).

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
- [x] **Pike VM bytecode view** (`components/PikePanel.tsx` + `disassemble` in `engine/pike.ts`):
      a new "Pike VM" tab disassembles the compiled program — `char/split/jmp/save/assert/match` with
      colour-coded ops, jump targets, capture-slot glosses and a legend — so the linear engine is as
      inspectable as the NFA/DFA diagrams. Backref/lookaround patterns show *why* they can't compile.

### Session 4 — the fourth engine (derivatives), a differential fuzzer, and a bug it found (2026-06-20, claude)

Three matching engines proved the same string the same way. This session adds a *fourth* engine on a
mathematically different footing, a **second independent road to the DFA**, and a fuzzer that turns
"the engines agree" from a claim into measured evidence — which immediately paid for itself by exposing
a real bug in the existing backtracking VM.

- [x] **Brzozowski derivatives** (`engine/derivatives.ts`) — a canonicalised derivative algebra with
      similarity smart constructors (ACI alternation, identity/associative concat, idempotent star) that
      keeps the derivative set finite. `nullable` + `derivative` give a **streaming matcher** (derive once
      per character, accept iff the residual is nullable).
- [x] **Derivative-DFA construction** (`buildDerivDFA`) — BFS over derivative states builds a DFA
      *straight from the regex*, no NFA in between, reusing the exact `DFA` structure subset construction
      emits. It minimises (via the existing Moore pass) to the **same** machine the Thompson→subset road
      produces — verified equal across 467k membership checks on 29 patterns.
- [x] **Derivatives panel** (`components/DerivativesPanel.tsx`) — the derivative DFA as a pan/zoom graph,
      a "subset DFA vs derivative DFA → both minimise to N" scoreboard, and the live **residual chain**
      for the test text (each step shows the shrinking expression, a `nullable` badge, and the dead-`∅`
      reject).
- [x] **Differential fuzzer** (`engine/fuzz.ts` + `components/FuzzPanel.tsx`) — a seeded PRNG draws
      random regular patterns + strings and cross-checks **six** engines (subset DFA · derivative DFA ·
      streaming derivatives · Pike VM · backtracking VM · the platform's `RegExp` oracle). Reproducible by
      seed; reports the exact counterexample on any disagreement. 70,000+ comparisons across 25 seeds:
      zero disagreements.
- [x] **Bug found & fixed by the fuzzer**: the backtracking VM's zero-width guard forbade *all* empty
      iterations of an unbounded repeat, so `(a?)+` could never take the single empty iteration it needs
      to satisfy its `min` (e.g. `/(a?)+b/` on `"b"`, `/(a?)+/` on `""`). The guard now blocks empty
      iterations only once `count >= min`, matching JS. (`engine/vm.ts`, both greedy and lazy paths.)
- [x] **SVG automaton export** (`toSvg` in `engine/export.ts`) — a self-contained, styled vector built
      from the laid-out graph, wired into every graph pane (download) alongside the existing copy-DOT.
- [x] New examples: a derivative chain, "two roads, one DFA", and a `(a?)+b` regression for the fixed bug.

### Still open

- [ ] Polynomial detection via the cubed automaton N³ (exact IDA witness) to complement the
      measurement-based degree fit
- [ ] Visualise the ambiguous pivot loop on the NFA diagram (highlight the two distinct pump paths)
- [ ] Single-step the Pike VM bytecode (animate the thread list) like the NFA/DFA debugger
- [ ] Animate the derivative-DFA walk on the test text (light the active state per character)
- [ ] "Harden this regex" suggestions (atomic groups / possessive quantifiers) for flagged patterns
- [ ] Worker-offload the fuzzer / large-pattern compilation so the UI never blocks
- [ ] Antimirov *partial* derivatives → a derivative-built NFA (a sibling to the derivative DFA)
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
- 2026-06-20 (claude, session 4): added the **fourth engine** — **Brzozowski derivatives** — and a
  **second independent road to the DFA**: a canonicalised derivative algebra (`derivatives.ts`) gives a
  streaming matcher *and* `buildDerivDFA`, which BFS-walks derivatives into a DFA straight from the regex
  (no NFA) reusing the existing `DFA` type, so it minimises to the very same machine subset construction
  yields. New **Derivatives panel** (derivative DFA graph + subset-vs-derivative scoreboard + live
  residual-per-character chain). Then a **differential fuzzer** (`fuzz.ts` + panel): a seeded PRNG
  cross-checks all six engines — subset DFA, derivative DFA, streaming derivatives, Pike VM, backtracking
  VM, and the platform's own `RegExp` oracle — on thousands of random pattern/string pairs, reproducible
  by seed, surfacing the exact counterexample on disagreement. It immediately **found and I fixed a real
  backtracking-VM bug**: the unbounded-repeat zero-width guard forbade the empty iterations a `+` needs to
  reach its minimum (`/(a?)+b/` on `"b"`). Also added **SVG export** for every automaton. Validated:
  derivative ≡ subset across 467k membership checks (and identical minimal DFAs); the fuzzer logged 70,000+
  six-engine comparisons across 25 seeds with zero disagreements; a default in-app run does 8,000 checks in
  ~0.8s. Gate green: scope + conformance + lint + build all pass.
