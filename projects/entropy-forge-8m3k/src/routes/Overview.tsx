import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat, SectionTitle } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { fmtNum, pct } from '../lib/format'
import { navigate } from '../hooks/useHashRoute'

const MODULES = [
  { route: 'analyzer', name: 'Entropy Analyzer', desc: 'Measure the information content and the theoretical compression floor.' },
  { route: 'huffman', name: 'Huffman Coding', desc: 'Build the optimal prefix-code tree and watch symbols become bits.' },
  { route: 'adaptive', name: 'Adaptive Huffman', desc: 'The FGK tree that learns as bytes arrive — scrub it mutating live.' },
  { route: 'arithmetic', name: 'Arithmetic Coding', desc: 'Spend fractional bits per symbol; reach the entropy bound.' },
  { route: 'rans', name: 'rANS', desc: 'Asymmetric numeral systems — the entropy coder inside zstd & LZFSE.' },
  { route: 'tans', name: 'tANS / FSE', desc: 'Table-driven ANS — the multiply-free finite-state entropy coder inside Zstandard.' },
  { route: 'rice', name: 'Rice · Elias · integer codes', desc: 'Codes for the integers — universal (Elias/Fibonacci) and parametric (Golomb/Rice), the residual substrate FLAC & JPEG-LS spend.' },
  { route: 'ppm', name: 'PPM', desc: 'Context modelling with escapes; watch more context hit diminishing returns.' },
  { route: 'cm', name: 'Context mixing (PAQ)', desc: 'A logistic mixer over many models — the state-of-the-art family, usually the best all-rounder here.' },
  { route: 'lempel', name: 'LZ77 & LZW', desc: 'Exploit repetition with back-references and self-building dictionaries.' },
  { route: 'burrows', name: 'Burrows–Wheeler', desc: 'The reversible permutation at the heart of bzip2.' },
  { route: 'suffix', name: 'Suffix Array', desc: 'Linear-time SA-IS that makes the BWT scale to kilobytes.' },
  { route: 'deflate', name: 'DEFLATE & gzip', desc: 'The real RFC 1951/1952 codec — its output round-trips through the browser’s own gunzip.' },
  { route: 'jpeg', name: 'JPEG · Rate–Distortion', desc: 'The lossy pillar — Shannon’s third theorem. DCT + quantisation, and the browser decodes our .jpg.' },
  { route: 'flac', name: 'FLAC · lossless audio', desc: 'A new modality — lossless audio by linear prediction + partitioned Rice coding. A real fLaC stream that round-trips bit-exactly and plays in the browser.' },
  { route: 'ratedistortion', name: 'Rate–Distortion · Quantisation', desc: 'The limits themselves — Blahut–Arimoto computes any channel’s capacity and any source’s R(D); Lloyd–Max & LBG build the optimal quantisers.' },
  { route: 'channel', name: 'The Noisy Channel', desc: 'Shannon’s other theorem — capacity, and why redundancy becomes resilience.' },
  { route: 'reedsolomon', name: 'Reed–Solomon', desc: 'The code in QR/CD/DVD/Voyager — corrects byte errors and bursts over GF(256).' },
  { route: 'convolutional', name: 'Convolutional · Viterbi', desc: 'The trellis code + maximum-likelihood decoder that flew on Voyager.' },
  { route: 'ldpc', name: 'LDPC · Belief Prop.', desc: 'Capacity-approaching codes decoded on a Tanner graph — inside 5G & Wi-Fi 6.' },
  { route: 'polar', name: 'Polar · SC List', desc: 'The first provably capacity-achieving code — channel polarisation + CRC-aided list decoding, the 5G control code.' },
  { route: 'channellab', name: 'Channel Lab', desc: 'End-to-end: gzip → Reed–Solomon → bursty channel → recovered byte-for-byte.' },
  { route: 'benchmark', name: 'Benchmark', desc: 'Race every codec on shared corpora against the entropy floor.' },
  { route: 'selftest', name: 'Self-test', desc: 'Every codec round-trips, every ECC corrects — proven live.' },
]

export function Overview() {
  const [text, setText] = useState(
    'the quick brown fox jumps over the lazy dog. the dog sleeps. the fox runs.',
  )
  const report = useMemo(() => analyze(strToBytes(text)), [text])

  return (
    <div>
      <PageHeader
        kicker="Information Theory · All Three of Shannon's Theorems"
        title="Entropy Forge"
        lede={
          <>
            A hands-on laboratory of information theory, built from first principles with zero
            dependencies. The <strong>source-coding</strong> half implements every major lossless codec —
            Huffman, arithmetic, <strong>rANS/tANS</strong>, <strong>PPM</strong>, context mixing, LZ77/LZW,
            a Burrows–Wheeler stack, and the real DEFLATE/gzip, LZMA and PNG formats — each provably
            round-tripping its input. The <strong>channel-coding</strong> half builds Shannon's{' '}
            <em>second</em> theorem: <strong>Hamming</strong>, <strong>Reed–Solomon</strong>,{' '}
            <strong>convolutional/Viterbi</strong>, <strong>LDPC</strong> and <strong>polar</strong>{' '}
            error-correction, each provably repairing every corruption within its guarantee. And the{' '}
            <strong>rate–distortion</strong> pillar builds the <em>third</em>: a from-scratch{' '}
            <strong>JPEG</strong> that steps past the entropy floor by discarding only what the eye
            can't see — the browser's own decoder renders the file it emits. Watch entropy turn into
            bits, redundancy turn into resilience, and bits buy fidelity.
          </>
        }
      />

      <Panel
        title="Live entropy meter"
        note="Shannon's source coding theorem: no lossless coder averages fewer than H(X) bits per symbol."
      >
        <InputPanel value={text} onChange={setText} rows={3} />
        <div className="grid grid-4" style={{ marginTop: 16 }}>
          <Stat label="Length" value={report.length} unit="bytes" />
          <Stat label="Distinct symbols" value={report.distinct} />
          <Stat
            label="Order-0 entropy"
            value={fmtNum(report.order0)}
            unit="bits/sym"
            accent
            sub={`ideal size ≈ ${Math.ceil(report.idealBits / 8)} B`}
          />
          <Stat
            label="Redundancy"
            value={pct(report.redundancy)}
            sub={`vs. uniform ${fmtNum(report.maxEntropy)} b/sym`}
          />
        </div>
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <Stat label="Order-1 entropy" value={fmtNum(report.order1)} unit="bits/sym" sub="given previous byte" />
          <Stat label="Order-2 entropy" value={fmtNum(report.order2)} unit="bits/sym" sub="given previous 2 bytes" />
          <Stat
            label="Context gain"
            value={pct(report.order0 > 0 ? 1 - report.order1 / report.order0 : 0)}
            sub="order-0 → order-1 drop"
          />
        </div>
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
          Notice how the higher-order entropies fall below order-0: real text carries{' '}
          <em>context</em>. Entropy coders that model context (arithmetic order-1, LZ, BWT) exploit
          exactly this gap. The Analyzer breaks it down symbol by symbol.
        </p>
      </Panel>

      <SectionTitle>The lab</SectionTitle>
      <div className="grid grid-2">
        {MODULES.map((m) => (
          <button
            key={m.route}
            className="panel"
            style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit' }}
            onClick={() => navigate(m.route)}
          >
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>{m.name}</h3>
            <div className="muted" style={{ fontSize: 13.5 }}>
              {m.desc}
            </div>
          </button>
        ))}
      </div>

      <SectionTitle>How the pieces fit</SectionTitle>
      <Panel>
        <div className="prose">
          <p>
            Lossless compression splits into two ideas that combine into every real format. First,{' '}
            <strong>entropy coding</strong> assigns shorter codes to more probable symbols: Huffman
            does it with whole-bit prefix codes (optimal among those), while{' '}
            <strong>arithmetic coding</strong> and <strong>rANS</strong> spend fractional bits to
            reach the entropy bound exactly — the latter by a fast table-and-multiply that powers
            zstd. Second, <strong>modelling</strong> makes symbols more predictable before they are
            coded — <strong>PPM</strong> conditions on the longest matching context,{' '}
            <strong>LZ77/LZW</strong> replace repeats with references, and the{' '}
            <strong>Burrows–Wheeler transform</strong> reorders data so a cheap local model suffices.
            At the far end, <strong>context mixing</strong> (the PAQ family) runs <em>many</em> models
            at once and blends their bit-level predictions with a mixer that learns whom to trust — the
            architecture behind the strongest compressors ever measured.
          </p>
          <p>
            gzip is LZ77 + Huffman; bzip2 is BWT + move-to-front + Huffman; modern coders pair LZ
            with arithmetic coding. The <strong>Benchmark</strong> page assembles those very
            combinations here — DEFLATE-lite and bzip-lite — and races them, each result checked by
            a full decode back to the original bytes.
          </p>
        </div>
      </Panel>

      <SectionTitle>The other half of Shannon</SectionTitle>
      <Panel
        title="Channel coding — redundancy becomes resilience"
        note="Source coding removes redundancy to shrink data. Channel coding adds it back — structured and minimal — so a message survives a noisy channel and reconstructs exactly."
      >
        <div className="prose">
          <p style={{ marginTop: 0 }}>
            Shannon's 1948 paper proved <em>two</em> theorems. The rest of this lab chases the first —
            the entropy floor on compression. This pillar builds the second: the{' '}
            <strong>noisy-channel coding theorem</strong>. Every channel has a <strong>capacity</strong>{' '}
            C, and any code of rate R &lt; C can be made <strong>arbitrarily reliable</strong>. The
            error-correcting codes here are concrete constructions under that ceiling —{' '}
            <strong>Hamming</strong> (syndrome = error position), <strong>Reed–Solomon</strong>{' '}
            (the QR/CD/DVD/Voyager code, byte- and burst-error correcting over GF(256)),{' '}
            <strong>convolutional codes with Viterbi</strong> (the trellis and its maximum-likelihood
            decoder), and <strong>LDPC with belief propagation</strong> (capacity-approaching, inside 5G
            and Wi-Fi 6) — each proven to decode every corruption within its guarantee.
          </p>
          <p style={{ marginBottom: 0 }}>
            The <strong>Channel Lab</strong> page runs both halves together: it <em>gzips</em> a message
            (source coding), wraps it in <em>Reed–Solomon</em> parity (channel coding), fires it through a
            bursty channel, and recovers the original byte-for-byte — while the same noise on the
            unprotected stream destroys it. That is Shannon's <strong>separation theorem</strong>, made
            runnable.
          </p>
        </div>
      </Panel>
    </div>
  )
}
