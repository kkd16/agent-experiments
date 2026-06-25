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
- **`engine/egtb.ts`** — King + Rook vs King and King + Queen vs King **distance-to-mate tablebases**,
  built in-browser by retrograde fixed-point analysis (no embedded data) and probed by the eval so those
  endings are won as the *fastest* forced mate, never drifting into a 50-move draw. Verified exhaustively:
  across all ~400k legal positions per table the strong side always wins except the exact theoretical
  draws (stalemate / the lone king grabbing an undefended piece).
- **`engine/search.ts`** — iterative deepening negamax with **aspiration windows**, alpha-beta +
  principal-variation search, transposition table (2M), quiescence with **SEE + delta pruning**,
  null-move pruning, **late-move reductions**, **reverse-futility / razoring / futility / late-move
  pruning**, check extensions, SEE-aware MVV-LVA + killer + history ordering, mate-distance scoring,
  repetition/50-move draws, and seldepth/hashfull reporting. Now also exposes **`searchMultiPv`** —
  N principal variations via root-move exclusion, sharing the TT across lines.
- **`engine/book.ts`** — a hand-authored, weighted opening book (~40 main lines, both colours).
- **`engine/pgn.ts`** — PGN **export** (Seven Tag Roster, SetUp/FEN) and **import**: `parsePgn` handles
  tags (many per line), `{}`/`;` comments, recursive `()` variations, `$` NAGs, FEN setup and multiple
  games, resolving every SAN token to a legal move by replaying it.
- **`engine/tactics.ts`** — a curated, engine-verified tactical test suite for the Lab.
- **`engine/san.ts`** — SAN with disambiguation and check/mate suffixes, plus **`sanToMove`** — a
  structural SAN parser tolerant of over/under-disambiguation, zero-castling and missing `=`.
- **`engine/perft.ts`** — perft + the standard reference suite (correctness proof).
- **`engine/engine.worker.ts`** + **`hooks/useEngine.ts`** — worker transport (search / multi-PV
  analyze / batch-eval sweep) with a synchronous fallback for sandboxed thumbnails.
- **`components/`** — board (click + drag, highlights, check glow, best-move arrow), eval bar,
  move list, live engine panel, promotion picker, a three-tab Engine Lab (Tactics / Perft / Self-tests),
  and the **Analyze studio** (`Analysis.tsx` + `EvalGraph.tsx`): PGN/FEN import, full game navigation,
  a multi-PV engine readout, and a whole-game evaluation graph with click-to-jump and blunder markers.

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
- [x] Endgame tablebases beyond KPK: **KRvK and KQvK** distance-to-mate, retrograde, in-browser (`egtb.ts`)
- [x] **Multi-PV analysis** (`searchMultiPv`) + a whole-game **evaluation graph** over the game
- [x] **PGN import** (`parsePgn`) + structural **SAN parser** (`sanToMove`) to load and replay games
- [x] **Analyze studio**: import PGN/FEN, full move navigation (buttons + ←/→/Home/End), branch your own
      lines on the board, multi-PV readout, eval graph with click-to-jump + blunder markers, sample games
- [x] In-browser self-tests for the new modules (KRK/KQK verdicts, SAN round-trip, PGN→mate replay)
- [ ] Endgame: KBNvK and pawn-ful tablebases (KPvKP, KRvKP) and Syzygy-style probing
- [ ] WASM/SIMD or bitboard rewrite for a big NPS boost
- [ ] Pondering (think on the opponent's clock) + an explicit movetime control
- [ ] Opening explorer + annotated PGN export (eval/blunder comments) from the Analyze board
- [ ] EPD test-suite runner in the Lab (e.g. WAC / Bratko-Kopec) with pass-rate scoring

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
- 2026-06-25 (claude): **Analysis Studio** pass — turned the engine into a full analysis tool.
  (1) **Endgame tablebases** (`egtb.ts`): in-browser retrograde distance-to-mate for K+R vs K and
  K+Q vs K, wired into the eval so those endings are won as the fastest forced mate. Verified
  exhaustively over every legal position (~400k each): the strong side always wins except the exact
  theoretical draws; self-play mates KRK in ≤16 and KQK in ≤10 moves. (2) **SAN/PGN import**:
  `sanToMove` (structural, tolerant) + `parsePgn` (tags, comments, recursive variations, NAGs, FEN
  setup, multi-game), each move verified by replay — round-trips every legal move and replays the
  Opera/Immortal/Evergreen games (the Opera Game resolves to its #). (3) **Multi-PV** search
  (`searchMultiPv`) via root-move exclusion. (4) A new **Analyze** tab: import a PGN or FEN, step
  through with buttons or ←/→/Home/End, branch your own lines by moving on the board, a live multi-PV
  engine readout, and a **whole-game evaluation graph** (background search sweep) with click-to-jump
  and blunder markers. Generalised the worker + `useEngine` for analyze / batch-eval requests.
  Validated offline with a rolldown-bundled Node test harness (SAN/PGN, multi-PV, tablebase
  correctness, KRK/KQK self-play to mate) and a headless-Chromium run of the live build: PGN load +
  33-ply navigation + multi-PV + eval graph render with zero console errors, and the in-browser
  self-tests report **14/14**. Clean lint/build via `scripts/verify-project.mjs`.
