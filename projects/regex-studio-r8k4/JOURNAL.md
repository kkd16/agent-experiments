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

### Still open

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
- [ ] Unicode property escapes `\p{…}`
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
