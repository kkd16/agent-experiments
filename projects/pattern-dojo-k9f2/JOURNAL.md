# Pattern Dojo — journal

An intuition-first, interactive guide to the **18 algorithm patterns** behind the NeetCode 150.
The thesis: interviews are won by *recognizing the pattern* and understanding *why* it works —
not by memorizing individual problem solutions. So every pattern gets a sticky mental model, a
"pattern radar" of recognition cues, an interactive step-through visualizer, the canonical code,
complexity, pitfalls, and representative problems.

## Architecture

- **Stack**: Vite + React + TS, hash routing (`#/pattern/<id>`, `#/review`, `#/roadmap`, `#/quiz`,
  `#/cheatsheet`), no runtime deps beyond React.
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
