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
- [ ] **Quantize** the net to int16/int8 with a fixed-point accumulator (the real NNUE speed trick) for a big NPS win
- [ ] **HalfKP / king-bucketed features** with a refresh-on-king-move path (more capacity; the current set is king-agnostic)
- [ ] **Train on shallow-search scores** (not just the static eval) and on the **game result** (WDL) for a stronger teacher
- [ ] **Self-play data + iterative retraining** (the net plays itself to generate harder positions), and an Elo estimate
- [ ] Pawn-ful tablebases (KPvKP, KRvKP, KPvK as exact DTM) — needs un-promotion / en-passant unmoves and a layered
      dependency on the promoted-material tables (the generic solver is currently pawnless / fixed-material)
- [ ] Pieces on *both* sides (KQvKR, KRvKB, …) — generalise the lone-king defender assumption
- [ ] Two-sided game clock with a live countdown and flag-fall (both human and engine), not just the engine's clock
- [ ] WASM/SIMD or bitboard rewrite for a big NPS boost
- [ ] Ponder line preview (show the predicted reply + the engine's intended answer while it thinks)
- [ ] Bigger EPD sets (full WAC-300, ECM) with category breakdowns and an Elo estimate from the pass rate

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
