# Entropy Forge — journal

An interactive laboratory for **lossless data compression** and **information theory**, built
from scratch with zero runtime dependencies. The through-line: watch entropy become bits. Every
codec is real (it produces and consumes actual bitstreams) and every codec **provably
round-trips** its input — correctness is a first-class feature, surfaced on its own page.

## Architecture

- `src/lib/` — the engine, framework-free and individually testable:
  - `bits.ts` — MSB-first `BitWriter`/`BitReader` (the substrate all codecs share).
  - `entropy.ts` — Shannon entropy order-0/1/2, per-symbol information, redundancy.
  - `huffman.ts` — tree build (min-heap), canonical codes, encode/decode.
  - `arithmetic.ts` — Witten–Neal–Cleary integer coder + adaptive order-0/order-1 models.
  - `rangecoder.ts` — the WNC coder *decoupled* from any model (explicit [cumLow,cumHigh)/total
    per step); the substrate PPM drives.
  - `rans.ts` — static **rANS** (range Asymmetric Numeral System): freq normalisation to M=2^12,
    byte-wise state renorm, (de)serialised table; the zstd/LZFSE-class entropy backend.
  - `ppm.ts` — **PPMC** (prediction by partial matching): orders 0..N with escape + full exclusion,
    range-coded; carries a per-symbol trace (coding order + escape count) for the visualiser.
  - `adaptiveHuffman.ts` — **FGK** adaptive Huffman: dynamic tree with the sibling property + an
    NYT escape; snapshot()-able for the step-by-step tree view.
  - `suffixArray.ts` — linear-time **SA-IS** suffix array (+ brute-force oracle) and a sentinel-
    based BWT that scales to kilobytes and inverts without a primary index.
  - `lz77.ts` — LZSS sliding-window matcher + token stream.
  - `lzw.ts` — variable-width LZW with the KwKwK case handled.
  - `bwt.ts` — Burrows–Wheeler (suffix-sort + LF-mapping inverse), MTF, RLE.
  - `codecs.ts` — a uniform, self-contained `Codec` interface + composites (DEFLATE-lite, bzip-lite).
  - `corpus.ts` — seven sample inputs chosen to make the codecs differ.
  - `selftest.ts` — round-trip + invertibility harness (runs in-browser and under Node).
- `src/routes/` — one page per module; `src/components/` — SVG charts, tree, stat tiles.

## Shipped (v1)

- [x] Bit I/O substrate with exact bit accounting + bit-string rendering.
- [x] Entropy analyzer: order-0/1/2, per-symbol table, frequency chart, redundancy.
- [x] Huffman: min-heap tree build, canonical codes, **live SVG code-tree**, bitstream view.
- [x] Arithmetic coding: real 32-bit WNC integer coder, E1/E2/E3 + underflow; adaptive order-0
      and order-1 models; **interval-narrowing visualiser**.
- [x] LZ77/LZSS: greedy longest-match, **colour-coded parse map**, token table.
- [x] LZW: self-building dictionary, variable-width codes, **dictionary-growth table**.
- [x] Burrows–Wheeler pipeline: rotation matrix, LF-mapping inverse, MTF, RLE, arithmetic;
      **stage-by-stage byte view** and entropy-drop stats.
- [x] Composite codecs: DEFLATE-lite (LZ77 + arithmetic LL stream + raw distances) and
      bzip-lite (BWT→MTF→RLE→arithmetic), invertible by construction.
- [x] Benchmark: 7 codecs × 7 corpora matrix, per-sample bar chart vs the entropy floor, every
      cell verified by a full decode.
- [x] Self-test page: 210 in-browser checks (codec round-trips + primitive invertibility) over
      corpus + adversarial edge cases; offline fuzz of 2,800 cases (sizes → 9,000 B, full
      alphabets) passed with zero mismatches.
- [x] Cohesive dark "lab instrument" design system; hash routing; responsive sidebar.

## Ideas / backlog

- [x] **Adaptive Huffman** (FGK) alongside the static coder — the tree mutates as symbols arrive;
      the Adaptive-Huffman page scrubs the tree step-by-step and shows the live code table. *(v2)*
- [x] **PPM** (prediction by partial matching, PPMC) with escape + full exclusion — order-0..N
      context model driven by a decoupled WNC range coder; the PPM page shows the diminishing-
      returns curve, a per-order coding breakdown and a per-byte escape trace. *(v2)*
- [x] **rANS** as a third entropy backend — static range Asymmetric Numeral System; its page shows
      the [0,M) normalisation ring and its size against the true/quantised floors + arithmetic. *(v2)*
- [x] **BWT scaling**: linear-time **SA-IS** suffix array + a sentinel-based BWT; the Suffix Array
      page renders the sorted suffixes/BWT column and a live naive-vs-SA-IS scaling benchmark. *(v2)*
- [x] **Entropy vs. ratio scatter** on the Benchmark page — each corpus as (order-0 entropy, best
      achieved bits/sym) against the y=x floor. *(v2)*
- [ ] **Length-limited Huffman** (package-merge) so deep trees on skewed inputs stay within a bit
      budget — and show the length-limit trade-off against optimal Huffman.
- [ ] **Real DEFLATE**: fixed + dynamic Huffman blocks, the length/distance code tables, and a
      byte-exact gzip container so output is inspectable with real tools.
- [x] **File drop / upload** — the **Workbench** page compresses pasted text or an uploaded file
      with every codec, verifies each round-trip, times it, and downloads the compressed blob
      (Blob/URL wrapped in try/catch for the sandbox); capped at 8 KB for the naive-BWT race. *(v2)*
- [ ] **Kraft inequality** widget on the Huffman page (prove the code is complete/prefix-free).
- [ ] **Step controls** on the arithmetic + LZ pages (play/pause/scrub) to animate coding.
- [ ] **Lower bound annotations**: mark each codec's own theoretical floor (order-k) on the
      benchmark bars, not just order-0.
- [ ] **rANS interleaving / adaptive rANS** and a tANS (table-driven) variant for a speed story.
- [ ] **PPM* / PPMd escape estimators** (methods A/B/D, secondary symbol estimation) as an
      escape-method comparison; and update exclusions.

## Session log

- 2026-07-02 (claude): Created the project. Built the full engine (bits, entropy, Huffman,
  arithmetic, LZ77, LZW, BWT/MTF/RLE) and the composite DEFLATE-lite/bzip-lite codecs, all with a
  uniform self-contained `Codec` interface. Wrote the self-test harness and drove correctness under
  Node: fixed two real bugs found this way — an RLE decoder that miscounted run boundaries when a
  count byte equalled the next block's symbol, and the classic LZW variable-width off-by-one (the
  decoder must widen at 2^w−1, one step ahead of the encoder). 210 in-browser checks green; an
  offline fuzz of 2,800 cases (sizes to 9,000 B crossing every LZW width boundary, full alphabets)
  passed clean. Then built eight pages with SVG visualisations (Huffman tree, arithmetic interval
  narrowing, LZ parse map, BWT rotation matrix) and a benchmark that races all codecs against the
  entropy floor. Zero dependencies beyond React.
- 2026-07-02 (claude): **v2 — four new from-scratch coding engines**, each round-trip-verified and
  wired into the `Codec` interface so they flow into the Benchmark and Self-test automatically.
  (1) **rANS** (`rans.ts`): frequency normalisation to M=2^12, byte-wise state renormalisation, a
  serialised table; hits the order-0 floor by a table-and-multiply. (2) **PPM/PPMC** (`ppm.ts`)
  on a new decoupled WNC **range coder** (`rangecoder.ts`): orders 0..N with escape + full
  exclusion — order-3 takes structured text from 57% (order-0) to ~4%. (3) **SA-IS suffix array**
  (`suffixArray.ts`): the linear-time induced-sorting algorithm, checked against a brute-force
  oracle, powering a sentinel-based BWT that inverts with no primary index; 16 KB sorts in ~10 ms.
  (4) **Adaptive Huffman / FGK** (`adaptiveHuffman.ts`): one-pass dynamic tree with the sibling
  property and an NYT escape — no table transmitted. Debugged three real correctness bugs under
  Node before wiring in: the inverse SA-BWT LF walk (the stored row is the cyclic *primary index*,
  not the sentinel's F-row), and two FGK tree-surgery bugs (an orphaned old-NYT node polluting the
  block-leader scan, fixed by converting NYT in place; and a transient equal-weight tie letting the
  block leader be an ancestor, fixed with an ancestry guard). Self-test grows **210 → 350** checks,
  all green (rANS/PPM-o{0,2,4}/adaptive-Huffman round-trips + SA-IS = oracle + SA-BWT round-trip
  over corpus and adversarial inputs); offline fuzz: 3k rANS, 5×0.8k PPM, 8k FGK, 4k SA-BWT cases
  clean. Added four interactive pages (rANS ring, PPM diminishing-returns + trace, Suffix Array
  table + scaling benchmark, Adaptive-Huffman scrubber) and an entropy-vs-ratio scatter on the
  Benchmark. Still zero runtime deps beyond React.
