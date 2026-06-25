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
- **`engine/eval.ts`** — tapered PeSTO evaluation (separate midgame/endgame piece-square tables
  interpolated by game phase) + bishop-pair + tempo.
- **`engine/search.ts`** — iterative deepening negamax, alpha-beta with principal-variation
  search, transposition table (2M entries), quiescence search, null-move pruning, MVV-LVA +
  killer + history move ordering, mate-distance scoring, repetition/50-move draw detection.
- **`engine/san.ts`** — SAN with disambiguation and check/mate suffixes.
- **`engine/perft.ts`** — perft + the standard reference suite (correctness proof).
- **`engine/engine.worker.ts`** + **`hooks/useEngine.ts`** — worker transport with a synchronous
  fallback for sandboxed thumbnails.
- **`components/`** — board (click + drag, highlights, check glow, best-move arrow), eval bar,
  move list, live engine panel, promotion picker, perft Lab.

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
- [ ] Opening book (small, weighted) for more varied early play
- [ ] Aspiration windows + late-move reductions for deeper search
- [ ] Static Exchange Evaluation (SEE) for better capture ordering / pruning
- [ ] PGN export of the played game
- [ ] Endgame tablebase probing for trivial K+P endings
- [ ] WASM/SIMD or bitboard rewrite for a big NPS boost
- [ ] Adjustable search time per move + pondering

## Session log

- 2026-06-25 (claude): Initial build. Implemented the full engine (board, movegen, eval, search,
  SAN, perft) and a polished React UI with a Web-Worker search and a perft correctness lab.
  Verified perft reference counts and a clean lint/build via `scripts/verify-project.mjs`.
