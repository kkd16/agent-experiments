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
  - `tans.ts` — static **tANS / FSE** (table-driven ANS): the *multiply-free* finite-state entropy
    coder inside Zstandard. Shares rANS's normalised model, adds the FSE symbol-spread + encode/decode
    transition tables (Yann Collet's construction), and codes with lookups + shifts only.
  - `ppm.ts` — **PPMC** (prediction by partial matching): orders 0..N with escape + full exclusion,
    range-coded; carries a per-symbol trace (coding order + escape count) for the visualiser.
  - `adaptiveHuffman.ts` — **FGK** adaptive Huffman: dynamic tree with the sibling property + an
    NYT escape; snapshot()-able for the step-by-step tree view.
  - `logistic.ts` — the **stretch/squash** integer log-odds transform (lpaq's 33-knot spline + its
    inverse table); the domain all context-mixing math happens in.
  - `cm.ts` — **context mixing (PAQ/lpaq)**: a bit-level Predictor (order-0..6 + word + longest-match
    models, each an adaptive StateMap), a context-selected **logistic mixer**, two **SSE** stages, and
    a carryless 32-bit **binary arithmetic coder**. Encode and decode share the Predictor, so it
    round-trips by construction; carries an instrumented `cmAnalyze` pass for the visualiser.
  - `suffixArray.ts` — linear-time **SA-IS** suffix array (+ brute-force oracle) and a sentinel-
    based BWT that scales to kilobytes and inverts without a primary index.
  - `lz77.ts` — LZSS sliding-window matcher + token stream.
  - `lzw.ts` — variable-width LZW with the KwKwK case handled.
  - `bwt.ts` — Burrows–Wheeler (suffix-sort + LF-mapping inverse), MTF, RLE.
  - `crc32.ts` — **CRC-32** (the gzip/PNG reflected-poly checksum) + **Adler-32** (the zlib one).
  - `deflateTables.ts` — the fixed constants of RFC 1951: the length/distance base+extra-bit tables,
    the code-length-alphabet order, and the §3.2.6 fixed Huffman code.
  - `deflateBits.ts` — DEFLATE's own **LSB-first** bit reader/writer (its Huffman codes pack MSB-first,
    everything else LSB-first) and the canonical-Huffman code builder + puff-style decoder.
  - `deflate.ts` — a real, **RFC 1951-compliant DEFLATE** codec: a 32 KB hash-chain + lazy LZ77 matcher,
    stored/fixed/dynamic block encoders (dynamic codes built by package-merge, capped at 15 bits), an
    auto-selector that emits the cheapest block, and the inflater.
  - `gzip.ts` — the **gzip (RFC 1952)** and **zlib (RFC 1950)** containers, encode + decode, with
    CRC-32/Adler-32 + ISIZE verification and annotated header parsing.
  - `codecs.ts` — a uniform, self-contained `Codec` interface + composites (DEFLATE-lite, bzip-lite)
    **and the real `gzip` codec** (so it races in the Benchmark and Self-test automatically).
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
- [x] **Length-limited Huffman** (package-merge, Larmore–Hirschberg) — the Huffman page gains a
      cap slider showing the depth/size trade-off (bits rise above the unlimited optimum as the cap
      tightens; matches optimal exactly when the cap ≥ natural depth). *(v2)*
- [x] **Kraft inequality** widget on the Huffman page — a live Σ2⁻ˡⁱ bar proving the length-limited
      code is complete and prefix-free. *(v2)*
- [x] **Real DEFLATE**: fixed + dynamic Huffman blocks, the length/distance code tables, and a
      byte-exact gzip container so output is inspectable with real tools. **Shipped in v3** (see below) —
      the output round-trips through the browser's own `gunzip` and beats zlib level 9 on several corpora.
- [x] **File drop / upload** — the **Workbench** page compresses pasted text or an uploaded file
      with every codec, verifies each round-trip, times it, and downloads the compressed blob
      (Blob/URL wrapped in try/catch for the sandbox); capped at 8 KB for the naive-BWT race. *(v2)*
- [ ] **Kraft inequality** widget on the Huffman page (prove the code is complete/prefix-free).
- [ ] **Step controls** on the arithmetic + LZ pages (play/pause/scrub) to animate coding.
- [ ] **Lower bound annotations**: mark each codec's own theoretical floor (order-k) on the
      benchmark bars, not just order-0.
- [x] **tANS (table-driven) variant** — shipped in v4 (see below): the multiply-free FSE coder,
      cross-checked to land within a few bytes of rANS on every input (same quantised floor). *(v4)*
- [ ] **rANS interleaving / adaptive rANS** (two interleaved states for ILP) for a speed story.
- [ ] **PPM* / PPMd escape estimators** (methods A/B/D, secondary symbol estimation) as an
      escape-method comparison; and update exclusions.
- [x] **Context mixing (PAQ/lpaq)** — the state-of-the-art family. A bit-level logistic mixer over
      order-0..6 + word + longest-match models, two SSE stages, and a binary arithmetic coder.
      Shipped in **v5** (see below): the strongest all-rounder in the lab, with its own visualiser
      (learning curve, mixer trust weights, per-model accuracy, prediction ribbon, match trace). *(v5)*
- [ ] **CM tuning pass**: an 8-bit nonstationary state-machine counter (lpaq's `nex` table) instead
      of the running-mean StateMap; a two-layer mixer; an indirect/sparse model; a run model. Each is a
      few percent and a clean incremental follow-up on the v5 architecture.

## Entropy Forge v3 — Real DEFLATE (the actual gzip)

Every codec here was "real" in the sense that it produced and consumed a genuine bitstream — but none
of them was a *format*. DEFLATE is the format: the algorithm inside **gzip, zlib, PNG and ZIP**, and
the one place where "does it round-trip against my own decoder" is no longer the bar. The bar is
**interoperability** — does the bytestream this lab emits open in the tools the rest of the world uses?
v3 clears that bar, both directions, and proves it live in the browser.

### What shipped (all from scratch, zero new deps)

- [x] **CRC-32 + Adler-32** (`crc32.ts`) — the integrity checksums the two containers carry, verified
      against the canonical vectors (`CRC32("123456789") = 0xCBF43926`, `Adler32("Wikipedia") = 0x11E60398`)
      and against Node's `zlib.crc32` over the whole corpus.
- [x] **The RFC 1951 constant tables** (`deflateTables.ts`) — the 29 length codes and 30 distance codes
      with their base values and extra-bit counts, the shuffled code-length-alphabet order, and the
      §3.2.6 fixed Huffman code, plus reverse maps (actual length → code, actual distance → code).
- [x] **DEFLATE's bit order, done right** (`deflateBits.ts`) — the format's genuinely tricky rule
      (§3.1.1): plain fields pack **least-significant-bit-first**, but Huffman codes pack
      **most-significant-bit-first**, so every canonical code is bit-reversed on the way out. The
      single most common DEFLATE bug; a dedicated LSB-first writer/reader isolates it. Plus the
      canonical-code builder (lengths → codes) and a compact puff.c-style count/symbol decoder.
- [x] **A real LZ77 stage** (`deflate.ts`) — a 32 KB sliding window (vs the lab's toy 4 KB), matches
      up to 258 bytes, a **15-bit rolling hash + chained `head`/`prev`** match finder, and zlib-style
      **lazy matching** (hold a match one byte to see if the next position beats it). Three effort
      levels (`fast`/`default`/`max`) expose the chain-length ↔ ratio trade-off.
- [x] **All three block types** — **stored** (raw, chunked at 65535 B), **fixed** (the canned Huffman
      code, no header), and **dynamic** (a Huffman code tailored to the block). Dynamic codes are the
      provably-optimal length-limited codes from the lab's own **package-merge** (capped at 15 bits),
      the two length tables run-length-compressed by the 19-symbol code-length alphabet (16/17/18
      repeat codes) and that code emitted in HCLEN order. An **`auto`** strategy encodes all three and
      ships the smallest — exactly what real encoders do per block.
- [x] **The gzip (RFC 1952) & zlib (RFC 1950) containers** (`gzip.ts`) — encode and decode, with the
      10-byte gzip header (magic/CM/FLG/MTIME/XFL/OS), optional FNAME, the little-endian CRC-32 + ISIZE
      trailer, and zlib's 2-byte CMF/FLG (mod-31 checked) + **big-endian** Adler-32. Decode verifies the
      checksum and length and returns annotated field offsets for the hex viewer.
- [x] **The inflater** — a full block-loop decoder (stored/fixed/dynamic), handling the RFC's special
      cases (the single incomplete distance code; forcing ≥2 literal/length codes so an empty input's
      lone EOB is still a *complete* tree, which zlib requires).
- [x] **The `gzip` codec is wired into `codecs.ts`**, so it now races in the Benchmark (winning several
      corpora — e.g. beating every other codec on DNA and source) and round-trips in the Self-test
      automatically.
- [x] **A `DEFLATE & gzip` lab page** (`routes/Deflate.tsx`): live gzip size + CRC, a **native-interop
      badge** that runs our gzip through the browser's `DecompressionStream` and vice-versa, a
      **block-type showdown** bar chart (stored vs fixed vs dynamic, the auto-pick highlighted), the LZ77
      parse map over the 32 KB window, the **dynamic-block anatomy** (HLIT/HDIST/HCLEN, header-vs-body
      bit split, and the three live code tables — code-length, literal/length, distance), and an
      **annotated gzip hex dump** with the payload elided and every header/trailer field colour-keyed.

### Correctness — the interop proof

Verified under Node against the real `node:zlib` before wiring any UI: for empty / single-byte / long-run
/ text / random / all-256 / 17 KB inputs × {stored, fixed, dynamic, auto} × 3 effort levels, (1) our
`inflate(deflate(x)) = x`, (2) **`zlib.inflateRawSync(ourDeflate(x)) = x`** — the platform accepts our
stream — and (3) **`ourInflate(zlib.deflateRawSync(x)) = x`** — we accept the platform's. Same three
ways for the gzip and zlib containers against `gzipSync`/`gunzipSync`/`deflateSync`/`inflateSync`. In the
browser the same cross-check runs live via `CompressionStream`/`DecompressionStream` (28 cases). Our
`auto` encoder matches or **beats zlib level 9** on the structured corpora (e.g. text 60 B vs 63 B,
repeated-lorem 117 B vs 118 B). The in-app Self-test grows **364 → 464** checks, all green, plus the 28
live native-interop checks.

## Entropy Forge v5 — Context mixing (the PAQ engine)

Every coder here so far models *symbols*: it estimates the next byte (or the next LZ token) and codes
it. Context mixing throws that out and models the next **bit**, but with *many* models at once, and
adds the one component none of the others have — a learner that decides, online and per-context, which
models to believe. This is the architecture behind **PAQ**, **cmix** and **lpaq**: the strongest
general-purpose compressors ever measured. v5 builds it from scratch, and it walks into the Benchmark
as the best all-rounder in the lab.

### The mechanism (all from scratch, zero new deps)

- [x] **The logistic substrate** (`logistic.ts`) — `stretch`/`squash`, the integer log-odds transform
      (the lpaq 33-knot spline + its inverse table). CM never averages probabilities; it averages them
      in the log-odds domain, where independent evidence adds linearly. Everything is integer and
      table-driven, because encode and decode must compute *bit-identical* predictions.
- [x] **The model panel** (`cm.ts`) — eight predictors of P(next bit = 1): six byte-context models
      (orders 0,1,2,3,4,6), a **word model** (a rolling hash of the current run of letters, reset on a
      boundary), and a **match model** that finds where the current 4-byte context last occurred and
      predicts the byte that followed, with a confidence that climbs with the match length. Each context
      model is a **StateMap**: a 22-bit adaptive probability with a saturating count, so the learning
      rate is ∝ 1/n — a fresh context adapts fast, a well-seen one holds steady (a nonstationary running
      estimate).
- [x] **The logistic mixer** — the heart of CM. It combines the eight stretched predictions with a
      weighted sum and squashes the result; after each bit it takes an **online logistic-regression
      step**, nudging each weight to reduce the error. So a model that keeps being right gains influence
      and a noisy one fades — automatically, per input. The weight set is **context-selected** (by the
      partial byte and whether a match is live, 512 sets), so the mixer trusts different models in
      different places.
- [x] **Two SSE stages** — adaptive probability maps (secondary symbol estimation): they take the mixed
      probability and a context and correct its calibration by interpolating over 33 learned buckets.
      The last few percent.
- [x] **A carryless 32-bit binary arithmetic coder** — the fpaq0/lpaq scheme, driven one bit at a time
      by the final 12-bit probability; encoder and decoder are exact mirrors. Nothing is transmitted but
      the length + coded stream — the decoder rebuilds the identical panel and replays every update, so
      correctness is *structural*.
- [x] **The `cm` codec is wired into `codecs.ts`**, so it races in the Benchmark and round-trips in the
      Self-test automatically, and a **Context mixing** lab page (`routes/ContextMixing.tsx`): a live
      **bits-per-byte learning curve** (the cost per byte falling as the models sharpen), the mixer's
      **signed per-model trust weights** (a diverging bar per model), **per-model accuracy**, a
      **bit-by-bit prediction ribbon** (green where the panel bet correctly, red where it was
      surprised, height = confidence), and the **match length climbing** over repetitive data — plus a
      size race against PPM, gzip and order-1 arithmetic.

### Correctness & result

Driven under Node before wiring any UI: round-trips every corpus + edge input (empty, single byte,
all-256, long run, pseudo-random) on the first try, plus a **400-case fuzz** (random lengths to ~900 B
over alphabets of 1–12 symbols) with zero mismatches. On the seven-corpus benchmark it is the **best
all-rounder** — it wins `lorem`, `json`, `source` and even `random` outright, and lands within a byte
or two of PPM on `declaration`, `dna` and `repetitive`. In-app Self-test grows **506 → 534** checks
(14 CM codec round-trips + 14 CM primitive round-trips), all green. Still zero runtime deps beyond
React.

## Session log

- 2026-07-03 (claude): **v5 — Context mixing (the PAQ engine).** Built the state-of-the-art
  compression family from scratch: `logistic.ts` (the stretch/squash log-odds substrate) and `cm.ts`
  (a bit-level Predictor = order-0..6 + word + match models, each an adaptive StateMap; a
  context-selected logistic mixer trained by online logistic regression; two SSE / adaptive-probability-map
  stages; and a carryless 32-bit binary arithmetic coder). Because encode and decode call the identical
  Predictor and replay the identical updates, a correct predictor is automatically a correct codec —
  proved by round-tripping every corpus + edge input and a 400-case fuzz under Node with zero
  mismatches. Wired the `cm` codec into the roster (it races in the Benchmark and Self-test) and built
  the **Context mixing** lab page (bits-per-byte learning curve, signed mixer trust weights, per-model
  accuracy, a bit-by-bit prediction ribbon, and the match-length trace). On the benchmark it is the
  best all-rounder — winning most corpora outright and within a byte or two of PPM on the rest.
  Self-test **506 → 534**, all green. Also added `.prose-list` styling and surfaced CM on the Overview.
- 2026-07-03 (claude): **v4 — tANS / FSE, the multiply-free entropy coder.** Added `tans.ts`: a
  from-scratch static **table-driven ANS** — the Finite State Entropy coder inside **Zstandard** and
  Apple's LZFSE. It reuses rANS's normalised M=2^12 frequency table (so the two share a model), then
  builds the FSE machinery: the symbol **spread** (an odd-stride permutation of the 4096 states),
  Yann Collet's **encode transition tables** (`deltaNbBits`/`deltaFindState` + the state table, with
  the `freq==1` and power-of-two `highbit` special cases handled), and the **decode tables**
  (per-state symbol / bits-to-read / next-state base). The whole codec is a finite-state machine —
  **no multiplies**, only lookups, shifts and bit I/O. Being LIFO like all ANS, the encoder records
  its bit-writes and lays them into the stream in reverse, so a plain forward MSB-first reader inverts
  it exactly. Verified under Node: round-trips every input on the first try, and — the headline
  invariant — its coded payload lands **within a few bytes of rANS** on every corpus (both hit the same
  quantised floor; tANS is often a touch smaller thanks to a smaller state flush). Wired the `tans`
  codec into the roster (races in Benchmark + Self-test) and added a **tANS / FSE** page: a
  "same floor, four ways" size chart (floor vs tANS vs rANS vs arithmetic), the symbol-spread strip,
  the live finite-state-machine transition table, and a bits-read-per-state histogram. Self-test
  **464 → 506** checks (adds tANS round-trips + the tANS≈rANS parity check across all inputs), all
  green. Still zero runtime deps beyond React.
- 2026-07-03 (claude): **v3 — Real DEFLATE / gzip.** Built the actual format from scratch: `crc32.ts`
  (CRC-32 + Adler-32), `deflateTables.ts` (the RFC 1951 length/distance/code-length tables + fixed code),
  `deflateBits.ts` (the LSB-first bit substrate + canonical Huffman builder/decoder), `deflate.ts`
  (32 KB hash-chain + lazy LZ77, stored/fixed/dynamic/auto block encoders with package-merge dynamic
  codes, and the inflater) and `gzip.ts` (the gzip + zlib containers). Wired the real `gzip` codec into
  the Codec roster and added the `DEFLATE & gzip` lab page (native-interop badge, block-type showdown,
  32 KB parse map, dynamic-block anatomy with live code tables, annotated gzip hex dump). Drove
  correctness against `node:zlib` first: fixed the zlib Adler-32 trailer endianness (it's **big**-endian,
  unlike gzip's little-endian fields) and handled the RFC's empty-input special case (force a complete
  ≥2-code literal/length tree so zlib's inflater doesn't reject the lone-EOB stream). Result: our
  output decompresses with the OS/browser gunzip, theirs inflates here, and `auto` beats zlib -9 on
  several corpora. Self-test **364 → 464** checks + 28 live native-interop cross-checks, all green.
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
- 2026-07-02 (claude): Added **length-limited Huffman** via package-merge (`lengthLimited.ts`),
  verified optimal (matches unlimited Huffman's total bits whenever the cap ≥ natural depth, Kraft
  = 1, prefix-free) and wired into the Huffman page with a cap slider + a **Kraft inequality** bar.
  Self-test 350 → **364** checks, all green.
