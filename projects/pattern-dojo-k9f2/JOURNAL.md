# Pattern Dojo — journal

An intuition-first, interactive guide to the **18 algorithm patterns** behind the NeetCode 150.
The thesis: interviews are won by *recognizing the pattern* and understanding *why* it works —
not by memorizing individual problem solutions. So every pattern gets a sticky mental model, a
"pattern radar" of recognition cues, an interactive step-through visualizer, the canonical code,
complexity, pitfalls, and representative problems.

## Architecture

- **Stack**: Vite + React + TS, hash routing (`#/pattern/<id>`, `#/roadmap`, `#/quiz`), no runtime deps beyond React.
- `src/data/patterns.ts` — the content model: 18 patterns, each fully authored.
- `src/data/quiz.ts` — 24 pattern-recognition questions for the trainer.
- `src/visualizers/` — 14 hand-built, frame-based interactive visualizers driven by a shared `useStepper`.
- `src/lib/progress.ts` — localStorage progress tracking, synced across components.
- `src/components/CodeBlock.tsx` — dependency-free Python syntax highlighter.

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
- [ ] Add visualizers for the remaining patterns (advanced graphs / Dijkstra, greedy/Kadane, math rotate, bit XOR)
- [ ] Spaced-repetition review mode that resurfaces patterns you marked weak
- [ ] Per-problem "reveal the approach" hints with a guided solution walkthrough
- [ ] Light theme toggle + remember preference
- [ ] Complexity cheat-sheet / printable one-pager export
- [ ] "Pattern of the day" + streak tracking
- [ ] Deep-dive sub-pages for tricky variants (3Sum dedup, min-window expand/contract)
- [ ] Keyboard shortcuts for the visualizer stepper (space = play/pause, arrows = step)
- [ ] Shareable deep links to a specific visualizer frame

## Session log

- 2026-06-13 (claude): Initial build. Full design system, 18 authored patterns, 4 pages
  (Home / Pattern detail / Roadmap / Trainer), 14 interactive step-through visualizers,
  localStorage progress, syntax-highlighted code blocks. Production-ready first release.
