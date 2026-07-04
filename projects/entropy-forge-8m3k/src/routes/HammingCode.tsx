import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import {
  HAMMING_7_4,
  HAMMING_8_4,
  HAMMING74_CHECKS,
  decodeSecDed,
  hammingFamily,
} from '../lib/hamming'
import { encodeLinear, decodeLinear, syndromeKey } from '../lib/linearCode'

function BitCell({
  bit,
  role,
  flipped,
  onClick,
  highlight,
}: {
  bit: number
  role: string
  flipped?: boolean
  onClick?: () => void
  highlight?: string
}) {
  return (
    <div
      onClick={onClick}
      title={role + (flipped ? ' — flipped by you' : '')}
      style={{
        width: 46,
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'center',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 22,
          fontWeight: 600,
          height: 42,
          lineHeight: '42px',
          borderRadius: 8,
          border: `1px solid ${flipped ? 'var(--red)' : highlight ?? 'var(--border)'}`,
          background: flipped ? 'color-mix(in srgb, var(--red) 22%, var(--panel-2))' : 'var(--panel-2)',
          color: flipped ? 'var(--red)' : highlight ?? 'var(--text)',
        }}
      >
        {bit}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>{role}</div>
    </div>
  )
}

export function HammingCode() {
  const [msg, setMsg] = useState<number[]>([1, 0, 1, 1])
  const [flip, setFlip] = useState<Set<number>>(new Set([5]))

  const codeword = useMemo(() => encodeLinear(HAMMING_7_4, msg), [msg])
  const received = useMemo(() => codeword.map((b, i) => (flip.has(i) ? b ^ 1 : b)), [codeword, flip])
  const decoded = useMemo(() => decodeLinear(HAMMING_7_4, received), [received])
  const synKey = syndromeKey(decoded.syndrome)

  const toggleFlip = (i: number) =>
    setFlip((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const roles = ['d₀', 'd₁', 'd₂', 'd₃', 'p₀', 'p₁', 'p₂']

  // Venn circle contents: each parity check is a circle covering its data bits.
  // Positions for the classic 3-circle picture.
  const circles = [
    { cx: 90, cy: 78, label: 'p₀', color: 'var(--teal)' },
    { cx: 150, cy: 78, label: 'p₁', color: 'var(--violet)' },
    { cx: 120, cy: 130, label: 'p₂', color: 'var(--amber)' },
  ]
  // Data/parity bit placements inside the Venn regions (7,4 layout).
  const venn: { i: number; x: number; y: number }[] = [
    { i: 3, x: 120, y: 92 }, // d3 — center (all three)
    { i: 2, x: 108, y: 66 }, // d2 — p0 & p1
    { i: 1, x: 102, y: 110 }, // d1 — p0 & p2
    { i: 0, x: 138, y: 110 }, // d0 — p1 & p2
    { i: 4, x: 66, y: 60 }, // p0 only
    { i: 5, x: 174, y: 60 }, // p1 only
    { i: 6, x: 120, y: 158 }, // p2 only
  ]

  const fam = [3, 4, 5].map((m) => hammingFamily(m))

  return (
    <div>
      <PageHeader
        kicker="Channel coding · the first error-correcting code"
        title="Hamming Codes"
        lede={
          <>
            Richard Hamming's 1950 insight: place the parity bits so the failed checks, read as a
            binary number, spell out the <b>position</b> of the flipped bit. The <b>Hamming(7,4)</b> code
            carries 4 data bits in a 7-bit codeword and corrects <b>any single error</b>. Flip a bit
            below and watch the <b>syndrome</b> point straight at it.
          </>
        }
      />

      <Panel
        title="Encode → corrupt → correct"
        note="Toggle the 4 data bits; click any codeword bit to flip it (simulate a channel error). The decoder computes the syndrome and, if non-zero, XORs out the coset leader it names."
      >
        <div className="row" style={{ gap: 24, marginBottom: 16, alignItems: 'flex-start' }}>
          <div>
            <div className="stat-label" style={{ marginBottom: 8 }}>Message (4 data bits)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {msg.map((b, i) => (
                <button
                  key={i}
                  className="chip"
                  style={{ fontFamily: 'var(--mono)', fontSize: 18, width: 42, height: 42, justifyContent: 'center', color: 'var(--teal)' }}
                  onClick={() => setMsg((m) => m.map((x, j) => (j === i ? x ^ 1 : x)))}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div className="stat-label" style={{ marginBottom: 8 }}>Received codeword — click to inject errors</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {received.map((b, i) => (
                <BitCell
                  key={i}
                  bit={b}
                  role={roles[i]}
                  flipped={flip.has(i)}
                  onClick={() => toggleFlip(i)}
                  highlight={decoded.errorPattern[i] ? 'var(--amber)' : i < 4 ? 'var(--teal)' : undefined}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-4">
          <Stat label="Syndrome" value={<span style={{ fontFamily: 'var(--mono)' }}>{decoded.syndrome.join('')}</span>} sub={synKey === 0 ? 'zero — no error' : `= ${synKey} → position ${synKey}`} accent={synKey !== 0} />
          <Stat label="Errors injected" value={flip.size} sub={flip.size > 1 ? 'beyond t=1 guarantee' : ''} />
          <Stat
            label="Decode"
            value={flip.size === 0 ? 'clean' : decoded.numErrors === 0 ? 'undetected' : 'corrected'}
            sub={decoded.errorPattern.some((e) => e) ? `flips bit ${decoded.errorPattern.indexOf(1)}` : ''}
          />
          <Stat
            label="Recovered = sent?"
            value={decoded.message.join('') === msg.join('') ? 'yes ✓' : 'NO ✗'}
            sub={`msg ${decoded.message.join('')}`}
          />
        </div>
        {flip.size >= 2 && (
          <div className="prose" style={{ fontSize: 13, marginTop: 12, color: 'var(--text-mid)' }}>
            With 2 errors you've exceeded the (7,4) code's guarantee of t=⌊(d−1)/2⌋=1. The syndrome is
            still non-zero, but it names a <em>single</em> wrong position — the decoder "corrects" to the
            nearest codeword, which is no longer yours. This is exactly why the <b>extended</b> code below
            adds a distance and can at least <em>detect</em> the double error instead of silently mangling it.
          </div>
        )}
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="The three-circle picture"
          note="Each parity bit makes its own circle even. A single flip breaks a distinct subset of circles — and no two bits break the same subset, so the broken set identifies the culprit."
        >
          <svg viewBox="0 0 240 190" width="100%" style={{ maxWidth: 320, display: 'block', margin: '0 auto' }}>
            {circles.map((c, ci) => {
              const broken = decoded.syndrome[ci] === 1
              return (
                <circle
                  key={ci}
                  cx={c.cx}
                  cy={c.cy}
                  r={44}
                  fill={`color-mix(in srgb, ${c.color} 10%, transparent)`}
                  stroke={broken ? 'var(--red)' : c.color}
                  strokeWidth={broken ? 3 : 1.5}
                  strokeDasharray={broken ? '5 3' : undefined}
                />
              )
            })}
            {venn.map((v) => {
              const flipped = flip.has(v.i)
              return (
                <g key={v.i}>
                  <circle cx={v.x} cy={v.y} r={11} fill={flipped ? 'var(--red)' : 'var(--panel)'} stroke="var(--border-hi)" />
                  <text x={v.x} y={v.y + 4} textAnchor="middle" fontSize={12} fontFamily="var(--mono)" fill={flipped ? '#0a0d13' : 'var(--text)'}>
                    {received[v.i]}
                  </text>
                  <text x={v.x} y={v.y - 14} textAnchor="middle" fontSize={8} fill="var(--text-dim)">{roles[v.i]}</text>
                </g>
              )
            })}
            {circles.map((c, ci) => (
              <text key={`l${ci}`} x={c.cx} y={c.cy + (ci === 2 ? 40 : -34)} textAnchor="middle" fontSize={11} fontFamily="var(--mono)" fill={c.color}>
                {c.label}{decoded.syndrome[ci] === 1 ? ' ✗' : ' ✓'}
              </text>
            ))}
          </svg>
          <div className="chip-row" style={{ marginTop: 8, justifyContent: 'center' }}>
            {HAMMING74_CHECKS.map((c, ci) => (
              <span key={ci} className="chip" style={{ cursor: 'default' }}>
                p{ci} = d{c.covers.join(' ⊕ d')}
              </span>
            ))}
          </div>
        </Panel>

        <Panel
          title="Syndrome → error position"
          note="The complete lookup table: every non-zero 3-bit syndrome maps to the one flipped position. This is 'standard-array' decoding — precomputed once, then decode is a table lookup."
        >
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr><th style={{ textAlign: 'left' }}>syndrome</th><th>as int</th><th style={{ textAlign: 'left' }}>error at</th></tr>
              </thead>
              <tbody>
                {Array.from(HAMMING_7_4.syndromeTable.entries())
                  .sort((a, b) => a[0] - b[0])
                  .map(([key, e]) => {
                    const pos = e.indexOf(1)
                    const isCur = key === synKey && synKey !== 0
                    return (
                      <tr key={key} style={isCur ? { background: 'color-mix(in srgb, var(--amber) 16%, transparent)' } : undefined}>
                        <td style={{ textAlign: 'left', fontFamily: 'var(--mono)' }}>{key.toString(2).padStart(3, '0')}</td>
                        <td style={{ fontFamily: 'var(--mono)' }}>{key}</td>
                        <td style={{ textAlign: 'left' }}>{pos === -1 ? '— (no error)' : `${roles[pos]} (bit ${pos})`}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel
        title="Extended Hamming(8,4) — SEC-DED"
        note="Add one overall-parity bit → minimum distance jumps 3→4. Now it Single-Error-Corrects and Double-Error-Detects: it can tell a 2-bit error apart from a 1-bit one instead of mis-correcting. This is the code guarding ECC server memory."
      >
        <SecDedDemo msg={msg} />
      </Panel>

      <Panel
        title="The Hamming family scales"
        note="Add m parity bits, cover 2^m−1 positions. The rate climbs toward 1 as the blocks grow — the overhead is only the log of the block length."
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th style={{ textAlign: 'left' }}>code</th><th>n</th><th>k</th><th>parity m</th><th>d</th><th>corrects</th><th>rate k/n</th></tr>
            </thead>
            <tbody>
              {fam.map((c) => (
                <tr key={c.n}>
                  <td style={{ textAlign: 'left' }}>{c.name}</td>
                  <td>{c.n}</td>
                  <td>{c.k}</td>
                  <td>{c.n - c.k}</td>
                  <td>{c.d}</td>
                  <td>{c.t}</td>
                  <td style={{ color: 'var(--teal)' }}>{(c.k / c.n).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

function SecDedDemo({ msg }: { msg: number[] }) {
  const [flips, setFlips] = useState<Set<number>>(new Set([2, 5]))
  const code = HAMMING_8_4
  const codeword = useMemo(() => encodeLinear(code, msg), [msg, code])
  const received = useMemo(() => codeword.map((b, i) => (flips.has(i) ? b ^ 1 : b)), [codeword, flips])
  const res = useMemo(() => decodeSecDed(received), [received])
  const roles = ['d₀', 'd₁', 'd₂', 'd₃', 'p₀', 'p₁', 'p₂', 'p₃']

  const toggle = (i: number) =>
    setFlips((prev) => {
      const n = new Set(prev)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  const statusColor = res.status === 'clean' ? 'var(--green)' : res.status === 'corrected' ? 'var(--teal)' : 'var(--amber)'
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {received.map((b, i) => (
          <BitCell key={i} bit={b} role={roles[i]} flipped={flips.has(i)} onClick={() => toggle(i)} highlight={i === res.errorPos && res.status === 'corrected' ? 'var(--teal)' : i < 4 ? 'var(--teal)' : undefined} />
        ))}
      </div>
      <div className="grid grid-4">
        <Stat label="Inner syndrome" value={<span style={{ fontFamily: 'var(--mono)' }}>{res.syndrome.join('')}</span>} />
        <Stat label="Overall parity" value={res.overallParityFail ? 'fails' : 'ok'} />
        <Stat label="Status" value={<span style={{ color: statusColor }}>{res.status === 'double-error-detected' ? 'DED' : res.status}</span>} accent sub={res.status === 'corrected' ? `fixed bit ${res.errorPos}` : res.status === 'double-error-detected' ? 'flagged, uncorrectable' : ''} />
        <Stat label="Errors" value={flips.size} sub={flips.size >= 2 ? 'double → detected not fixed' : ''} />
      </div>
    </div>
  )
}
