# Cortex Chess — journal

A complete chess engine written from scratch in TypeScript, running entirely in the browser
(search lives in a Web Worker so the UI never freezes). No chess libraries — board
representation, move generation, search and evaluation are all hand-built here.

## Architecture

- **`engine/board.ts`** — 0x88 mailbox board, piece encoding, FEN parse/serialize, incremental
  Zobrist hashing, allocation-free `make`/`unmake` (plus null moves for pruning). Castling is encoded
  **king-captures-rook** (a castle move's `to` is the rook's origin square) and the rights-voiding mask
  is a **per-position** square table, so the same code path serves standard chess *and* every Chess960
  layout (king and rooks on arbitrary files). FEN reads/writes X-FEN (`KQkq`) and **Shredder-FEN** file
  letters; the king/rook may overlap destinations and make/unmake vacates both home squares before
  filling the g/c and f/d targets.
- **`engine/zobrist.ts`** — deterministic splitmix64-seeded 64-bit hash keys.
- **`engine/movegen.ts`** — pseudo-legal generation (incl. **Chess960-general castling**, en passant,
  promotion), attack detection, and a make/unmake legality filter. Castling validates the king's path
  (out-of/through/into-check), and that the king-span and rook-span are clear except for the two movers,
  for arbitrary king/rook files.
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
- **`engine/gtb.ts`** — a **material-generic retrograde DTM solver**. One code path derives the whole family of
  pawnless 3–4-man distance-to-mate tablebases (no embedded data, built in-browser): it reproduces KRvK/KQvK
  (`egtb.ts`) and KBNvK (`kbnk.ts`) **bit-for-bit**, and newly solves **KBBvK** (the two-bishop mate — a forced win),
  **KNNvK** (proven a draw) and the major combinations (KQRvK, KRRvK, KQQvK, KRBvK, KRNvK, KQBvK, KQNvK). Backward
  retrograde BFS over a **DTM-keyed bucket queue** (Dial's), with Syzygy-style **sub-table probing** — a defender
  capture that leaves a still-won residual is scored from the relevant 3-man table. Proven from the inside (Bellman
  optimality on a random sample + optimal self-play to mate that follows captures across tables).
- **`engine/tbcache.ts`** — sandbox-safe **IndexedDB** persistence for built DTM tables (main thread *and* worker), so a
  solved ending survives a reload and re-hydrates instantly instead of rebuilding (~10 s).
- **`engine/endgames.ts`** — maps a position's material to a tablebase config and **warms the cached table before the
  search**, so once an ending is solved in the Lab the engine plays it perfectly with no mid-move rebuild.
- **`engine/clock.ts`** — **UCI-style time management**: `allocateTime` turns a clock (base + increment) into a
  soft/hard per-move budget (sudden-death horizon + most of the increment, with a hard cap so the engine never flags).
- **`engine/kbnk.ts`** — the **King + Bishop + Knight vs King** distance-to-mate tablebase — the hardest of
  the elementary mates (only winnable in the two corners the bishop controls; longest forced mate is 33
  moves). The whole ~33.6M-position table is generated in-browser by **backward retrograde BFS** (seed the
  mates, walk predecessors outward layer by layer, each position touched once) in ~10 s, then *self-verified*:
  retrograde consistency on a sample and thousands of optimal self-play games that must mate in exactly the
  stored distance. The eval probes it for perfect play, and falls back to a corner-driving heuristic (which
  also wins) before the table is built.
- **`engine/epd.ts`** — EPD parser + the classic **Bratko–Kopec** and **Win at Chess** benchmark suites, so
  the Lab can score the engine against *published* best moves at a chosen time budget.
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
- **`engine/nnue.ts`** — a from-scratch **NNUE (efficiently-updatable neural-network) evaluation**: a
  768-input-per-perspective feature transformer (`W1: 768×H`) feeding two colour-indexed **accumulators**,
  a clipped-ReLU, and a linear output → stm-relative centipawns. The headline is the **`Accumulator`**: it
  supports both a full `refresh` *and* an incremental `applyMove(±1)` that folds a single move's feature
  deltas into the two accumulators in O(features touched). The feature set is plain piece-square (not
  king-bucketed), so *every* move — castling, en passant, promotion — is a pure incremental update and a
  null move touches nothing; the search keeps one accumulator in lock-step with make/unmake.
- **`engine/nnue-train.ts`** — a hand-rolled trainer (no ML library): seeded self-play position sampling,
  **knowledge distillation** from the classical `evaluate`, **Adam SGD** with hand-derived gradients
  (sparse `W1` updates over only the active features), a finite-difference **gradient check**, and a
  net-vs-classical **correlation** (R²/Pearson/RMSE) for the Lab.
- **`engine/nnue-cache.ts`** — sandbox-safe **IndexedDB** persistence for a trained net (same pattern as
  `tbcache`), so it survives a reload and is re-hydrated by the search worker for play.
- **`engine/tactics.ts`** — a curated, engine-verified tactical test suite for the Lab.
- **`engine/san.ts`** — SAN with disambiguation and check/mate suffixes, plus **`sanToMove`** — a
  structural SAN parser tolerant of over/under-disambiguation, zero-castling and missing `=`.
- **`engine/perft.ts`** — perft + the standard reference suite (correctness proof).
- **`engine/review.ts`** — **Cortex Coach**, a from-scratch game-review model (no external service). A
  logistic **win-probability** from centipawns, per-move **accuracy%** from the win-% drop, per-player
  **accuracy** (the lichess mean of a volatility-weighted mean and the harmonic mean), **ACPL** and an
  estimated rating; a move **classifier** (Brilliant via SEE-negative-but-best sacrifices, Great via
  only-moves, Best/Excellent/Good/Book/Inaccuracy/Mistake/Blunder, and Missed-win/missed-mate); and a
  heuristic **coach narration** built purely from engine facts. It consumes a per-node analysis (best
  line + score + 2nd-best) produced by the worker's `review` multi-PV(2) sweep, and carries its own
  `reviewSelftest`.
- **`engine/chess960.ts`** — **Chess960 / Fischer Random**. The Scharnagl numbering both ways
  (`backRankForId`/`idForBackRank`, the canonical 0–959 SP-IDs, 518 = standard), `startFenForId`,
  `startFenForDfrc` (Double Fischer Random — independent back ranks per side, which the per-side
  castling code supports for free), and `randomStartId`. It carries its **own exact-oracle self-test**
  (`chess960Selftest`): the id⇄position bijection over all 960, the standard position routed through the
  960 castle path matching reference perft, make/unmake + hashing integrity over random 960 trees, an
  **independent castle-move oracle** (a from-scratch re-derivation) cross-checked node-for-node across
  perft trees, colour-flip perft symmetry, and a DFRC pass — no external reference tables needed.
- **`engine/engine.worker.ts`** + **`hooks/useEngine.ts`** — worker transport (search / multi-PV
  analyze / batch-eval sweep) with a synchronous fallback for sandboxed thumbnails.
- **`components/`** — board (click + drag, highlights, check glow, best-move arrow), eval bar,
  move list, live engine panel, promotion picker, a **Chess960 panel** (Random 960 / start a chosen
  SP-ID / #518 standard / Random DFRC, with the live SP-ID badge), the Engine Lab (Tactics / EPD /
  tablebases / NNUE / Perft / Self-tests — the Self-tests tab now includes the six Chess960 checks),
  and the **Analyze studio** (`Analysis.tsx` + `EvalGraph.tsx`): PGN/FEN import, full game navigation,
  a multi-PV engine readout, and a whole-game evaluation graph with click-to-jump and blunder markers.
  Castling input is variant-aware: drop the king on its g/c square *or* click your own rook.

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
- [x] **KBNvK distance-to-mate tablebase** (`kbnk.ts`) — the hardest elementary mate, ~33.6M positions
      solved in-browser by backward retrograde BFS (~10s), wired into the eval, exhaustively self-verified
      (retrograde consistency + thousands of optimal self-play games to mate); corner-driving heuristic fallback
- [x] **Pondering** (think on the opponent's clock, on a second worker, with instant *ponder hits*) + an
      explicit **movetime** control (fixed think-time presets that override the strength level's budget)
- [x] **Opening explorer** (weighted book moves for the current position, click to branch) + **annotated PGN
      export** ([%eval] comments and ?!/?/?? glyphs from the Analyze sweep, with a per-game blunder summary)
- [x] **EPD test-suite runner** in the Lab (Bratko–Kopec + Win at Chess) with a chosen budget and pass-rate scoring
- [x] **Search**: internal iterative reduction (off the PV), countermove heuristic, history malus on quiets
      that didn't cut, improving-aware LMP/LMR — ~23% fewer nodes to reach a given depth, no tactical regression
- [x] Node-limit + soft/hard-time search options (`maxNodes`, `softTime`) underpinning the movetime control
- [x] **Generalized retrograde tablebase engine** (`gtb.ts`): one material-generic solver derives the whole family of
      pawnless 3–4-man DTM tables — reproduces KRvK/KQvK/KBNvK **bit-for-bit** and newly solves **KBBvK** (forced win),
      **KNNvK** (draw) and the major combos (KQRvK, KRRvK, KQQvK, KRBvK, KRNvK, KQBvK, KQNvK) via a DTM bucket queue +
      Syzygy-style sub-table probing for captures; cross-checked against the hand-rolled tables + Bellman + self-play
- [x] **Persist built tablebases to IndexedDB** (`tbcache.ts`) — survive reloads, warm instantly; KBNvK + every gtb table
- [x] **Warm the cached tablebase before the search** (`endgames.ts`) so the engine plays solved endings perfectly in play
- [x] **Eval probes the generalized tables** — exact DTM-graded wins, true 0 for proven draws (KNNvK, same-coloured KBBvK)
- [x] **Endgame TBs Lab tab** — pick an ending, build + verify (oracle / Bellman / self-play), see stats, longest-mate FEN, cache state
- [x] **UCI-style time controls** (`clock.ts`): clock + increment with real per-move time management (1+0 … 10+5), live engine clock
- [x] **NNUE neural-network evaluation** (`nnue.ts`) — from scratch, no ML libraries: a 768-feature-per-perspective
      transformer → two colour-indexed accumulators → clipped-ReLU → linear output, returning stm-relative centipawns
- [x] **Incremental (efficiently-updatable) accumulator** — `applyMove(±1)` folds one move's feature deltas in
      O(features touched); plain piece-square features make castling/en-passant/promotion pure incremental updates and
      null moves free. Proven **bit-for-bit identical to a full refresh** over thousands of random make/unmake positions
- [x] **In-browser training by knowledge distillation** (`nnue-train.ts`) — seeded self-play sampling labelled by the
      classical eval, **hand-rolled Adam SGD** with hand-derived gradients (sparse W1 updates), **gradient-checked**
      against finite differences (max rel err ~4e-4); reaches **R²≈0.92** vs the classical eval on a holdout
- [x] **Search integration** — `Searcher.setEvaluator(net)` swaps the leaf eval to the NNUE and keeps the accumulator
      in lock-step with make/unmake (refresh at the root, incremental per move); the worker takes a `setnnue` message
- [x] **NNUE Lab tab** — train live (loss curve + progress), net-vs-classical **correlation scatter + R²/RMSE**, the
      accumulator-equivalence + gradient-check self-tests, **save/load/clear** to IndexedDB, and an **8-game
      head-to-head** (NNUE eval vs classical eval, same search) reporting the score
- [x] **Play with the net** — a "NNUE eval" toggle in the Play panel runs the trained net (loaded from IndexedDB) in
      both the play and ponder engines; the **Self-tests** tab gains the accumulator-equivalence + gradcheck checks
- [x] **Ship a pre-trained default net** (`nnue-weights.ts`, built by `tools/train-default-nnue.ts`) so "NNUE eval"
      works on a fresh load with no training — holdout **R²=0.9939 / RMSE 55 cp**; a net trained in the Lab overrides it
- [x] **Chess960 / Fischer Random** (`chess960.ts`) — full support for all 960 Scharnagl start positions, played
      from the Play panel (Random 960 / a chosen SP-ID / #518 standard), with the SP-ID shown as a live badge
- [x] **Scharnagl SP-ID numbering both ways** — `backRankForId`/`idForBackRank` (a verified bijection over all 960,
      id 518 = the standard set-up), `startFenForId`, and `randomStartId`
- [x] **General king-captures-rook castling** — re-encoded castling so king and rooks can start on arbitrary files;
      make/unmake vacates both home squares before filling the fixed g/c (king) and f/d (rook) targets, handling
      every destination overlap; the rights-voiding mask is now a per-position square table built at `parseFen`
- [x] **X-FEN + Shredder-FEN castling fields** — parse `KQkq` (outermost-rook reading) *and* file letters (`HAha`),
      and emit Shredder-FEN for 960 positions so FEN round-trips exactly
- [x] **960-aware SAN, move input, and NNUE** — `O-O`/`O-O-O` by rook-vs-king file; the UI accepts a castle by the
      king's g/c square *or* by clicking your own rook; the NNUE accumulator folds the king+rook deltas as one update
- [x] **Double Fischer Random (DFRC)** — independent back ranks per side (`startFenForDfrc`, a "Random DFRC" button);
      falls straight out of the per-side castling code with no special-casing
- [x] **Exact-oracle Chess960 self-test** (`chess960Selftest`, surfaced in the Self-tests Lab tab): id⇄position
      bijection over all 960, the standard position via the 960 castle path matching reference perft, make/unmake +
      hashing integrity over random 960 trees, an **independent castle-move oracle** cross-checked node-for-node
      across perft trees (tens of thousands of castles), colour-flip perft symmetry, and a DFRC pass
- [ ] **A Chess960 opening principles / start-position browser** in the Lab (mini-board per SP-ID, side-to-side compare)
- [ ] **960-aware king-safety eval** — the pawn-shield term currently assumes a king castled to g/c; generalise it
- [ ] **Persist the last 960 SP-ID** and add a "copy SP-ID / share position" affordance
- [ ] **Quantize** the net to int16/int8 with a fixed-point accumulator (the real NNUE speed trick) for a big NPS win
- [ ] **HalfKP / king-bucketed features** with a refresh-on-king-move path (more capacity; the current set is king-agnostic)
- [ ] **Train on shallow-search scores** (not just the static eval) and on the **game result** (WDL) for a stronger teacher
- [ ] **Self-play data + iterative retraining** (the net plays itself to generate harder positions), and an Elo estimate
- [ ] Pawn-ful tablebases (KPvKP, KRvKP, KPvK as exact DTM) — needs un-promotion / en-passant unmoves and a layered
      dependency on the promoted-material tables (the generic solver is currently pawnless / fixed-material)
- [ ] Pieces on *both* sides (KQvKR, KRvKB, …) — generalise the lone-king defender assumption
- [ ] WASM/SIMD or bitboard rewrite for a big NPS boost
- [ ] Ponder line preview (show the predicted reply + the engine's intended answer while it thinks)
- [ ] Bigger EPD sets (full WAC-300, ECM) with category breakdowns and an Elo estimate from the pass rate

## Cortex Coach — full game review (planned + shipping this session)

The engine could *analyse* a position and graph a game's eval, but it could never tell you **how well
you played**: which move was the blunder, what you should have played instead, and a number for the
whole game. That's the loop every serious player lives in (chess.com/lichess "Game Review"). Cortex
Coach closes it with a principled, from-scratch accuracy model — no external service, all in-browser.

- [x] **`engine/review.ts` — a principled move-quality model.** Win-probability from centipawns via the
      logistic `win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)`; per-move **accuracy%** from the win-%
      drop (`103.1668·e^(−0.04354·Δ) − 3.1669`); per-player **accuracy** as the mean of a
      volatility-weighted mean and the harmonic mean of move accuracies (the lichess method);
      **ACPL** (average centipawn loss) and an **estimated performance rating**.
- [x] **Move classification** — Brilliant `‼` (a sound sacrifice that's still best, SEE< 0 yet stays
      winning), Great `❗` (the only move that holds — the 2nd-best is far worse), Best, Excellent, Good,
      Book (in the opening book — excluded from stats), Inaccuracy `?!`, Mistake `?`, Blunder `??`, and
      **Missed win / missed mate** (a forced mate or winning edge thrown away).
- [x] **Heuristic coach text per move** generated from engine facts only (no LLM): the played vs. best
      move, the eval swing, "hangs material" (SEE), "missed mate in N", and the best line in SAN.
- [x] **Worker `review` request** — a multi-PV(2) sweep over every node that streams progress and
      returns, per node, the best line + score + 2nd-best score (so the model can spot only-moves and
      sacrifices); a `reviewGame` method on the `useEngine` hook with a synchronous fallback.
- [x] **A new `Review` tab** — paste a PGN (or pick a sample), hit **Review**, watch the progress bar,
      then get: an **accuracy scoreboard** for both players (accuracy %, ACPL, est. rating, a per-class
      tally), a **classification-coloured move list**, a **key-moments** list (biggest swings, jump-to),
      a navigable board with a best-move arrow, and a **coach card** for the current move.
- [x] **`reviewSelftest()`** wired into the **Self-tests** Lab tab — win% is monotone/symmetric and
      pins 50 at 0 cp, accuracy is 100 at no loss and decreasing, a constructed game yields the expected
      Best/Blunder/Missed-mate labels, and player accuracy stays in `[0,100]`.
- [x] **Offline validation harness** (`tools/test-review.ts`) — review a real master game end-to-end
      (the Opera Game) and assert the model's invariants and that Black's accuracy < White's there.

## Engine Arena — measurable strength (planned this session)

- [x] **Engine-vs-engine arena in the Lab** — pit two configurations (search node budget and/or NNUE
      on/off) head-to-head over N games from varied openings, with a live score, and compute an **Elo
      difference with a confidence interval** (and LOS) from the result — a real, in-browser way to
      *measure* that the engine's knobs do what they claim.

## Play-tab polish (planned this session)

- [x] **Two-sided live game clock** with a per-side countdown and **flag-fall** (both the human and the
      engine), driven off the existing time-control presets — not just the engine's clock.

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
- 2026-06-25 (claude): **Endgame mastery + benchmarking + pondering** pass. (1) **KBNvK tablebase**
  (`kbnk.ts`): the complete King+Bishop+Knight vs King distance-to-mate table — the hardest elementary
  mate — generated in-browser by **backward retrograde BFS** over all ~33.6M positions (~10s). Wired into
  the eval for perfect play, with a corner-driving heuristic fallback that also wins. A new Lab tab builds and
  **exhaustively self-verifies** it: 10,822,184 winning / 11,188,168 lost / 2,525,736 drawn positions, longest
  forced mate 33 moves (65 plies), 196,758/196,758 retrograde-consistency checks hold, and 3,000/3,000 optimal
  self-play games mate in exactly the stored distance (0 mismatches). (2) **EPD test-suite runner** (`epd.ts`
  + Lab tab): scores the engine against the *published* best moves of the Bratko–Kopec and Win-at-Chess suites
  at a chosen budget (~16/22 at 1.5s). (3) **Search strength**: internal iterative reduction (off the PV),
  countermove heuristic, history malus, improving-aware pruning — **~23% fewer nodes to reach a given depth**
  with no tactical regression (still solves every forced-mate puzzle); plus `maxNodes`/`softTime` options.
  (4) **Pondering** on a second worker with instant *ponder hits*, and an explicit **movetime** control.
  (5) **Opening explorer** and **annotated-PGN export** ([%eval] + ?!/?/?? glyphs) on the Analyze board.
  Validated offline (rolldown-bundled Node harnesses: KBNvK build+verify, KBNvK/heuristic self-play to mate,
  EPD legality + pass rate, search node-efficiency, annotated-PGN round-trip) and with a **headless-Chromium**
  run of the live build: the app loads with **zero console errors**, the KBNvK table builds + verifies
  in-browser in 10.5s, and a full play loop with pondering + movetime replies cleanly. Clean lint/build via
  `scripts/verify-project.mjs`.
- 2026-06-25 (claude): **Generalized tablebase engine + persistence + time management** pass.
  (1) **`gtb.ts`** — one *material-generic* retrograde solver derives the whole family of pawnless 3–4-man
  distance-to-mate tablebases (backward retrograde BFS over a **DTM-keyed bucket queue**, with Syzygy-style
  **sub-table probing**: a defender capture leaving a still-won residual is scored from the relevant 3-man table).
  It **reproduces the hand-rolled KRvK / KQvK (`egtb.ts`) and KBNvK (`kbnk.ts`) tables bit-for-bit** — the proof it's
  correct — and newly solves **KBBvK** (the two-bishop mate, a forced win, ≤19 moves), **KNNvK** (correctly a draw)
  and every major combination (KQRvK, KRRvK, KQQvK, KRBvK, KRNvK, KQBvK, KQNvK). (2) **`tbcache.ts`** — sandbox-safe
  **IndexedDB** persistence so a built table survives a reload and warms instantly; (3) **`endgames.ts`** warms the
  cached table before the search, and the **eval probes the generic tables** (exact DTM-graded wins, true 0 for proven
  draws material count misjudges). (4) A new **Endgame TBs** Lab tab builds + verifies any ending with progress, oracle
  cross-checks, Bellman optimality, self-play to mate, the longest-mate FEN, and cache controls. (5) **`clock.ts`** —
  real **UCI-style time management** (clock + increment, 1+0 … 10+5) with a live engine clock, replacing fixed movetime.
  Validated offline (esbuild-bundled Node harnesses): KRvK/KQvK/KBNvK match the oracles with **0 mismatches** across
  ~1.3M sampled probes, Bellman holds on every sample, and 3,000/3,000 optimal self-play games per ending mate in
  exactly the stored distance; the engine **checkmates from random KBBvK / KQRvK / KRBvK / KRNvK positions against any
  defence** (8/8 each) once the table is resident. A **headless-Chromium** run of the live build loads with **zero
  console errors**, builds + verifies KQvK against the egtb oracle in-browser, and persists it to IndexedDB. Clean
  lint/build via `scripts/verify-project.mjs`.

- 2026-06-26 (claude): **Neural evaluation (NNUE)** pass — the one headline feature modern engines have that
  Cortex was missing. Built a from-scratch **NNUE** (`nnue.ts`, no ML libraries): a 768-feature-per-perspective
  transformer feeding two **colour-indexed accumulators**, a clipped-ReLU and a linear head → stm-relative
  centipawns. The centrepiece is the **efficiently-updatable accumulator**: `applyMove(±1)` folds a single move's
  feature deltas into both accumulators in O(features touched), and because the feature set is plain piece-square
  (not king-bucketed) *every* move — castling, en passant, promotion — is a pure incremental update and a null move
  costs nothing. Trained **in-browser by knowledge distillation** (`nnue-train.ts`): positions are sampled by seeded
  self-play, labelled with Cortex's own classical `evaluate`, and a **hand-rolled Adam SGD** loop with hand-derived
  gradients (sparse W1 updates over only the active features) fits the net. Wired it into search via
  `Searcher.setEvaluator(net)` — the accumulator is refreshed at the root and updated incrementally through
  make/unmake — and into play through a worker `setnnue` message + a **"NNUE eval" toggle** in the Play panel (the
  trained net is persisted to **IndexedDB**, `nnue-cache.ts`, and re-hydrated for play). A new **NNUE Lab tab**
  trains live (loss curve + progress), shows the **net-vs-classical correlation** (scatter + R²/Pearson/RMSE), runs
  the **accumulator-equivalence + gradient-check** self-tests, saves/loads/clears the net, and plays an **8-game
  head-to-head** (NNUE eval vs classical eval, same search). The **Self-tests** tab gains the two NNUE checks.
  **Validated outside the browser first** (vite-SSR bundle, Node): the incremental accumulator is **bit-for-bit
  identical to a full refresh** (max Δ 2.1e-6, 0 eval mismatches over 1,200 positions), the hand-derived gradients
  pass the finite-difference check (**max rel err 4.2e-4** over 49 probed params), training drives the holdout MSE
  **1.32 → 0.11** with **R²=0.916 / r=0.963 / RMSE 199cp** vs the classical eval, the weights serialize/round-trip,
  and an NNUE-driven search plays only legal moves and completes a head-to-head match. Clean scope + conformance +
  lint + tsc + vite build via `node scripts/verify-project.mjs cortex-chess-7q4d`.
- 2026-06-26 (claude): **Ship a pre-trained NNUE so it works out of the box.** The NNUE eval was fully built but the
  toggle was *disabled on a fresh page load* — you had to train and save a net in the Lab first. Closed that gap by
  baking in a **default network, trained offline to convergence** with the repo's *own* trainer and serializer (no new
  architecture): `tools/train-default-nnue.ts` runs `generatePositions` → `NnueTrainer` → `correlation` exactly as the
  Lab does, just longer (50k distilled positions, 45 epochs), and writes `nnue-weights.ts` — a base64 Float32 blob plus
  its `NnueMeta`. The shipped net reaches **holdout R²=0.9939, Pearson r=0.9970, RMSE 55 cp** vs the classical eval —
  it reproduces the hand-crafted evaluation almost exactly (start 10≈10 cp, +Q +1005≈+1014 cp). `App` now loads this
  default whenever IndexedDB has no user-trained net (a net you train in the Lab still wins), so **"NNUE eval" is
  usable immediately** and the toggle reads "shipped · R²=0.99". Verified offline that the baked blob round-trips
  through `deserializeNnue` and evaluates within a few cp of the classical eval on material/midgame probes, and with a
  **headless-Chromium** run of the live build: the app loads with **zero console errors** and the neural engine plays.
  Additive only — reuses #336's NNUE wholesale, adds the trainer harness + the weights module + a one-line default in
  `App`. Clean lint + tsc + vite build via `node scripts/verify-project.mjs cortex-chess-7q4d`.
- 2026-06-26 (claude): **Chess960 / Fischer Random — a whole new variant, played and proven.** Re-encoded castling
  as **king-captures-rook** (a castle's `to` is the rook's origin) with a **per-position rights-mask**, so one code
  path serves standard chess *and* every 960 layout where the king and rooks start on arbitrary files. Rewrote
  make/unmake to vacate both home squares before filling the fixed g/c (king) and f/d (rook) targets — correct even
  when a destination square coincides with the other piece's origin — and generalised castle generation (king-path
  out-of/through/into-check + king-span/rook-span clear, for any files). FEN now reads **X-FEN** (`KQkq`, outermost-rook
  reading) *and* **Shredder-FEN** file letters and emits Shredder for 960 so FENs round-trip. Added `chess960.ts`: the
  **Scharnagl SP-ID** numbering both ways (`backRankForId`/`idForBackRank`, all 960, 518 = standard), `startFenForId`,
  `randomStartId`, and **`startFenForDfrc`** — Double Fischer Random falls out for free because castling rights are
  tracked per side. SAN (`O-O`/`O-O-O` by rook-vs-king file), the **NNUE accumulator** (king+rook folded as one update,
  no false capture), and **move input** (drop the king on g/c *or* click your own rook) are all 960-aware. New Play-panel
  **Chess960 controls** (Random 960 / a chosen SP-ID / #518 standard / Random DFRC, with a live SP-ID badge) and a FEN
  loader that auto-detects the variant. **Verified to the hilt outside the browser** (vite-SSR Node harness): standard
  perft (all 5 reference positions) is **bit-for-bit unchanged** through the new castle path; the SP-ID↔position map is a
  bijection over all 960 (id 518 = `RNBQKBNR`); SP-518 routed through the 960 path matches reference perft 20/400/8902/197281;
  make/unmake + incremental hashing are exact and FENs restore over random 960 *and* DFRC perft trees; an **independent
  castle-move oracle** (a from-scratch re-derivation) agrees node-for-node across perft trees — **31,312** castle moves
  cross-checked with zero mismatches; perft is colour-flip symmetric; engine **self-play from random 960 starts** plays
  only legal moves (144 plies, 10 castles, no hash drift) and the NNUE accumulator stays equal to a full refresh across
  960 games that castle. A **headless-Chromium** run of the live build: **zero console errors**, Random 960 and Random
  DFRC update the board + badge, and the in-browser Self-tests report **22/22** (the six new Chess960 checks included).
  The whole layer self-tests in-app via `chess960Selftest`. Clean scope + conformance + lint + tsc + vite build via
  `node scripts/verify-project.mjs cortex-chess-7q4d`.
- 2026-06-26 (claude): **Cortex Coach — full game review, an Engine Arena, and a two-sided clock.** Three
  additive features that turn the engine into a coach and a measuring instrument, none of them touching the
  hot search/movegen paths. (1) **`engine/review.ts`** — a principled, no-external-service review model: a
  logistic **win-probability** from centipawns, per-move **accuracy %** from the win-% drop, per-player
  **accuracy** computed the lichess way (the mean of a volatility-weighted mean and a harmonic mean of the
  move accuracies), **ACPL**, and an estimated rating. A move **classifier** flags Brilliant (a SEE-negative
  sacrifice that's still the best move and stays at least equal), Great (the only move that holds — the
  2nd-best is far worse), Best / Excellent / Good / Book / Inaccuracy / Mistake / Blunder, and
  **Missed win / missed mate**; plus a **coach note** per move written purely from engine facts (played vs.
  best, the eval swing, "hangs material" via SEE, "missed mate in N", and the best line in SAN). It runs off
  a worker **`review`** request — a **multi-PV(2)** sweep over every node that streams progress and returns
  the best line + score + 2nd-best — exposed as `useEngine().reviewGame` with a synchronous fallback.
  (2) A new **Review tab** (`components/Review.tsx`): paste a PGN (or pick the Opera / Immortal /
  Kasparov–Topalov samples), hit **Review**, and get a two-player **accuracy scoreboard** (accuracy %, ACPL,
  ≈Elo, a per-class tally), a **classification-coloured move list**, a **key-moments** list, a navigable
  board with a best-move arrow, a whole-game eval graph, and a **coach card** for the move you're on.
  (3) An **Engine Arena** Lab tab (`components/Lab.tsx`): pit two configs (search node budget × classical /
  NNUE eval) over N games from eight varied openings (both colours), with a live score and an **Elo
  difference + 95% CI + LOS** computed from the result. (4) A **two-sided live clock** on the Play tab — a
  real-time per-colour countdown with **flag-fall**, unified around a single ticker (the engine reads its own
  colour's clock for time allocation; every move credits that colour the increment), replacing the old
  engine-only clock. `reviewSelftest()` joins the **Self-tests** Lab tab. **Validated outside the browser**
  (`tools/test-review.ts`, vite-SSR/Node): the win% curve is monotone/symmetric and pinned at 50 cp=0,
  accuracy is 100 at no loss and decreasing, the classifier flags a forced-mate miss / a large swing / a best
  move correctly, and a full review of the **Opera Game** scores **Morphy 97.6 % vs the Allies 86.2 %** with
  **Rxd7 flagged Brilliant** and the mate detected — all invariants green. A **headless-Chromium** run of the
  live build: a review completes with the scoreboard + 33 classified moves + 5 key moments and **zero console
  errors**; the Arena plays a 6-game match (a 2k-node engine swept 0–6 by a 30k-node engine, ≈ −1600 Elo, LOS
  0.7 %) with zero errors; and the two-sided clock counts down for the side to move, highlights the active
  side, and credits the increment on a move. Clean scope + conformance + lint + tsc + vite build via
  `node scripts/verify-project.mjs cortex-chess-7q4d`.
