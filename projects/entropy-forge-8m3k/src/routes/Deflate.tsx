import { useEffect, useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart } from '../components/charts'
import { strToBytes } from '../lib/bits'
import { byteGlyph } from '../lib/format'
import { CORPUS } from '../lib/corpus'
import { deflate, type DToken } from '../lib/deflate'
import { canonicalFromLengths } from '../lib/deflateBits'
import { LEN_BASE, LEN_EXTRA, DIST_BASE, DIST_EXTRA } from '../lib/deflateTables'
import { gzipEncode, gzipDecode, type GzipField } from '../lib/gzip'
import { crc32 } from '../lib/crc32'
import { runInterop, interopAvailable, type InteropResult } from '../lib/selftest'

const DEFAULT = CORPUS.find((c) => c.id === 'json')?.text ?? 'the quick brown fox'

function codeStr(code: number, len: number): string {
  return len > 0 ? code.toString(2).padStart(len, '0') : '—'
}

function llLabel(sym: number): string {
  if (sym < 256) return byteGlyph(sym)
  if (sym === 256) return 'EOB'
  const lc = sym - 257
  const base = LEN_BASE[lc]
  const extra = LEN_EXTRA[lc]
  const hi = lc === LEN_BASE.length - 1 ? base : base + (1 << extra) - 1
  return extra ? `len ${base}–${hi}` : `len ${base}`
}
function distLabel(sym: number): string {
  const base = DIST_BASE[sym]
  const extra = DIST_EXTRA[sym]
  const hi = base + (1 << extra) - 1
  return extra ? `dist ${base}–${hi}` : `dist ${base}`
}
function clcLabel(sym: number): string {
  if (sym <= 15) return `length ${sym}`
  if (sym === 16) return 'copy prev ×3–6'
  if (sym === 17) return 'zeros ×3–10'
  return 'zeros ×11–138'
}

function InteropBadge({
  ok,
  label,
  checking,
}: {
  ok: boolean | undefined
  label: string
  checking: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 10,
        background: checking
          ? 'var(--panel-2)'
          : ok
            ? 'color-mix(in srgb, var(--teal) 16%, transparent)'
            : 'color-mix(in srgb, var(--amber) 22%, transparent)',
        border: `1px solid ${checking ? 'var(--border)' : ok ? 'var(--teal)' : 'var(--amber)'}`,
        fontSize: 13,
      }}
    >
      <span style={{ fontSize: 16 }}>{checking ? '⟳' : ok ? '✓' : '✗'}</span>
      <span>{label}</span>
    </div>
  )
}

// ---- native interop badge: our gzip ⇄ the platform's own gzip ----
function InteropBadges({ data }: { data: Uint8Array }) {
  // Availability is known at first render, so seed it there (not via a synchronous
  // setState in the effect). The parent remounts this via `key` when the input
  // changes, so each input starts fresh in the 'checking' state.
  const [state, setState] = useState<'checking' | 'done' | 'unavailable'>(() =>
    interopAvailable() ? 'checking' : 'unavailable',
  )
  const [results, setResults] = useState<InteropResult[]>([])

  useEffect(() => {
    if (!interopAvailable()) return
    let live = true
    runInterop([{ name: 'input', data }]).then((r) => {
      if (live) {
        setResults(r)
        setState('done')
      }
    })
    return () => {
      live = false
    }
  }, [data])

  if (state === 'unavailable') {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        The platform's native compression API isn't available here, so the live cross-check is
        skipped — the offline self-test still verifies 28 interop cases under Node.
      </div>
    )
  }
  const forward = results.find((r) => r.name.startsWith('native gunzip'))
  const backward = results.find((r) => r.name.startsWith('ours.gunzip'))
  const checking = state === 'checking'
  return (
    <div className="grid grid-2" style={{ gap: 12 }}>
      <InteropBadge checking={checking} ok={forward?.pass} label="Our gzip → the browser's native gunzip reproduces the input" />
      <InteropBadge checking={checking} ok={backward?.pass} label="The browser's native gzip → our inflater + CRC check" />
    </div>
  )
}

// ---- the annotated gzip container hex dump ----
function HexDump({ bytes, fields }: { bytes: Uint8Array; fields: GzipField[] }) {
  // Which annotated field (if any) owns each byte, so we can colour the header and
  // trailer and elide the long DEFLATE payload in the middle.
  const owner = new Int32Array(bytes.length).fill(-1)
  fields.forEach((f, fi) => {
    for (let i = f.offset; i < f.offset + f.bytes && i < bytes.length; i++) owner[i] = fi
  })
  const colors = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--teal)', 'var(--blue)', 'var(--violet)']
  const headerEnd = Math.max(...fields.filter((f) => f.name !== 'CRC32' && f.name !== 'ISIZE').map((f) => f.offset + f.bytes))
  const trailerStart = bytes.length - 8
  const rows: { start: number; slice: number[] }[] = []
  const pushRange = (from: number, to: number) => {
    for (let i = from; i < to; i += 16) {
      rows.push({ start: i, slice: Array.from(bytes.subarray(i, Math.min(i + 16, to))) })
    }
  }
  const showPayload = trailerStart - headerEnd <= 64
  pushRange(0, showPayload ? bytes.length : headerEnd)
  if (!showPayload) pushRange(trailerStart, bytes.length)

  return (
    <div>
      <div style={{ overflowX: 'auto', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.7 }}>
        {rows.map((row, ri) => {
          const prevEnd = ri > 0 ? rows[ri - 1].start + 16 : 0
          const gap = !showPayload && ri > 0 && row.start !== prevEnd
          return (
            <div key={row.start}>
              {gap && (
                <div className="muted" style={{ padding: '3px 0' }}>
                  ⋯ {trailerStart - headerEnd} bytes of DEFLATE-compressed payload ⋯
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, whiteSpace: 'pre' }}>
                <span style={{ color: 'var(--text-dim)' }}>{row.start.toString(16).padStart(4, '0')}</span>
                <span>
                  {row.slice.map((b, i) => {
                    const o = owner[row.start + i]
                    return (
                      <span key={i} style={{ color: o >= 0 ? colors[o % colors.length] : 'var(--text-mid)', fontWeight: o >= 0 ? 600 : 400 }}>
                        {b.toString(16).padStart(2, '0')}{' '}
                      </span>
                    )
                  })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="chip-row" style={{ marginTop: 12 }}>
        {fields.map((f, i) => (
          <span
            key={i}
            className="chip"
            style={{ borderColor: colors[i % colors.length], color: colors[i % colors.length], cursor: 'default' }}
            title={`offset ${f.offset}, ${f.bytes} B`}
          >
            {f.name}: {f.value}
          </span>
        ))}
      </div>
    </div>
  )
}

function CodeTable({
  rows,
  label,
  headBits,
}: {
  rows: { label: string; length: number; code: string }[]
  label: string
  headBits?: string
}) {
  return (
    <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{label}</th>
            <th style={{ textAlign: 'right' }}>bits</th>
            <th style={{ textAlign: 'left' }}>{headBits ?? 'code'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ textAlign: 'left' }}>{r.label}</td>
              <td style={{ textAlign: 'right' }}>{r.length}</td>
              <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', color: 'var(--teal)' }}>{r.code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Deflate() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])

  const result = useMemo(() => deflate(data, { strategy: 'auto' }), [data])
  const gz = useMemo(() => gzipEncode(data, { filename: 'input.txt', mtime: 0 }), [data])
  const gzMeta = useMemo(() => gzipDecode(gz), [gz])

  const inBytes = data.length
  const ratio = inBytes > 0 ? gz.length / inBytes : 1
  const savings = inBytes > 0 ? 1 - result.bytes.length / inBytes : 0

  // LZ parse stats
  const stats = useMemo(() => {
    let lits = 0
    let matches = 0
    let matchBytes = 0
    let maxRun = 0
    for (const t of result.tokens) {
      if (t.kind === 'lit') lits++
      else {
        matches++
        matchBytes += t.len
        if (t.len > maxRun) maxRun = t.len
      }
    }
    return { lits, matches, matchBytes, maxRun, avg: matches ? matchBytes / matches : 0 }
  }, [result])

  // Parse map (capped so the DOM stays light on big inputs)
  const CAP = 1600
  const spans = useMemo(() => {
    const out: { char: string; match: boolean; dist?: number; len?: number }[] = []
    for (const t of result.tokens as DToken[]) {
      if (out.length >= CAP) break
      if (t.kind === 'lit') out.push({ char: byteGlyph(t.byte), match: false })
      else {
        for (let k = 0; k < t.len && out.length < CAP; k++) {
          out.push({ char: byteGlyph(data[t.pos + k]), match: true, dist: t.dist, len: t.len })
        }
      }
    }
    return out
  }, [result, data])

  // Dynamic-block code tables
  const plan = result.plan
  const llCodes = useMemo(() => canonicalFromLengths(plan.llLengths), [plan])
  const distCodes = useMemo(() => canonicalFromLengths(plan.distLengths), [plan])
  const clcCodes = useMemo(() => canonicalFromLengths(plan.clcLengths), [plan])

  const llRows = plan.llLengths
    .map((len, sym) => ({ sym, len }))
    .filter((r) => r.len > 0)
    .map((r) => ({ label: `${r.sym}  ${llLabel(r.sym)}`, length: r.len, code: codeStr(llCodes[r.sym], r.len) }))
  const distRows = plan.distLengths
    .map((len, sym) => ({ sym, len }))
    .filter((r) => r.len > 0)
    .map((r) => ({ label: `${r.sym}  ${distLabel(r.sym)}`, length: r.len, code: codeStr(distCodes[r.sym], r.len) }))
  const clcRows = plan.clcLengths
    .map((len, sym) => ({ sym, len }))
    .filter((r) => r.len > 0)
    .map((r) => ({ label: `${r.sym}  ${clcLabel(r.sym)}`, length: r.len, code: codeStr(clcCodes[r.sym], r.len) }))

  const stratBars = [
    { label: 'stored (raw)', value: result.sizes.stored, color: result.chosen === 'stored' ? 'var(--amber)' : 'var(--panel-hi)' },
    { label: 'fixed Huffman', value: result.sizes.fixed, color: result.chosen === 'fixed' ? 'var(--amber)' : 'var(--blue)' },
    { label: 'dynamic Huffman', value: result.sizes.dynamic, color: result.chosen === 'dynamic' ? 'var(--amber)' : 'var(--teal)' },
  ]

  return (
    <div>
      <PageHeader
        kicker="Dictionary + entropy · the real format"
        title="DEFLATE & gzip"
        lede={
          <>
            The algorithm inside <b>gzip</b>, <b>zlib</b>, <b>PNG</b> and <b>ZIP</b>, built here from
            scratch to the letter of RFC 1951: a 32 KB hash-chain LZ77 parse, then <b>fixed</b> or{' '}
            <b>dynamic</b> Huffman coding of the literal/length/distance symbols, wrapped in a
            CRC-32-checked container. The proof it's real: its output round-trips through your
            browser's own <code>gunzip</code>.
          </>
        }
      />

      <InputPanel value={text} onChange={setText} rows={4} maxNote="live" />

      <div className="grid grid-4" style={{ margin: '18px 0' }}>
        <Stat label="Input" value={inBytes} unit="B" />
        <Stat label="gzip output" value={gz.length} unit="B" accent sub={`${result.chosen} block`} />
        <Stat label="Compression" value={`${(savings * 100).toFixed(0)}%`} sub={`ratio ${(ratio * 100).toFixed(0)}%`} />
        <Stat label="CRC-32" value={`0x${crc32(data).toString(16).padStart(8, '0')}`} sub={gzMeta.crcOk ? 'verified ✓' : 'mismatch'} />
      </div>

      <Panel
        title="Native interoperability"
        note="The strongest correctness test there is — no shared code with the platform, only the wire format."
      >
        <InteropBadges key={gz.length} data={data} />
      </Panel>

      <Panel
        title="Block-type showdown"
        note="DEFLATE picks, per block, the cheapest of three encodings. Amber = the one auto-selected here. On text, dynamic Huffman wins; on random data, storing raw wins; tiny inputs favour the header-free fixed code."
      >
        <HBarChart
          bars={stratBars}
          max={Math.max(inBytes, result.sizes.stored) * 1.12}
          unit=" B"
          marker={{ value: inBytes, label: `input ${inBytes} B` }}
        />
      </Panel>

      <Panel
        title="LZ77 parse (32 KB window)"
        note="Teal = literal byte · amber = copied from a back-reference. Hover a run for its (distance, length). This is the dictionary stage, before Huffman coding."
        right={
          <div style={{ display: 'flex', gap: 18, fontSize: 12 }} className="muted">
            <span>{stats.lits} literals</span>
            <span>{stats.matches} matches</span>
            <span>avg {stats.avg.toFixed(1)}B</span>
            <span>longest {stats.maxRun}B</span>
          </div>
        }
      >
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.9, wordBreak: 'break-all' }}>
          {spans.map((s, i) => (
            <span
              key={i}
              title={s.match ? `copy ${s.len}B from ${s.dist} back` : 'literal'}
              style={{
                background: s.match ? 'color-mix(in srgb, var(--amber) 22%, transparent)' : 'color-mix(in srgb, var(--teal) 14%, transparent)',
                borderBottom: s.match ? '2px solid var(--amber)' : '2px solid transparent',
                whiteSpace: 'pre',
              }}
            >
              {s.char}
            </span>
          ))}
          {result.tokens.length > 0 && spans.length >= CAP && <span className="muted"> … (truncated)</span>}
        </div>
      </Panel>

      <Panel
        title="Dynamic block anatomy"
        note="A dynamic block transmits its own Huffman codes first — themselves Huffman-coded. Package-merge builds provably optimal codes capped at 15 bits; the run-length 'code-length alphabet' then compresses the two length tables before the data even begins."
      >
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="HLIT" value={plan.hlit} sub="lit/length codes" />
          <Stat label="HDIST" value={plan.hdist} sub="distance codes" />
          <Stat label="HCLEN" value={plan.hclen} sub="code-length codes" />
          <Stat label="Header : body" value={`${plan.headerBits} : ${plan.bodyBits}`} unit="bits" sub={`${(plan.headerBits / 8).toFixed(0)}B of tables`} />
        </div>
        <div className="grid grid-3" style={{ gap: 16 }}>
          <div>
            <div className="section-title">Code-length code ({clcRows.length})</div>
            <CodeTable rows={clcRows} label="symbol" />
          </div>
          <div>
            <div className="section-title">Literal / length code ({llRows.length})</div>
            <CodeTable rows={llRows} label="symbol" />
          </div>
          <div>
            <div className="section-title">Distance code ({distRows.length})</div>
            <CodeTable rows={distRows} label="symbol" />
          </div>
        </div>
      </Panel>

      <Panel
        title="gzip container (RFC 1952)"
        note="The bytes an actual .gz file carries: a 10-byte header, the optional filename, the DEFLATE payload, then a CRC-32 and the input size mod 2³². Coloured bytes are annotated fields."
      >
        <HexDump bytes={gz} fields={gzMeta.fields} />
      </Panel>
    </div>
  )
}
