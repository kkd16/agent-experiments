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
  - `lzma.ts` — a genuine, from-scratch **LZMA** (the 7-Zip / xz coder): a binary **range coder**
    (11-bit adaptive probabilities, kTopValue renorm, the leading cache byte), the **12-state context
    machine**, the **rep0..rep3 distance MRU** recoded almost for free, bit-tree **posSlot + direct +
    align** distance coding, the low/mid/high **length coder**, **matched-literal** modelling, and an
    **HC4 match finder** (hash2/hash3 heads + hash4 chain) with a lazy, rep-preferring parse. Carries a
    token trace + stats for the visualiser. Decoder is length-driven (no end marker) and replays the
    identical model updates, so it inverts by construction.
  - `codecs.ts` — a uniform, self-contained `Codec` interface + composites (DEFLATE-lite, bzip-lite)
    **and the real `gzip` codec** (so it races in the Benchmark and Self-test automatically).
  - `png.ts` — a from-scratch, spec-compliant **PNG** (ISO 15948 / RFC 2083) codec on top of our own
    DEFLATE/zlib/CRC-32: the chunk layer (IHDR/PLTE/tRNS/IDAT/IEND + ancillary read-out), all five §6
    scanline filters (None/Sub/Up/Average/Paeth) with a libpng min-sum adaptive per-scanline chooser,
    every colour type × bit depth, **Adam7 interlacing**, and a raster ⇄ RGBA8 pixel layer (median-cut
    palette builder). Round-trips at the raw-raster level bit-for-bit.
  - `pngSamples.ts` — procedural RGBA source images for the Image Studio (gradient, colour wheel,
    rings, synthetic photo, flat UI blocks, noise, alpha vignette), each chosen to exercise the filters
    differently. `pngVectors.ts` — frozen known-answer PNGs made by Node's *independent* zlib.
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
- [x] **LZMA (the 7-Zip / xz coder)** — the strongest dictionary coder in the field. A from-scratch
      binary range coder, 12-state context machine, rep0..rep3 distance MRU, bit-tree distance/length
      coders, matched-literal modelling, and an HC4 match finder with a lazy rep-preferring parse.
      Shipped in **v6** (see below) with its own visualiser (packet stream, distance-source breakdown,
      state-machine table) and wired into the Benchmark + Self-test. *(v6)*

### LZMA roadmap (v6 follow-ups — the honest next steps)

- [ ] **Optimal parse** (LZMA's `GetOptimum`): a price-based forward dynamic program over a small
      window instead of the current lazy greedy. This is where LZMA's last few percent live — the
      current parse already leads the dictionary coders, but the optimal parse would close most of the
      gap to the context mixers on prose. Needs a bit-price estimator over the live probability model.
- [ ] **Short-rep packets in the encoder** — the decoder already handles the `IsRep0Long=0` length-1
      rep; teach the parser to emit it when a single byte matches at `rep0` and a literal would cost
      more, priced against the literal coder. A small, safe ratio win on structured data.
- [x] **Tunable `lc`/`lp`/`pb`** — shipped in **v7** (see below): the encoder now auto-races six
      (lc,lp,pb) presets and ships the smallest, storing its choice in the one-byte LZMA properties;
      the LZMA page shows every preset's size with the winner highlighted. This is what
      `xz --lzma2=lc=..,lp=..,pb=..` tunes. *(v7)*
- [ ] **A step-through of the range coder** on the LZMA page — watch `low`/`range` narrow bit-by-bit
      and the cache/carry ripple, the way the Arithmetic page animates the WNC interval.
- [ ] **LZMA2 chunk framing + a dictionary-reset control** — the container xz actually ships, so an
      `.xz`-shaped stream (with the real `lc/lp/pb` byte and uncompressed-chunk fallback) becomes
      inspectable, mirroring what the gzip page does for DEFLATE.
- [ ] **Delta + BCJ pre-filters** (the xz filter chain): a delta filter for tabular/audio data and a
      simple x86 BCJ call/jump filter, each shown improving LZMA's ratio on the data it targets.

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

## Entropy Forge v6 — LZMA (the 7-Zip / xz coder)

The lab had the two halves of a modern compressor sitting side by side but never joined: real LZ77
dictionary matching (`lz77.ts`, `deflate.ts`) and a family of adaptive entropy coders (arithmetic,
rANS, tANS, the PAQ mixer). **LZMA is what you get when you stop Huffman-coding the LZ token stream
and instead feed *every* decision — is-this-a-match, is-it-a-repeat, the length, the distance, the
literal byte — into one adaptive binary range coder with a rich, stateful context.** It is the
algorithm inside **7-Zip and xz**, and until v6 it was the obvious missing crown of the lab.

### What shipped (all from scratch, zero new deps)

- [x] **A binary range coder** (`lzma.ts`) — the LZMA variant, distinct from the WNC interval coder
      already in the lab: a 32-bit `range`, a 33-bit `low` with carry propagated through a **cache byte
      + cacheSize** run (the reference's leading-zero-byte trick), 11-bit adaptive bit probabilities
      nudged by `>> 5` toward each observed bit, and `kTopValue` (2²⁴) renormalisation. Encoder and
      decoder are exact mirrors; `encodeDirectBits`/`decodeDirectBits` handle equiprobable bits.
- [x] **The 12-state context machine** — every packet's probabilities are selected by a state that
      remembers whether the last few packets were literals or matches (states 0–6 vs 7–11); after-match
      states switch on **matched-literal** coding. The four `stateUpdate*` transitions mirror the spec.
- [x] **The rep0..rep3 distance MRU** — the four most-recent match distances are kept in a
      move-to-front list and recoded with a handful of context bits (`IsRep`, `IsRepG0/1/2`,
      `IsRep0Long`) instead of the full distance machinery. This is *the* reason LZMA crushes data that
      revisits offsets; the visualiser shows the rep-vs-new-distance split explicitly.
- [x] **Bit-tree distance coding** — a 6-bit **posSlot** (magnitude bucket) per length class, then the
      low bits as a reverse **specPos** tree (near distances) or **direct bits + a 4-bit align tree**
      (far distances). *(This is where the one subtle bug lived: the `specPos` table is sized
      `1 + kNumFullDistances − kEndPosModelIndex = 115`; one slot short and a typed-array OOB write is
      silently dropped, re-read later as a zero probability that collapses `range` to 0 — caught by the
      offline fuzz, not the corpus.)*
- [x] **The low/mid/high length coder** — a `choice`/`choice2` split over an 8/8/256 bit-tree spanning
      match lengths 2..273, one instance for new matches and one for rep matches.
- [x] **An HC4 match finder** — hash2 + hash3 **head** tables and a hash4 **chain** (bounded depth +
      niceLen), exactly the structure real LZMA "fast" mode uses, plus a rep-length probe at each of the
      four rep distances. The parse is **lazy** (hold a match if the next position beats it) and
      **rep-preferring** (a rep that ties a new match wins, because it is far cheaper).
- [x] **A length-driven decoder** — it knows `outLen` from the codec header (as every codec here does)
      and stops there, so no end marker is needed; it replays the identical context selections and
      probability updates the encoder made, so the stream inverts by construction.
- [x] **The `lzma` codec is wired into `codecs.ts`** — it races in the Benchmark and round-trips in the
      Self-test automatically, and a new **Server log** corpus sample (fixed-layout lines with recurring
      field offsets) was added to show the rep list at work.
- [x] **An `LZMA` lab page** (`routes/Lzma.tsx`): a size race against the other from-scratch coders,
      the **packet stream** (each token a slice coloured grey/teal/violet-blue-green-amber for
      literal/new-match/rep0..3, width ∝ output bytes, hover for detail), the **packet composition** and
      **distance-source** breakdowns, the live **12-state transition table** with the current state
      highlighted, and a plain-language "how a packet is coded" walk-through.

### Correctness & result

Driven under Node before any UI: round-trips every corpus + edge input on the first try, plus a
**3,000-case fuzz** (random lengths to ~2,500 B across five structure classes — full-random, small
alphabet, periodic-with-noise, runs, repeated-block) with **zero mismatches**, and two extra invariants
checked on every case — the stream opens with the reference's **leading zero byte** and the encoder is
**deterministic** (encode twice → identical bytes, which is what lets decode replay it). On the
eight-corpus benchmark LZMA is the **best dictionary coder** — it wins `repetitive` outright (6% vs
gzip's 9%) and leads gzip/DEFLATE/bzip on `dna`, `json`, `source` and `serverlog`; on tiny prose the
header-free context mixers (CM/PPM) still edge it, which is the honest and expected result at these
sizes. On larger structured inputs it is dominant (offline: a 7.8 KB repeated-JSON blob → 1.1%, a 5 KB
single-run → 0.6%). In-app Self-test grows **534 → 617** checks (14 LZMA codec round-trips + LZMA
primitive round-trips + leading-byte/determinism checks across the corpus and edge cases), all green.
Still zero runtime deps beyond React.

## Entropy Forge v7 — LZMA auto-tunes its literal/position model

v6 shipped LZMA with the reference default model (`lc=3, lp=0, pb=2`). But those three numbers are
the knob real LZMA encoders actually turn: **`lc`** = how many high bits of the previous byte context
each literal (0–8), **`lp`** = how many low bits of the *position* condition a literal (aligned/tabular
data), **`pb`** = how many low position bits select the match/length probabilities. Different data
wants different splits, and `xz` exposes exactly this as `--lzma2=lc=..,lp=..,pb=..`.

### What shipped

- [x] **Fully parameterised model** — `lc`/`lp`/`pb` are threaded through the literal-coder sizing
      (`0x300 << (lc+lp)`), the literal context (`(pos & litPosMask) << lc | prevByte >> (8−lc)`) and
      the position mask, instead of being compile-time constants.
- [x] **The one-byte LZMA properties** — `props = (pb·5 + lp)·9 + lc`, the exact byte `.lzma`/`.xz`
      store, is now prefixed to the stream and parsed back on decode, so the codec is **self-describing**:
      the decoder reads the model from the data, not from a hard-coded constant. (The range stream's own
      leading zero byte now lives at index 1; the self-test checks both it and the props round-trip.)
- [x] **An auto-tuner** — the encoder races six presets — `3/0/2` (default), `3/0/0` (text/logs, no
      position alignment), `4/0/2` (natural language), `2/0/0`, `0/2/2` (aligned/tabular binary),
      `0/0/0` (near-random/tiny) — and ships the smallest, re-encoding the winner with the token trace
      only if a visualiser asked for one. Correctness is unaffected (the decoder replays whatever model
      the props byte names), so the round-trip + fuzz guarantees carry straight over.
- [x] **The LZMA page shows it** — a new *Auto-tuned literal/position model* panel lists every preset's
      size and props byte with the winner highlighted; the stat row and the coded-packet walk-through now
      report the selected `lc/lp/pb`.

### Result

Every corpus got smaller or stayed equal, for one transmitted byte: `declaration` 67→**65%**, `json`
22→**21%**, `source` 21→**20%**, `random` 96→**90%** (the near-incompressible case, where dropping to
`lc=0` sheds the literal model's warm-up cost), and the text corpora settle on `pb=0`/`lc=0` at these
sizes where the range coder's own adaptivity already carries the context. LZMA remains the best
dictionary coder and widens its lead over gzip/DEFLATE. Re-verified end to end: the **3,000-case fuzz**
still passes with zero mismatches (now exercising all six presets via the auto-path), the full corpus +
edge inputs round-trip, and the in-app Self-test is **617** checks (LZMA rows now also assert the props
byte round-trips), all green. Zero new deps.

## Entropy Forge v8 — PNG, the codec that ties it together (Image Studio)

The lab has, from scratch, the exact ingredients a real **PNG** is built from — an RFC-1951
DEFLATE, a zlib (RFC 1950) container, and CRC-32/Adler-32 — but it had never assembled them into a
**real-world container that produces a viewable file**. PNG is the natural capstone: it is *lossless*
(on-theme), it rides our own DEFLATE, and it adds one genuinely new idea to the lab — a **modelling
pre-filter** (§6 scanline filters) that reshapes the image so the entropy coder sees far less
redundancy. The through-line "watch entropy become bits" becomes literal: you watch a per-scanline
filter *lower the order-0 entropy* of the byte stream before DEFLATE ever runs.

The whole thing is built from scratch (only `crc32`/`adler32` and `zlibEncode`/`zlibDecode` reused —
all our own code) and is verified two ways: an **exhaustive raster-level round-trip** (encode→decode
is the identity across every colour type × bit depth × filter × interlace), a **differential** check
against a deliberately-independent "stored-block, filter-None" oracle encoder, and — the showstopper,
mirroring the gzip interop proof — an in-browser check that the **browser's own PNG decoder renders
our from-scratch file** pixel-for-pixel, and that we decode the **browser's** PNG in turn.

### Plan (this session)

- [x] `png.ts` core: PNG signature, chunk layer (length/type/data/CRC-32) with `IHDR`/`PLTE`/`tRNS`/
      `IDAT`/`IEND` write + parse, and CRC validation on every chunk.
- [x] All five §6 filters — None/Sub/Up/Average/Paeth — encode (apply) and decode (reconstruct),
      with the correct `bpp` byte offset (incl. sub-byte bit depths where bpp = 1).
- [x] Adaptive filter selection: the libpng **minimum-sum-of-absolute-differences** heuristic per
      scanline, plus fixed single-filter strategies (to show the ratio spread).
- [x] All colour types × bit depths: grayscale (1/2/4/8/16), truecolour RGB (8/16), palette (1/2/4/8),
      grayscale+alpha (8/16), truecolour+alpha (8/16) — packed big-endian, sub-byte and 16-bit samples.
- [x] Adam7 **interlacing**: the 7-pass split/merge, filtered per reduced image, both directions.
- [x] A raster ⇄ RGBA8 pixel layer (exact expand for display; pack/quantise + a median-cut-ish
      palette builder for encoding an arbitrary RGBA image at a chosen colour type).
- [x] Ancillary chunk *reading* for the inspector: `gAMA`, `pHYs`, `sRGB`, `bKGD`, `tIME`, `tEXt`.
- [x] Robust decode errors (bad signature, CRC mismatch, unknown critical chunk, truncation, bad
      IHDR combo) — surfaced, never a silent wrong answer.
- [x] Self-test group `png` wired into `selftest.ts`: exhaustive raster round-trips, filter
      apply/reconstruct inverses, Adam7 split/merge inverse, the differential stored-oracle check,
      and a known-answer decode of an embedded real PNG.
- [x] Native-interop (feature-detected, like the gzip one): our PNG → browser decode → pixel compare,
      and browser encode → our decode → pixel compare.
- [x] `Png.tsx` **Image Studio** route: procedural sources + upload, filter-strategy picker with a
      live per-scanline filter-choice strip, an entropy-before/after readout, a filter-vs-size bar
      chart, the decoded render on a canvas, a parsed chunk table, and the interop badge. Nav entry.
- [x] Update `project.json` (description + tags) and this journal's session log.

## Entropy Forge v9 — The Noisy Channel (Shannon's *other* theorem)

Everything the lab has shipped so far serves **one** of Shannon's two 1948 theorems: the **source
coding theorem** — the entropy H is a hard floor on lossless size, and Huffman/arithmetic/ANS/PPM/CM
all chase it. But *A Mathematical Theory of Communication* has a **second, dual** result — the
**noisy-channel coding theorem** — and the lab has never touched it. Source coding **removes**
redundancy to shrink data; channel coding **adds redundancy back**, but *structured* and *minimal*,
so that a message can survive a noisy channel and be **reconstructed exactly**. Shannon proved the
astonishing part: as long as the code rate R stays below the channel **capacity** C, the probability
of error can be driven to **zero** — arbitrarily reliable communication over an unreliable channel.

This is the natural capstone that makes Entropy Forge a *complete* information-theory lab: the two
halves of Shannon finally sit side by side. The through-line inverts beautifully — *"watch entropy
become bits"* becomes *"watch redundancy become resilience."* Same math (entropy, capacity,
log-likelihood), opposite direction. Every code here is **real** (it produces and consumes actual
codewords and corrects actual errors) and **provably correct** (decode∘channel∘encode = identity
whenever the error weight is within the code's guarantee), surfaced on the Self-test page exactly
like the codecs are.

### Plan (this session)

- [x] `galois.ts` — the algebraic substrate: **GF(2) linear algebra** (matrices, mod-2
      Gauss–Jordan/RREF, null space, rank) for linear block codes, and **GF(2^m) finite-field
      arithmetic** — the exp/log tables over **GF(256)** with primitive polynomial 0x11D (the
      Reed–Solomon / QR-code field), plus GF-polynomial multiply, divide, and evaluation.
- [x] `channel.ts` — the **channel models** and their capacities: the **Binary Symmetric Channel**
      (BSC, crossover p, capacity 1−H(p)), the **Binary Erasure Channel** (BEC, erasure ε, capacity
      1−ε), and an **AWGN/BPSK** model (for soft-decision + LLRs). A seeded PRNG so a run is
      reproducible; helpers to corrupt a bit/byte stream and to tally bit/symbol errors.
- [x] `linearCode.ts` — a general **linear block code** framework: a generator matrix G (k×n) and
      parity-check matrix H, systematic form, **syndrome-table (standard-array) decoding**, minimum
      distance by codeword enumeration, and the rate/distance/correction-capability summary. Repetition
      and single-parity codes fall straight out of it.
- [x] `hamming.ts` — the **Hamming(7,4)** SEC code and the **extended Hamming(8,4)** SEC-DED code
      built on the framework: generator/parity matrices, the classic **3-circle syndrome** picture,
      single-error *correction* and (extended) double-error *detection*; plus the general
      Hamming(2^m−1, 2^m−1−m) family.
- [x] `reedSolomon.ts` — **the crown jewel.** RS over GF(256): systematic encode by the generator
      polynomial g(x)=∏(x−α^i); decode by **syndromes → Berlekamp–Massey → Chien search → Forney**,
      handling both **errors and erasures** (the errata locator). This is the code inside **QR codes,
      CDs/DVDs, DVB and deep-space** — and its superpower, correcting long **burst** errors, gets its
      own demo. Parameterisable (n,k); ships the QR-standard configs.
- [x] `convolutional.ts` — a **convolutional encoder** (rate-1/2, K=3 generators 7,5 octal, plus the
      industry K=7 171/133 "Voyager/GSM/802.11" code) and a **Viterbi decoder** — the trellis, add-
      compare-select path metrics, and traceback of the survivor — in both **hard-decision** (Hamming
      metric) and **soft-decision** (Euclidean/AWGN) flavours.
- [x] `ldpc.ts` — a small **LDPC** (low-density parity-check) code with **sum-product / belief-
      propagation** decoding in the log-likelihood domain: the Tanner graph, variable→check and
      check→variable message passing, iterated to convergence. The capacity-approaching modern code,
      validated against exhaustive ML decoding on small blocks.
- [x] `Channel.tsx` — the pillar's **overview**: the noisy-channel picture, Shannon's theorem, live
      **capacity curves** (C_BSC vs p and C_BEC vs ε), and an interactive channel simulator (push bits
      through, watch flips/erasures) that makes the rate-vs-reliability trade-off tangible.
- [x] `Hamming.tsx` — encode 4 data bits → 7, inject an error, watch the **syndrome point straight at
      the flipped bit**, correct it; the 3-circle Venn visual and the full standard-array/syndrome
      table; the extended SEC-DED code detecting a double error.
- [x] `ReedSolomon.tsx` — pick (n,k), encode, corrupt up to t symbols (and mark erasures), and watch
      **Berlekamp–Massey** build the locator, **Chien** find the positions and **Forney** the
      magnitudes — then the codeword snap back. A burst-error demo showing RS shrug off a contiguous
      smear that would swamp a bit-level code.
- [x] `Convolutional.tsx` — the **trellis** drawn out, the encoder walking it, a corrupted stream, and
      **Viterbi** recovering the maximum-likelihood path with the survivor traced back; a BER-vs-noise
      readout showing the coding gain.
- [x] `Ldpc.tsx` — the **Tanner graph** with belief-propagation messages flowing along its edges,
      iterating until the syndrome clears; the parity-check structure and a convergence trace.
- [x] `ChannelLab.tsx` (Benchmark) — a **BER waterfall**: corrected bit-error-rate vs raw channel
      error for every code, the **coding gain** visible as the curves peel away from the uncoded
      diagonal; and the **end-to-end showstopper** — take real text, **gzip** it (source coding), wrap
      it in **Reed–Solomon** parity (channel coding), blast it through a bursty channel, watch RS
      **repair** the damage, and **gunzip** back to the exact original. Shannon's two theorems, from
      scratch, cooperating.
- [x] Wire the new `channel`/`hamming`/`reed-solomon`/`convolutional`/`ldpc` groups into `selftest.ts`
      (exhaustive small-code correctness: every correctable error pattern decoded right, every
      *un*correctable one either flagged or provably beyond the guarantee) and add the Nav group + the
      Overview surface. Update `project.json` (title/description/tags) and this journal's session log.

## Entropy Forge v10 — Polar codes (the code that *reaches* the limit)

The channel-coding pillar shipped four code families, ending with **LDPC** — the code that
*approaches* capacity with a clever sparse graph and iterative belief propagation. But there is a
deeper result, and the lab was missing it: **polar codes** (Arıkan 2009), the first codes ever
**proven** to *reach* the Shannon limit as the block length grows — and, with LDPC, one of the two
codes standardised for **5G-NR** (LDPC carries the data channel; polar carries the **control**
channel). Where LDPC's magic is a graph, polar's is a **recursive algebraic transform** and an
exact, sequential decoder. Adding it makes the pillar tell the whole modern story: *approach* the
limit (LDPC) and *achieve* it (polar), the two 5G codes side by side.

The idea is **channel polarisation**. Combine two copies of a channel W with the 2×2 kernel
F = [[1,0],[1,1]] and split the result into two *synthetic* bit-channels: the one decoded first is
**worse** than W, the one decoded second (knowing the first) is **better**. Recurse n times over
N = 2ⁿ copies and the synthetic channels **polarise** — a fraction → capacity C become nearly
perfect, the rest → 0 nearly useless. Ride the message on the good ones, freeze the bad ones to 0.
The encoder is the n-fold Kronecker power Gₙ = F⊗ⁿ, an in-place **butterfly** shaped exactly like an
FFT (O(N log N), no matrix). The decoder is **Successive Cancellation** (SC): a depth-first pass over
that same butterfly, turning channel LLRs into one hard bit at a time. **SC-List** (SCL) keeps the L
best partial decodings; **CRC-aided SCL** — the 5G decoder — appends a CRC and lets the list pick the
survivor that checks out, which is what lifts short polar codes past LDPC. It reuses the pillar's
existing `channel.ts` LLR convention verbatim, so a received word flows straight in.

### Plan (this session)

- [x] `polar.ts` — the engine, framework-free and Node-testable:
  - [x] **The transform** `polarTransform` — x = u·Gₙ, Gₙ = F⊗ⁿ, by the log₂N-stage in-place
        butterfly (verified against a brute-force generator rebuilt from basis vectors, N up to 32).
  - [x] **Construction** — ranking the N synthetic channels by reliability and freezing the worst
        N−K: the exact **Bhattacharyya recursion** for the BEC (Z⁻ = 2Z−Z², Z⁺ = Z², where the BEC
        capacity is exactly 1−Z), and the **Gaussian-approximation** (density-evolution mean-LLR)
        construction for the BI-AWGN via the Chung–Richardson–Urbanke φ/φ⁻¹. The channel index the
        recursion produces coincides exactly with the natural bit order SC decides — proven for N=2,4
        and checked in the self-test.
  - [x] **SC decoder** `scDecode` — the recursive f (min-sum "−") / g ("+") pass with partial sums
        stitched back up the butterfly; the L=1 oracle for the list decoder.
  - [x] **SC-List decoder** `sclDecode` — L parallel paths forking at every info bit, pruned by the
        exact `ln(1+e^{−(1−2b)λ})` path metric, with depth-indexed per-path LLR/partial-sum stacks
        eager-copied on each fork; picks the minimum-metric survivor.
  - [x] **CRC-aided SCL** — a from-scratch bit-wise CRC (`appendCrc`/`crcValid`, CRC-8/CRC-6); the
        list keeps only survivors whose trailing CRC recomputes from their payload. The 5G decoder.
- [x] `Polar.tsx` — the interactive page:
  - [x] **Channel polarisation figure** — the N synthetic channels sorted by capacity into the
        signature staircase, sharpening toward a step at C as N rises (N and ε sliders, BEC exact).
  - [x] **Encoder butterfly** — the (8,4) XOR network drawn stage-by-stage, info u-nodes teal,
        frozen grey, codeword amber: the "encoder is an FFT" made literal.
  - [x] **Live pipeline** — random payload → CRC → polar encode → **BI-AWGN** channel → decode three
        ways (SC / SCL / CA-SCL), with a flipped-bit strip and per-decoder recovered/failed badges;
        N, rate, channel Eb/N0, design Eb/N0 and list size L all live.
  - [x] **BLER waterfall** — frame-error rate vs Eb/N0 for a (128,64) code under SC, SCL(L=8) and
        CA-SCL(L=8) against uncoded BPSK — the list buys ~½ dB and the CRC steepens the cliff, the
        exact reason 5G chose CA-SCL.
- [x] Wire `polar` into `App.tsx`, the `Nav` "Channel coding" group, and the Overview surface.
- [x] **11 new self-test proofs** in `selftest.ts` (transform = Gₙ, SC/SCL/CA-SCL noiseless
      round-trips to (256,128), AWGN monotonicity SC ≥ SCL ≥ CA-SCL block-errors, polarisation +
      capacity conservation, CRC consistency + single-flip detection). Self-test **668 → 679**, all
      green under Node.

### Polar roadmap (honest next steps — not yet built)

- [ ] **Systematic polar encoding** (Arıkan 2011) — recover the message directly from the codeword
      positions, improving BER and making the info bits visible in the transmitted word.
- [ ] **The 5G-NR reliability sequence** (the standardised nested Q_Nmax=1024 order) as a third
      construction alongside GA/BEC, so the frozen set matches a real deployed code exactly.
- [ ] **Rate matching** — sub-block interleaving + puncturing/shortening/repetition to hit arbitrary
      (N,K) off the power-of-two grid, the way 5G actually ships polar codes.
- [ ] **A decode-tree animation** — scrub the SC recursion and watch f/g LLRs flow down the butterfly
      and hard bits propagate back up, the way the Arithmetic page animates the interval.
- [ ] **CRC-length / list-size sweep** on the waterfall — show the diminishing returns of L and the
      optimal CRC length, and the SCL→ML gap closing.
- [ ] **Fast simplified SC (SSC/Fast-SCL)** — collapse rate-0 and rate-1 subtrees for the O(N) decode
      the hardware actually uses, timed against the plain recursion.

## Entropy Forge v11 — JPEG, the lossy pillar (Shannon's *third* theorem)

Two of Shannon's three great 1948/1959 theorems were already in the lab. The **source coding theorem**
gave us the entropy floor H that Huffman/arithmetic/ANS/PPM/CM/LZMA all chase; the **noisy-channel
coding theorem** gave us the channel-coding pillar (Hamming → Reed–Solomon → convolutional → LDPC →
polar). But there was a third — the **rate–distortion theorem** — and the lab had never touched it,
because *everything* it shipped was **lossless**. Lossless coding can only ever remove the redundancy
that H predicts; it can never go below H. Rate–distortion is what happens when you allow a *little*
loss: R(D) is the minimum bits per symbol needed to reconstruct a source to within an average
distortion D, and it drops far below H as you spend distortion. The whole field of **lossy** media
compression lives here.

The natural, on-theme capstone for that pillar is **JPEG** — the lossy image format the way PNG was
the lossless one. JPEG is where the lab's own entropy machinery (Huffman) meets one genuinely new
idea: a **change of basis** (the 8×8 DCT) that concentrates a block's energy so that **quantisation**
— the single lossy step — can zero out the coefficients the eye won't miss. The through-line inverts
one more time: *"watch entropy become bits"* (lossless) and *"watch redundancy become resilience"*
(channel) become *"watch bits buy fidelity."* And, like gzip and PNG, JPEG is a **real interoperable
format**: the showstopper is the **browser's own decoder rendering the file we emit**, and ours
reading the browser's — now for a *lossy* codec, matched within a PSNR tolerance instead of bit-exact.

### Plan (this session) — all shipped

- [x] `dct.ts` — the orthonormal, separable **8×8 DCT-II** (F = M·B·Mᵀ) and its exact-transpose
      inverse, so `idct(fdct(b)) = b` to ~1e-9; plus the **zig-zag** scan order and its inverse.
- [x] `jpegTables.ts` — the **Annex K** example quantisation tables (luma + chroma), the **IJG
      quality→scale** mapping, and the four **standard Huffman code tables** (DC/AC × luma/chroma).
- [x] `jpeg.ts` — the codec. Encoder: BT.601 **RGB→YCbCr**, **4:4:4 / 4:2:2 / 4:2:0** chroma
      subsampling (box-average) + grayscale, per-8×8-block level-shift → DCT → **quantise** → zig-zag,
      **DC differential** + category/magnitude coding and **AC run/size** coding (ZRL + EOB), canonical
      Huffman (Annex C), a **byte-stuffed** (0xFF→0xFF00) entropy writer, and a real **JFIF** container
      (SOI/APP0/DQT/SOF0/DHT/SOS/EOI). Decoder: full marker parser, canonical Huffman **decode tables**
      (Annex F min/max-code), dequantise, inverse DCT, **DRI/restart-marker** support, and libjpeg-style
      **fancy (triangle-filter) chroma upsampling** so we reconstruct like real decoders do. Plus
      `psnr`/`mse` distortion metrics. Coefficients are clamped to the categories the baseline tables
      can express (only ever bites on pathological synthetic blocks at quality ~100).
- [x] `selftest.ts` — a new **JPEG** group: the DCT identity + flat-block + Parseval + zig-zag-bijection
      checks, the colour-transform inverse (≤1 LSB), and full-codec invariants across four sample images
      × three subsamplings — 4:4:4 high-fidelity, subsampled ≤ 4:4:4, valid SOI…EOI framing, every 0xFF
      stuffed, **near-lossless at quality 100**, **quality-monotone** PSNR *and* size (the operational
      R–D curve is well-ordered), grayscale = 1 component, deterministic output, and exact **MCU edge
      padding** on odd dimensions (7×5, 17×3, 1×1, 33×31). Self-test **679 → 698**, all green.
- [x] **Native interop** (`runJpegInterop`, feature-detected like the gzip/PNG ones): our encoder → the
      browser's `createImageBitmap` decoder, and the browser's `canvas.toBlob('image/jpeg')` encoder →
      our decoder, each measured by PSNR agreement. Verified live in headless Chromium before shipping:
      the browser reads our `.jpg` at **62+ dB** agreement with our own decoder (36–49 dB vs the
      original), and we read the browser's `.jpg` at **50–58 dB** agreement (the fancy-upsample upgrade
      lifted this from ~31 dB — the divergence had been purely nearest-vs-triangle chroma upsampling).
- [x] `Jpeg.tsx` **Rate–Distortion Studio** route + Nav entry: image picker, quality slider,
      subsampling picker; a stat row (compression ×, bpp, PSNR, model); an **original → decoded →
      amplified-error** triptych (click the original to pick a block); the live **R–D curve** (PSNR vs
      bpp, every point a real encode+decode, marker at the current setting); a click-to-inspect **8×8
      block walk-through** (luma pixels → DCT coefficients → quantisation table → surviving quantised
      coefficients → inverse-DCT reconstruction, with the survivor count); a **DC-vs-AC bit budget**;
      the annotated **JFIF marker table**; and the live **native-interop** badges.
- [x] Update `project.json` (description + JPEG tags) and this journal.

### Why it's *not* in the lossless Benchmark / Codec roster

JPEG is deliberately **not** wired into `codecs.ts` (the uniform lossless `Codec` interface) or the
Benchmark, because those demand bit-exact `decode(encode(x)) = x` over arbitrary byte inputs — a bar a
lossy image codec cannot and should not meet. Its correctness gate is the JPEG self-test group and the
interop cross-checks instead. This keeps the "every codec provably round-trips" invariant of the
lossless pillar honest while still holding the lossy codec to a rigorous, appropriate standard.

### JPEG roadmap (honest next steps — not yet built)

- [ ] **Optimised (custom) Huffman tables** — a two-pass encode that builds the actual symbol
      histogram and ships a code tailored to the image (what `mozjpeg -optimize` does), a few percent
      smaller than the standard Annex-K tables for one extra pass.
- [ ] **Trellis quantisation** (the mozjpeg headline) — a per-block rate–distortion-optimal choice of
      which coefficients to keep, pricing each against the entropy coder; the last few percent of the
      R–D curve, and a beautiful visualiser of the R–D Lagrangian at work.
- [ ] **Progressive JPEG** — spectral-selection + successive-approximation scans, decoded to show the
      image sharpening in passes; the decoder already rejects it cleanly, so this is purely additive.
- [ ] **A step-through of the entropy coder** on the JPEG page — watch the DC predictor and the AC
      run/size symbols emit bit by bit, the way the Arithmetic page animates the WNC interval.
- [ ] **SSIM / MS-SSIM** alongside PSNR — a perceptual distortion axis on the R–D curve, since PSNR
      undersells how good chroma subsampling looks to a human.
- [ ] **A WebP-style intra-frame or a tiny learned/transform comparison** — race JPEG's DCT+quant
      against an alternative transform (e.g. a Hadamard or a 4×4 integer DCT) on the same R–D axes.
- [ ] **Quantisation-table presets** (the "Q-tables" real encoders ship for different content) and a
      side-by-side of how the table reshapes the surviving-coefficient mask.

## Session log

- 2026-07-05 (claude): **v11 — JPEG, the lossy pillar (Shannon's third theorem: rate–distortion).**
  The lab was entirely *lossless* — every coder chasing the entropy floor H. v11 steps past it with a
  from-scratch **baseline JPEG** codec: `dct.ts` (orthonormal separable 8×8 DCT-II, exact-transpose
  inverse, zig-zag), `jpegTables.ts` (Annex-K quant tables, IJG quality scaling, the four standard
  Huffman tables), and `jpeg.ts` — a full encoder (RGB→YCbCr, 4:4:4/4:2:2/4:2:0 + grayscale, DCT →
  quantise → zig-zag, DC-diff + AC run/size, canonical Huffman, byte-stuffed JFIF container) and a
  mirror decoder (marker parse, canonical Huffman decode tables, dequant, inverse DCT, DRI/restart
  support, libjpeg-style *fancy* triangle-filter chroma upsampling). Drove correctness under Node
  first (68 dev checks): DCT identity/Parseval, colour-transform inverse, quality-monotone PSNR *and*
  size, near-lossless at q100, grayscale, determinism, byte-stuffing, odd-dimension MCU padding. Then
  the **interop showstopper**, proven live in headless Chromium: the browser's own decoder renders our
  `.jpg` (agreeing with our decoder to 62+ dB, 36–49 dB vs the original) and our decoder reads the
  browser's canvas-encoded `.jpg` (50–58 dB agreement — the fancy-upsampling upgrade, which also just
  makes our decode *better*, lifted this from ~31 dB). Wired a JPEG self-test group (Self-test
  **679 → 698**, all green) + 6 native-JPEG cross-checks, and built the **Rate–Distortion Studio**
  page: original→decoded→error triptych, the live R–D curve (fidelity vs bpp saturating exactly as the
  theorem predicts), a click-to-inspect 8×8 block pipeline (pixels → DCT → quant table → survivors →
  reconstruction), a DC-vs-AC bit budget, and the annotated JFIF marker table. Deliberately kept out of
  the lossless Codec roster/Benchmark (a lossy codec can't meet bit-exact round-trip). Zero new deps.
- 2026-07-04 (claude): **v10 — Polar codes: the first code that *reaches* the Shannon limit (and the
  5G control code).** Added the capacity-*achieving* sibling to LDPC's capacity-*approaching* code,
  completing the modern channel-coding story. New engine `polar.ts` (zero deps): the **polar
  transform** Gₙ = F⊗ⁿ by an in-place FFT-shaped butterfly; two **constructions** — the exact BEC
  **Bhattacharyya recursion** and the BI-AWGN **Gaussian approximation** (Chung–Richardson–Urbanke
  φ/φ⁻¹ density evolution) — that rank and freeze the synthetic bit-channels; a recursive
  **successive-cancellation** decoder (min-sum f / g with partial sums stitched up the butterfly);
  an **SC-List** decoder (L forking paths, exact log-domain path metric, per-path depth-indexed
  LLR/partial-sum stacks eager-copied on each fork); and **CRC-aided SCL** — the 5G decoder — on a
  from-scratch bitwise CRC. Verified the channel-index ordering matches SC's decision order
  analytically (N=2,4) before building, then headlessly: at Eb/N0 = 1.5 dB on (128,64), block-error
  rate falls **SC 0.25 → SCL 0.16 → CA-SCL 0.03** — the list-and-CRC coding gain, exactly why 5G
  uses CA-SCL. New page `Polar.tsx`: the **polarisation staircase** (channels sorted by capacity,
  sharpening to a step as N grows), the **(8,4) encoder butterfly**, a **live encode→AWGN→decode**
  pipeline with three decoders racing and a flipped-bit strip, and a **BLER waterfall** (uncoded vs
  SC vs SCL vs CA-SCL). Wired into Nav/App/Overview and added **11 self-test proofs** (transform =
  Gₙ, SC/SCL/CA-SCL noiseless round-trips to (256,128), AWGN monotonicity, polarisation + capacity
  conservation, CRC consistency). Self-test **668 → 679**, all green; the CI gate (scope +
  conformance + lint + build) passes and the page renders clean in Chromium.
- 2026-07-04 (claude): **v9 — The Noisy Channel: Shannon's *other* theorem (channel coding).** Built a
  complete error-correction pillar from scratch — the dual of the whole compression side. New engine
  modules, all zero-dep and individually tested: `galois.ts` (GF(2) linear algebra with mod-2
  Gauss–Jordan / rank / null-space, and GF(256) field arithmetic via exp/log tables over primitive
  poly 0x11D, plus a polynomial ring); `channel.ts` (BSC / BEC / BI-AWGN models with their Shannon
  capacities C=1−H(p), 1−ε and a numerically-integrated AWGN capacity, a seeded xorshift PRNG, LLRs);
  `linearCode.ts` (a general (n,k,d) linear block code: systematic G↔H, minimum-weight coset-leader
  syndrome/standard-array decoding, min-distance by enumeration; repetition + parity codes fall out);
  `hamming.ts` ((7,4) with the three-circle Venn checks, extended SEC-DED (8,4) with a dedicated
  inner-syndrome + overall-parity decoder, and the general Hamming(2^m−1,·) family); `reedSolomon.ts`
  (the QR/CD/DVD/Voyager code — generator-poly systematic encode, syndromes → **Berlekamp–Massey** →
  **Chien** → **Forney** with the errata locator for errors *and* erasures, QR/CCSDS presets);
  `convolutional.ts` ((7,5) K=3 and (171,133) K=7 encoders + a **Viterbi** ACS/traceback decoder in
  hard *and* soft decision, with a free-distance search); `ldpc.ts` (a full-rank systematic sparse
  code + **sum-product belief propagation** in the LLR domain over the **Tanner graph**, plus a seeded
  larger-code builder for the waterfall). Six interactive pages: **The Noisy Channel** (capacity
  curves + a live BSC/BEC/AWGN simulator), **Hamming** (encode→corrupt→correct with the Venn picture
  and the full syndrome table, plus SEC-DED), **Reed–Solomon** (click bytes to inject errors/erasures,
  watch BM/Chien/Forney repair them, burst-error demo), **Convolutional · Viterbi** (the trellis with
  the survivor path traced back, and a soft-vs-hard **BER waterfall** showing the ~2 dB coding gain),
  **LDPC · Belief Propagation** (the Tanner graph decoding live with a scrubbable iteration slider +
  convergence trace + waterfall), and **Channel Lab** — the capstone that runs *both* theorems end to
  end: gzip → Reed–Solomon(255,223) → bursty channel → RS-repair → gunzip, recovered byte-for-byte,
  with an unprotected-gzip control that the same noise destroys (the **separation theorem**, runnable).
  Correctness driven under Node first (GF axioms, exhaustive Hamming SEC/SEC-DED, 7,000+ RS
  error/burst/erasure/mixed trials, convolutional clean/single-error/soft decoding with verified
  d_free = 5 and 10, LDPC validity + BP correction); wired 25 new checks into the Self-test harness
  (**643 → 668**, all green) and surfaced the pillar on the Nav, Overview and `project.json`. Added a
  reusable log-scale `LineChart` for the capacity/BER/convergence curves. Every page smoke-tested in a
  headless browser with zero console errors. Still zero runtime deps beyond React.
- 2026-07-03 (claude): **v8 — PNG, the codec that ties the lab together (Image Studio).** Built a
  from-scratch, spec-compliant **PNG** codec (`png.ts`, ISO 15948 / RFC 2083) on top of the lab's
  own DEFLATE/zlib/CRC-32 — the first *real-world container that produces a viewable file*. It does
  every colour type × bit depth the spec allows (grayscale 1–16-bit, RGB/RGBA 8/16-bit, indexed
  palette 1–8-bit + tRNS, gray+alpha), all five §6 scanline filters with a libpng min-sum adaptive
  per-scanline chooser, **Adam7 interlacing** (the 7-pass split/merge, filtered per reduced image),
  multi-IDAT decoding, and CRC-validated chunk parsing (IHDR/PLTE/tRNS/IDAT/IEND + gAMA/pHYs/sRGB/tEXt
  read-out). Debugged the classic Adam7 gotcha along the way — two wrong entries in the pass table
  (pass 4 and pass 6 `yStep`) surfaced immediately from an exhaustive interlaced round-trip and were
  fixed against the canonical (row, col, rowInc, colInc) values. A raster ⇄ RGBA8 pixel layer (with a
  median-cut palette builder) makes it encode arbitrary images. **Correctness**, three ways: an
  **exhaustive raster round-trip** (decode∘encode = identity across every colour type × depth ×
  filter × interlace — 1,080 offline cases, 0 fail); **known-answer** decodes of real PNGs produced
  by Node's *independent* zlib (their expected pixels hashed from the source pattern before our code
  runs — proven headlessly); and, in the browser, an interop badge that has the platform's **own PNG
  decoder render our from-scratch file pixel-for-pixel** (premultiplied-alpha aware) and decodes the
  browser's PNG in turn. Verified live in Chromium: the **Image Studio** (`Png.tsx`) encodes a
  procedural or uploaded image, drags a filter-strategy picker with a live per-scanline filter-choice
  strip, shows the entropy the filter *removes* before DEFLATE runs (a smooth gradient 6.5 → 1.0
  b/byte), charts total size under each filter (adaptive wins), renders the decoded pixels, lists the
  byte-exact chunk table, and lights the interop badge **✓ interoperable**. Self-test **617 → 643**
  in-browser checks, all green; zero new deps.
- 2026-07-03 (claude): **v7 — LZMA auto-tunes its literal/position model.** Parameterised the whole
  literal/position model (`lc`/`lp`/`pb`) instead of hard-coding the `3/0/2` default, made the stream
  **self-describing** by prefixing the one-byte LZMA `props = (pb·5+lp)·9+lc` (the exact `.xz` byte) and
  parsing it back on decode, and added an **auto-tuner** that races six presets and ships the smallest.
  Because the decoder rebuilds whatever model the props byte names, correctness is untouched — the
  3,000-case fuzz (now through the auto-path) and the 617-check Self-test stay green. The LZMA page grew
  an *Auto-tuned model* panel (every preset's size + props byte, winner highlighted) and reports the
  chosen `lc/lp/pb`. Every corpus shrank or held for one transmitted byte (declaration 67→65%, json
  22→21%, random 96→90%). Zero new deps.
- 2026-07-03 (claude): **v6 — LZMA, the 7-Zip / xz coder.** Joined the lab's two halves — LZ77
  dictionary matching and adaptive entropy coding — into the algorithm that does them together. Built
  `lzma.ts` from scratch: a binary **range coder** (11-bit adaptive probs, kTopValue renorm, cache-byte
  carry), the **12-state context machine**, the **rep0..rep3 distance MRU** recoded almost for free,
  bit-tree **posSlot + direct + align** distance coding, the low/mid/high **length coder**,
  **matched-literal** modelling, and an **HC4 match finder** (hash2/3 heads + hash4 chain) with a lazy,
  rep-preferring parse; the decoder is length-driven and replays the identical model updates, so it
  inverts by construction. Found and fixed one genuinely subtle bug — the `specPos` table was one slot
  short, so a far-distance match wrote past a typed array, the drop re-read as a zero probability, and
  `range` collapsed to 0 into an infinite renormalisation loop; the 3,000-case fuzz caught it where the
  corpus didn't. Wired the `lzma` codec into the roster, added a **Server log** corpus sample to
  showcase the rep list, and built the **LZMA** page (packet stream, distance-source breakdown, live
  12-state table, coded-packet walk-through). On the benchmark it is the best dictionary coder — winning
  the repetitive corpus outright and leading gzip/DEFLATE on the structured ones. Self-test **534 →
  617**, all green. Left a six-item LZMA roadmap (optimal parse, short-rep packets, tunable lc/lp/pb, a
  range-coder step-through, LZMA2 framing, delta/BCJ pre-filters). Zero new deps.
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
