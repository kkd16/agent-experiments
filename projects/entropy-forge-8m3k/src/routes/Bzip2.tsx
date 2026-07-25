import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart } from '../components/charts'
import { strToBytes, bytesToStr } from '../lib/bits'
import { byteGlyph } from '../lib/format'
import { bzip2Analyze, bzip2Decode } from '../lib/bzip2'

const DEFAULT =
  'the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog. ' +
  'she sells sea shells by the sea shore; the shells she sells are surely sea shells.'

// A real .bz2 stream, produced by the Unix `bzip2 -9` tool, embedded so the page
// can prove interoperability *live* in the browser: our from-scratch decoder
// reconstructs bytes another program wrote. (Base64 to keep it a plain string.)
const REAL_BZ2_VECTOR =
  'QlpoOTFBWSZTWYULd1YAABmfgEAHEAgbQASAP//fsDAAuUGqPRpMjID1AAMgwyMCaYEyGJowGqfppNRlNqmwoekMnmqeUXIhvqWmrvvv6YEw0K/BlPFNJcPLczQSbai4Djv3IGUuFzRrhMiRG7Ipw1uB+8i22mRaMDrLx0hM2qaPq5IsxGd8XQa42QCg/ChSJK9YQPIwsyBEy13Vqjqgg/0DCDzm34ZCqE8V6uXjLtE3YSOmfaAXN/lXmuMMyFBQOLSuzf7TYt1XrYV9oBtrNg5H+LuSKcKEhChburA='

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex32(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0')
}

// A label for one entry of the MTF/RLE2 symbol stream.
function mtfLabel(sym: number, eob: number): { text: string; kind: 'run' | 'eob' | 'val' } {
  if (sym === 0) return { text: 'A', kind: 'run' }
  if (sym === 1) return { text: 'B', kind: 'run' }
  if (sym === eob) return { text: 'EOB', kind: 'eob' }
  return { text: String(sym - 1), kind: 'val' }
}

function download(name: string, bytes: Uint8Array) {
  try {
    const ab = new ArrayBuffer(bytes.length)
    new Uint8Array(ab).set(bytes)
    const blob = new Blob([ab], { type: 'application/x-bzip2' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    /* sandboxed thumbnail — ignore */
  }
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 10,
        background: ok
          ? 'color-mix(in srgb, var(--teal) 16%, transparent)'
          : 'color-mix(in srgb, var(--amber) 22%, transparent)',
        border: `1px solid ${ok ? 'var(--teal)' : 'var(--amber)'}`,
        fontSize: 13,
      }}
    >
      <span style={{ fontSize: 16 }}>{ok ? '✓' : '✗'}</span>
      <span>{label}</span>
    </div>
  )
}

export function Bzip2() {
  const [text, setText] = useState(DEFAULT)
  const [level, setLevel] = useState(9)

  const data = useMemo(() => strToBytes(text.slice(0, 12000)), [text])
  const a = useMemo(() => bzip2Analyze(data, { level }), [data, level])

  // Live interop: decode the embedded real bzip2 stream.
  const interop = useMemo(() => {
    try {
      const bytes = b64ToBytes(REAL_BZ2_VECTOR)
      const decoded = bytesToStr(bzip2Decode(bytes))
      return { ok: true, text: decoded, bytes: bytes.length }
    } catch (e) {
      return { ok: false, text: (e as Error).message, bytes: 0 }
    }
  }, [])

  const first = a.first
  const stageData = [
    { label: 'input', value: a.sizes.input, color: 'var(--c0)' },
    { label: 'RLE1', value: a.sizes.rle1, color: 'var(--c1)' },
    { label: 'MTF/RLE2 symbols', value: a.sizes.mtfSymbols, color: 'var(--c2)' },
    { label: '.bz2 out', value: a.sizes.compressed, color: 'var(--c3)' },
  ]

  // MTF stream stats: what fraction of symbols became zero-runs?
  const zeroRunSyms = first ? first.mtfv.filter((s) => s === 0 || s === 1).length : 0
  const eob = first ? first.seqToUnseq.length + 1 : 0

  // Selector histogram (which of the tables each group chose).
  const selHist = useMemo(() => {
    if (!first) return [] as { label: string; value: number; color: string }[]
    const counts = new Array<number>(first.nGroups).fill(0)
    for (const s of first.selectors) counts[s]++
    return counts.map((c, i) => ({ label: `table ${i}`, value: c, color: `var(--c${i % 7})` }))
  }, [first])

  return (
    <div>
      <PageHeader
        kicker="The real thing · Burrows–Wheeler in production"
        title="bzip2 — the genuine .bz2 format"
        lede={
          <>
            The lab has every piece of the block-sorting stack as an isolated primitive; this page
            assembles them into the <strong>actual bzip2 container</strong>. RLE1 → BWT → move-to-front →
            RUNA/RUNB zero-runs → 2–6 Huffman tables chosen per 50-symbol group, wrapped with the exact
            bzip2 CRC-32 and stream magics. It is <strong>byte-compatible</strong>: <code>bunzip2</code>{' '}
            decompresses what this writes, and it reads real <code>.bz2</code> files — proven live below.
          </>
        }
      />

      <Panel>
        <InputPanel value={text} onChange={setText} rows={5} maxNote="first 12 KB compressed" />
        <div className="row" style={{ marginTop: 12 }}>
          <span className="stat-label">Block size</span>
          <input
            type="range"
            min={1}
            max={9}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            style={{ flex: 1, maxWidth: 260 }}
          />
          <span className="mono">
            −{level} · {level * 100}k
          </span>
          <button className="chip" onClick={() => download('entropy-forge.bz2', a.stream)}>
            ⭳ download .bz2
          </button>
        </div>
      </Panel>

      {!a.ok && (
        <Panel title="Error">
          <div className="mono" style={{ color: 'var(--amber)' }}>
            {a.error}
          </div>
        </Panel>
      )}

      {a.ok && (
        <>
          <div className="grid grid-4" style={{ marginTop: 16 }}>
            <Stat
              label="Compressed"
              value={a.sizes.compressed}
              unit="B"
              accent
              sub={`from ${a.sizes.input} B`}
            />
            <Stat label="Ratio" value={(a.ratio * 100).toFixed(1)} unit="%" sub={`${a.bitsPerByte.toFixed(3)} bits/byte`} />
            <Stat label="Blocks" value={a.blocks.length} sub={`origPtr ${first?.bwtPtr ?? 0}`} />
            <Stat
              label="Round-trip"
              value={a.roundTrips ? '✓ exact' : '✗ FAIL'}
              sub="decode(encode(x)) = x"
            />
          </div>

          <Panel title="The pipeline, stage by stage" note="how many symbols survive each transform before the entropy coder">
            <HBarChart
              bars={stageData.map((s) => ({ label: s.label, value: s.value, color: s.color }))}
              valueFmt={(v) => `${v}`}
            />
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              RLE1 defuses long runs; the BWT then clusters like bytes so move-to-front collapses them into a
              sea of zeros — here{' '}
              <strong>
                {first && first.mtfv.length ? ((zeroRunSyms / first.mtfv.length) * 100).toFixed(0) : 0}%
              </strong>{' '}
              of the {first?.mtfv.length ?? 0} MTF symbols are RUNA/RUNB run codes — which the multi-table
              Huffman stage codes in a fraction of a bit each.
            </p>
          </Panel>

          {first && (
            <>
              <div className="grid grid-2">
                <Panel title="Burrows–Wheeler output (last column)" note={`origPtr = ${first.bwtPtr} · the one index the inverse needs`}>
                  <div className="glyph-wrap">
                    {Array.from(first.bwtL.slice(0, 200)).map((b, i) => (
                      <span key={i} className="glyph" title={String(b)}>
                        {byteGlyph(b)}
                      </span>
                    ))}
                    {first.bwtL.length > 200 && <span className="muted"> …+{first.bwtL.length - 200}</span>}
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    A reversible permutation, not a compressor — but notice the runs it manufactures. That
                    clustering is the whole point.
                  </p>
                </Panel>

                <Panel title="MTF + RLE2 symbol stream" note="RUNA/RUNB (A/B) = zero-run codes · numbers = move-to-front ranks · EOB ends the block">
                  <div className="glyph-wrap">
                    {first.mtfv.slice(0, 160).map((s, i) => {
                      const l = mtfLabel(s, eob)
                      const bg =
                        l.kind === 'run'
                          ? 'color-mix(in srgb, var(--teal) 22%, transparent)'
                          : l.kind === 'eob'
                            ? 'color-mix(in srgb, var(--amber) 26%, transparent)'
                            : 'var(--panel-2)'
                      return (
                        <span
                          key={i}
                          className="mono"
                          style={{ padding: '1px 5px', borderRadius: 5, background: bg, fontSize: 12 }}
                        >
                          {l.text}
                        </span>
                      )
                    })}
                    {first.mtfv.length > 160 && <span className="muted"> …+{first.mtfv.length - 160}</span>}
                  </div>
                </Panel>
              </div>

              <div className="grid grid-2">
                <Panel
                  title="Entropy stage — several codes, best per group"
                  note={`${first.nGroups} Huffman tables · ${first.selectors.length} groups of 50 symbols · MTF-coded selectors`}
                >
                  <HBarChart bars={selHist} valueFmt={(v) => `${v} groups`} />
                  <div className="glyph-wrap" style={{ marginTop: 10 }}>
                    {first.tableLens.map((len, t) => {
                      let mn = 99
                      let mx = 0
                      let sum = 0
                      for (const L of len) {
                        if (L < mn) mn = L
                        if (L > mx) mx = L
                        sum += L
                      }
                      return (
                        <span key={t} className="mono" style={{ fontSize: 12, marginRight: 14 }}>
                          <span className="muted">table {t}:</span> {mn}–{mx} bits (avg {(sum / len.length).toFixed(1)})
                        </span>
                      )
                    })}
                  </div>
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    bzip2's signature trick: instead of one code for the whole block it trains up to six and, in
                    four refinement passes, lets each 50-symbol group pick the cheapest — a poor man's context
                    model that costs only a MTF-coded selector per group.
                  </p>
                </Panel>

                <Panel title="Alphabet & block header" note="the sparse symbol map bzip2 ships so the decoder knows which of 256 bytes occur">
                  <div className="grid grid-2" style={{ gap: 10 }}>
                    <Stat label="Distinct bytes" value={first.seqToUnseq.length} unit="/256" />
                    <Stat label="Huffman tables" value={first.nGroups} />
                    <Stat label="Block CRC-32" value={<span className="mono" style={{ fontSize: 15 }}>{hex32(a.blocks[0]?.crc ?? 0)}</span>} sub="bzip2's non-reflected variant" />
                    <Stat label="Stream CRC" value={<span className="mono" style={{ fontSize: 15 }}>{hex32(a.combinedCrc)}</span>} sub="rotate-left ⊕ per block" />
                  </div>
                  <div className="glyph-wrap" style={{ marginTop: 10 }}>
                    {first.seqToUnseq.slice(0, 64).map((b, i) => (
                      <span key={i} className="glyph" title={String(b)}>
                        {byteGlyph(b)}
                      </span>
                    ))}
                    {first.seqToUnseq.length > 64 && (
                      <span className="muted"> …+{first.seqToUnseq.length - 64}</span>
                    )}
                  </div>
                </Panel>
              </div>
            </>
          )}

          <Panel
            title="Interoperability — the proof"
            note="bzip2 is a real, standardised format; this implementation speaks it byte-for-byte"
          >
            <div className="grid grid-2" style={{ gap: 12 }}>
              <div>
                <Badge ok={interop.ok} label="Decodes a real .bz2 written by the Unix bzip2 tool" />
                <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                  {interop.bytes} bytes produced by <code>bzip2 -9</code>, decoded live by our engine:
                </p>
                <div
                  className="mono"
                  style={{
                    fontSize: 12,
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--panel-2)',
                    maxHeight: 120,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {interop.text}
                </div>
              </div>
              <div>
                <Badge ok={a.roundTrips} label="Our .bz2 round-trips through our own decoder" />
                <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                  And <code>bunzip2</code> accepts it too — the encoder emits a spec-valid stream (correct
                  origPtr, complete canonical Huffman codes, MTF-coded selectors, matching per-block CRC). Hit{' '}
                  <strong>⭳ download .bz2</strong> above and run:
                </p>
                <div
                  className="mono"
                  style={{ fontSize: 12, padding: 10, borderRadius: 8, background: 'var(--panel-2)' }}
                >
                  $ bunzip2 -c entropy-forge.bz2
                </div>
                <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                  The stream you download begins <code>BZh{level}</code> and ends with bzip2's √π footer magic
                  and the combined stream CRC — exactly what the tool expects.
                </p>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
