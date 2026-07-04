import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import {
  rsEncode,
  rsDecode,
  rsCode,
  generatorPoly,
  RS_PRESETS,
  RsError,
} from '../lib/reedSolomon'
import { strToBytes } from '../lib/bits'

type Corrupt = 'clean' | 'error' | 'erasure'

function hex(b: number): string {
  return b.toString(16).padStart(2, '0')
}

export function ReedSolomon() {
  const [presetId, setPresetId] = useState('qr-m')
  const preset = useMemo(() => RS_PRESETS.find((p) => p.id === presetId)!, [presetId])
  const code = useMemo(() => rsCode(preset.n, preset.k), [preset])
  const { n, k, nsym, t } = code
  const [text, setText] = useState('Reed-Solomon guards this text against noise.')

  // Message bytes, trimmed/padded to exactly k.
  const message = useMemo(() => {
    const b = Array.from(strToBytes(text)).slice(0, k)
    while (b.length < k) b.push(0)
    return b
  }, [text, k])

  const codeword = useMemo(() => rsEncode(message, nsym), [message, nsym])

  // Per-position corruption state; keyed by position so it survives preset text edits.
  const [corrupt, setCorrupt] = useState<Record<number, Corrupt>>({})
  const [noiseBytes, setNoiseBytes] = useState<Record<number, number>>({})

  const received = useMemo(() => {
    return codeword.map((b, i) => {
      const c = corrupt[i]
      if (c === 'error' || c === 'erasure') return noiseBytes[i] ?? b ^ 0xff
      return b
    })
  }, [codeword, corrupt, noiseBytes])

  const erasurePos = useMemo(
    () => Object.entries(corrupt).filter(([, v]) => v === 'erasure').map(([pos]) => +pos),
    [corrupt],
  )

  const decode = useMemo(() => {
    try {
      const r = rsDecode(received, nsym, erasurePos)
      return { ok: true as const, r }
    } catch (e) {
      return { ok: false as const, err: (e as RsError).message }
    }
  }, [received, nsym, erasurePos])

  const nErr = Object.values(corrupt).filter((c) => c === 'error').length
  const nEra = erasurePos.length
  const budget = 2 * nErr + nEra
  const withinBudget = budget <= nsym

  const cycle = (i: number) =>
    setCorrupt((prev) => {
      const cur = prev[i] ?? 'clean'
      const next: Corrupt = cur === 'clean' ? 'error' : cur === 'error' ? 'erasure' : 'clean'
      const out = { ...prev }
      if (next === 'clean') delete out[i]
      else out[i] = next
      return out
    })

  // re-roll the corrupting byte value at a position
  const reroll = (i: number) => setNoiseBytes((p) => ({ ...p, [i]: Math.floor(Math.random() * 256) }))

  const clearAll = () => {
    setCorrupt({})
    setNoiseBytes({})
  }
  const burst = () => {
    const start = Math.floor(Math.random() * (n - t))
    const next: Record<number, Corrupt> = {}
    const nb: Record<number, number> = {}
    for (let i = 0; i < t; i++) {
      next[start + i] = 'error'
      nb[start + i] = Math.floor(Math.random() * 256)
    }
    setCorrupt(next)
    setNoiseBytes(nb)
  }

  const gen = generatorPoly(nsym)
  const decoded = decode.ok ? decode.r : null
  const recoveredOk = decoded ? decoded.message.every((b, i) => b === message[i]) : false
  const errSet = new Set(decoded?.errorPositions ?? [])

  return (
    <div>
      <PageHeader
        kicker="Channel coding · the workhorse of the physical world"
        title="Reed–Solomon"
        lede={
          <>
            The code inside <b>QR codes, CDs, DVDs, Blu-ray, DVB and Voyager</b>. A message of k bytes
            gains 2t = n−k parity bytes and can then survive <b>t corrupted bytes</b> — or <b>2t erased</b>{' '}
            ones. Because it counts errors in whole <b>symbols</b>, a long contiguous <b>burst</b> costs
            only a few symbols, which is why it guards media that fail in scratches and dropouts. Watch{' '}
            <b>Berlekamp–Massey</b>, <b>Chien</b> and <b>Forney</b> find and repair the damage over GF(256).
          </>
        }
      />

      <Panel title="Configure the code">
        <div className="row" style={{ gap: 16, marginBottom: 12 }}>
          <div className="chip-row">
            {RS_PRESETS.map((p) => (
              <button key={p.id} className={`chip${presetId === p.id ? ' active' : ''}`} onClick={() => { setPresetId(p.id); clearAll() }} title={p.note}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-4">
          <Stat label="Codeword n" value={n} unit="B" />
          <Stat label="Message k" value={k} unit="B" />
          <Stat label="Parity 2t" value={nsym} unit="B" sub={preset.note.split('—')[0]} />
          <Stat label="Corrects t" value={t} unit="errors" accent sub={`or ${nsym} erasures`} />
        </div>
        {k <= 40 && (
          <label className="field" style={{ marginTop: 12 }}>
            Message text (first {k} bytes used)
            <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          </label>
        )}
      </Panel>

      <Panel
        title="Corrupt the transmission"
        note="Click a byte to cycle clean → error (red) → erasure (amber, position known) → clean. Errors cost 2 of the parity budget each; erasures cost 1. Stay within 2t and Reed–Solomon repairs it exactly."
        right={
          <div className="row">
            <button className="btn" onClick={burst}>Burst of t errors</button>
            <button className="btn" onClick={clearAll}>Clear</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 14 }}>
          {received.map((b, i) => {
            const isMsg = i < k
            const c = corrupt[i] ?? 'clean'
            const repaired = errSet.has(i) || (c === 'erasure' && recoveredOk)
            const bg = c === 'error' ? 'var(--red)' : c === 'erasure' ? 'var(--amber)' : isMsg ? 'var(--panel-2)' : 'var(--panel-hi)'
            const col = c === 'clean' ? (isMsg ? 'var(--text-mid)' : 'var(--text-dim)') : '#0a0d13'
            return (
              <div
                key={i}
                onClick={() => cycle(i)}
                onContextMenu={(e) => { e.preventDefault(); reroll(i) }}
                title={`byte ${i} (${isMsg ? 'message' : 'parity'})${c !== 'clean' ? ' — ' + c : ''}${repaired ? ' · repaired ✓' : ''}`}
                style={{
                  width: 26, height: 30, borderRadius: 4, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontSize: 11, background: bg, color: col,
                  border: `1px solid ${repaired ? 'var(--green)' : 'var(--border)'}`,
                  boxShadow: repaired ? '0 0 0 1px var(--green)' : undefined,
                }}
              >
                {c === 'erasure' ? '??' : hex(b)}
              </div>
            )
          })}
        </div>
        <div className="chip-row" style={{ marginBottom: 8 }}>
          <span className="tag" style={{ borderColor: 'var(--panel-2)' }}>message bytes</span>
          <span className="tag" style={{ borderColor: 'var(--panel-hi)', background: 'var(--panel-hi)' }}>parity bytes</span>
          <span className="tag" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>error</span>
          <span className="tag" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>erasure</span>
          <span className="muted" style={{ fontSize: 11 }}>right-click a corrupted byte to re-roll its value</span>
        </div>

        <div className="grid grid-4">
          <Stat label="Errors · erasures" value={`${nErr} · ${nEra}`} sub={`budget 2·${nErr}+${nEra} = ${budget} / ${nsym}`} />
          <Stat label="Within guarantee" value={withinBudget ? 'yes' : 'no'} sub={withinBudget ? '≤ 2t' : 'beyond 2t'} />
          <Stat
            label="Decode"
            value={decode.ok ? (decoded!.errorPositions.length || nEra ? 'repaired' : 'clean') : 'failed'}
            accent={decode.ok}
            sub={decode.ok ? `found ${decoded!.errorPositions.length} error${decoded!.errorPositions.length === 1 ? '' : 's'}` : decode.err}
          />
          <Stat label="Message recovered" value={recoveredOk ? 'exact ✓' : decode.ok ? 'wrong ✗' : '—'} sub={recoveredOk && (nErr || nEra) ? 'byte-for-byte' : ''} />
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="The decoder's working"
          note="Syndromes S(αⁱ) probe the codeword; if any are non-zero, Berlekamp–Massey synthesises the error-locator Λ, Chien search finds its roots (the error positions), and Forney solves for the magnitudes."
        >
          <div className="grid grid-3" style={{ gap: 10, marginBottom: 12 }}>
            <Stat label="Syndromes" value={decoded ? decoded.syndromes.filter((s) => s !== 0).length : '—'} sub={decoded ? `of ${nsym} non-zero` : ''} />
            <Stat label="deg Λ(x)" value={decoded ? decoded.errorLocator.length - 1 : '—'} sub="error count" />
            <Stat label="Positions" value={decoded ? decoded.errorPositions.length : '—'} sub="by Chien search" />
          </div>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr>
                  <td style={{ textAlign: 'left', color: 'var(--text-dim)' }}>Syndromes S₀..</td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'normal' }}>
                    {decoded ? decoded.syndromes.map(hex).join(' ') : (decode.ok ? '' : '—')}
                  </td>
                </tr>
                <tr>
                  <td style={{ textAlign: 'left', color: 'var(--text-dim)' }}>Locator Λ(x)</td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--violet)', whiteSpace: 'normal' }}>
                    {decoded ? decoded.errorLocator.map(hex).join(' ') : '—'}
                  </td>
                </tr>
                <tr>
                  <td style={{ textAlign: 'left', color: 'var(--text-dim)' }}>Error positions</td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)' }}>
                    {decoded ? (decoded.errorPositions.join(', ') || '—') : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Generator polynomial g(x)"
          note={`g(x) = ∏(x − αⁱ) for i=0..${nsym - 1}, degree ${nsym}. Every valid codeword is a multiple of g, so the parity is exactly (message·x^${nsym}) mod g.`}
        >
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th style={{ textAlign: 'left' }}>coefficient (hex, high → low degree)</th></tr></thead>
              <tbody>
                <tr>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'normal', lineHeight: 1.7 }}>
                    {gen.map((c, i) => (
                      <span key={i} style={{ display: 'inline-block', minWidth: 22, marginRight: 4, color: i === 0 ? 'var(--teal)' : 'var(--text-mid)' }}>{hex(c)}</span>
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="prose" style={{ fontSize: 13, marginTop: 10 }}>
            <p style={{ margin: 0 }}>
              The field is <b>GF(256)</b> with primitive polynomial <span style={{ fontFamily: 'var(--mono)' }}>0x11D</span> and
              generator α = 2. A byte is an element; multiplication is polynomial multiply mod 0x11D,
              done by exp/log tables so it's a single array lookup.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Why bytes beat bits — the burst-error story">
        <div className="prose" style={{ fontSize: 14 }}>
          <p style={{ marginTop: 0 }}>
            A scratch on a CD or a fading radio dropout corrupts a <em>run</em> of adjacent bits. A
            bit-level code sees dozens of independent errors and drowns. Reed–Solomon sees the same run
            as only a handful of corrupted <b>bytes</b> — click <b>“Burst of t errors”</b> above and it
            shrugs the whole smear off. This is the single reason RS became the default for storage and
            broadcast: real channels fail in <em>bursts</em>, and RS is a burst-error code.
          </p>
        </div>
      </Panel>
    </div>
  )
}
