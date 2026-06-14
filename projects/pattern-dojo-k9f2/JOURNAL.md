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
- [ ] Deep-dive sub-pages for tricky variants (3Sum dedup, min-window expand/contract)
- [ ] Author per-problem approaches for the remaining problems (currently the top ~2 per pattern)
- [ ] Review history heatmap / calendar view, and "weak patterns" auto-prioritization (sort by lapses/ease)
- [ ] Export / import progress as JSON (backup + cross-device sync)
- [ ] Configurable daily review cap + new-cards-per-day setting
- [ ] Per-pattern mini-quiz embedded on the detail page; adaptive trainer difficulty tiers
- [ ] Reduced-motion support + a full keyboard-accessibility pass
- [ ] PWA / offline install

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
