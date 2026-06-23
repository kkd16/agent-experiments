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
- `src/engine/hopcroft.ts` — **Hopcroft's O(n·log n) minimisation**: a second, independent road to the
  *minimal* DFA. Maintains a worklist of distinguisher blocks and splits by inverse transitions, always
  re-queuing the smaller half (the log factor). Same Myhill–Nerode equivalence as Moore, so it produces the
  same minimal machine — the Min-DFA tab verifies `Moore ≡ Hopcroft` live via the product-automaton check.
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
- `src/engine/coalgebra.ts` — equivalence **without determinising**: both ε-NFAs are embedded into one
  combined state space over a shared atomic alphabet (the Bonchi–Pous setting), then language equivalence is
  decided by **bisimulation up to congruence** (POPL 2013). The one driver runs all three up-to closures —
  naïve Hopcroft–Karp, up-to-equivalence (union-find), and up-to-**congruence** (set-rewriting to a normal
  form) — so the panel can show, in pairs-expanded, how the congruence closure collapses an exponential
  powerset to a handful of pairs. Returns the bisimulation `R` and the shortest distinguishing word.
- `src/engine/antichain.ts` — inclusion & universality by **antichains** (De Wulf–Doyen–Henzinger–Raskin,
  CAV 2006). `L(A) ⊆ L(B)` searches for a word in `L(A)\L(B)` over macrostates `(q, S)` — one existential
  A-state, the determinised B-subset — keeping only the ⊑-minimal frontier; equivalence is inclusion both
  ways, the 5-way relation adds an intersection-emptiness probe, and universality is inclusion of a synthesised
  Σ*. Reports the antichain size against the full-product count it replaces, plus the counterexample word.
- `src/engine/coalgebra-verify.ts` — the cross-check: thousands of random pattern *pairs* confirm the three
  HKC modes agree with each other and with `equivalence.ts`, the antichain road rebuilds the same 5-way
  relation, antichain universality matches a DFA oracle, witnesses really separate the languages, and HKC
  never expands more pairs than naïve. Drives the Coalgebra tab's "run" button.
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
- `src/engine/antimirov.ts` — **Antimirov partial derivatives**: the app's *fifth* engine and a *third*,
  independent road from a regex to an automaton. Where Brzozowski's derivative is one residual regex,
  the *partial* derivative `∂c(r)` is a **set** of regexes whose union is Brzozowski's — and keeping the
  set unmerged makes the construction non-deterministic. The `linearForm` (head-class → continuation
  monomials) drives three things: a streaming **partial-derivative matcher** (`acceptsPartial`, a direct
  breadth-first NFA simulation), the **equation automaton** (`buildAntimirovNFA`) whose states are the
  partial-derivative terms — ε-free and provably **linear-size** (≤ one state per character occurrence + 1,
  far smaller than Thompson's ε-NFA), and its determinisation (`buildAntimirovDFA`, which lowers the PNFA
  into the studio's `NFA` shape with a synthetic accept and reuses `buildDFA` verbatim) — a third road that
  minimises to the *same* canonical machine. `partialChain` exposes the per-character set of live terms for
  the panel. Reuses the `DReg` similarity algebra from `derivatives.ts` so the term set stays finite.
- `src/engine/fuzz.ts` — **differential fuzzer**. A seeded PRNG draws random *regular* patterns and
  strings and asks all **eight** engines the same membership question — subset DFA, derivative DFA,
  streaming derivatives, Antimirov DFA, partial derivatives, Pike VM, backtracking VM, and the platform's
  own `RegExp` as an external oracle — failing loudly with a reproducible counterexample on any
  disagreement. It restricts itself to the subset where our semantics and JS agree, skips backtracking-VM
  step-limit aborts (ReDoS, not a wrong answer), and immediately earned its keep by catching a real
  backtracking-VM bug (see Session 4).
- `src/engine/ereg.ts` — **Boolean Brzozowski derivatives** (session 7): the studio's *fifth road* and the
  first beyond the core algebra — the full **Boolean closure** (intersection `&`, complement `~`, difference `−`).
  A self-contained extended algebra `EReg` (the core `DReg` plus `and`/`not`) with similarity smart constructors
  (`&` ACI with `∅` annihilator + `Σ*=~∅` identity; `~` an involution). `nullable`/`derivative` extend by the
  Boolean rules; `buildEregDFA` BFS-walks the derivatives into the studio's `DFA` shape over a **complete**
  alphabet (the whole of Σ partitioned when a `~` is present, so `~A` accepts the characters `A` never names).
  Also `ends` — an independent **span oracle** deciding membership straight from the algebra, no derivatives.
- `src/engine/booldfa.ts` — the *classical* gold standard the Boolean engine is cross-checked against: the
  **product automaton** (`∩`/`∪`/`−`) and a **complete-then-flip** complement, both on the studio's existing DFAs.
- `src/engine/ereg-verify.ts` — the session-7 proofs: live algebraic-law badges (`compareDFAs`), the recursive
  `tryClassicalDFA` cross-check (Boolean-derivative DFA ≡ classic product/complement), and the seeded
  three-engine differential fuzzer (streaming derivative · derivative DFA · `ends` oracle).
- `src/engine/monoid.ts` — **the syntactic monoid** (session 8): the algebraic theory of the language. `completeDFA`
  re-adds the dead sink the minimiser dropped (the transition monoid needs a *total* transition function);
  `buildSyntacticMonoid` then BFS-closes the per-atom state-transformations under composition into the full transition
  monoid — which, for the *minimal* complete DFA, **is** the syntactic monoid `M(L)`. Each element carries a shortest
  realising word, its image-rank, and an idempotent flag; the Cayley table, the idempotents and any two-sided zero fall
  out. `greenRelations` computes the five **Green's relations** R/L/J/H/D on that table (right/left/two-sided ideals;
  `H = R ∩ L`; `D = R∘L` as connected components, `= J` in a finite monoid) and assembles the **egg-box** structure —
  each D-class as a grid of R-classes × L-classes, the group H-classes (those with an idempotent) flagged with their
  order. `counterFreeWitness` is the DFA-side aperiodicity test (no word induces a non-trivial cycle), and
  `monoidProperties` reads off the variety membership: **aperiodic ⇔ star-free ⇔ FO[<] ⇔ counter-free**
  (Schützenberger / McNaughton–Papert, decided three independent ways and cross-checked), **J-trivial ⇔ piecewise
  testable** (Simon), R/L-trivial, commutative, band, group language, and the **counting modulus** (the largest group
  order — 1 iff star-free). Capped at 1500 elements with graceful degradation.
- `src/engine/monoid-verify.ts` — the session-8 proof console: a seeded fuzzer draws random regular patterns, builds
  each one's syntactic monoid, and asserts the three roads to "aperiodic" agree plus Green's-relation sanity
  (`H = R ∩ L`, full egg-boxes, R,L ⊆ D, J-trivial ⇒ aperiodic, aperiodic ⇔ modulus 1) — reproducible by seed,
  surfacing any counterexample. Drives the panel's "run cross-check" button.
- `src/engine/explain.ts` — AST → plain-English prose. `src/engine/export.ts` — Graphviz **DOT** *and*
  standalone **SVG** export (`toSvg`), the latter built straight from the laid-out graph.
- `src/components/*` — `AutomatonGraph` (pan/zoom SVG, active-edge highlight), `AstView`,
  `Debugger`, plus the panels: `MatchPanel` (three-engine run + captures), `LanguagePanel`,
  `ComparePanel`, `SynthesizePanel`, `ExplainPanel`, `PikePanel`, `RedosPanel`, the session-4
  `DerivativesPanel` (derivative DFA + residual chain) and `FuzzPanel` (the differential-testing console),
  and the session-5 `AntimirovPanel` (equation automaton + Thompson-size comparison + live live-term-set chain),
  the session-6 `GlushkovPanel`, and the session-7 `ExtendedPanel` (Boolean-derivative DFA + proof badges +
  Boolean-derivative chain + language stats + a "run cross-check" fuzz console), and the session-8 `MonoidPanel`
  (the **Algebra** tab: the star-free/aperiodic verdict with its three-way cross-check, the variety badges, the
  monoid summary, the **egg-box diagram**, the Cayley table, and the fuzz cross-check).

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

### Session 5 — the fifth engine: Antimirov partial derivatives (the equation automaton) (2026-06-20, claude)

Four engines and *two* roads to a DFA (Thompson→subset and Brzozowski). This session adds a *fifth* engine
and a **third, independent road** — Antimirov's **partial** derivatives, which build a tiny ε-free NFA
directly from the regex, the mirror image of Brzozowski's derivative DFA.

- [x] **Antimirov partial derivatives** (`engine/antimirov.ts`) — the **linear form** `lf(r)` (head-class →
      continuation *monomials*), reusing the canonical `DReg` similarity algebra so the partial-derivative
      term set stays finite. From it: `partialDerivative` (the *set* `∂c(r)` whose union is Brzozowski's
      derivative) and a streaming **partial-derivative matcher** (`acceptsPartial`) that is literally a
      breadth-first NFA simulation — linear time, no backtracking.
- [x] **The equation automaton** (`buildAntimirovNFA`) — states are partial-derivative terms; the result is
      **ε-free** and **provably linear-size** (≤ one state per character occurrence + 1). Verified against
      Thompson's ε-NFA on a battery of patterns: e.g. `(a|b|c)*` → **1 state** vs Thompson's 10 states +
      10 ε-edges; `(a|b)*abb` → 4 vs 14; `ab|ba|aa|bb` → 4 vs 18. The bound held on every pattern tested.
- [x] **The third road, verified** (`buildAntimirovDFA`) — the PNFA is lowered into the studio's `NFA` shape
      (a synthetic accept state with an ε-edge from each nullable term) so the *existing* subset construction
      and Moore minimisation run unchanged. Determinising + minimising the equation automaton lands on the
      **exact same canonical machine** the Thompson→subset and Brzozowski roads reach — confirmed via the
      product-automaton `compareDFAs` (relation = equal) on 17 patterns. Three roads, one minimal automaton.
- [x] **Antimirov panel** (`components/AntimirovPanel.tsx`) — a new "Antimirov" pipeline tab: the equation
      automaton as a pan/zoom graph (multiple double-circled accept states, DOT/SVG export), a Thompson-vs-
      equation **size scoreboard** with the live "−N% states, no ε" win and the "≡ canonical ✓" verification,
      and the **live-term-set chain** on the test text — where Brzozowski shows one shrinking residual, this
      shows the *set* of live terms (the NFA's active states) forking and dying one character at a time.
- [x] **Fuzzer upgraded to eight engines** (`engine/fuzz.ts` + `FuzzPanel`) — the partial-derivative matcher
      and the Antimirov DFA join the cross-check. Validated: **all eight engines agree** across 8 seeds ×
      1,200 patterns × 16 strings = **153,600 membership checks**, zero disagreements (and the existing
      `RegExp` oracle still in the mix). A default in-app run cross-checks all eight in well under a second.
- [x] **Hopcroft minimisation** (`engine/hopcroft.ts`) — a *second road to the minimal DFA*: the classic
      O(n·log n) worklist refinement (split by inverse transitions, always re-queue the smaller half),
      alongside the existing Moore O(n²) pass. Both compute Myhill–Nerode, so they must agree; the Min-DFA
      tab now shows a live **"Moore ≡ Hopcroft ✓"** badge (verified via `compareDFAs` + equal state count).
      Validated headless: identical to Moore (same #states + language-equal) on **4,024 patterns**.
- [x] Two new examples (`(a|b|c|d)*` — the one-state collapse; `(ab|cd)+ef` — the third road), updated
      header/footer/Fuzz copy to "three roads · five engines · eight cross-checked · Moore≡Hopcroft".

### Session 6 — the fourth road: Glushkov's position automaton + hardening advice (2026-06-20, claude)

Three independent roads ran from a regex to its canonical automaton (Thompson→subset, Brzozowski
derivatives, Antimirov partial derivatives). This session adds the **fourth** — Glushkov's
**position automaton** — the ε-free construction every textbook teaches first, and the missing
*middle* of the studio's size story: Thompson (ε-laden, ~2 states/operator) → **Glushkov (ε-free,
exactly m+1 states)** → Antimirov (ε-free, a *quotient* of Glushkov). Then it turns the ReDoS tab
from a diagnosis into a *prescription*.

- [x] **Glushkov's construction** (`engine/glushkov.ts`) — linearise the parsed AST so every letter
      occurrence gets a **position** `1…m`, then read the four classic functions straight off the
      tree: `nullable`, `first`, `last`, `follow`. The position automaton falls out mechanically:
      start → every `first`; `p` → every `q ∈ follow(p)`; accept at every `last` (and at the start
      when the pattern is nullable). ε-free, with **exactly m+1 states** — one per letter plus the
      start. `+`/`?`/`*` are handled directly (one position each); `{m,n}` expands to explicit copies.
- [x] **A sixth matching engine** — a streaming position-automaton simulator (`acceptsGlushkov`):
      carry the live position set, and per character replace it by the union of every live position's
      `follow` restricted to admitting positions. A breadth-first NFA simulation — linear, no
      backtracking.
- [x] **The fourth road, verified** (`buildGlushkovDFA`) — lower the position automaton into the
      studio's `NFA` shape (a synthetic accept with an ε-edge from each `last`) so the *existing*
      subset construction + Moore minimisation run unchanged. Determinising + minimising lands on the
      **exact same canonical minimal DFA** the other three roads reach (verified via `compareDFAs`).
      Four roads, one minimal automaton.
- [x] **Homogeneity proof** — the position automaton is *homogeneous*: every edge entering a state
      carries that state's character class. Verified structurally and shown as a live badge.
- [x] **Glushkov panel** (`components/GlushkovPanel.tsx`) — a new "Glushkov" pipeline tab: the
      position automaton as a pan/zoom graph (DOT/SVG export), a Thompson→Glushkov→Antimirov size
      scoreboard with the "ε-free, exactly m+1" win and the "≡ canonical ✓" verification, the live
      **first/last/follow tables** (the whole automaton in three columns), and the **position-set
      chain** on the test text (the active states as it reads the input — accept iff a live position
      is a `last`).
- [x] **Fuzzer upgraded to ten engines** (`engine/fuzz.ts` + `FuzzPanel`) — the Glushkov DFA and the
      streaming position automaton join the cross-check. Validated: **all ten engines agree** across
      8 seeds × 1,200 patterns × 16 strings = **153,600 membership checks**, zero disagreements (plus
      the standalone Glushkov cross-check: 192,000 checks, always canonical, always homogeneous,
      Glushkov never larger than Thompson). The 45 "Antimirov > Glushkov(m+1)" cases observed are not
      bugs — the studio's Antimirov is built on the canonical derivative algebra, which desugars `+`
      and `?` with extra letters, so the two linearisations differ; the quotient relation holds only
      on a shared linearisation, and the panel says so.
- [x] **"Harden this regex"** (`hardenSuggestions` in `engine/redos.ts` + the ReDoS panel) — when the
      analyser *proves* super-linear backtracking, it now prescribes the three canonical mitigations,
      strongest first: make the loop **atomic / possessive** (`(?>…)`, `a*+`), run it on a **DFA-based
      engine** (RE2/Go/Rust — immune by construction, like this studio's own DFA/Pike tabs), or
      **bound/disambiguate** the repetition. Anchored to the loop the analysis found, and it
      deliberately does *not* auto-rewrite the pattern (a silent language change would be worse than
      the ReDoS) — honest advice over a clever-but-unsafe transform.
- [x] Two new examples (`(a|b)*abb` — the textbook five-letters→six-states position automaton;
      `(ab|ba)*(a|b)` — "four roads, one DFA"), plus header/footer copy updated to "compile four ways
      · six engines · ten cross-checked".

### Session 7 plan — Extended (Boolean) regular expressions via Boolean derivatives

The studio reaches an automaton four ways, but every road so far speaks the same *core*
algebra: union, concatenation, star. The big gap is the **Boolean closure** of the regular
languages — **intersection (`&`), complement (`~`), and difference (`−`)**. Classically these
need the product / subset-complement constructions (and complement needs a *complete* DFA);
there is no NFA fragment for them, so Thompson/Glushkov/Antimirov can't touch them. But
**Brzozowski derivatives extend to the full Boolean algebra for free** — `∂c(A & B) = ∂cA &
∂cB`, `∂c(~A) = ~(∂cA)`, `nullable(A & B) = nullable A ∧ nullable B`, `nullable(~A) = ¬nullable
A`. So derivatives are the **one road of the four that builds these languages directly**, and
that's the headline. This is a genuine new *language class* for the studio, not a new view of
the old one.

- [x] **Extended AST** (`ast.ts`) — two new nodes `intersect` (n-ary `&`) and `complement`
      (`~`); `analyzeFeatures` learns an `extended` flag. The classic pipeline is untouched: the
      main pattern bar still parses in *non-extended* mode, so `&` `~` `−` stay literals there and
      the ten-engine fuzzer's guarantees are byte-for-byte unchanged. (Adding the two AST variants
      did break the *exhaustive* switches in the regular-only engines — TS enforces exhaustiveness
      once a union is fully covered — so `nfa`/`vm`/`glushkov`/`derivatives` now throw a clear
      "not a regular construct" on them, and `explain`/`AstView` render them.)
- [x] **Extended parser** (`parser.ts`) — an opt-in `extended` mode reusing 100% of the existing
      atom / class / escape / quantifier parsing, adding one precedence layer: `|` (union) <
      `&`,`−` (intersection / difference, left-assoc) < concat < `~` (prefix complement) < postfix.
      `A − B` desugars to `A & ~B`. `\&` `\~` `\-` escape the literals. New `parseExtended(src)`.
- [x] **Boolean derivative engine** (`ereg.ts`) — a self-contained extended algebra `EReg`
      (`emp eps chr cat alt star and not`) with similarity smart constructors: `&` is
      associative-commutative-idempotent with `∅` annihilator and `Σ*` identity, `~` is an
      involution (`~~A = A`, `~∅ = Σ*`). `nullable` / `derivative` / `show` / streaming `accepts`.
- [x] **Complement-correct alphabet** — derivatives of `~A` stay *alive* on characters `A` never
      mentions, so the derivative DFA must be **complete**: when a `not` is present, partition the
      *whole* of Σ (covered **and** uncovered ranges) into atoms so "every other character" routes
      to a real state, not the dead sink. (Without a `not`, behave exactly as the plain derivative
      DFA so a regular pattern still minimises to the very same canonical machine.)
- [x] **`buildEregDFA`** — BFS the Boolean derivatives into the studio's own `DFA` shape, so the
      result flows unchanged into the graph / minimise / **Language** (count·enumerate) views.
- [x] **An independent semantic oracle** (`ends`) — evaluate extended membership *without*
      derivatives, straight from the algebra: `ends(E,i)` = the set of span ends `j` with `E`
      matching `w[i..j)`, where `ends(A&B)=ends A ∩ ends B` and `ends(~A,i)={j : j∉ends(A,i)}`.
      A second engine to differentially test the DFA against.
- [x] **Classical cross-check** (`booldfa.ts`) — product-automaton `∩`/`∪`/`−` and a
      *complete-then-flip* complement on the studio's existing DFAs. The headline proof:
      `derivativeDFA(A & B) ≡ product(DFA A, DFA B)` and `derivativeDFA(~A) ≡ complement(DFA A)`,
      via a recursive `tryClassicalDFA` that rebuilds any &/~/− nesting over regular cores.
- [x] **Live proof badges** — involution (`~~A ≡ A`), idempotence (`A & A ≡ A`), excluded middle
      (`A ∪ ~A ≡ Σ*`), non-contradiction (`A ∩ ~A ≡ ∅`), and the classical cross-check, each
      verified with `compareDFAs` and shown as a ✓ badge the way the other panels do.
- [x] **Extended differential fuzzer** — a seeded generator of random `&`/`~` expressions over a
      tiny alphabet, cross-checking the **three** extended engines (streaming derivative · DFA ·
      `ends` oracle) over thousands of strings, reproducible by seed, surfacing the counterexample.
- [x] **The Extended panel** (`components/ExtendedPanel.tsx`) — its own input + curated examples,
      the derivative-built DFA graph (DOT/SVG export), the live Boolean-derivative chain on the
      test text, language stats (min states · finite/∞ · members), the proof badges, and a
      "run cross-check" button. A new top-level **Extended &~** tab.
- [x] **Showcase examples** — the password lookahead `(?=.*\d)(?=.*[a-z]).{6,}` re-expressed as a
      *true regular intersection* `.*[0-9].*&.*[a-z].*&.{6,}` (now it has a DFA!); "no `abc`
      substring" via `~(.*abc.*)`; identifiers minus reserved words via `−`; even-`a`-even-`b`
      `b*(ab*ab*)*&a*(ba*ba*)*` (the textbook 4-state product); "contains ab but not ba"; ÷6.
- [x] Header/footer/`project.json` copy updated to "five roads · Boolean closure".

### Session 8 — the algebraic theory: the syntactic monoid, Green's relations & star-freeness (2026-06-21, claude)

Every road so far ends at an *automaton*. This session opens a whole new dimension — the **algebra** of the language.
Each regular language has a canonical finite monoid `M(L)`, and a chain of deep theorems lets you read the language's
hardest-to-see properties straight off it. The headline is **Schützenberger's theorem**: a language is *star-free*
(definable with union, concatenation and complement — no Kleene star) **exactly when** its syntactic monoid is
*aperiodic* (has no non-trivial group). The studio now builds that monoid from scratch and *proves* the verdict.

- [x] **The syntactic monoid, from scratch** (`engine/monoid.ts`) — `completeDFA` re-adds the dead sink the minimiser
      drops (a transition monoid needs a total transition function), then `buildSyntacticMonoid` BFS-closes the per-atom
      state-transformations under composition. For the *minimal complete* DFA the transition monoid **is** the
      syntactic monoid `M(L)` (a classical theorem) — so this is the genuine algebraic invariant, not an approximation.
      Each element keeps a shortest realising word; the idempotents and any two-sided zero fall out of the Cayley table.
- [x] **Green's relations & the egg-box** (`greenRelations`) — the five relations R/L/J/H/D computed on the
      multiplication table (right/left/two-sided principal ideals; `H = R ∩ L`; `D` as the connected components of
      R∪L, `= J` for a finite monoid). Assembled into the classic **egg-box diagram**: each D-class a grid of
      R-classes (rows) × L-classes (columns), every cell an H-class, the **group** H-classes (those containing an
      idempotent) flagged with their order — the structure that makes the abstract algebra *visible*.
- [x] **Schützenberger, decided three independent ways** — aperiodicity (⇔ star-free ⇔ FO[<]-definable ⇔
      counter-free) is computed by (a) every H-class a singleton, (b) every element group-free `mⁿ = mⁿ⁺¹`, and
      (c) a direct DFA **counter-free** test (`counterFreeWitness`: no word induces a non-trivial state cycle). The
      panel shows all three pills and an "all three agree ✓" — and the seeded fuzzer confirms they *always* agree.
- [x] **Variety membership** (`monoidProperties`) — beyond star-free: **J-trivial ⇒ piecewise testable** (Simon's
      theorem), R-trivial, L-trivial, commutative, idempotent (band), **group language** (one idempotent ⇒ the DFA is
      a permutation automaton), and trivial; plus the **counting modulus** — the largest group order, the modulus of
      the counting a non-star-free language does (`(aa)*` → 2, `(aaa)*` → 3).
- [x] **The Algebra panel** (`components/MonoidPanel.tsx`) — a new analysis tab: the headline star-free verdict (with
      the counter and its witness word when it fails), the three-way aperiodicity cross-check, a monoid summary
      (order · idempotents · generators · D-classes · modulus · identity · zero), the variety badges, the rendered
      **egg-box** (idempotent cells starred & shaded, group cells highlighted with their order, each cell a shortest
      word), a colour-by-D-class **Cayley table** toggle, and a "run cross-check" fuzz console.
- [x] **Verified before shipping** — a headless harness (curated known-answer cases + 4,000 random patterns ×
      8 structural invariants) ran **32,021 assertions, zero failures**: `(aa)*`→ℤ/2 and `(aaa)*`→ℤ/3 caught as
      non-star-free; `a*b*`, `(ab)*`, "contains a" proved star-free; and on every random monoid the three
      aperiodicity tests agreed, `H = R ∩ L`, the egg-boxes were full grids, and J-trivial ⇒ aperiodic held.
- [x] Four new examples (`(aa)*` not star-free · `(aaa)*` mod-3 counter · `a*b*` star-free/piecewise-testable ·
      `(ab)*` starred-yet-star-free), header/footer/`project.json` copy updated to mention the syntactic monoid.

### Session 9 plan — the variety ladder: DA / FO², the syntactic group, and the egg-box↔DFA bridge (2026-06-21, claude)

Session 8 left the algebra one verdict deep: aperiodic-or-not. This session turns that single badge into a
**legible classification ladder** and makes the abstract monoid *tangible* by tying every element back to the
state-map it actually is. New engine module `engine/variety.ts` plus a heavily-extended Algebra panel. Every new
claim is decided structurally from `M(L)` and cross-checked by the fuzzer — no assertions without a proof.

- [x] **DA / FO²[<] membership** — a finite monoid is in **DA** iff every *regular* element is idempotent
      (Schützenberger–Pin–Tesson–Thérien). This is exactly the languages definable in two-variable first-order logic
      `FO²[<]`, equivalently the **unambiguous polynomials** `A₀*a₁A₁*…aₖAₖ*`, equivalently `Σ₂ ∩ Π₂`. Decide it,
      return a witness (a regular non-idempotent element) when it fails, and prove `DA ⊆ aperiodic` automatically.
- [x] **The syntactic group, named** — identify the structure group of `M(L)` (the whole monoid when it's a group,
      else the group `H`-class of the top counting `D`-class): order, abelian?, exponent, and an **isomorphism type**
      — trivial · cyclic `ℤ/n` · the full abelian **invariant-factor** decomposition `ℤ/d₁×…×ℤ/dₖ` (incl. the Klein
      four) computed from the element-order spectrum by primary decomposition · dihedral `Dₙ` (incl. `S₃≅D₃`) ·
      quaternion `Q₈` · `A₄` / `S₄` by signature · a safe "non-abelian order n" fallback — all read off the Cayley
      table, so the counting modulus finally has a *name* and an operational reading.
- [x] **The variety ladder** — classify `L` on the inclusion lattice trivial ⊂ piecewise-testable (`J`-trivial,
      Simon, `BΣ₁[<]`) ⊂ `DA` (`FO²[<]`, unambiguous polynomials) ⊂ star-free (aperiodic, `FO[<]`, Schützenberger /
      McNaughton–Papert, counter-free, LTL) ⊂ all-regular, with the group branch on the side. Each level carries the
      theorem that justifies the language↔algebra correspondence and a one-line *operational* reading (what logic /
      what query can and cannot express it). Compute the *tightest* variety `L` provably sits in.
- [x] **Render the ladder** in the Algebra panel as a nested-inclusion diagram with `L`'s position highlighted,
      replacing the flat badge row, each level expandable to its theorem + meaning.
- [x] **Element ARE transformations — the egg-box↔DFA bridge.** Click any egg-box cell (or Cayley entry) to select
      that monoid element and show the **state map it induces on the complete minimal DFA**: each state `s ↦ δ(s,w)`,
      fixed points, the image (its rank), and any non-trivial **cycle** (the counter, when the element sits in a
      group), with the realising word. Makes "an element is a word's transformation of the states" concrete.
- [x] **Verify it the house way** — extend `engine/monoid-verify.ts`: `DA ⟹ aperiodic`, `J-trivial ⟹ DA`,
      the identified group's order matches its `H`-class, and (abelian case) the invariant factors multiply to the
      group order, form a divisibility chain, and *reconstruct the element-order spectrum* — over thousands of
      random monoids, zero disagreements.

### Session 11 — learning the language back: Angluin's L* (active) + RPNI (passive) (2026-06-21, claude)

Ten sessions all run the *same* direction: a regex you wrote → an automaton (four roads), → an
algebra (the monoid), → Unicode. This session opens the **opposite** direction — **grammatical
inference**. Hide the regex behind an oracle and *reconstruct* the minimal DFA from nothing but
its answers. It is a genuinely new capability (the studio has never *learned* a machine, only
*built* one) and it closes a beautiful loop: the learned automaton, minimised, is byte-for-byte
the one the regex compiles to — Myhill–Nerode made operational.

- [x] **Angluin's L\*** (`engine/learn.ts`) — active learning from a *minimally adequate teacher*.
      The teacher is the studio's own engine: **membership** queries are a walk over the target
      minimal DFA; **equivalence** queries reuse `compareDFAs` (the Compare tab's product
      automaton), which already returns the *shortest* distinguishing witness — exactly the
      counterexample L\* needs. The learner maintains the **observation table** (access strings
      `S` × distinguishing experiments `E` → {0,1}), drives it to **closed** + **consistent**
      (adding a boundary row to `S` when not closed; prepending a symbol to a distinguishing
      experiment into `E` when not consistent), reads a hypothesis DFA off the distinct rows, asks
      "is this it?", and folds every counterexample's **prefixes** back into `S` (classic Angluin).
      Learns over the studio's **atom alphabet** so the result drops straight into the existing
      graph / minimise / language views (it is a real `DFA`).
- [x] **The headline invariant — L\* learns the *minimal* DFA** — at termination each distinct
      table row is a residual language, so the hypothesis has exactly one state per Myhill–Nerode
      class: it **is** the minimal DFA. Proven the house way — `minimizeDFA(learned)` lands on the
      studio's own canonical machine (same state count, language-equal via `compareDFAs`), reported
      live as a "minimal: N states ✓" badge alongside the membership/equivalence **query counts**.
- [x] **RPNI** (`engine/rpni.ts`) — *passive* learning (Oncina–García): no questions, just a fixed
      bag of labelled strings. Build the **prefix-tree acceptor**, then greedily **merge** states
      lowest-first; a merge is accepted iff its determinising **fold** (union–find closure of the
      transition function) creates no accept/reject clash — i.e. no negative example becomes
      accepted — and rolled back otherwise; a blue state that can merge with no red state is
      promoted. Because a **complete sample** of every string up to a sufficient length is
      *characteristic*, RPNI provably recovers the exact target; the panel grows the sample depth
      `L` until it does (or the sample exceeds the cap), reporting positives/negatives/PTA size.
- [x] **The Learn tab** (`components/LearnPanel.tsx`) — the reconstructed DFA as a pan/zoom graph
      (it shows the explicit reject **sink** the minimiser usually drops), the **live observation
      table** (`+`/`−` cells, `S` above the one-step boundary `S·Σ`, distinct rows = states), the
      **conjecture-and-counterexample trace** (each round: states conjectured, the counterexample
      that refuted it), a full event log, the RPNI sample statistics, and a seeded **cross-check**
      console.
- [x] **Verified the house way** (`engine/learn-verify.ts`) — a seeded fuzzer draws random regular
      patterns, compiles each to its minimal DFA and confirms (a) L\* reconstructs a
      **language-equivalent** DFA that is **also state-for-state minimal** (so it learns the
      studio's *own* minimal DFA, not merely some equivalent machine), (b) the complete learned DFA
      differs from the partial canonical one by **at most the single dropped trap**, and (c) RPNI
      recovers the target from a complete sample. Validated offline before shipping: **10 worked
      cases + edge cases (empty language, Σ*, single char, empty alphabet) all green, and 4,000
      random patterns across 8 seeds = 0 failures** over **849,257 membership queries** and 12,611
      equivalence queries; RPNI recovered **1,921 / 2,032** targets exactly within the length cap
      (the rest need a larger characteristic sample — reported honestly, not hidden).
- [x] Two new examples (`(a|b)*abb` — the textbook learning target; `(aa)*` — parity, learned in one
      conjecture), header/footer/`project.json` copy updated to mention grammatical inference.

### Session 12 — counting the language: the rational generating function, growth rate & entropy (2026-06-21, claude)

The studio could already *enumerate* a language; this session *counts* it in closed form and reads off
how fast it grows. A regular language has a **rational generating function** `S(x) = Σ sₙxⁿ = P(x)/Q(x)`
(Chomsky–Schützenberger), and everything follows from the minimal DFA's **transfer matrix** `M`. New
engine `engine/census.ts` + a **Census** tab, all exact and triple-cross-checked.

- [x] **The transfer matrix & exact counts** — `M[i][j]` counts the alphabet symbols taking state `i` to
      `j`, so `sₙ = uᵀMⁿv` (start vector `u`, accept vector `v`). Counted two ways: **structural** (each
      atomic class is one letter — the combinatorial skeleton) and the true **Unicode** count (each class
      weighted by how many code points it holds), both in exact BigInt arithmetic.
- [x] **The closed-form generating function** — `Q(x) = det(I − xM)` computed from the **characteristic
      polynomial of `M` by the integer Faddeev–LeVerrier recursion** (whose `tr/k` divisions are exact),
      and the numerator `P(x)` from the first counts; the denominator's coefficients are exactly the
      **linear recurrence** the counts obey (Cayley–Hamilton). Rendered as a real fraction with the
      recurrence spelled out (e.g. `a*b*` → `1/(1−x)²`, n+1 words; `(a|b)*` → `1/(1−2x)`, 2ⁿ words).
- [x] **Growth rate, entropy & classification** — the exponential growth rate `λ = limₙ sₙ^(1/n)` is the
      **Perron root** of `M`, and `ln λ` is the language's **topological entropy**. The class
      (finite / polynomial / exponential) is decided **exactly** from the automaton's cycle structure
      (Tarjan SCCs: a component forces exponential growth iff a state lies on two distinct cycles, i.e. an
      irreducible block with a non-uniform row sum), and `λ` is computed per-(irreducible)-SCC block — the
      only reliable way, since (a) power iteration on the full *reducible* matrix can miss the global root,
      and (b) a plain max-norm ratio **oscillates on periodic blocks** (`[[0,2],[1,0]]` → 2,1,2,1…), so a
      **geometric-mean** of the per-step growth factors is used, giving `√2` there and exactly `1` for a
      pure cycle.
- [x] **The Census panel** (`components/CensusPanel.tsx`) — the growth verdict with λ and entropy, the
      generating function as a typeset fraction + the recurrence, the exact count table (structural and,
      when classes are non-singletons, the Unicode count), and the proof badges + a seeded cross-check.
- [x] **Verified three independent ways the house way** (`engine/census-verify.ts`) — for every pattern
      the GF's **power-series re-expansion** must reproduce the transfer-matrix counts, which must match a
      **brute-force enumeration**; and the structural growth class is cross-checked against the GF's
      **denominator** (a completely different route): finite ⟺ `Q` is constant, polynomial ⟹ `Q(1)=0`
      exactly (x=1 is a pole, λ=1), exponential ⟹ `λ>1` and `Q(1/λ)≈0` (the Perron root is a pole).
      Validated offline before shipping: **5,200 random patterns across 13 seeds = 0 failures** (plus all
      worked/edge cases: `a*` 1/(1−x), `a*b*` 1/(1−x)², `(a|b)*` λ=2/H=ln2, `(a|b|c)*` λ=3, `(aa)*`
      1/(1−x²), `.` finite total 1,114,111).
- [x] Two new examples (`a*b*` linear growth; `(a|b)*` entropy ln 2), header/footer/`project.json` copy
      updated to mention the generating function and growth.

### Session 13 — equivalence without determinising: bisimulation up to congruence + antichains (2026-06-23, claude)

Every comparison the studio could make went through a **determinised** machine: the Compare tab walks the
product of the two *minimal DFAs*, paying the subset construction (worst-case exponential) on both sides
before it can answer. This session adds the modern road that skips it — two independent decision procedures
that run straight on the ε-NFAs — and, in the studio's tradition, proves the new road agrees with the old one
over thousands of fuzzed pattern pairs. New `engine/coalgebra.ts` + `engine/antichain.ts` +
`engine/coalgebra-verify.ts`, and a **Coalgebra** tab.

- [x] **Bisimulation up to congruence — the HKC algorithm** (Bonchi & Pous, *Checking NFA equivalence with
      bisimulations up to congruence*, POPL 2013). Both ε-NFAs are embedded into one combined state space over a
      shared atomic alphabet, so the powerset transition is one function and subset union is plain integer-set
      union — exactly the paper's setting. Language equivalence `L(X₀)=L(Y₀)` is then a bisimulation search over
      the determinised powerset, explored **lazily** and pruned by an *up-to* closure. The one driver runs all
      three closures so the win is visible, not asserted: **naïve** Hopcroft–Karp (skip an identical pair),
      **up-to-equivalence** (union-find: skip a pair already in the equivalence closure of what's proved), and
      **up-to-congruence** (skip a pair whose two sides share a normal form under the set-rewriting `u ⊇ p ⟹
      u := u ∪ q` saturation — membership in the least congruence, i.e. equivalence *plus* closed under ∪).
- [x] **The determinisation bomb, collapsed.** On `(a|b)*(a(a|b){6}|b(a|b){6})` ≡ `(a|b)*(a|b){7}` the
      determinised product has **255** reachable pairs (the DFA is 2⁸ states) — and congruence proves the
      equivalence in **27**. The win **doubles with each extra repeat** (k=4→3.3×, 5→5.5×, 6→9.4×): congruence
      closure folds the union-of-cases the powerset blows apart. The panel shows it as a three-bar chart
      (pairs expanded vs discharged) with the live ratio, and the bisimulation `R` itself as a togglable table.
- [x] **Inclusion & universality by antichains** (De Wulf–Doyen–Henzinger–Raskin, *Antichains*, CAV 2006).
      `L(A) ⊆ L(B)` hunts for a word in `L(A)\L(B)` over macrostates `(q, S)` — one existential A-state, the
      determinised B-subset — under the order `(q,S) ⊑ (q,S') ⇔ S ⊆ S'` (smaller B-subset = more dangerous),
      keeping only the ⊑-minimal frontier. The 5-way relation (equal / ⊂ / ⊃ / disjoint / overlap) is inclusion
      both ways + an intersection-emptiness probe; **universality** `L = Σ*` (over the pattern's own alphabet) is
      inclusion of a synthesised Σ*. Each direction reports its antichain size against the full-product count it
      replaces, and a concrete counterexample word.
- [x] **Three roads, one verdict — and proven so.** `engine/coalgebra-verify.ts` draws thousands of random
      pattern *pairs* from a seeded PRNG and checks, from independent code paths: the three HKC modes agree with
      each other and with `compareDFAs`; the antichain road rebuilds the same 5-way relation as the DFA product;
      antichain universality matches a from-scratch DFA-reachability oracle; every reported witness really is a
      member of one language and not the other; and HKC never expands more pairs than naïve. Validated offline
      before shipping: **25,000 random pattern pairs across 10 seeds — zero mismatches**, with congruence beating
      naïve on every run (best ≈9× on the bombs, and strictly fewer expansions throughout). The "run" button in
      the tab reproduces it live.
- [x] New **Coalgebra** tab (`components/CoalgebraPanel.tsx`): pattern-B input + a preset gallery (the bomb, the
      two faces of Σ*, idempotence, a strict subset, a disjoint pair, a universal/witness case), the verdict card
      with the triple-agreement badge, the three-mode bar chart, the bisimulation `R` table, the witness grid,
      the per-direction antichain inclusion stats, and the universality badges — plus the seeded cross-check.
- [x] **The HKC worklist, stepped.** `traceEquivalence` records every pair popped from the worklist — expanded
      into `R`, **discharged by the congruence closure**, or a **split** (acceptance disagrees ⇒ the witness) — and
      the panel animates it: a tick strip coloured by action, a scrubber + prev/next, and a per-step card showing
      the prefix word, the pair `(X, Y)`, each side's acceptance, and the running "in R / discharged" tally. On the
      bomb it tells the whole story at a glance — **27 pairs expanded, 20 discharged for free** — the discharges
      being exactly what the determinised product would have built in full. (Recording is opt-in, so the fuzzer's
      hot path is untouched.)
- [x] Header/footer prose updated to name the new road; `project.json` tags + description updated.

### Still open

- [ ] **Highlight the firing congruence rule** in the stepper — when a pair is discharged, show *which* earlier
      pairs' `U → U∪V` rewrites fold its two sides to a common normal form.
- [ ] **Antichain frontier on the NFA diagram** — light the macrostates `(q, S)` of the live inclusion search and
      show the ⊑-subsumption that prunes a node, edge for edge.
- [ ] **HKC vs DFA-product, side by side** — a head-to-head counter (pairs explored / states built / wall-clock)
      on the same pair, so the determinisation cost the coalgebra road avoids is a number on screen.
- [ ] **`L(A) ⊆ L(B)` via the congruence road too** (the "up-to-congruence for inclusion" preorder) to put both
      decision problems on the same coalgebraic footing.
- [ ] **Star-free expression synthesis** — when `M(L)` is aperiodic, actually *build* a star-free expression (e.g. via
      the Krohn–Rhodes / counter-free decomposition or an FO[<]/LTL translation) instead of only certifying one exists
- [ ] **dot-depth / Straubing–Thérien** hierarchy badges above `J`-trivial (the concatenation hierarchy levels)
- [x] **Group-language structure** — name the syntactic group *and* show the permutation automaton with each
      generator's cycle structure *(Session 9: ℤ/n, the abelian invariant-factor product incl. Klein four, Dₙ, Q₈,
      A₄/S₄, named off the Cayley table; the group card lists every generator as a permutation in cycle notation with
      its order — e.g. even-`a`-even-`b` shows a=(0 1)(2 3), b=(0 2)(1 3): two commuting involutions = ℤ/2×ℤ/2)*
- [ ] Polynomial detection via the cubed automaton N³ (exact IDA witness) to complement the
      measurement-based degree fit
- [ ] Visualise the ambiguous pivot loop on the NFA diagram (highlight the two distinct pump paths)
- [ ] Single-step the Pike VM bytecode (animate the thread list) like the NFA/DFA debugger
- [x] Animate the derivative-DFA walk on the test text (light the active state per character) *(Session 7 — in the Extended panel: a scrubber walks the Boolean-derivative DFA, lighting the active state on the graph and the matching residual in the chain in lockstep; click any chain step to jump)*
- [x] "Harden this regex" suggestions (atomic groups / possessive quantifiers) for flagged patterns *(Session 6)*
- [ ] Worker-offload the fuzzer / large-pattern compilation so the UI never blocks
- [x] Antimirov *partial* derivatives → a derivative-built NFA (a sibling to the derivative DFA) *(Session 5)*
- [x] Glushkov's position automaton → a fourth road to the canonical DFA (ε-free, exactly m+1 states) *(Session 6)*
- [x] **Unicode property escapes `\p{…}` / `\P{…}`** *(Session 10: resolved **live from the host Unicode database** —
      no bundled tables. For a spec like `L`, `Lu`, `Script=Greek` or `White_Space` we build the native `/\p{…}/u`,
      scan the whole code-point space [U+0000, U+10FFFF] and coalesce the matches into the studio's own range `CharSet`,
      so every road — Thompson, Glushkov, derivatives, the syntactic monoid — speaks Unicode for free. Correct by
      construction and re-confirmed by a **differential self-check** vs the native engine over thousands of sampled
      points (incl. every range boundary). Also landed the code-point escapes `\xHH`, `\uHHHH`, `\u{H…}`, a new
      **Unicode** inspector tab (ranges · code-point count · % of Unicode · glyph strip · the live agreement badge) and
      five worked examples. The whole feature is host-derived, so it tracks whatever Unicode version the browser ships.)*

#### Next steps for Unicode (planned)
- [ ] Property **aliases & loose-matching cheatsheet** in the inspector (gc=Lu ≡ Uppercase_Letter ≡ Lu), surfaced from the host
- [ ] `\p{Script_Extensions=…}` vs `\p{Script=…}` side-by-side (the scx multi-script subtlety)
- [ ] POSIX class shims `[[:alpha:]]`→`\p{Alpha}` in the class parser
- [ ] A **case-folding** view: render `\p{Lu}` beside its simple-case-fold image so equivalence under `i` is visible
- [x] Wire a handful of `\p`-bearing patterns into the differential **fuzzer**'s random generator (oracle stays `/u`)
      *(Session 10: `genAtom` now emits `\p{L}` / `\p{Lu}` / `\p{Ll}` / `\p{N}` / `\p{P}` / `\P{L}` and `genInput` mixes in
      non-ASCII probes (É, é, Σ, π, ·, !, …) so the classes get true *and* false coverage — 120 000 checks across five
      seeds, all ten engines + the `/u` oracle agreed, zero disagreements)*
- [ ] Brzozowski-vs-Antimirov side-by-side: align the two chains so you can watch one residual fork into a set
- [ ] Glushkov-vs-Antimirov: align the position automaton with its quotient (the equation automaton), edge for edge
- [ ] Animate the equation-automaton / position-automaton walk on the test text (light the live state set per character)
- [x] Hopcroft O(n log n) minimisation as a second road to the minimal DFA (compare against Moore) *(Session 5)*

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
- 2026-06-20 (claude, session 5): added the **fifth engine** — **Antimirov partial derivatives** — and a
  **third independent road** from regex to automaton. New `engine/antimirov.ts`: the `linearForm` of head-class
  → continuation monomials gives the partial derivative `∂c(r)` (a *set*, vs Brzozowski's single residual), a
  streaming partial-derivative matcher (a direct BFS NFA simulation), and the **equation automaton** —
  states are partial-derivative terms, ε-free and provably linear-size (≤ #char-classes + 1), typically far
  smaller than Thompson's ε-NFA (`(a|b|c)*` collapses to **one** state vs Thompson's ten + ten ε-edges).
  Lowering the PNFA into the existing `NFA` shape lets the unchanged subset construction + Moore pass
  determinise it to the **same canonical minimal DFA** the other two roads reach (verified equal via
  `compareDFAs` on 17 patterns). New **Antimirov panel** (equation-automaton graph, Thompson-vs-equation size
  scoreboard with "≡ canonical ✓", and a live *set-of-residuals* chain). The **differential fuzzer now
  cross-checks eight engines** (added the partial-derivative matcher + Antimirov DFA): **153,600 checks across
  8 seeds, zero disagreements**. Also added **Hopcroft O(n·log n) minimisation** (`engine/hopcroft.ts`) as a
  second, independent road to the minimal DFA: the Min-DFA tab now shows a live "Moore ≡ Hopcroft ✓" badge,
  verified identical to the Moore pass (same #states + language-equal) across 4,024 patterns. Two new
  examples + updated header/footer/Fuzz copy. Gate green: scope + conformance + lint + build all pass.
- 2026-06-20 (claude, session 6): added the **fourth road** — **Glushkov's position automaton** — and a
  **sixth matching engine**. New `engine/glushkov.ts`: linearise the AST so each letter occurrence is a
  **position** `1…m`, then read `nullable`/`first`/`last`/`follow` off the tree to build an **ε-free NFA with
  exactly m+1 states** (the textbook `(a|b)*abb` → 5 letters → 6 states). It is the missing *middle* of the
  size story — Thompson (ε-laden) → **Glushkov (ε-free, m+1)** → Antimirov (a quotient of Glushkov). A
  streaming position-automaton simulator is the sixth engine; lowering the automaton into the existing `NFA`
  shape lets the unchanged subset+Moore pipeline determinise it to the **same canonical minimal DFA** the other
  three roads reach (verified via `compareDFAs`). The construction is also **homogeneous** (every in-edge to a
  state shares its label — verified). New **Glushkov panel** (position-automaton graph, Thompson→Glushkov→
  Antimirov size scoreboard with "≡ canonical ✓" + "homogeneous ✓", live **first/last/follow tables**, and a
  position-set chain on the test text). The **differential fuzzer now cross-checks ten engines** (added the
  Glushkov DFA + streaming position automaton): **153,600 checks across 8 seeds, zero disagreements** (plus a
  standalone Glushkov cross-check of 192,000 checks — always canonical, always homogeneous, never larger than
  Thompson). Also shipped **"Harden this regex"**: when the ReDoS analyser proves super-linear backtracking it
  now prescribes the canonical mitigations (atomic/possessive groups · a DFA-based engine · bound/disambiguate),
  anchored to the loop it found, without auto-rewriting the pattern (a silent language change would be worse than
  the ReDoS). Two new examples + header/footer/Fuzz copy updated to "four ways · six engines · ten cross-checked".
  Gate green: scope + conformance + lint + build all pass.
- 2026-06-21 (claude, session 7): added a **fifth road** that leaves the core algebra behind for the entire
  **Boolean closure** of the regular languages — intersection `A&B`, complement `~A`, and difference `A−B`. No
  ε-NFA can express these (there is no Thompson/Glushkov/Antimirov fragment for `&` or `~`), but **Brzozowski
  derivatives extend to them for free** — `∂c(A&B)=∂cA&∂cB`, `∂c(~A)=~∂cA`, `nullable(A&B)=∧`, `nullable(~A)=¬` —
  so the derivative method is the *one* road that builds an intersection or a complement directly. New
  `engine/ereg.ts`: a self-contained extended algebra `EReg` (the core `DReg` plus `and`/`not`) with similarity
  smart constructors (`&` associative-commutative-idempotent with `∅` annihilator and `Σ*=~∅` identity; `~` an
  involution), and `buildEregDFA` that BFS-walks the Boolean derivatives into the studio's own `DFA` shape, so it
  flows unchanged into the graph / minimise / Language views. The subtle part is the **complete alphabet**: `∂c(~A)`
  stays alive on characters `A` never mentions, so when a `~` is present the DFA partitions *all* of Σ (covered
  **and** uncovered) — that "Σ∖…" edge is what makes `~A` accept the symbols `A` never names; without a `~` it
  behaves exactly as the plain derivative DFA, so a regular pattern still minimises to the very same canonical
  machine. An opt-in `parseExtended` adds one precedence layer (`|` < `& −` < concat < `~` < postfix) reusing
  100% of the existing atom/class/escape parsing, so the **classic pipeline and its ten-engine fuzzer are
  byte-for-byte untouched** (`& ~ −` stay literals there). Verified the house way, three ways: (1) live
  **algebraic-law badges** — involution `~~A≡A`, idempotence `A&A≡A`, excluded middle `A∪~A≡Σ*`, non-contradiction
  `A∩~A≡∅` — each decided by `compareDFAs`; (2) a **classical cross-check** (`engine/booldfa.ts`) that rebuilds the
  same language with the studio's *existing* automata — product-automaton `∩` and a complete-then-flip complement —
  via a recursive `tryClassicalDFA`, proving `derivativeDFA(A&B) ≡ product(DFA A, DFA B)` and
  `derivativeDFA(~A) ≡ complement(DFA A)` (the brand-new Boolean engine equals the classic Thompson→subset→Moore
  pipeline); and (3) an **independent span oracle** `ends` — membership defined straight from the algebra
  (`ends(A&B)=∩`, `ends(~A,i)={j : j∉ends(A,i)}`, no derivatives) — cross-checked against the streaming derivative
  and the DFA by a seeded **three-engine differential fuzzer**: **480,000 checks across 8 seeds × 1,500 random
  Boolean expressions × 40 strings, zero disagreements**; an in-app run does ~22k checks in <100 ms. Validated
  offline before shipping: 40/40 hand-written assertions, all showcase examples pass all five proof badges, and
  the even-`a`-even-`b` pattern is exhaustively correct over all 511 strings of length ≤8 (its minimal DFA is the
  textbook 4-state product). New **Extended &~ panel** (own input + 7 curated examples — the password lookahead
  re-expressed as a *true regular intersection* `.*[0-9].*&.*[a-z].*&.{6,}` that now has a finite DFA, `~(.*abc.*)`,
  identifiers−keywords, even-even, "ab but not ba", ÷6 — the DFA graph with DOT/SVG export, the live
  Boolean-derivative chain, language stats, the proof badges, and a "run cross-check" button). Header/footer/
  `project.json` updated to "five roads · Boolean closure". Gate green: scope + conformance + lint + build all pass.
- 2026-06-21 (claude, session 8): opened a whole new **dimension** — the *algebra* of the language. Every prior road
  ends at an automaton; this one builds the language's **syntactic monoid** `M(L)` from scratch (`engine/monoid.ts`):
  re-complete the minimal DFA with its dead sink, then BFS-close the per-atom state-transformations under composition —
  the transition monoid of a minimal complete DFA *is* the syntactic monoid (classical theorem), so this is the genuine
  invariant. From it: the Cayley table, the idempotents, the two-sided zero, and the five **Green's relations** R/L/J/H/D
  rendered as the classic **egg-box diagram** (D-classes as R×L grids, group H-classes flagged with their order). The
  headline is **Schützenberger's theorem** — *aperiodic ⇔ star-free ⇔ first-order (FO[<]) definable ⇔ counter-free* —
  decided **three independent ways** (every H-class a singleton · every element group-free `mⁿ=mⁿ⁺¹` · the DFA
  counter-free) and shown agreeing live; plus **Simon's** J-trivial ⇔ piecewise-testable, R/L-trivial, commutative,
  band, group-language, and the **counting modulus**. New **Algebra** tab (`components/MonoidPanel.tsx`): the star-free
  verdict with its counter witness, the three-way cross-check pills, a monoid summary, the variety badges, the egg-box,
  a colour-by-D-class Cayley table, and a seeded "run cross-check" fuzz console (`engine/monoid-verify.ts`). So `(aa)*`
  is exposed as the group **ℤ/2** — *not* star-free, a real mod-2 counter — while `a*b*` is proved star-free and
  piecewise-testable, and `(ab)*` is the surprise: a Kleene star that needs none (aperiodic, FO-definable). Validated
  offline before shipping with a headless harness — curated known-answer cases plus 4,000 random patterns ×
  8 structural invariants = **32,021 assertions, zero failures** (the three aperiodicity tests always agreed, `H=R∩L`,
  full egg-boxes, J-trivial ⇒ aperiodic). Four new examples + header/footer/`project.json` copy updated. Gate green:
  scope + conformance + lint + build all pass.
- 2026-06-21 (claude, session 9): turned the one-bit "aperiodic?" verdict into a full **variety ladder** and made the
  abstract monoid *tangible*. New `engine/variety.ts`. (1) **DA / FO²[<] membership** — decided by the clean
  structural theorem *M ∈ DA ⇔ every regular element is idempotent* (Schützenberger–Pin–Tesson–Thérien), which alone
  forces aperiodicity, so it slots exactly between piecewise-testable and star-free; it returns a genuine regular,
  non-idempotent **witness** when it fails. DA is the languages of two-variable first-order logic `FO²[<]` =
  unambiguous polynomials `A₀*a₁A₁*…aₖAₖ*` = `Σ₂ ∩ Π₂`. (2) **The syntactic group, NAMED** — the counting modulus
  finally gets a name: the structure group of `M(L)` (the whole monoid when it's a group, else the group `H`-class of
  the top counting `D`-class) is identified up to isomorphism straight from the Cayley table — cyclic `ℤ/n`, the full
  abelian **invariant-factor decomposition** `ℤ/d₁×…×ℤ/dₖ` (incl. the Klein four) recovered from the element-order
  spectrum by per-prime **primary decomposition**, dihedral `Dₙ` (incl. `S₃≅D₃`) via a structural rotation/reflection
  probe, quaternion `Q₈`, `A₄`/`S₄` by signature, and a safe "non-abelian order n" fallback. (3) **The variety
  ladder** places `L` on the nested lattice trivial ⊂ piecewise-testable (`J`-trivial, Simon, `BΣ₁[<]`) ⊂ `DA`
  (`FO²[<]`) ⊂ star-free (aperiodic, `FO[<]`, Schützenberger / McNaughton–Papert, counter-free, LTL) ⊂ all-regular,
  each level carrying its theorem and a one-line operational/logical reading, with the *tightest* class computed. (4)
  **The egg-box↔DFA bridge** — click any egg-box cell or Cayley entry to light the **state-map** `s ↦ δ(s,w)` that
  element induces on the complete minimal DFA: fixed points, the image (rank) and any non-trivial **cycle** (a cycle
  > 1 is exactly the counter a group element does and an aperiodic one can't), so "an element *is* a transformation"
  stops being abstract. New `MonoidPanel` UI: the nested ladder (replacing the flat badge row), the named-group card
  with its order spectrum and — for group languages — every generator drawn as a **permutation** in cycle notation
  with its order (the permutation automaton made legible, e.g. even-`a`-even-`b` → a=(0 1)(2 3), b=(0 2)(1 3)), and
  the interactive state-map explorer. Verified the house way — `monoid-verify.ts` gained
  the ladder's own invariants (`J`-trivial ⇒ `DA` ⇒ aperiodic; every `DA` failure exhibits a real regular
  non-idempotent witness; each named group's order = the counting modulus and, abelian, its invariant factors
  multiply to the order, form a divisibility chain and reproduce the exponent). Validated offline before shipping with
  the headless harness: group identification matched hand-built `ℤ/n`, Klein four, `ℤ/2×ℤ/4`, `S₃≅D₃` and `Q₈` Cayley
  tables, and **491,891 invariant checks over 48,000 random patterns produced zero disagreements**. So `a(a|b)*` now
  lands exactly in DA (FO², not piecewise), even-`a`-even-`b` is named the **Klein four-group ℤ/2×ℤ/2**, `(aa)*∣(aaa)*`
  is the cyclic **ℤ/6**, and `(ab)*` is the new surprise — star-free yet *not* in DA (its regular element `a=aba`
  isn't idempotent). Four new examples + header/footer/`project.json` copy updated. Gate green: scope + conformance +
  lint + build all pass.
- 2026-06-21 (claude, session 10): the studio now **speaks Unicode**. Added the property escapes `\p{…}` / `\P{…}`
  and the code-point escapes `\xHH`, `\uHHHH`, `\u{H…}` — and did it without bundling a single byte of Unicode tables.
  New `engine/unicode.ts` resolves a property spec (`L`, `Lu`, `Ll`, `N`, `P`, `Emoji`, `White_Space`, `Zs`,
  `Script=Greek`, `Script=Han`, `ASCII`, … — anything the host accepts) by building the **native** `/\p{…}/u`, scanning
  the entire code-point space [U+0000, U+10FFFF] (lone surrogates skipped) and coalescing the matching scalars into the
  studio's own merged-range `CharSet`. Because the whole engine is built on `CharSet`, **every road inherits Unicode for
  free** — Thompson, subset/Min-DFA, Brzozowski & Antimirov derivatives, Glushkov, the Pike/backtracking VMs and even the
  syntactic-monoid algebra now classify `\p{L}+` and friends with no per-road change. The parser gained `\p`/`\P` (outside
  *and* inside `[...]` classes), lenient hex escapes, helpful errors for an unknown property or a missing `{`, and a
  `registerNamedClass` hook so a 684-range class still renders on graph edges as the compact `\p{L}` the user typed. New
  **Unicode** inspector tab: pick any property (used-in-pattern ones flagged), see its range count, code-point total,
  share of Unicode, a live glyph strip, the first ranges in `U+XXXX–U+XXXX` form, and — house style — a **differential
  self-check badge** that re-confirms our coalesced set against the native engine over thousands of sampled points
  (every range boundary included). Validated offline with the headless Vite harness: all ten showcased properties agree
  with `/\p{…}/u` byte-for-byte (e.g. `\p{L}` = 684 ranges, scanned in ~100 ms, cached), end-to-end DFA membership
  matches native `/u` across Latin/Greek/Han/emoji/negation. Then **taught the fuzzer Unicode**: `genAtom` now also
  emits `\p{…}` / `\P{…}` atoms and `genInput` mixes in non-ASCII probes (É, é, Σ, π, ·, !, space) so the classes get
  both true and false coverage — and it **stayed green over 120 000 checks across five seeds (1 200 patterns × 20
  strings each), all ten engines plus the `/u` oracle agreeing, zero disagreements**, so `\p` is now continuously
  cross-checked, not just in a one-off harness. Five new examples (`\p{L}+`, title-case, `Script=Greek`, a
  no-punctuation class, an astral `\u{1F600}`). Gate green: scope + conformance + lint + build all pass.
- 2026-06-21 (claude, session 11): opened the **opposite direction** to every prior session — instead of
  compiling a regex *down* to an automaton, **learn the automaton back** from queries (grammatical inference).
  Two algorithms, from scratch. **Angluin's L\*** (`engine/learn.ts`): active learning from a minimally
  adequate teacher — membership queries are a walk over the target's minimal DFA, equivalence queries reuse the
  Compare tab's `compareDFAs` product automaton (which already returns the shortest counterexample) — driving an
  **observation table** (`S` × `E` → {0,1}) to closed + consistent, conjecturing a DFA off the distinct rows,
  and folding each counterexample's prefixes into `S`. The payoff is the Myhill–Nerode theorem made operational:
  at termination each distinct row is a residual language, so the hypothesis **is** the minimal DFA — proven the
  house way by `minimizeDFA(learned)` landing byte-for-byte on the studio's own canonical machine, with the
  membership/equivalence query counts reported. **RPNI** (`engine/rpni.ts`): passive learning (Oncina–García) —
  no questions, just a labelled sample; build the prefix-tree acceptor, greedily merge states lowest-first
  (accepting a merge iff its determinising union–find fold makes no negative example accepted, rolling back the
  rest), and — since a complete sample up to a sufficient length is characteristic — grow the depth until it
  recovers the exact target. New **Learn tab** (`components/LearnPanel.tsx`): the reconstructed DFA as a graph
  (showing the explicit reject sink the minimiser drops), the live observation table (`+`/`−`, `S` over the
  boundary `S·Σ`), the conjecture-and-counterexample trace, the RPNI sample stats, and a seeded cross-check
  console. Verified offline before shipping (`engine/learn-verify.ts`): 10 worked cases + edge cases (empty
  language, Σ*, single char, empty alphabet) all green, and **4,000 random patterns across 8 seeds = 0 failures**
  over **849,257 membership queries** and 12,611 equivalence queries — every L\* result language-equivalent AND
  state-for-state minimal; RPNI recovered **1,921 / 2,032** targets exactly within the length cap (the remainder
  need a larger characteristic sample, reported honestly). Two new examples + header/footer/`project.json`
  updated. Gate green: scope + conformance + lint + build all pass.
- 2026-06-21 (claude, session 12): the studio now **counts** the language in closed form. New
  `engine/census.ts` builds the minimal DFA's **transfer matrix** `M` and reads off the enumerative
  combinatorics: exact word counts `sₙ = uᵀMⁿv` (structural — atoms as letters — and the true Unicode
  count, both BigInt), the **rational generating function** `S(x)=P(x)/Q(x)` with `Q(x)=det(I−xM)`
  computed from the **characteristic polynomial via the integer Faddeev–LeVerrier recursion** (numerator
  from the first counts; the denominator's coefficients are the Cayley–Hamilton recurrence the counts
  obey), and the **growth rate** `λ = limₙ sₙ^(1/n)` (the Perron root) with **topological entropy** `ln λ`.
  The finite/polynomial/exponential class is decided **exactly** from the cycle structure (Tarjan SCCs: a
  component is exponential iff a state lies on two distinct cycles), and `λ` is computed per-irreducible-SCC
  block with a **geometric-mean** power iteration — necessary because power iteration on the full reducible
  matrix can miss the global root and a max-norm ratio oscillates on periodic blocks (`[[0,2],[1,0]]` →
  2,1,2,1…, geo-mean → √2; a pure cycle → exactly 1). New **Census** tab (`components/CensusPanel.tsx`): the
  growth verdict + λ + entropy, the generating function typeset as a fraction with its recurrence, the exact
  count table, and proof badges + a seeded cross-check. Verified three independent ways
  (`engine/census-verify.ts`): the GF's power-series re-expansion ≡ the transfer-matrix counts ≡ a
  brute-force enumeration, and the growth class cross-checked against the GF's denominator (finite ⟺ Q
  constant; polynomial ⟹ Q(1)=0 exactly; exponential ⟹ λ>1 and Q(1/λ)≈0). Validated offline before
  shipping: **5,200 random patterns across 13 seeds, zero failures** (e.g. `a*b*` → 1/(1−x)², `(a|b)*` →
  1/(1−2x) with λ=2, H=ln2; `.` finite, total 1,114,111). Two new examples + header/footer/`project.json`
  updated. Gate green: scope + conformance + lint + build all pass.
- 2026-06-23 (claude, session 13): the studio can now decide equivalence & inclusion **without
  determinising**. New `engine/coalgebra.ts` embeds both ε-NFAs into one combined powerset (the
  Bonchi–Pous setting) and decides language equivalence by **bisimulation up to congruence** (HKC,
  POPL 2013); one driver runs all three up-to closures — naïve Hopcroft–Karp, up-to-equivalence
  (union-find), up-to-**congruence** (set-rewriting normal forms) — so the pay-off is shown, not
  asserted: on `(a|b)*(a(a|b){6}|b(a|b){6})` ≡ `(a|b)*(a|b){7}` the determinised product has **255**
  reachable pairs and congruence needs **27** (≈9×, doubling per extra repeat). New
  `engine/antichain.ts` decides inclusion & universality by **antichains** (De Wulf et al., CAV 2006)
  over ⊑-minimal macrostates `(q, S)`, giving the full 5-way relation + counterexample words + the
  antichain size against the full product it replaces. New **Coalgebra** tab
  (`components/CoalgebraPanel.tsx`): preset gallery, a triple-agreement verdict (HKC · antichains ·
  DFA-product), the three-mode bar chart, the bisimulation `R` table, witnesses, per-direction
  inclusion stats, universality badges, a **step-through** of the HKC worklist (a tick strip + scrubber that
  shows each pair expanded into R, discharged by the congruence closure, or split into the witness — 27 expanded /
  20 discharged on the bomb), and a seeded cross-check button. Verified offline before
  shipping (`engine/coalgebra-verify.ts`): **25,000 random pattern pairs across 10 seeds, zero
  mismatches** — the three HKC modes agree with each other and with `compareDFAs`, the antichain road
  rebuilds the same relation, universality matches a DFA oracle, every witness genuinely separates the
  languages, and HKC never expands more pairs than naïve. Header/footer/`project.json` updated. Gate
  green: scope + conformance + lint + build all pass.

### Session 14 plan — the converse of the whole studio: Logic ⇒ Automaton (Büchi–Elgot–Trakhtenbrot) (2026-06-23, claude)

Every prior road runs **one** direction — a *regex* (or a query, or a sample) is compiled *down* to an
automaton, and sessions 8–9 then *classify* the resulting language by which **logic** can define it
(`FO[<]`, `FO²`, `MSO`). But the studio never let you go the other way: **write a logic formula and build the
automaton it denotes.** That converse is one of the deepest theorems in the field —

> **Büchi–Elgot–Trakhtenbrot (1960):** a language is regular **iff** it is definable by a sentence of
> **monadic second-order logic** `MSO[<]` over word positions.

and it nests exactly onto the variety ladder this studio already computes:

```
LTLf  ⊆  FO[<]      ⊊      MSO[<]   =   regular
 │        │ (Kamp)         │ (Büchi)     │ (Kleene)
 └─ temporal              star-free    all of the studio
    operators            (sess. 8–9)
```

McNaughton–Papert says `FO[<]` is exactly the **star-free** languages — so a formula with *no second-order
quantifier* must compile to a language the **existing monoid engine** independently certifies star-free, and
one that *needs* a set quantifier (e.g. "even length") must come back **not** star-free. That makes this
session self-verifying against machinery already in the repo: the compiler asserts `FO ⇒ star-free` by asking
session 9's `varietyLadder`, not by trusting itself.

New `engine/logic/` package (kept self-contained, lowered into the studio's own `DFA` so it flows into the
graph / Min-DFA / Language / Census / Algebra views unchanged), plus a new **Logic** tab.

- [ ] **Formula AST + parser** (`logic/ast.ts`, `logic/parser.ts`) — first-order variables `x,y,…` and
      second-order (set) variables `X,Y,…`; atoms `Qa(x)` (position `x` carries letter `a`), order `x<y`,
      `x<=y`, `x=y`, successor `S(x,y)`, membership `x in X`, constants `true/false`; connectives
      `~ & | -> <->`; quantifiers `exists x`, `forall x`, `exists X`, `forall X` (and the Unicode spellings
      `∃ ∀ ¬ ∧ ∨ → ↔ ∈ ≤`). Friendly parse errors with an index, house style. Free-variable analysis +
      an `isFirstOrder` predicate (no second-order quantifier anywhere).
- [ ] **The bit-automaton** (`logic/bitaut.ts`) — a DFA/NFA over the **product alphabet** `Σ × {0,1}^V`:
      one *track* per free variable, a symbol is a letter plus one bit per track (does this position equal
      the FO variable / lie in the SO set). Operations: `lift` (cylindrify onto more tracks), `product`
      (`∧`/`∨`), `complement` (within the **validity** language — every FO track a singleton), `project`
      (drop a track → NFA → subset-determinize), Moore `minimize`, reachable-trim, emptiness witness.
- [ ] **The inductive Büchi compiler** (`logic/compile.ts`) — structural recursion building one
      bit-automaton per subformula over its own free tracks: tiny hand-built atomic automata (each FO atom
      enforcing its variables are singletons), `∧`→product, `∨`→union, `¬`→complement-within-validity,
      `∃x`→project+determinize, `∀x ≡ ¬∃x¬`, second-order `∃X`/`∀X` the same but with no singleton
      constraint. Per-node automaton sizes are recorded so the panel can **show the non-elementary blow-up**.
      State/track caps with a friendly "this formula blew up to N states" instead of a hang — itself a lesson.
- [ ] **Lowering + the variety bridge** — a *sentence* (no free tracks) leaves an automaton over just `Σ`;
      lower it to the studio `DFA`, `minimizeDFA`, and run it through session 9's
      `buildSyntacticMonoid → greenRelations → varietyLadder`. Assert **`FO ⇒ star-free`** live (a green
      badge when the formula is first-order and the ladder agrees), and surface the actual variety verdict
      for MSO formulas so `FO ⊊ MSO` is *shown* (even-length comes back the group `ℤ/2`, not star-free).
- [ ] **The brute-force oracle** (`logic/semantics.ts`) — a direct Tarski-style evaluator: interpret the
      quantifiers literally over positions (FO) and position-*subsets* (SO, `2^n`) of a concrete word. The
      independent ground truth the compiled DFA is differentially checked against.
- [ ] **LTLf mode** (Kamp's theorem for free) — parse **linear temporal logic on finite traces**
      (`X F G`, `U`, `R`, boolean connectives, atomic prop = a letter) and **desugar to `FO[<]`** with one
      free "now" variable (`⟦Xφ⟧(x)=∃y.S(x,y)∧⟦φ⟧(y)`, `⟦φUψ⟧(x)=∃y.x≤y∧⟦ψ⟧(y)∧∀z.(x≤z<y→⟦φ⟧(z))`, …),
      closed at the first position. Reuses the whole FO pipeline, so an LTL formula compiles to a DFA and
      lands in **star-free** automatically — Kamp's theorem (`LTL = FO`) made operational.
- [ ] **The Logic panel** (`components/LogicPanel.tsx`) — MSO/LTLf mode toggle, a configurable alphabet,
      formula input + a curated gallery (contains-`a`, "every `a` is immediately followed by `b`",
      even-length, "the `b`'s are exactly the even positions", a∗b∗, parity), the compiled DFA as a pan/zoom
      graph with DOT/SVG export, the **variety verdict** with the `FO ⇒ star-free` badge, language stats
      (count + growth, reusing Census), a **truth table** over short words (oracle ✓ vs DFA, agreement
      badge), the per-subformula **size trace** (the blow-up), and a seeded **cross-check** console.
- [ ] **The proof console** (`logic/verify.ts`) — a seeded fuzzer drawing random FO + MSO sentences over a
      small alphabet: compile → DFA, brute-force the oracle over **all** words up to length `L`, and assert
      the DFA accepts *exactly* the true words; assert `∀x.φ ≡ ¬∃x¬φ` (build both, compare DFAs); assert
      every FO sentence's language is star-free and every sentence's language is regular. Reproducible by
      seed, zero mismatches the bar — drives the panel's "run cross-check" button.
- [ ] Wire the tab into `App.tsx`, refresh the header/footer/`project.json` copy to "compile logic to
      automata — Büchi–Elgot–Trakhtenbrot", add the Logic examples, and re-run the gate to green.

### Session 14 — Logic ⇒ Automaton: the Büchi–Elgot–Trakhtenbrot construction (2026-06-23, claude)

Shipped the converse of the entire studio — a from-scratch compiler from **logic to automata**, closing the
loop with the variety ladder sessions 8–9 built. New `engine/logic/` package + a new **Logic** tab.

- [x] **Formula AST + parser** (`logic/ast.ts`, `logic/parser.ts`) — MSO[<] with FO position variables
      (lowercase) and SO set variables (uppercase); atoms `Qa(x)`, `x<y`/`x<=y`/`x=y`, successor `S(x,y)`,
      membership `x in X`, `true`/`false`; connectives `~ & | -> <->`; quantifiers `exists/forall` (the
      variable's case picks first- vs second-order), with Unicode spellings (`∃ ∀ ¬ ∧ ∨ → ↔ ∈ ≤`). Friendly
      index-tagged parse errors, free-variable analysis, and an `isFirstOrder` predicate.
- [x] **The bit-automaton** (`logic/bitaut.ts`) — a DFA/NFA over the product alphabet `Σ × {0,1}^V`, one
      *track* per free variable. `lift` (cylindrify), `product` (∧/∨), `complement` (within the validity
      language — every FO track a singleton), `projectToNFA` + `determinize`, Moore `minimize`,
      `reachableTrim`, `witness`/`isEmpty`, `languageEqual`. State/track caps with a `LogicError` instead of
      a hang (the non-elementary cost, surfaced as a lesson).
- [x] **The inductive Büchi compiler** (`logic/compile.ts`) — tiny hand-built atomic automata (each FO atom
      enforcing its variables are singletons), `∧`→product, `∨`→union, `¬`→complement-within-validity,
      `∃x`→project + re-determinise, `∀ ≡ ¬∃¬`, second-order `∃X`/`∀X` the same with no singleton constraint.
      Maintains the invariant "accepts exactly the valid (all-FO-singleton) encodings satisfying the formula",
      minimises at every node, and records a **per-step size trace** (with the determinisation blow-up).
- [x] **Lowering + the variety bridge** (`logic/lower.ts`, `logic/index.ts`) — a *sentence* leaves an
      automaton over just Σ; lowered into the studio `DFA`, minimised, and run through session 9's
      `buildSyntacticMonoid → greenRelations → varietyLadder`. The panel asserts **FO ⇒ star-free** live
      (McNaughton–Papert), and for MSO formulas surfaces the real verdict — **even length** comes back the
      group **ℤ/2**, not star-free, so `FO ⊊ MSO` is *shown*. Free-variable formulas render the bit-automaton
      directly (each edge labelled with its letter + per-track bit pattern, `x̄` = bit off).
- [x] **The brute-force oracle** (`logic/semantics.ts`) — a direct Tarski evaluator: quantifiers interpreted
      literally over positions (FO) and the `2^n` position-subsets (SO) of a concrete word. The independent
      ground truth.
- [x] **LTLf mode** (`logic/ltlf.ts`) — linear temporal logic on finite traces (`X F G`, `U`, `R`, boolean
      connectives, atomic prop = a letter), parsed and **desugared to FO[<]** with one "now" variable (Kamp's
      theorem), closed at the first position. Reuses the whole FO pipeline, so an LTL spec compiles to a DFA
      and lands star-free automatically — `LTL = FO ⊆ star-free`, operational.
- [x] **The Logic panel** (`components/LogicPanel.tsx`) — MSO/LTLf mode toggle, configurable alphabet,
      formula input + curated galleries, the compiled DFA as a pan/zoom graph with DOT/SVG export, the variety
      verdict with the FO⇒star-free badge, language stats (Census/Language reused), a **truth table** (oracle
      vs automaton over short words, agreement badge), the per-subformula **size trace** (the blow-up made
      visible), and a seeded **cross-check** console.
- [x] **The proof console** (`logic/verify.ts`) — a seeded fuzzer drawing random FO + MSO sentences:
      compile → DFA, brute-force the oracle over every word up to length L, assert the DFA accepts exactly the
      true words; assert the `∀ ≡ ¬∃¬` duality (a negation-normal-form recompile lands on the same language);
      assert every FO sentence's language is star-free and every sentence's language is regular.
- [x] Wired the Logic tab into `App.tsx` (persisted source + mode), refreshed header/footer/`project.json`
      copy, added the Logic CSS, and re-ran the gate to green.

Validated offline before shipping with the esbuild headless harness: **55/55 known-answer cases** (contains-a,
"every a immediately followed by b", a∗b∗, first-letter-a, even-length-is-ℤ/2-and-not-star-free, the LTLf
suite incl. release and strong-next semantics), and the fuzzer at **665,520 checks across 22 seeds — random FO
and MSO sentences over 2- and 3-letter alphabets, every word up to length 7, duality, and the star-free bridge
— zero disagreements, zero state-cap blow-ups**. So `forall x.(Qa(x) -> exists y. S(x,y) & Qb(y))` compiles to
a star-free DFA the Algebra tab independently certifies aperiodic, while the even-length MSO sentence is named
ℤ/2 and `G(a -> X b)` (LTLf) is proved star-free by Kamp. Gate green: scope + conformance + lint + build all pass.

## Regex Studio — Ambiguity & Multiplicity (this session)

The studio could count **words** (Census) and prove **exponential backtracking** (ReDoS), but it had no pillar
for the dual, deeper question every NFA poses: for one input word, *how many distinct accepting runs are there?*
That is an NFA's **degree of ambiguity**, and the **Weber–Seidl theorem** (1991) says it falls into exactly four
classes — **unambiguous** (≤1 run ever) ⊂ **finitely ambiguous** (a constant cap) ⊂ **polynomially ambiguous**
of a precise integer **degree d** (runs ~ nᵈ) ⊂ **exponentially ambiguous** (runs ~ 2ⁿ) — and each class is
decided *structurally* by two combinatorial criteria on the trimmed NFA:

- **EDA** (exponential): a state q and a non-empty word v with **two distinct** cycles q ─v→ q — found as an SCC
  of the **squared** automaton N×N touching both the diagonal (q,q) and an off-diagonal (a,b≠a). This is exactly
  the ReDoS exponential condition, now read off the ε-free **Glushkov** automaton and tied back to that tab.
- **IDA** (the cubed automaton, the journal's standing open item): states **p≠q** and a word v with paths
  p→p, p→q, q→q — found as a reachability `(p,p,q) ⇝ (p,q,q)` in the **triple** automaton N×N×N. The **degree** of
  polynomial ambiguity is the longest IDA-chain of states (a longest path in the acyclic IDA relation).

This pillar implements all of it from scratch, proves it the house way (every structural verdict cross-checked
against a brute-force **run count** over the pattern's symbol atoms, and the **total runs** Rₙ proven equal to an
integer transfer-matrix `e₀ᵀBⁿf`), and connects the three views: **Census counts words, Ambiguity counts runs,
and their gap _is_ the ambiguity** (Rₙ = words ⇔ unambiguous).

- [x] `engine/ambiguity.ts` — ε-free NFA from the Glushkov position automaton; trim (reachable ∧ co-reachable);
      the squared product (unambiguity + EDA via Tarjan SCC) and the triple product (IDA + degree via longest
      path in the acyclic IDA relation, restricted to cyclic states for speed); concrete **witnesses** (a word
      with two runs + its two position-paths, the EDA prefix·pump·suffix, the IDA p,q,v), and the integer
      transfer matrix Rₙ = e₀ᵀBⁿf + the brute am(n) over the pattern's symbol **atoms** (the Boolean-algebra
      partition the classes induce). Squared-product cap 150 states (decides unambiguity + EDA outright);
      cubed-product cap 26 (refines the degree); when the cube is skipped the verdict degrades honestly to
      "polynomially bounded, degree not computed" rather than guessing.
- [x] `engine/ambiguity-verify.ts` — a seeded fuzzer: random regular patterns; the **exact** check Rₙ (transfer
      matrix) ≡ Rₙ (brute) at every length; the rigorous `unambiguous ⇔ runs = words`; direct witness
      confirmations (an "ambiguous" word truly has ≥2 runs; the EDA pump genuinely multiplies the run count via
      prefix·pumpᵏ·suffix); and the structural invariant EDA ⇒ IDA. (The earlier idea of cross-checking the
      growth *class* empirically was dropped as unsound — at small n a high-degree polynomial is indistinguishable
      from an exponential by ratio alone; the exact + direct-witness checks catch real bugs without false alarms.)
- [x] `components/AmbiguityPanel.tsx` — the colour-coded verdict badge + Weber–Seidl explainer, the EDA/IDA
      criteria cards, a word matched two ways (the two position-paths with the divergence lit), the EDA pump's
      2ᵏ growth, the Glushkov graph with the witness states highlighted, the **runs vs words** table (the
      ambiguity gap, with the transfer-matrix ≡ brute badge), and the seeded cross-check console.
- [x] Wired the **Ambiguity** tab into `App.tsx`, added three showcase examples ((a|a)* EDA, the Fibonacci
      (aa|a)*, and the sliding-match polynomial \w*(aa|ee|oo)\w*), refreshed header/footer/`project.json`, added
      the Ambiguity CSS, and re-ran the gate to green.

Validated offline with the typescript-transpile headless harness: **12/12 known-answer cases** (deterministic
regexes unambiguous; `.*a.*` and `\w*(aa|ee|oo)\w*` polynomial degree 1; `(a|b)*a(a|b)*a(a|b)*` degree 2; `(a|a)*`
and `(aa|a)*` exponential via EDA; `(a|a)` and `(a|a)(a|a)` finite) and the seeded fuzzer at **1,600 random
patterns across 8 seeds — 1,600 exact Rₙ≡brute equalities and ~1,600 direct witness confirmations, zero
failures**, observing degrees up to 6 and a healthy spread across all four classes. A subtle truth surfaced and is
now documented: the Glushkov automaton is ε-free, so `(a*)*` and `(.*)*` collapse to a *deterministic* self-loop
and are genuinely **unambiguous** here — their exponential character is a property of the ε-NFA / backtracking
structure, which is precisely what the **ReDoS** tab analyses. Gate green: scope + conformance + lint + build all
pass.
