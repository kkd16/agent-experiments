import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart, LineChart, type Series } from '../components/charts'
import { seriesColor } from '../lib/format'
import { BitWriter, BitReader } from '../lib/bits'
import {
  INT_CODES,
  codeword,
  codeLength,
  riceKFromMean,
  golombMFromMean,
  type IntCode,
} from '../lib/intcodes'

// The values shown in the codeword table — a spread that reveals each code's
// growth: powers of two straddle the length jumps.
const TABLE_VALUES = [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 63, 255]

export function Rice() {
  const [n, setN] = useState(19)
  const [riceK, setRiceK] = useState(3)
  const [golombM, setGolombM] = useState(5)
  const [egOrder, setEgOrder] = useState(0)
  const [mean, setMean] = useState(6)

  const paramFor = (code: IntCode): number => {
    if (code.id === 'rice') return riceK
    if (code.id === 'golomb') return golombM
    if (code.id === 'expgolomb') return egOrder
    return 0
  }

  // ---- codeword table rows ----
  const rows = useMemo(() => {
    return TABLE_VALUES.map((v) => ({
      v,
      cells: INT_CODES.map((code) => {
        const p = paramFor(code)
        const s = codeword(code, v, p)
        return { code: code.id, bits: s }
      }),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riceK, golombM, egOrder])

  // ---- length-vs-n curves ----
  const curves = useMemo<Series[]>(() => {
    const N = 96
    const families: { code: IntCode; label: string }[] = INT_CODES.filter(
      (c) => ['unary', 'gamma', 'delta', 'omega', 'fib', 'rice'].includes(c.id),
    ).map((c) => ({ code: c, label: c.id === 'rice' ? `Rice(k=${riceK})` : c.name }))
    return families.map((f, i) => ({
      label: f.label,
      color: seriesColor(i),
      points: Array.from({ length: N }, (_, k): [number, number] => [k, codeLength(f.code, k, paramFor(f.code))]),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riceK])

  // ---- expected length on a geometric source (the parametric codes' home turf) ----
  const geometric = useMemo(() => {
    const theta = mean / (mean + 1)
    const N = 4000
    const probs: number[] = []
    let norm = 0
    for (let k = 0; k < N; k++) {
      const p = (1 - theta) * Math.pow(theta, k)
      probs.push(p)
      norm += p
    }
    // Shannon entropy of the (truncated, renormalised) distribution.
    let H = 0
    for (const p of probs) {
      const pn = p / norm
      if (pn > 0) H -= pn * Math.log2(pn)
    }
    const kStar = riceKFromMean(mean)
    const mStar = golombMFromMean(mean)
    const expected = (code: IntCode, param: number) => {
      let e = 0
      for (let k = 0; k < N; k++) e += (probs[k] / norm) * codeLength(code, k, param)
      return e
    }
    const byId = (id: string) => INT_CODES.find((c) => c.id === id)!
    return {
      theta,
      H,
      kStar,
      mStar,
      bars: [
        { label: 'Shannon entropy H', value: H, color: 'var(--text-dim)', caption: 'floor' },
        { label: `Golomb(m=${mStar})`, value: expected(byId('golomb'), mStar), color: 'var(--teal)' },
        { label: `Rice(k=${kStar})`, value: expected(byId('rice'), kStar), color: 'var(--blue)' },
        { label: 'Elias δ', value: expected(byId('delta'), 0), color: 'var(--violet)' },
        { label: 'Elias γ', value: expected(byId('gamma'), 0), color: seriesColor(4) },
        { label: 'Unary', value: expected(byId('unary'), 0), color: 'var(--amber)' },
      ],
    }
  }, [mean])

  // ---- live round-trip of a small sequence ----
  const demo = useMemo(() => {
    const code = INT_CODES.find((c) => c.id === 'rice')!
    const seq = [4, 0, 1, 9, 2, 0, 0, 5, 17, 1]
    const bw = new BitWriter()
    for (const v of seq) code.encode(bw, v, riceK)
    const bits = bw.toBitString()
    const br = new BitReader(bw.finish())
    const back = seq.map(() => code.decode(br, riceK))
    const ok = back.every((v, i) => v === seq[i])
    return { seq, bits, back, ok, bytes: Math.ceil(bits.length / 8) }
  }, [riceK])

  const selected = useMemo(() => {
    return INT_CODES.map((code) => ({
      code,
      bits: codeword(code, n, paramFor(code)),
      len: codeLength(code, n, paramFor(code)),
    })).sort((a, b) => a.len - b.len)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, riceK, golombM, egOrder])

  return (
    <div className="prose">
      <PageHeader
        kicker="Coders · the substrate"
        title="Codes for the integers"
        lede={
          <>
            Every codec so far coded a <em>symbol from a known alphabet</em>. But the moment a coder must
            emit a number whose range it can't bound in advance — a match length, a run of zeros, a
            linear-prediction residual — it needs a code for the <strong>integers themselves</strong>.
            There are two answers. <strong>Universal</strong> codes (Elias γ/δ/ω, Fibonacci) assume nothing
            but "smaller is likelier" and pay a length that grows like log n. <strong>Parametric</strong>
            codes (Golomb, Rice) are the <em>exact optimum</em> for a geometric source once you name its
            decay — and Rice, being multiply-free, is the residual coder inside FLAC, Apple Lossless,
            JPEG-LS and Shorten. This page is that toolbox; the FLAC page spends it.
          </>
        }
      />

      <Panel title="One value, every code" note="Pick a value and see who spends the fewest bits on it. Parametric codes take a parameter.">
        <div className="grid-4" style={{ gap: 14, marginBottom: 14 }}>
          <label className="field">value n = {n}
            <input type="range" min={0} max={255} value={n} onChange={(e) => setN(+e.target.value)} />
          </label>
          <label className="field">Rice k = {riceK}
            <input type="range" min={0} max={10} value={riceK} onChange={(e) => setRiceK(+e.target.value)} />
          </label>
          <label className="field">Golomb m = {golombM}
            <input type="range" min={1} max={32} value={golombM} onChange={(e) => setGolombM(+e.target.value)} />
          </label>
          <label className="field">Exp-Golomb order = {egOrder}
            <input type="range" min={0} max={4} value={egOrder} onChange={(e) => setEgOrder(+e.target.value)} />
          </label>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>code</th>
                <th>codeword for n = {n}</th>
                <th style={{ textAlign: 'right' }}>bits</th>
              </tr>
            </thead>
            <tbody>
              {selected.map(({ code, bits, len }, i) => (
                <tr key={code.id}>
                  <td>
                    <strong>{code.name}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>{code.blurb}</div>
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-all', color: i === 0 ? 'var(--teal)' : undefined }}>
                    {bits || '∅'}
                  </td>
                  <td className="mono num" style={{ textAlign: 'right' }}>{len}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Codeword table" note="How each code grows across values. Watch the universal codes' logarithmic climb vs unary's linear one.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ textAlign: 'right' }}>n</th>
                {INT_CODES.map((c) => (
                  <th key={c.id}>{c.id === 'rice' ? `Rice(${riceK})` : c.id === 'golomb' ? `Gol(${golombM})` : c.id === 'expgolomb' ? `ExpG(${egOrder})` : c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.v}>
                  <td className="mono num" style={{ textAlign: 'right' }}>{r.v}</td>
                  {r.cells.map((c) => (
                    <td key={c.code} className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{c.bits}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Codeword length vs value" note="Unary is linear; the Elias family is logarithmic; Rice(k) is a flat k-bit floor plus a unary quotient.">
          <LineChart
            series={curves}
            xDomain={[0, 96]}
            yDomain={[0, 40]}
            xLabel="value n"
            yLabel="codeword length (bits)"
            height={260}
            xFmt={(v) => v.toFixed(0)}
            yFmt={(v) => v.toFixed(0)}
          />
        </Panel>

        <Panel
          title="Which code wins?"
          note="Expected bits/symbol on a geometric source. The parametric codes, tuned to the mean, hug the Shannon floor; universal codes pay a constant penalty; unary explodes."
        >
          <label className="field" style={{ marginBottom: 12 }}>geometric mean = {mean} &nbsp;(θ = {geometric.theta.toFixed(3)}, optimal k* = {geometric.kStar}, m* = {geometric.mStar})
            <input type="range" min={1} max={40} value={mean} onChange={(e) => setMean(+e.target.value)} />
          </label>
          <HBarChart
            bars={geometric.bars}
            unit=" b"
            valueFmt={(v) => v.toFixed(2)}
            marker={{ value: geometric.H, label: 'H' }}
            height={30}
          />
        </Panel>
      </div>

      <Panel
        title="Round-trip proof"
        note="Codes are only useful if the decoder recovers them with no separators. Every code here is a prefix code — the boundaries are implicit."
      >
        <div className="grid-3" style={{ marginBottom: 12 }}>
          <Stat label="sequence" value={demo.seq.length} unit="ints" sub={<span className="mono">{demo.seq.join(' ')}</span>} />
          <Stat label="Rice(k) stream" value={demo.bits.length} unit="bits" sub={`${demo.bytes} bytes`} />
          <Stat label="decoded" value={demo.ok ? '✓ exact' : '✗ mismatch'} accent sub={<span className="mono">{demo.back.join(' ')}</span>} />
        </div>
        <div className="bitstream mono" style={{ wordBreak: 'break-all' }}>{demo.bits}</div>
      </Panel>

      <Panel title="Where these live">
        <ul className="prose-list">
          <li><strong>Rice(k)</strong> is the residual coder in <strong>FLAC</strong>, Apple Lossless, Shorten and WavPack — see the FLAC page, where a whole block's residual is split into partitions each with its own k.</li>
          <li><strong>Golomb(m)</strong> is the run-length coder in <strong>JPEG-LS</strong> (LOCO-I) and the classic optimum for a memoryless geometric source (Gallager–Van Voorhis).</li>
          <li><strong>Exp-Golomb</strong> is the integer code of <strong>H.264/H.265</strong> — the <span className="mono">ue(v)</span>/<span className="mono">se(v)</span> syntax elements — at order 0.</li>
          <li><strong>Elias γ/δ</strong> code gaps in <strong>inverted indexes</strong> (search engines) and the distances in some LZ variants; <strong>Fibonacci</strong> trades a little length for the ability to resynchronise after a bit flip.</li>
        </ul>
      </Panel>
    </div>
  )
}
