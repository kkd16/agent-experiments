# Cortex Chess — journal

A complete chess engine written from scratch in TypeScript, running entirely in the browser
(search lives in a Web Worker so the UI never freezes). No chess libraries — board
representation, move generation, search and evaluation are all hand-built here.

## Architecture

- **`engine/board.ts`** — 0x88 mailbox board, piece encoding, FEN parse/serialize, incremental
  Zobrist hashing, allocation-free `make`/`unmake` (plus null moves for pruning).
- **`engine/zobrist.ts`** — deterministic splitmix64-seeded 64-bit hash keys.
- **`engine/movegen.ts`** — pseudo-legal generation (incl. castling, en passant, promotion),
  attack detection, and a make/unmake legality filter.
- **`engine/eval.ts`** — tapered PeSTO evaluation (mg/eg PST interpolation) plus a full positional
  layer: piece **mobility** (sane centres), **king safety** (pawn-shield holes + a weighted attacker
  count), **pawn structure** (passed / isolated / doubled), **rooks** on open/semi-open files and the
  7th, **knight outposts**, a **mop-up** term that drives the bare king to a corner in won endings,
  bishop-pair + tempo, and a perfect **KPK bitbase** probe.
- **`engine/see.ts`** — Static Exchange Evaluation on the 0x88 board (reused scratch, x-ray aware).
- **`engine/kpk.ts`** — King + Pawn vs King bitbase, generated in-browser by retrograde analysis.
- **`engine/search.ts`** — iterative deepening negamax with **aspiration windows**, alpha-beta +
  principal-variation search, transposition table (2M), quiescence with **SEE + delta pruning**,
  null-move pruning, **late-move reductions**, **reverse-futility / razoring / futility / late-move
  pruning**, check extensions, SEE-aware MVV-LVA + killer + history ordering, mate-distance scoring,
  repetition/50-move draws, and seldepth/hashfull reporting.
- **`engine/book.ts`** — a hand-authored, weighted opening book (~40 main lines, both colours).
- **`engine/pgn.ts`** — PGN export with the Seven Tag Roster (and a SetUp/FEN tag for custom starts).
- **`engine/tactics.ts`** — a curated, engine-verified tactical test suite for the Lab.
- **`engine/san.ts`** — SAN with disambiguation and check/mate suffixes.
- **`engine/perft.ts`** — perft + the standard reference suite (correctness proof).
- **`engine/engine.worker.ts`** + **`hooks/useEngine.ts`** — worker transport with a synchronous
  fallback for sandboxed thumbnails.
- **`components/`** — board (click + drag, highlights, check glow, best-move arrow), eval bar,
  move list, live engine panel, promotion picker, and a three-tab Engine Lab (Tactics / Perft /
  Self-tests).

## Ideas / backlog

- [x] 0x88 board, FEN parse/serialize, make/unmake with incremental Zobrist hashing
- [x] Full pseudo-legal move generation (castling, en passant, promotion, double push)
- [x] Attack detection + make/unmake legality filter
- [x] perft module + standard reference suite for correctness
- [x] Tapered PeSTO evaluation (mg/eg PST interpolation) + bishop pair + tempo
- [x] Negamax + alpha-beta + principal-variation search
- [x] Iterative deepening with time control
- [x] Transposition table (Zobrist-keyed, depth-preferred, mate-score adjusted)
- [x] Quiescence search (captures + promotions) to kill the horizon effect
- [x] Null-move pruning
- [x] Move ordering: TT move, MVV-LVA, killer + history heuristics
- [x] Draw detection: threefold repetition, 50-move rule, insufficient material
- [x] SAN generation with disambiguation and +/# suffixes
- [x] Web Worker search so the UI stays responsive (sync fallback for thumbnails)
- [x] Interactive board: click-to-move, drag-and-drop, legal-move dots, last-move + check highlight
- [x] Evaluation bar + live engine panel (depth, nodes, nps, PV)
- [x] Difficulty levels, choose side, take-back, flip, hint arrow
- [x] FEN import/export
- [x] Engine Lab: run perft suite live and verify against reference counts
- [x] Opening book (~40 weighted main lines, both colours) for varied early play
- [x] Aspiration windows + late-move reductions for deeper search
- [x] Static Exchange Evaluation (SEE) for capture ordering + quiescence pruning
- [x] Reverse-futility / razoring / futility / late-move pruning around the static eval
- [x] Positional evaluation: mobility, king safety, passed/isolated/doubled pawns, rook files, outposts
- [x] KPK endgame bitbase (retrograde analysis, generated in-browser) + KX-vs-K mop-up
- [x] PGN export of the played game (copy + download, Seven Tag Roster)
- [x] Background analysis: live eval + best line on the human's move (no auto-play)
- [x] seldepth + hashfull in the engine readout
- [x] Engine Lab: live tactics suite (engine-verified puzzles) + SEE/eval-symmetry/KPK self-tests
- [ ] Endgame: extend bitbases beyond KPK (KQvK / KRvK / KPvKP) and Syzygy-style probing
- [ ] WASM/SIMD or bitboard rewrite for a big NPS boost
- [ ] Pondering (think on the opponent's clock) + an explicit movetime control
- [ ] Multi-PV analysis and an evaluation graph over the game
- [ ] PGN/EPD import to set up positions and replay games

## Session log

- 2026-06-25 (claude): Initial build. Implemented the full engine (board, movegen, eval, search,
  SAN, perft) and a polished React UI with a Web-Worker search and a perft correctness lab.
  Verified perft reference counts and a clean lint/build via `scripts/verify-project.mjs`.
- 2026-06-25 (claude): Major strength + feature pass. Added Static Exchange Evaluation (`see.ts`)
  feeding SEE-aware capture ordering and quiescence pruning; rebuilt the search with aspiration
  windows, late-move reductions, reverse-futility/razoring/futility/late-move pruning and a hard
  ply ceiling; and grew the evaluation from PST-only into a positional engine (mobility, king
  safety, pawn structure, rook files, outposts, KX-vs-K mop-up). Generated a perfect **KPK
  bitbase** in-browser via retrograde analysis (`kpk.ts`) and wired it into the eval. Added a
  weighted **opening book** (`book.ts`), **PGN export** (`pgn.ts`), and a **background-analysis**
  mode that shows a live evaluation and best line on the human's move. Rebuilt the Engine Lab into
  three tabs: a live **tactics suite** (`tactics.ts`) that times the engine on famous puzzles, the
  existing **perft** lab, and deterministic **self-tests** (SEE values, eval symmetry, KPK verdicts).
  Validated offline: perft reference counts match, SEE/eval-symmetry/KPK self-tests pass, the engine
  solves the tactical set and plays clean, fully legal self-play; a headless-Chromium smoke test
  loads the app with zero console errors and the in-browser self-tests report 9/9. Clean
  lint/build via `scripts/verify-project.mjs`.
