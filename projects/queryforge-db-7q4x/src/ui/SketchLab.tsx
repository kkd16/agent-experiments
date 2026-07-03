// The Sketch Lab — the tenth Lab. Approximate query processing made legible:
// pick a sketch and a data distribution, watch the estimate track the exact
// answer, and see the memory-vs-accuracy trade play out across a precision
// sweep. Every number comes from the from-scratch sketches in `db/sketch/*`,
// cross-checked against an exact oracle computed over the same stream.

import { useMemo, useState } from 'react'
import {
  DISTRIBUTIONS,
  genStream,
  runHll,
  runCountMin,
  runTDigest,
  runTopK,
  runBloom,
  type Distribution,
} from '../db/sketch/lab'

type Kind = 'hll' | 'countmin' | 'tdigest' | 'topk' | 'bloom'

const KINDS: Array<{ id: Kind; label: string; tagline: string }> = [
  { id: 'hll', label: 'HyperLogLog', tagline: 'COUNT(DISTINCT) in kilobytes' },
  { id: 'countmin', label: 'Count–Min', tagline: 'point frequency, one-sided error' },
  { id: 'tdigest', label: 't-digest', tagline: 'tail-accurate quantiles' },
  { id: 'topk', label: 'Space-Saving', tagline: 'top-k heavy hitters' },
  { id: 'bloom', label: 'Bloom filter', tagline: 'membership, no false negatives' },
]

const SIZES = [10_000, 50_000, 200_000]
const DOMAIN = 20_000

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString()
}
function pct(x: number): string {
  return `${(x * 100).toFixed(x < 0.001 ? 3 : 2)}%`
}

/** A sweep bar chart: each bar's height is its error; the memory footprint is
 *  the x-axis label. The lowest-error bar is highlighted as the sweet spot. */
function SweepBars({
  points,
  valueFmt,
  yLabel,
}: {
  points: Array<{ label: string; mem: string; err: number; sub?: string }>
  valueFmt: (e: number) => string
  yLabel: string
}) {
  const max = Math.max(...points.map((p) => p.err), 1e-12)
  const best = points.reduce((a, b) => (b.err < a.err ? b : a))
  const W = 520
  const H = 170
  const padL = 8
  const padB = 40
  const gap = 12
  const barW = (W - padL * 2 - gap * (points.length - 1)) / points.length
  return (
    <div className="sk-chart">
      <div className="sk-chart-y">{yLabel}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="sk-svg" role="img" aria-label={yLabel}>
        {points.map((p, i) => {
          const h = (p.err / max) * (H - padB - 12)
          const x = padL + i * (barW + gap)
          const y = H - padB - h
          const isBest = p === best
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={Math.max(1, h)} rx={3} className={`sk-bar ${isBest ? 'best' : ''}`} />
              <text x={x + barW / 2} y={y - 5} textAnchor="middle" className="sk-bar-val">
                {valueFmt(p.err)}
              </text>
              <text x={x + barW / 2} y={H - padB + 14} textAnchor="middle" className="sk-axis">
                {p.label}
              </text>
              <text x={x + barW / 2} y={H - padB + 28} textAnchor="middle" className="sk-axis-mem">
                {p.mem}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function Verdict({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <div className={`sk-verdict ${ok ? 'ok' : 'warn'}`}>{children}</div>
}

export function SketchLab() {
  const [kind, setKind] = useState<Kind>('hll')
  const [dist, setDist] = useState<Distribution>('zipf')
  const [size, setSize] = useState(50_000)

  const stream = useMemo(() => genStream(dist, size, DOMAIN, 1), [dist, size])
  const hll = useMemo(() => (kind === 'hll' ? runHll(stream) : null), [kind, stream])
  const cm = useMemo(() => (kind === 'countmin' ? runCountMin(stream) : null), [kind, stream])
  const td = useMemo(() => (kind === 'tdigest' ? runTDigest(stream) : null), [kind, stream])
  const tk = useMemo(() => (kind === 'topk' ? runTopK(stream, 10) : null), [kind, stream])
  const bl = useMemo(() => (kind === 'bloom' ? runBloom(stream) : null), [kind, stream])

  const distMeta = DISTRIBUTIONS.find((d) => d.id === dist)!

  return (
    <div className="sk-lab">
      <div className="sk-head">
        <h2>Sketch Lab</h2>
        <p>
          The exact answer to <em>how many distinct</em>, <em>the p99</em>, or <em>the hot keys</em> is the most
          expensive one — it must remember everything. A <strong>sketch</strong> trades a provable, tiny error for a
          fixed, sublinear footprint and one-pass, mergeable state. Pick one, feed it a distribution, and watch the
          estimate close on the truth as you spend more memory.
        </p>
      </div>

      <div className="sk-tabs">
        {KINDS.map((k) => (
          <button key={k.id} className={`sk-tab ${kind === k.id ? 'active' : ''}`} onClick={() => setKind(k.id)}>
            <span className="sk-tab-label">{k.label}</span>
            <span className="sk-tab-tag">{k.tagline}</span>
          </button>
        ))}
      </div>

      <div className="sk-controls">
        <div className="sk-control">
          <label>Distribution</label>
          <div className="sk-seg">
            {DISTRIBUTIONS.map((d) => (
              <button key={d.id} className={dist === d.id ? 'active' : ''} onClick={() => setDist(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
          <span className="sk-hint">{distMeta.blurb}</span>
        </div>
        <div className="sk-control">
          <label>Stream size</label>
          <div className="sk-seg">
            {SIZES.map((s) => (
              <button key={s} className={size === s ? 'active' : ''} onClick={() => setSize(s)}>
                {s.toLocaleString()}
              </button>
            ))}
          </div>
          <span className="sk-hint">
            {fmtNum(stream.keys.length)} rows · {fmtNum(stream.exactDistinct)} distinct keys
          </span>
        </div>
      </div>

      {/* HyperLogLog ------------------------------------------------------- */}
      {hll && (
        <div className="sk-panel">
          <div className="sk-stat-row">
            <div className="sk-stat">
              <span className="sk-stat-k">exact COUNT(DISTINCT)</span>
              <span className="sk-stat-v">{fmtNum(hll.exact)}</span>
            </div>
            <div className="sk-stat">
              <span className="sk-stat-k">HLL p=14 estimate</span>
              <span className="sk-stat-v accent">{fmtNum(hll.points.find((p) => p.p === 14)!.estimate)}</span>
            </div>
            <div className="sk-stat">
              <span className="sk-stat-k">footprint at p=14</span>
              <span className="sk-stat-v">{fmtBytes(hll.points.find((p) => p.p === 14)!.bytes)}</span>
            </div>
          </div>
          <SweepBars
            yLabel="relative error vs exact distinct count — as precision p (memory) grows"
            valueFmt={(e) => pct(e)}
            points={hll.points.map((p) => ({
              label: `p=${p.p}`,
              mem: fmtBytes(p.bytes),
              err: Math.abs(p.relErr),
              sub: `±${pct(p.stdErr)}`,
            }))}
          />
          <table className="sk-table">
            <thead>
              <tr>
                <th>precision</th>
                <th>registers</th>
                <th>memory</th>
                <th>estimate</th>
                <th>error</th>
                <th>1.04/√m (theory)</th>
              </tr>
            </thead>
            <tbody>
              {hll.points.map((p) => (
                <tr key={p.p}>
                  <td>p = {p.p}</td>
                  <td>{fmtNum(p.registers)}</td>
                  <td>{fmtBytes(p.bytes)}</td>
                  <td>{fmtNum(p.estimate)}</td>
                  <td className={Math.abs(p.relErr) <= 3 * p.stdErr ? 'good' : 'bad'}>{pct(p.relErr)}</td>
                  <td className="dim">±{pct(p.stdErr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Verdict ok={Math.abs(hll.mergeEstimate - hll.mergeExact) / hll.mergeExact < 0.03}>
            <strong>Mergeable (the monoid):</strong> split the stream in half, sketch each part, then merge
            register-wise → {fmtNum(hll.mergeEstimate)} distinct vs {fmtNum(hll.mergeExact)} exact. Two sketches
            combine into the union's estimate — the reason HLL scales across partitions.
          </Verdict>
        </div>
      )}

      {/* Count–Min --------------------------------------------------------- */}
      {cm && (
        <div className="sk-panel">
          <div className="sk-stat-row">
            <div className="sk-stat">
              <span className="sk-stat-k">stream length N</span>
              <span className="sk-stat-v">{fmtNum(cm.totalKeys)}</span>
            </div>
            <div className="sk-stat">
              <span className="sk-stat-k">distinct keys</span>
              <span className="sk-stat-v">{fmtNum(cm.distinct)}</span>
            </div>
          </div>
          <SweepBars
            yLabel="worst-case over-estimate across all keys — as width w (memory) grows"
            valueFmt={(e) => `+${fmtNum(e)}`}
            points={cm.points.map((p) => ({ label: `w=${p.width}`, mem: fmtBytes(p.bytes), err: p.maxErr }))}
          />
          <table className="sk-table">
            <thead>
              <tr>
                <th>width × depth</th>
                <th>memory</th>
                <th>avg over-estimate</th>
                <th>max over-estimate</th>
                <th>ε·N bound</th>
              </tr>
            </thead>
            <tbody>
              {cm.points.map((p) => (
                <tr key={p.width}>
                  <td>
                    {p.width} × {p.depth}
                  </td>
                  <td>{fmtBytes(p.bytes)}</td>
                  <td>+{p.avgErr.toFixed(1)}</td>
                  <td>+{fmtNum(p.maxErr)}</td>
                  <td className="dim">≤ {fmtNum(p.errBound)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Verdict ok>
            <strong>One-sided error:</strong> Count–Min never <em>under</em>-counts (collisions only ever add), so the
            min over the {cm.points[0].depth} rows is the tightest safe over-estimate — and it shrinks as the table
            widens. Conservative update keeps it tighter still.
          </Verdict>
        </div>
      )}

      {/* t-digest ---------------------------------------------------------- */}
      {td && (
        <div className="sk-panel">
          <SweepBars
            yLabel="worst quantile error (fraction of range) — as compression δ (memory) grows"
            valueFmt={(e) => pct(e)}
            points={td.points.map((p) => ({ label: `δ=${p.compression}`, mem: fmtBytes(p.bytes), err: p.maxRelErr }))}
          />
          <table className="sk-table">
            <thead>
              <tr>
                <th>quantile</th>
                <th>exact</th>
                <th>t-digest (δ=300)</th>
                <th>error (of range)</th>
              </tr>
            </thead>
            <tbody>
              {td.rows.map((r) => (
                <tr key={r.q}>
                  <td>p{(r.q * 100).toFixed(r.q < 0.1 ? 0 : r.q >= 0.999 ? 1 : 0)}</td>
                  <td>{r.exact.toFixed(2)}</td>
                  <td className="accent">{r.approx.toFixed(2)}</td>
                  <td className={r.relErr < 0.02 ? 'good' : 'bad'}>{pct(r.relErr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Verdict ok>
            <strong>Tail-accurate by design:</strong> the scale function forces small (tight) centroids near p0 and
            p100 and large ones in the middle, so p99/p999 stay sharp in kilobytes where an equal-width histogram is
            useless. And two digests merge — quantile state combines across partitions.
          </Verdict>
        </div>
      )}

      {/* Space-Saving top-k ------------------------------------------------ */}
      {tk && (
        <div className="sk-panel">
          <div className="sk-stat-row">
            <div className="sk-stat">
              <span className="sk-stat-k">top-{tk.k} recall</span>
              <span className="sk-stat-v accent">{pct(tk.exactRecall)}</span>
            </div>
            <div className="sk-stat">
              <span className="sk-stat-k">footprint</span>
              <span className="sk-stat-v">{fmtBytes(tk.bytes)}</span>
            </div>
            <div className="sk-stat">
              <span className="sk-stat-k">vs. exact counter</span>
              <span className="sk-stat-v">{fmtNum(stream.exactDistinct)} keys</span>
            </div>
          </div>
          <table className="sk-table">
            <thead>
              <tr>
                <th>rank</th>
                <th>key</th>
                <th>estimated count</th>
                <th>error bound</th>
                <th>exact count</th>
                <th>in true top-{tk.k}?</th>
              </tr>
            </thead>
            <tbody>
              {tk.rows.map((r) => (
                <tr key={r.value}>
                  <td>#{r.rank}</td>
                  <td>{r.value}</td>
                  <td className="accent">{fmtNum(r.approxCount)}</td>
                  <td className="dim">−{fmtNum(r.error)}</td>
                  <td>{fmtNum(r.exactCount)}</td>
                  <td className={r.correct ? 'good' : 'bad'}>{r.correct ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Verdict ok={tk.exactRecall >= 0.8}>
            <strong>Guaranteed heavy hitters:</strong> any key with true frequency &gt; N/k is certain to be monitored,
            and each estimate brackets the truth in <code>[count − error, count]</code>. Skew (Zipf) is exactly where
            this shines — the hot keys pop out in a handful of slots.
          </Verdict>
        </div>
      )}

      {/* Bloom filter ------------------------------------------------------ */}
      {bl && (
        <div className="sk-panel">
          <div className="sk-stat-row">
            <div className="sk-stat">
              <span className="sk-stat-k">members inserted</span>
              <span className="sk-stat-v">{fmtNum(bl.members)}</span>
            </div>
          </div>
          <SweepBars
            yLabel="measured false-positive rate — as bits-per-element (memory) grows"
            valueFmt={(e) => pct(e)}
            points={bl.points.map((p) => ({ label: `${p.bitsPerElem} b/elem`, mem: fmtBytes(p.bytes), err: p.measuredFpr }))}
          />
          <table className="sk-table">
            <thead>
              <tr>
                <th>bits / element</th>
                <th>hashes k</th>
                <th>memory</th>
                <th>predicted FPR</th>
                <th>measured FPR</th>
              </tr>
            </thead>
            <tbody>
              {bl.points.map((p) => (
                <tr key={p.bitsPerElem}>
                  <td>{p.bitsPerElem}</td>
                  <td>{p.hashes}</td>
                  <td>{fmtBytes(p.bytes)}</td>
                  <td className="dim">{pct(p.predictedFpr)}</td>
                  <td className={Math.abs(p.measuredFpr - p.predictedFpr) < 0.01 ? 'good' : 'bad'}>{pct(p.measuredFpr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Verdict ok>
            <strong>No false negatives, ever:</strong> a member always passes; only absent keys can (rarely) collide.
            The measured false-positive rate tracks the <code>(1 − e^(−kn/m))^k</code> curve — spend more bits, pay
            less error. This is the pruning behind a Bloom join filter.
          </Verdict>
        </div>
      )}

      <div className="sk-foot">
        Every estimate is computed by the from-scratch sketches in <code>db/sketch/*</code> and checked against an
        exact oracle over the same seeded stream. The headline sketches are wired into SQL as{' '}
        <code>APPROX_COUNT_DISTINCT</code>, <code>APPROX_PERCENTILE</code>, <code>APPROX_TOP_K</code> and{' '}
        <code>TABLESAMPLE</code> — try them in the Playground.
      </div>
    </div>
  )
}
