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

- [ ] **Length-limited Huffman** (package-merge) so deep trees on skewed inputs stay within a bit
      budget — and show the length-limit trade-off against optimal Huffman.
- [ ] **Adaptive Huffman** (FGK / Vitter) alongside the static coder, to mirror the adaptive
      arithmetic story and animate the tree mutating as symbols arrive.
- [ ] **PPM** (prediction by partial matching) with escape symbols — a proper order-N context
      model to sit above order-1 arithmetic and show diminishing returns per order.
- [ ] **rANS / range coder** as a third entropy backend; compare speed/size against WNC.
- [ ] **Real DEFLATE**: fixed + dynamic Huffman blocks, the length/distance code tables, and a
      byte-exact gzip container so output is inspectable with real tools.
- [ ] **File drop / upload**: compress arbitrary user bytes (with the sandbox `try/catch` guards)
      and show a live size readout; add a download of the compressed blob.
- [ ] **BWT scaling**: swap the O(n² log n) rotation sort for a real suffix-array (DC3/SA-IS) so
      the pipeline handles kilobytes, and visualise the suffix array.
- [ ] **Kraft inequality** widget on the Huffman page (prove the code is complete/prefix-free).
- [ ] **Entropy vs. ratio scatter**: plot every corpus as (order-0 entropy, best ratio) to make
      the "you can't beat entropy on random data" point visually.
- [ ] **Step controls** on the arithmetic + LZ pages (play/pause/scrub) to animate coding.
- [ ] **Lower bound annotations**: mark each codec's own theoretical floor (order-k) on the
      benchmark bars, not just order-0.

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
