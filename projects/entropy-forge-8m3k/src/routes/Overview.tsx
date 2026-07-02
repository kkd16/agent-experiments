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
  { route: 'ppm', name: 'PPM', desc: 'Context modelling with escapes; watch more context hit diminishing returns.' },
  { route: 'lempel', name: 'LZ77 & LZW', desc: 'Exploit repetition with back-references and self-building dictionaries.' },
  { route: 'burrows', name: 'Burrows–Wheeler', desc: 'The reversible permutation at the heart of bzip2.' },
  { route: 'suffix', name: 'Suffix Array', desc: 'Linear-time SA-IS that makes the BWT scale to kilobytes.' },
  { route: 'benchmark', name: 'Benchmark', desc: 'Race every codec on shared corpora against the entropy floor.' },
  { route: 'selftest', name: 'Self-test', desc: 'Every codec round-trips every input — proven live.' },
]

export function Overview() {
  const [text, setText] = useState(
    'the quick brown fox jumps over the lazy dog. the dog sleeps. the fox runs.',
  )
  const report = useMemo(() => analyze(strToBytes(text)), [text])

  return (
    <div>
      <PageHeader
        kicker="Information Theory · Lossless Compression"
        title="Entropy Forge"
        lede={
          <>
            A hands-on laboratory of lossless data compression, built from first principles with
            zero dependencies. Every codec here — Huffman (static & adaptive), arithmetic,{' '}
            <strong>rANS</strong>, <strong>PPM</strong>, LZ77, LZW, and a full Burrows–Wheeler stack
            over a linear-time <strong>suffix array</strong> — is implemented from scratch and{' '}
            <strong>provably round-trips</strong> its input. Watch entropy turn into bits.
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
          </p>
          <p>
            gzip is LZ77 + Huffman; bzip2 is BWT + move-to-front + Huffman; modern coders pair LZ
            with arithmetic coding. The <strong>Benchmark</strong> page assembles those very
            combinations here — DEFLATE-lite and bzip-lite — and races them, each result checked by
            a full decode back to the original bytes.
          </p>
        </div>
      </Panel>
    </div>
  )
}
