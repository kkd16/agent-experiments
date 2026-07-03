import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { HBarChart } from '../components/charts'
import { lzmaEncode, LZMA_PARAMS, propsByte, type LzmaToken } from '../lib/lzma'
import { CODECS } from '../lib/codecs'
import { analyze } from '../lib/entropy'
import { strToBytes } from '../lib/bits'
import { byteGlyph } from '../lib/format'

const DEFAULT =
  'LZMA feeds every decision — is-this-a-match, is-it-a-repeat, the length, the ' +
  'distance, the literal byte — to ONE adaptive binary range coder. The four most ' +
  'recent distances live in an MRU list (rep0..rep3) and are recoded almost for free, ' +
  'which is why LZMA crushes structured data that reuses offsets. ' +
  'LZMA feeds every decision to one adaptive binary range coder.'

// colours for the packet strip, by kind / rep index
const KIND_COLOR: Record<string, string> = {
  lit: 'var(--text-dim)',
  match: 'var(--teal)',
  shortrep: 'var(--amber)',
}
const REP_COLOR = ['var(--violet)', 'var(--blue)', 'var(--green)', 'var(--amber)']
function tokenColor(t: LzmaToken): string {
  if (t.kind === 'rep') return REP_COLOR[t.repIndex] ?? 'var(--violet)'
  return KIND_COLOR[t.kind] ?? 'var(--teal)'
}

// The rivals LZMA is raced against on the size chart (all from-scratch here).
const RIVALS = ['gzip', 'deflate', 'bzip', 'cm', 'ppm']

export function Lzma() {
  const [text, setText] = useState(DEFAULT)
  const data = useMemo(() => strToBytes(text), [text])

  const enc = useMemo(() => lzmaEncode(data, { collectTokens: true }), [data])
  const floor = useMemo(() => analyze(data), [data])

  // The auto-tuner races these (lc,lp,pb) presets and ships the smallest; show
  // every preset's size so the winning model — and the spread — is visible.
  const presetSizes = useMemo(
    () =>
      LZMA_PARAMS.PRESETS.map(([lc, lp, pb]) => {
        const r = lzmaEncode(data, { lc, lp, pb, auto: false })
        return { lc, lp, pb, bytes: 4 + r.encoded.length, props: propsByte(lc, lp, pb) }
      }),
    [data],
  )
  const bestPresetBytes = Math.min(...presetSizes.map((p) => p.bytes))

  // Race LZMA against the other dictionary/transform coders + the entropy floor.
  const rivalSizes = useMemo(() => {
    const out: { id: string; name: string; bytes: number }[] = []
    for (const id of RIVALS) {
      const c = CODECS.find((x) => x.id === id)
      if (!c) continue
      try {
        out.push({ id, name: c.name, bytes: c.encode(data).length })
      } catch {
        out.push({ id, name: c.name, bytes: 0 })
      }
    }
    return out
  }, [data])

  const lzmaBytes = 4 + enc.encoded.length // + 4-byte length header, as the codec ships it
  const floorBytes = Math.ceil(floor.idealBits / 8)

  const sizeBars = [
    { label: 'order-0 entropy floor', value: floorBytes, color: 'var(--text-dim)', caption: 'H₀' },
    { label: 'LZMA', value: lzmaBytes, color: 'var(--teal)' },
    ...rivalSizes.map((r) => ({ label: r.name.split(' ')[0], value: r.bytes, color: 'var(--panel-hi)' })),
  ]

  // packet composition
  const packetBars = [
    { label: 'literals', value: enc.stats.literals, color: 'var(--text-dim)' },
    { label: 'new matches', value: enc.stats.matches, color: 'var(--teal)' },
    { label: 'rep matches', value: enc.stats.reps, color: 'var(--violet)' },
  ]

  const repBars = [
    { label: 'rep0 (last dist)', value: enc.stats.repDist[0], color: REP_COLOR[0] },
    { label: 'rep1', value: enc.stats.repDist[1], color: REP_COLOR[1] },
    { label: 'rep2', value: enc.stats.repDist[2], color: REP_COLOR[2] },
    { label: 'rep3', value: enc.stats.repDist[3], color: REP_COLOR[3] },
    { label: 'new distance', value: enc.stats.matches, color: 'var(--teal)' },
  ]

  const bestRival = rivalSizes.reduce(
    (a, b) => (b.bytes > 0 && (a.bytes === 0 || b.bytes < a.bytes) ? b : a),
    { id: '', name: '—', bytes: 0 },
  )

  return (
    <div>
      <PageHeader
        kicker="Module 05b · the strongest dictionary coder"
        title="LZMA — one range coder to rule them all"
        lede={
          <>
            LZMA is the algorithm inside <strong>7-Zip</strong> and <strong>xz</strong>. Where
            DEFLATE splits a literal/length stream from a distance stream and Huffman-codes each,
            LZMA feeds <em>every</em> decision — <span className="mono">is-match</span>,{' '}
            <span className="mono">is-rep</span>, the length, the distance slot, the literal byte —
            to a single adaptive <strong>binary range coder</strong> whose per-bit probabilities are
            chosen by a rich context: a 12-state machine that remembers the last few packets, the low
            position bits, the previous byte, and — on the literal right after a match — the byte that
            <em> would</em> have been copied. The four most-recent match distances live in an{' '}
            <strong>MRU list (rep0..rep3)</strong> and are recoded almost for free. Everything here is
            from scratch and <strong>provably round-trips</strong> (Self-test).
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={5} />
      </Panel>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label="Input" value={data.length} unit="B" />
        <Stat
          label="LZMA"
          value={lzmaBytes}
          unit="B"
          accent
          sub={`model lc/lp/pb = ${enc.props.lc}/${enc.props.lp}/${enc.props.pb}`}
        />
        <Stat
          label="ratio"
          value={data.length > 0 ? ((lzmaBytes / data.length) * 100).toFixed(1) : '—'}
          unit="%"
          sub={`${enc.stats.bitsPerByte.toFixed(3)} bits/byte`}
        />
        <Stat
          label="vs best rival"
          value={bestRival.bytes > 0 ? `${bestRival.bytes - lzmaBytes >= 0 ? '−' : '+'}${Math.abs(bestRival.bytes - lzmaBytes)}` : '—'}
          unit="B"
          sub={`${bestRival.name.split(' ')[0]} = ${bestRival.bytes}B`}
        />
      </div>

      <Panel
        title="Size — LZMA vs the field"
        note="every rival is a full from-scratch codec in this lab, each verified by a round-trip decode"
      >
        <HBarChart bars={sizeBars} unit=" B" valueFmt={(v) => v.toFixed(0)} />
      </Panel>

      <Panel
        title="Auto-tuned literal / position model"
        note="the encoder races these (lc, lp, pb) presets and ships the smallest, storing its choice in the one-byte LZMA properties — exactly what xz's --lzma2=lc=..,lp=..,pb=.. tunes. lc = previous-byte context bits, lp = literal-position bits, pb = position bits."
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>lc</th>
                <th>lp</th>
                <th>pb</th>
                <th>props byte</th>
                <th>size</th>
                <th>vs best</th>
              </tr>
            </thead>
            <tbody>
              {presetSizes.map((p) => {
                const chosen = p.lc === enc.props.lc && p.lp === enc.props.lp && p.pb === enc.props.pb
                return (
                  <tr key={p.props} style={chosen ? { background: 'var(--panel-hi)' } : undefined}>
                    <td className="num">{p.lc}</td>
                    <td className="num">{p.lp}</td>
                    <td className="num">{p.pb}</td>
                    <td className="mono">
                      0x{p.props.toString(16).padStart(2, '0')}
                    </td>
                    <td className="num" style={{ fontWeight: chosen ? 700 : 400, color: chosen ? 'var(--green)' : 'var(--text)' }}>
                      {p.bytes} B{chosen && ' ●'}
                    </td>
                    <td className="num" style={{ color: 'var(--text-dim)' }}>
                      {p.bytes === bestPresetBytes ? '—' : `+${p.bytes - bestPresetBytes}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          The single properties byte costs 1 B but lets the decoder rebuild the exact model, so the
          choice pays for itself whenever a preset beats the default by more than a byte. Text and logs
          often prefer <span className="mono">pb=0</span> (no position alignment); tabular or binary
          data likes <span className="mono">lp&gt;0</span>; strong natural language likes higher{' '}
          <span className="mono">lc</span>.
        </div>
      </Panel>

      <Panel
        title="Packet stream"
        note="each packet covers the bytes it produces; width ∝ output length. Grey = literal, teal = new match, violet/blue/green/amber = rep0..rep3 match."
      >
        <PacketStrip tokens={enc.tokens} total={data.length} />
        <div className="legend" style={{ marginTop: 12 }}>
          <span><span className="swatch" style={{ background: KIND_COLOR.lit }} />literal — a single byte, coded by the previous byte's context</span>
          <span><span className="swatch" style={{ background: KIND_COLOR.match }} />new match — a fresh (length, distance) back-reference</span>
          <span><span className="swatch" style={{ background: REP_COLOR[0] }} />rep0..3 — a match reusing one of the last four distances (cheap)</span>
        </div>
      </Panel>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Panel title="Packet composition" note="how the message was split into literals vs matches">
          <HBarChart bars={packetBars} unit="" valueFmt={(v) => v.toFixed(0)} height={24} />
          <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            {enc.stats.matchBytes} of {data.length} bytes ({data.length > 0 ? ((enc.stats.matchBytes / data.length) * 100).toFixed(0) : 0}%)
            were produced by copies; the rest are literals.
          </div>
        </Panel>
        <Panel title="Where distances came from" note="the payoff of the rep0..rep3 MRU list">
          <HBarChart bars={repBars} unit="" valueFmt={(v) => v.toFixed(0)} height={24} />
          <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            A rep match skips the whole distance-slot + direct-bits + align coding — it costs only a
            couple of context bits. Structured data that revisits the same offsets rides the rep list.
          </div>
        </Panel>
      </div>

      <Panel
        title="The 12-state context machine"
        note="every packet's probabilities are selected by the current state; the state then advances by what was just coded. States 0–6 mean 'a literal was recent'; 7–11 mean 'a match/rep was recent' (which turns on matched-literal coding)."
      >
        <StateMachine current={enc.tokens.length ? enc.tokens[enc.tokens.length - 1].state : 0} />
      </Panel>

      <Panel title="How a packet is coded">
        <div className="prose" style={{ fontSize: 14 }}>
          <p>
            At each position the coder emits one bit for <span className="mono">IsMatch[state, posState]</span>. A{' '}
            <strong>0</strong> means a literal follows — its eight bits are coded MSB-first through a
            context of the previous byte's high {enc.props.lc} bits (the auto-selected{' '}
            <span className="mono">lc</span>), and if the last packet was a
            match, each bit is additionally predicted by the corresponding bit of the byte that would
            have been copied (<em>matched-literal</em> mode). A <strong>1</strong> means a match, and a
            second bit <span className="mono">IsRep</span> splits <em>new distance</em> from{' '}
            <em>repeat</em>. Repeats spend a few more bits to pick <span className="mono">rep0..rep3</span>;
            new distances code a 6-bit <em>slot</em> (a magnitude bucket), then the low bits as{' '}
            <em>direct</em> (equiprobable) bits plus a 4-bit reverse <em>align</em> tree. The match
            length is a low/mid/high split spanning {LZMA_PARAMS.MIN_MATCH}..{LZMA_PARAMS.MAX_MATCH} bytes.
          </p>
          <p>
            Every probability is an 11-bit adaptive estimate nudged toward each observed bit. Because
            the decoder replays the identical context selections and updates in the identical order,
            the two stay in lock-step and the stream inverts exactly — the property the Self-test
            page verifies on every input, alongside a {`3,000`}-case fuzz of the encoder offline.
          </p>
        </div>
      </Panel>
    </div>
  )
}

// The packet strip: a single horizontal bar, each token a slice whose width is
// proportional to the number of output bytes it produced. Hovering shows detail.
function PacketStrip({ tokens, total }: { tokens: LzmaToken[]; total: number }) {
  const W = 960
  const h = 40
  if (total === 0 || tokens.length === 0)
    return <div className="muted" style={{ fontSize: 13 }}>No packets (empty input).</div>
  const slices: { x: number; w: number; t: LzmaToken }[] = []
  let acc = 0
  for (const t of tokens) {
    const w = (t.len / total) * W
    slices.push({ x: acc, w, t })
    acc += w
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${h + 6}`} width="100%" style={{ minWidth: 640 }} role="img">
        {slices.map((s, i) => (
          <g key={i}>
            <rect
              x={s.x}
              y={2}
              width={Math.max(0.5, s.w - 0.4)}
              height={h}
              fill={tokenColor(s.t)}
              opacity={s.t.kind === 'lit' ? 0.5 : 0.85}
            >
              <title>
                {s.t.kind === 'lit'
                  ? `literal '${byteGlyph(s.t.byte)}' @${s.t.pos} (state ${s.t.state})`
                  : `${s.t.kind === 'rep' ? `rep${s.t.repIndex}` : 'match'} len ${s.t.len} dist ${s.t.dist} @${s.t.pos} (state ${s.t.state})`}
              </title>
            </rect>
            {s.w > 26 && s.t.kind !== 'lit' && (
              <text x={s.x + s.w / 2} y={h / 2 + 6} textAnchor="middle" fontSize={11} fill="#0a0d13">
                {s.t.len}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

// A compact rendering of the 12 states and their four transition rules.
function StateMachine({ current }: { current: number }) {
  const upLit = (s: number) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6)
  const upMatch = (s: number) => (s < 7 ? 7 : 10)
  const upRep = (s: number) => (s < 7 ? 8 : 11)
  const upShort = (s: number) => (s < 7 ? 9 : 11)
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>state</th>
            <th>kind</th>
            <th>after literal →</th>
            <th>after match →</th>
            <th>after rep →</th>
            <th>after short-rep →</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 12 }, (_, s) => (
            <tr key={s} style={s === current ? { background: 'var(--panel-hi)' } : undefined}>
              <td className="mono" style={{ fontWeight: s === current ? 700 : 400 }}>
                {s}
                {s === current && ' ●'}
              </td>
              <td style={{ color: s < 7 ? 'var(--text-dim)' : 'var(--teal)' }}>
                {s < 7 ? 'after-literal' : 'after-match'}
              </td>
              <td className="num">{upLit(s)}</td>
              <td className="num">{upMatch(s)}</td>
              <td className="num">{upRep(s)}</td>
              <td className="num">{upShort(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
