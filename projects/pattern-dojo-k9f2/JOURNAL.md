# Pattern Dojo — journal

An intuition-first, interactive guide to the **18 algorithm patterns** behind the NeetCode 150.
The thesis: interviews are won by *recognizing the pattern* and understanding *why* it works —
not by memorizing individual problem solutions. So every pattern gets a sticky mental model, a
"pattern radar" of recognition cues, an interactive step-through visualizer, the canonical code,
complexity, pitfalls, and representative problems.

## Architecture

- **Stack**: Vite + React + TS, hash routing (`#/pattern/<id>`, `#/practice`, `#/interview`,
  `#/interview/session`, `#/interview/report/<id>`, `#/review`, `#/roadmap`, `#/quiz`,
  `#/cheatsheet`, `#/stats`, `#/settings`), no runtime deps beyond React.
- `src/interview/` — **The Interview Room** pillar: `types.ts` (session model + scoring constants),
  `select.ts` (seeded mulberry32 PRNG + weakness-weighted, diversity-penalised problem selection),
  `store.ts` (event-synced `useInterview` — one persisted in-progress session + capped history),
  `score.ts` (readiness scorer: correctness → speed-vs-budget → hint/peek penalties, difficulty-
  weighted grade + coach's notes + drill recommendations). UI lives in `src/pages/Interview.tsx`
  (lobby / live room / scorecard / history) and `src/interview/interview.css`.
- `src/data/patterns.ts` — the content model: 18 patterns, each fully authored.
- `src/data/quiz.ts` — 25 pattern-recognition questions for the trainer.
- `src/data/approaches.ts` — guided "hint + approach" walkthroughs for representative problems,
  keyed by pattern → problem name, merged into the detail page at render.
- `src/visualizers/` — 18 hand-built, frame-based interactive visualizers driven by a shared
  `useStepper`. The stepper is keyboard-driven (space/←/→/Home/End/R) and supports shareable
  deep-links to a specific frame (`?frame=N`).
- `src/lib/srs.ts` — **the spaced-repetition engine**: an SM-2–style scheduler (learning steps →
  expanding ease-driven review intervals), mastery classification (new/learning/reviewing/mastered),
  legacy-progress migration, and the `useSRS` hook. This is now the single source of truth for
  progress; `src/lib/progress.ts` is a thin compatibility facade over it.
- `src/lib/streak.ts` — daily-activity streak tracking (current + longest).
- `src/lib/theme.ts` — light/dark theme with system-preference detection, persisted, applied via a
  `data-theme` attribute over CSS variables (no flash on load).
- `src/lib/daily.ts` — deterministic, date-seeded "pattern of the day".
- `src/components/CommandPalette.tsx` — ⌘K fuzzy-search palette to jump to any pattern, page or action.
- `src/components/CodeBlock.tsx` — dependency-free Python syntax highlighter.
- `src/pages/Review.tsx` — the flagship: a flashcard review session (recall from cues → grade
  Again/Hard/Good/Easy) plus a stats dashboard.
- `src/pages/Cheatsheet.tsx` — sortable/filterable complexity table with a print-to-PDF one-pager.
- `src/pages/Stats.tsx` — an 18-week activity heatmap, mastery analytics, a per-pattern tracked table,
  and JSON backup (`src/lib/backup.ts`: export / import / reset).

## Ideas / backlog

- [x] Scaffold app from template, design system + dark theme
- [x] Author all 18 patterns with intuition, mental model, recognition cues, code, complexity, pitfalls, problems
- [x] Home page: hero, progress donut, pattern grid grouped by level
- [x] Pattern detail page with full content + prev/next nav + mark-as-learned
- [x] Roadmap page (suggested learning order, foundational → advanced)
- [x] Pattern-recognition trainer/quiz with explanations
- [x] Interactive visualizers: two pointers, sliding window, binary search, hash map
- [x] Interactive visualizers: stack (monotonic), linked-list reversal, heap sift-up
- [x] Interactive visualizers: tree traversal (DFS orders + BFS), grid BFS, trie insertion
- [x] Interactive visualizers: 1-D DP, 2-D DP (LCS), backtracking (subsets), interval merge
- [x] localStorage progress tracking + progress donut
- [x] Add visualizers for the remaining patterns (Dijkstra, greedy/Kadane, math rotate, bit XOR) — all 18 now interactive
- [x] Spaced-repetition review mode that resurfaces patterns you marked weak — full SM-2 engine (`srs.ts`) + `#/review`
- [x] SM-2 mastery model: per-pattern ease/interval/due, new→learning→reviewing→mastered, with legacy-progress migration
- [x] Review dashboard (due/learning/mastered/tracked/streak) + flashcard recall with graded scheduling previews
- [x] Per-problem "reveal the approach" hints with a guided solution walkthrough (`approaches.ts`)
- [x] Light theme toggle + remember preference (system-aware, themed CSS variables, no flash)
- [x] Complexity cheat-sheet / printable one-pager export (sortable, filterable, print CSS)
- [x] "Pattern of the day" + streak tracking (current + longest, fed by reviews and the trainer)
- [x] Keyboard shortcuts for the visualizer stepper (space = play/pause, arrows = step, Home/End, R = reset)
- [x] Shareable deep links to a specific visualizer frame (`?frame=N`, copy-link button)
- [x] ⌘K command palette — fuzzy jump to any pattern, page, or action (theme toggle, start review)
- [x] Mastery badges on cards / detail / cheat-sheet; home "today" strip + due-count nav badge
- [x] Review history heatmap / calendar view (`#/stats`) + "weak patterns" auto-prioritization (review queue sorts by lapses ↓, ease ↑, due ↑)
- [x] Export / import progress as JSON (`backup.ts` — download a snapshot, restore on another device) + reset-everything
- [x] Stats page: streak/best/total-reviews/mastered tiles, mastery breakdown bar, per-pattern tracked table
- [x] Author per-problem approaches for **all** representative problems — full coverage (93/93)
- [x] Per-day review intensity in the heatmap (5 levels, driven by per-day activity counts)
- [x] Reduced-motion support (`prefers-reduced-motion` disables transitions/animations)
- [x] Adaptive trainer: 36 questions (≥2 per pattern), selection weighted toward un-mastered patterns, and a missed-but-learned answer feeds the SRS as a lapse
- [x] Configurable session size + new-patterns-per-session (`#/settings`, `settings.ts`), applied to the review queue
- [ ] Deep-dive sub-pages for tricky variants (3Sum dedup, min-window expand/contract)
- [ ] Per-pattern mini-quiz embedded on the detail page; trainer difficulty tiers
- [ ] A full keyboard-accessibility / focus-trap pass on the command palette and modals
- [ ] PWA / offline install

## Code Dojo — in-browser coding practice with auto-grading (planned + shipping this session)

The app teaches you to *recognize* a pattern and previews the *approach* — but you could never
actually **write the code and find out if it works**. That's the biggest missing loop in interview
prep. Code Dojo closes it: a real, dependency-free judge that runs your JavaScript against test
cases right in the browser and tells you which cases pass, fail, error, or time out — then feeds a
solve back into the spaced-repetition engine. The pattern you just *solved* graduates into review.

- [x] **Sandboxed judge** — a Web Worker test-runner built from a Blob (no bundler worker plumbing,
  works under the relative GitHub-Pages base). Per-test results stream back so we can attribute a
  pass/fail/error to each case; a rolling main-thread timeout terminates the worker on infinite
  loops and reports **Time Limit Exceeded** against the offending case. (`runner.ts`)
- [x] **Deterministic comparator** (`equal.ts`) — a stable canonical serializer that handles
  `NaN`/`±Infinity`/`-0`, plus comparison modes: `deep`, `unordered` (top-level multiset),
  `unordered-deep` (order-irrelevant everywhere — for subsets/permutations/anagram groups), and
  `approx` (float tolerance — for `pow`).
- [x] **A real code editor** (`CodeEditor.tsx`, zero deps) — line-number gutter synced to scroll,
  Tab/Shift-Tab (indent/outdent, multi-line aware), auto-indent on newline, bracket-aware close-dedent.
- [x] **A curated problem set** (`challenges.ts`) — 36 classic NeetCode-style problems across 17
  patterns, each with a statement, signature, starter code, sample + hidden judge tests, a verified
  reference solution, staged hints, and target complexity. Trees use nested `{val,left,right}`
  nodes; linked-list problems are framed over arrays so every problem is a pure JSON-in/JSON-out
  function. **All 36 reference solutions (163 tests) were validated against their own tests in Node
  before shipping** (caught a real spiral-matrix bound bug), so the judge can never disagree with
  the answer key. The exact Web Worker source was also driven through a fake `self` to verify the
  compile-error / runtime-error-attribution / console-capture paths.
- [x] **Practice hub** (`#/practice`) — challenges grouped by pattern, difficulty + solved filters,
  search, a solved/total progress ring, and per-pattern solve tallies.
- [x] **Solve page** (`#/practice/<id>`) — split layout: statement + hints + reference on the left,
  editor + Run (sample tests) / Submit (full judge) + a collapsible results console on the right.
  Drafts autosave per-problem; a first solve records best runtime, marks the pattern learned in the
  SRS, and feeds the daily streak. ⌘/Ctrl+Enter submits.
- [x] **Wire-up everywhere** — nav entry + ⌘K palette (hub *and* every challenge), a "Solve it
  yourself" panel on each pattern detail page, a Code-Dojo solved tile on Stats, a home strip card,
  and dojo state folded into JSON backup/restore.

## Complexity Profiler — empirical Big-O for your own code (planned + shipping this session)

Code Dojo proved your solution *correct*, but never whether it was *fast*. An accepted
O(n²) answer to an O(n) problem passes every test and says nothing — exactly the trap that
fails real interviews. The Complexity Profiler closes that gap: it runs your solution over a
geometric ladder of input sizes, times each in the sandbox, fits the curve to a growth class,
and tells you the empirical Big-O — then compares it to the problem's optimal.

- [x] **Fitting & classification math** (`complexity.ts`, pure / Node-tested) — seven model
  classes (1, log n, n, n log n, n², n³, 2ⁿ), each fit as `t ≈ a·f(n) + b` by non-negative
  least squares with R². A **robust Theil–Sen log–log slope** is the backbone (it shrugs off
  the GC-pause outliers that inflate ordinary slope on allocation-heavy O(n) code); the slope
  picks a *band* of plausible classes and the best fit within it wins, ties broken toward the
  simpler class (Occam). Honest about limits: O(n) vs O(n log n) and O(1) vs O(log n) aren't
  reliably separable by timing, so they're treated as adjacent.
- [x] **Per-challenge input scaling** (`scaling.ts`) — a self-contained, seeded generator for
  **all 36 problems** that builds a valid, *worst-case-eliciting* input at any size n (a target
  with no answer so a search scans fully; a true palindrome; a balanced tree; a DAG; a shuffled
  interval set). Each knows its size meaning, optimal class, and whether an idiomatic solution
  mutates in place.
- [x] **Sandboxed profiling worker** (`profiler.ts`) — a Blob Web Worker that assembles
  generator + user code + driver. **Batch timing** (auto-grow K until a batch clears the clock's
  resolution, keep the min across reps) makes per-call times reliable even under a coarse,
  Spectre-clamped `performance.now()`; it adaptively stops on a time budget or when a call gets
  slow, streams per-size progress, and a rolling main-thread watchdog kills genuine infinite loops.
- [x] **From-scratch SVG chart** (`ComplexityChart.tsx`) — measured points + best-fit curve on a
  toggleable **log–log / linear** axis (on log–log every power law is a straight line whose slope
  is the exponent), with nice ticks, hover detail, and theme/reduced-motion awareness. No chart lib.
- [x] **Profiler panel** (`ComplexityProfiler.tsx`) on every solvable problem — a verdict banner
  (optimal / on-target / **slower than optimal** / faster), measured-vs-optimal class, empirical
  exponent, fit R², the chart, and a raw-measurement table, with live progress while it runs.
- [x] **Validated before shipping** — a Node harness drives the real modules: every generator runs
  cleanly on every reference, the classifier recovers synthetic curves (incl. noisy) exactly, and
  end-to-end timing of all 36 references detects each stated optimal (revealing that the
  `network-delay` and `last-stone-weight` *reference* solutions are themselves sub-optimal — which
  the profiler now surfaces). A Playwright pass confirms the real browser worker: brute-force
  two-sum → "Slower than optimal — O(n²)", the hash version → "Optimal — O(n)", binary search → O(log n).
- [ ] **Space profiling** — estimate auxiliary memory growth by sampling allocation between sizes.
- [ ] **Operation-count mode** — instrument the source to count key operations for a deterministic,
  noise-free second opinion alongside wall-clock timing.
- [ ] **Persist the best measured class** per problem in the dojo store + a Stats tile, and fold it
  into JSON backup/restore.
- [ ] **"Beat the curve" goals** — mark a problem fully mastered only once a solution profiles at
  the optimal class, not merely passing.
- [ ] **Shareable profile permalinks** (seed + sizes in the URL) so a run reproduces byte-for-byte.

## The Interview Room — a timed, adaptive mock interview (planned + shipping this session)

You could learn a pattern, drill it, profile it — but the app never made you *perform* under the
one constraint interviews actually impose: **a ticking clock on an unfamiliar problem, with no
retries.** The Interview Room closes that last loop. It assembles a short set of Code Dojo problems
chosen to hunt your weakest patterns, runs a countdown, judges your code in the same sandbox, and
then grades not just *whether* you solved but *how* — speed against a difficulty budget, and how
much you leaned on hints or the answer key. It's the difference between "I know this pattern" and
"I can produce it, cold, in twelve minutes."

- [x] **Session model** (`interview/types.ts`) — a `LiveSession` captures config, the chosen problem
  ids, the countdown window, the current problem and a per-problem `ProblemAttempt` (draft code,
  first-view / first-pass timestamps, best pass-ratio, submit/run/hint counts, peeked flag). Enough
  to fully replay and score a session, and to survive a reload mid-interview.
- [x] **Deterministic, weakness-weighted selection** (`interview/select.ts`) — a seeded `mulberry32`
  PRNG + a stable string→seed hash make every session reproducible from its seed. Adaptive mode
  weights each problem by its pattern's **spaced-repetition mastery** (`new ×4.2 → mastered ×0.9`)
  and your Dojo solve history (unsolved problems weighted up), then samples *without* replacement
  with a strong same-pattern diversity penalty so a session spreads across patterns like a real
  loop. Difficulty *bands* (Warm-up / Mixed / Standard / Onsite) reshape the difficulty mix; a
  single-pattern focus is also supported.
- [x] **Persistence + live-session store** (`interview/store.ts`) — event-synced `useInterview` hook
  (same pattern as the SRS/Dojo stores), one persisted in-progress session (so a refresh never loses
  your code or the timer) plus an append-only, capped history of finished sessions. All storage is
  try/catch-guarded so the sandboxed catalog thumbnail still renders.
- [x] **Readiness scorer** (`interview/score.ts`) — turns a session into a 0–100 report. Per problem:
  correctness first, then a **speed score** relative to a difficulty-appropriate time budget
  (full credit ≤40% of budget, zero past 150%), docked for each hint and **capped** if the reference
  was peeked; unsolved problems earn partial credit from their best pass-ratio. The session score is
  a **difficulty-weighted** blend (a hard problem counts ~2.4× an easy one), mapped to a letter grade
  with plain-language **coach's notes** and a de-duplicated, priority-ranked list of patterns to drill.
- [x] **The live room** (`pages/Interview.tsx` → `Room`) — a sticky command bar with per-problem
  status dots, a tabular-numeral countdown that pulses red under two minutes and **auto-finishes at
  zero**, the real zero-dep editor + sandbox judge (Run samples / Submit, ⌘/Ctrl+Enter), a compact
  results console, an "Interviewer" panel that reveals staged hints on request (each noted on the
  scorecard) and a peek-guarded reference. A win folds straight back into the rest of the app —
  it marks the pattern learned in the SRS, records the Dojo solve, and feeds the daily streak.
- [x] **The lobby** — configure time budget, problem count, difficulty band, focus and whether hints
  are allowed, with a **live, deterministic preview** of the exact problems (a Shuffle reroll) so
  what you see is what you get; a resume banner for an in-progress session.
- [x] **Scorecard + analytics** (`ReportView`, `History`) — a readiness ring + letter grade, headline
  stats (solved, time used, avg solve, hints), coach's notes, drill-these-next chips linking to the
  pattern pages, and a problem-by-problem breakdown with a per-problem score meter. The lobby keeps a
  session history with a **from-scratch SVG readiness sparkline** (trend over time) and links back to
  every past scorecard.
- [x] **Wired in** — nav entry with a live-session pulse dot, ⌘K palette, a home hero CTA, and a
  dedicated `interview.css`. **Playwright-verified end to end**: configure → start → solve against the
  real worker → Accepted → End & score → a rendered scorecard, with the session landing in history.
- [x] **One-click session presets** — Phone screen / Standard onsite / Hard onsite / Speed drill,
  each setting time, count, difficulty band, focus and hint policy in one tap (with the active
  preset highlighted).
- [x] **Auto-lapse weak patterns** — on finish, any pattern left unsolved, peeked, or leaning on ≥2
  hints that you'd *already learned* is graded an SRS lapse, resurfacing it in review — closing the
  loop the trainer already does.
- [ ] **Fold empirical complexity into the score** — reuse the Complexity Profiler so an accepted but
  sub-optimal solution scores below an optimal one, not equal to it.
- [ ] **Shareable session permalinks** (seed + config in the hash) so two people can attempt the exact
  same interview and compare scorecards.
- [ ] **Auto-lapse weak patterns** — schedule an SRS review for any pattern left unsolved or heavily
  hinted, closing the loop the way the trainer already does.
- [ ] **A "talk-aloud" timer / notes pane** and a post-session self-rating to practise communication,
  not just code.

## Session log

- 2026-06-13 (claude): Initial build. Full design system, 18 authored patterns, 4 pages
  (Home / Pattern detail / Roadmap / Trainer), 14 interactive step-through visualizers,
  localStorage progress, syntax-highlighted code blocks. Production-ready first release.
- 2026-06-13 (claude): Added the final 4 visualizers (Kadane/greedy, XOR/bit-manip,
  matrix rotation, Dijkstra) so all 18 patterns are now interactive. 18 step-through viz total.
- 2026-06-14 (claude): **Major release — Pattern Dojo becomes a spaced-repetition learning
  platform.** Built an SM-2 scheduler from scratch (`srs.ts`): learning steps then expanding,
  ease-driven review intervals, mastery classification, and one-time migration of the old boolean
  progress store. New `#/review` flashcard mode with a stats dashboard, grade-aware "next due"
  previews, and learn-ahead/cram fallbacks. Added daily streaks, a date-seeded pattern-of-the-day,
  a system-aware light/dark theme (themed all CSS variables), keyboard control + shareable
  `?frame=N` deep-links for every visualizer, a ⌘K command palette, a sortable/printable complexity
  cheat-sheet (`#/cheatsheet`), guided per-problem hint+approach walkthroughs (`approaches.ts`,
  ~36 authored), mastery badges throughout, and a home "today" strip. The trainer now feeds the
  streak. Everything stays React-only, localStorage-backed (sandbox-safe), and passes the full
  gate (scope + conformance + lint + build).
- 2026-06-14 (claude): **Stats & durability pass.** Added a `#/stats` page — a GitHub-style 18-week
  activity heatmap, mastery breakdown bar, headline tiles (streak / best / total reviews / mastered),
  and a per-pattern tracked table sorted by next-due. Added full JSON backup (`backup.ts`): export a
  snapshot, import it on another device, or reset everything. The review queue now surfaces your
  weakest patterns first (more lapses, lower ease). Wired Stats into the nav, the ⌘K palette, and the
  home streak card. Gate still green.
- 2026-06-14 (claude): **Content completion + a11y.** Authored guided hint+approach walkthroughs for
  every remaining representative problem — coverage is now 93/93, so the "Approach" reveal is live on
  every problem in the app. Upgraded the activity heatmap to 5 graded intensity levels backed by
  per-day activity counts (streak store extended, with backfill for older saves). Added
  `prefers-reduced-motion` support that disables transitions/animations. Gate green.
- 2026-06-14 (claude): **Adaptive trainer.** Grew the question bank to 36 (≥2 per pattern) and made
  selection adaptive — questions are weighted toward patterns you haven't mastered (new ×4 →
  mastered ×1). Missing a pattern you'd previously learned now schedules it for review (an SRS lapse),
  closing the loop between the trainer and spaced repetition. The results screen lists the patterns to
  brush up on and links straight to any due review. Gate green.
- 2026-06-14 (claude): **Settings.** Added `#/settings` (gear icon + ⌘K) to tune the study flow —
  session size (caps the due queue, 5–50) and new-patterns-per-session (1–18), persisted via
  `settings.ts` and applied throughout the review flow, plus a theme selector. Gate green.
- 2026-06-22 (claude): **Major release — Code Dojo: in-browser coding practice with a real judge.**
  Closed the app's biggest missing loop — you could *recognise* a pattern and preview the approach,
  but never actually write code and find out if it works. Built a from-scratch, dependency-free
  judge: a Web Worker constructed from a Blob (`runner.ts`) runs your JavaScript against sample +
  hidden tests, streaming one result per case so each gets its own pass/wrong/error verdict, with a
  rolling main-thread timeout that terminates the worker on infinite loops and reports a time-limit.
  A deterministic comparator (`equal.ts`) handles `NaN`/`±Infinity`/`-0` and four modes
  (`deep`/`unordered`/`unordered-deep`/`approx`). Authored **36 curated problems across 17 patterns**
  (`challenges.ts`) — pure JSON-in/JSON-out functions (trees as nested nodes, lists as arrays) with
  statements, signatures, starter code, staged hints, verified reference solutions and target
  complexity. Added a zero-dep code editor with a synced line-number gutter and editor-grade key
  handling (`CodeEditor.tsx`), a Practice hub (`#/practice`) with filters/search/progress ring, and a
  split solve page (`#/practice/<id>`) with autosaving drafts; a first solve graduates the pattern
  into spaced review and feeds the streak. Wired into the nav, ⌘K palette (hub + every problem), each
  pattern detail page, the Stats tiles, the home strip, and JSON backup/restore. **Validated all 36
  references (163 tests) and the worker source itself in Node before shipping** (the harness caught a
  real spiral-matrix bound bug). Full gate (scope + conformance + lint + build) green.
- 2026-06-28 (claude): **Major release — the Complexity Profiler: empirical Big-O for your own
  code.** Code Dojo could tell you a solution was *correct* but never whether it was *fast* — so an
  accepted O(n²) answer to an O(n) problem passed silently, the exact trap that loses interviews.
  The profiler closes it. New `complexity.ts` fits timing curves to seven growth classes by
  non-negative least squares and a **robust Theil–Sen log–log slope** (which ignores the GC-pause
  outliers that wreck ordinary slope on allocation-heavy O(n) code), choosing a slope-gated band and
  the simplest good fit within it. New `scaling.ts` gives **all 36 problems** a seeded,
  worst-case-eliciting input generator. New `profiler.ts` is a Blob Web Worker that **batch-times**
  each size (auto-grown K so per-call times stay reliable under a coarse, Spectre-clamped
  `performance.now()`, min across reps), adaptively stops on a budget, streams progress, and is
  watchdog-guarded against infinite loops. A from-scratch SVG chart (`ComplexityChart.tsx`,
  log–log/linear toggle) plots the points and fit; the panel (`ComplexityProfiler.tsx`) on every
  solvable problem shows a verdict (optimal / on-target / **slower than optimal** / faster),
  measured-vs-optimal class, empirical exponent and R². **Validated before shipping**: a Node harness
  confirms every generator runs on every reference, the classifier recovers synthetic curves
  (incl. noisy), and end-to-end timing of all 36 references detects each optimal — and a Playwright
  run proves the real browser worker (brute-force two-sum → "Slower than optimal — O(n²)"; the hash
  version → "Optimal — O(n)"; binary search → O(log n)). Full gate (scope + conformance + lint +
  build) green.
- 2026-07-06 (claude): **Major release — The Interview Room: a timed, adaptive mock interview.**
  Closed the app's last missing loop — you could learn, drill and profile a pattern, but never
  *perform* under a clock on an unfamiliar problem with no retries. New `interview/` module: a
  `LiveSession` model that fully captures and replays a session (`types.ts`); deterministic,
  weakness-weighted problem selection (`select.ts`) — a seeded mulberry32 PRNG picks problems by
  spaced-repetition mastery (`new ×4.2 → mastered ×0.9`) and Dojo history, sampled without
  replacement with a same-pattern diversity penalty, reshaped by difficulty *bands*; an event-synced
  `useInterview` store (`store.ts`) that persists the in-progress session across reloads plus a capped
  history; and a readiness scorer (`score.ts`) that grades correctness → speed-vs-budget → hint/peek
  penalties, difficulty-weighted into a letter grade with personalised coach's notes and ranked drill
  recommendations. The UI (`pages/Interview.tsx`) is a lobby (configurable, with a live deterministic
  problem preview), a live room (sticky bar with status dots, an auto-finishing countdown that pulses
  under 2 min, the real editor + sandbox judge, a staged-hint "interviewer" and a peek-guarded
  reference), and a scorecard (readiness ring, headline stats, coach's notes, drill chips, per-problem
  score meters) with a from-scratch SVG readiness sparkline over session history. A solve folds back
  into the SRS, the Dojo store and the streak. Wired into the nav (with a live-session pulse dot), the
  ⌘K palette and a home hero CTA. **Playwright-verified end to end** (configure → start → solve against
  the real worker → Accepted → End & score → rendered scorecard, session recorded in history). Full
  gate (scope + conformance + lint + build) green.
- 2026-07-06 (claude): **Interview Room follow-ups.** Added one-click **session presets** (Phone
  screen / Standard onsite / Hard onsite / Speed drill) that set time, count, difficulty band, focus
  and hint policy together, with the matching preset highlighted. On finish, the room now
  **auto-lapses weak patterns** — any pattern left unsolved, peeked, or leaning on ≥2 hints that you'd
  already learned is graded an SRS lapse so it resurfaces in review, closing the interview→learning
  loop the way the trainer already does; the scorecard notes it. Playwright-checked (preset applies:
  60m + hints-off highlighted). Gate green.
