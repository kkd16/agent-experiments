import { useEffect, useMemo, useRef, useState } from 'react'
import { B_CRIT, M, kerrISCO } from '../state'
import {
  shadowCurve,
  shadowMetrics,
  isCaptured,
  horizons,
  photonRingRadius,
  spinA,
  type ShadowPoint,
} from '../physics/kerr'
import { tracePhotonSchw } from '../physics/cpu-geodesic'
import { runSelfTests, summarize, type TestResult } from '../physics/selftest'

// Observer polar angle θ_o (from the spin axis) for a given app "inclination" (elevation above
// the equatorial plane). 0° elevation = edge-on = θ_o 90°; 90° elevation = pole-on = θ_o 0°.
// Clamp a hair off the pole so the 1/sinθ_o projection stays finite.
function thetaOf(inclDeg: number): number {
  const t = ((90 - Math.abs(inclDeg)) * Math.PI) / 180
  return Math.max(t, (2 * Math.PI) / 180)
}

const VIEW = 6.2 // half-extent of the α–β sky window shown, in rs

/** Precompute the Schwarzschild light-bending curve once — it doesn't depend on spin. */
function useDeflectionCurve() {
  return useMemo(() => {
    const pts: { b: number; alpha: number }[] = []
    // Dense just above b_crit (the photon-ring regime, where the bending races through π and 2π as
    // the photon loops the hole), sparse far out. Fine integration near the divergence.
    const bcrit = B_CRIT
    const samples: number[] = []
    let db = 0.0015
    for (let i = 0; i < 44; i++) {
      samples.push(bcrit + db)
      db *= 1.2
    }
    for (let b = Math.ceil(bcrit + 4); b <= 12; b += 0.5) samples.push(b)
    samples.sort((a, b) => a - b)
    for (const b of samples) {
      if (b > 12.2) break
      const d = tracePhotonSchw(b, { steps: 300000, baseStep: 0.02 }).deflection
      if (Number.isFinite(d)) pts.push({ b, alpha: d })
    }
    return pts
  }, [])
}

export default function Observatory() {
  const [spin, setSpin] = useState(0.6)
  const [incl, setIncl] = useState(0) // elevation; 0 = edge-on
  const [tests, setTests] = useState<TestResult[] | null>(null)

  const shadowRef = useRef<HTMLCanvasElement>(null)
  const shadowWrap = useRef<HTMLDivElement>(null)
  const deflRef = useRef<HTMLCanvasElement>(null)
  const deflWrap = useRef<HTMLDivElement>(null)
  const [shadowSize, setShadowSize] = useState({ w: 560, h: 560 })
  const [deflSize, setDeflSize] = useState({ w: 560, h: 320 })

  const deflection = useDeflectionCurve()

  // Run the (heavier) verification suite after first paint so the tab opens instantly.
  useEffect(() => {
    let alive = true
    const id = window.setTimeout(() => {
      const results = runSelfTests()
      if (alive) setTests(results)
    }, 40)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [])

  // Track container sizes.
  useEffect(() => {
    const el = shadowWrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setShadowSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setShadowSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = deflWrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setDeflSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setDeflSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const theta = thetaOf(incl)
  const curve: ShadowPoint[] = useMemo(() => shadowCurve(spin, theta, 480), [spin, theta])
  const metrics = useMemo(() => shadowMetrics(curve), [curve])
  const a = spinA(spin)

  // ---- draw the shadow / critical-curve panel --------------------------------------------------
  useEffect(() => {
    const canvas = shadowRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, shadowSize.w)
    const h = Math.max(1, shadowSize.h)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const scale = Math.min(w, h) / (2 * VIEW)
    const cx = w / 2
    const cy = h / 2
    const sx = (al: number) => cx + al * scale
    const sy = (be: number) => cy - be * scale

    ctx.fillStyle = '#04050a'
    ctx.fillRect(0, 0, w, h)

    // Numerically-determined captured region (independent radial-potential test) — the "simulation"
    // the analytic curve is checked against. Computed on a modest grid and drawn as the shadow.
    const G = 150
    const img = ctx.createImageData(G, G)
    for (let j = 0; j < G; j++) {
      const be = VIEW - (2 * VIEW) * (j / (G - 1))
      for (let i = 0; i < G; i++) {
        const al = -VIEW + (2 * VIEW) * (i / (G - 1))
        const cap = isCaptured(al, be, a, theta)
        const idx = (j * G + i) * 4
        if (cap) {
          // The numeric shadow: a near-black silhouette (this is the "simulation" the analytic
          // critical curve is checked against — its rim should sit exactly under the cyan line).
          img.data[idx] = 1
          img.data[idx + 1] = 2
          img.data[idx + 2] = 5
          img.data[idx + 3] = 255
        } else {
          // Faint blue veil outside the shadow so the captured silhouette stands out.
          img.data[idx] = 34
          img.data[idx + 1] = 52
          img.data[idx + 2] = 84
          img.data[idx + 3] = 46
        }
      }
    }
    // Blit the low-res mask scaled up via a temporary canvas.
    const tmp = document.createElement('canvas')
    tmp.width = G
    tmp.height = G
    tmp.getContext('2d')?.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    const px = sx(-VIEW)
    const py = sy(VIEW)
    ctx.drawImage(tmp, px, py, 2 * VIEW * scale, 2 * VIEW * scale)

    // Grid + axes.
    ctx.strokeStyle = 'rgba(120,140,200,0.10)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let g = -6; g <= 6; g += 2) {
      ctx.moveTo(sx(g), sy(-VIEW))
      ctx.lineTo(sx(g), sy(VIEW))
      ctx.moveTo(sx(-VIEW), sy(g))
      ctx.lineTo(sx(VIEW), sy(g))
    }
    ctx.stroke()
    ctx.strokeStyle = 'rgba(150,170,230,0.28)'
    ctx.beginPath()
    ctx.moveTo(sx(0), sy(-VIEW))
    ctx.lineTo(sx(0), sy(VIEW))
    ctx.moveTo(sx(-VIEW), sy(0))
    ctx.lineTo(sx(VIEW), sy(0))
    ctx.stroke()

    // Schwarzschild reference circle b_crit = 3√3 M.
    ctx.strokeStyle = 'rgba(255,190,120,0.5)'
    ctx.setLineDash([5, 6])
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(sx(0), sy(0), B_CRIT * scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Analytic critical curve (the exact shadow edge) — bright, hugging the numeric region's rim.
    ctx.strokeStyle = 'rgba(120,230,255,0.98)'
    ctx.lineWidth = 2.2
    ctx.shadowBlur = 10
    ctx.shadowColor = 'rgba(90,200,255,0.7)'
    ctx.beginPath()
    let started = false
    for (const p of curve) {
      const X = sx(p.alpha)
      const Y = sy(p.beta)
      if (!started) {
        ctx.moveTo(X, Y)
        started = true
      } else ctx.lineTo(X, Y)
    }
    for (let i = curve.length - 1; i >= 0; i--) {
      ctx.lineTo(sx(curve[i].alpha), sy(-curve[i].beta))
    }
    ctx.closePath()
    ctx.stroke()
    ctx.shadowBlur = 0

    // Centroid marker + displacement tick.
    if (Math.abs(metrics.displacement) > 1e-3) {
      ctx.fillStyle = 'rgba(255,120,90,0.9)'
      ctx.beginPath()
      ctx.arc(sx(metrics.displacement), sy(0), 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Axis labels.
    ctx.fillStyle = 'rgba(180,195,235,0.75)'
    ctx.font = '12px ui-monospace, monospace'
    ctx.fillText('α  (rs) →', sx(VIEW) - 66, sy(0) - 8)
    ctx.save()
    ctx.translate(sx(0) + 12, sy(VIEW) + 60)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('β  (rs) ↑  (spin axis)', 0, 0)
    ctx.restore()
  }, [shadowSize, curve, metrics, a, theta])

  // ---- draw the light-bending / photon-ring panel ---------------------------------------------
  useEffect(() => {
    const canvas = deflRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, deflSize.w)
    const h = Math.max(1, deflSize.h)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const padL = 52
    const padR = 16
    const padT = 16
    const padB = 34
    const bMin = 2.2
    const bMax = 12
    const aMax = 2.6 * Math.PI // deflection axis top
    const X = (b: number) => padL + ((b - bMin) / (bMax - bMin)) * (w - padL - padR)
    const Y = (al: number) => h - padB - (Math.min(al, aMax) / aMax) * (h - padT - padB)

    ctx.fillStyle = '#05060c'
    ctx.fillRect(0, 0, w, h)

    // Horizontal π-multiple gridlines = successive "extra half-orbit" photon-ring orders.
    ctx.font = '11px ui-monospace, monospace'
    for (let n = 1; n <= 2; n++) {
      const yy = Y(n * Math.PI)
      ctx.strokeStyle = 'rgba(120,230,255,0.16)'
      ctx.setLineDash([3, 5])
      ctx.beginPath()
      ctx.moveTo(padL, yy)
      ctx.lineTo(w - padR, yy)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(120,200,235,0.6)'
      ctx.fillText(`${n}π`, 6, yy + 4)
    }

    // b_crit vertical asymptote.
    ctx.strokeStyle = 'rgba(255,120,90,0.7)'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(X(B_CRIT), padT)
    ctx.lineTo(X(B_CRIT), h - padB)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(255,150,120,0.9)'
    ctx.fillText('b_crit', X(B_CRIT) + 4, padT + 12)

    // Weak-field asymptote α = 4M/b.
    ctx.strokeStyle = 'rgba(255,210,140,0.55)'
    ctx.setLineDash([6, 5])
    ctx.beginPath()
    let first = true
    for (let b = bMin; b <= bMax; b += 0.1) {
      const al = (4 * M) / b
      const xx = X(b)
      const yy = Y(al)
      if (first) {
        ctx.moveTo(xx, yy)
        first = false
      } else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
    ctx.setLineDash([])

    // The integrated deflection curve.
    ctx.strokeStyle = 'rgba(120,230,255,0.95)'
    ctx.lineWidth = 2
    ctx.beginPath()
    let started = false
    for (const p of deflection) {
      if (p.b < bMin) continue
      const xx = X(p.b)
      const yy = Y(p.alpha)
      if (!started) {
        ctx.moveTo(xx, yy)
        started = true
      } else ctx.lineTo(xx, yy)
    }
    ctx.stroke()

    // Axes.
    ctx.strokeStyle = 'rgba(150,170,230,0.4)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padL, padT)
    ctx.lineTo(padL, h - padB)
    ctx.lineTo(w - padR, h - padB)
    ctx.stroke()
    ctx.fillStyle = 'rgba(180,195,235,0.75)'
    ctx.fillText('impact parameter b  (rs) →', w - 190, h - padB + 24)
    ctx.save()
    ctx.translate(16, padT + 96)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('bending angle α', 0, 0)
    ctx.restore()
  }, [deflSize, deflection])

  const suite = tests ? summarize(tests) : null
  const { rPlus } = horizons(a)

  return (
    <div className="obs">
      <div className="obs__head">
        <h2>Observatory — the shadow, measured &amp; proven</h2>
        <p className="muted">
          The main view <em>paints</em> the black hole one traced photon at a time. This tab computes
          what it <em>should</em> look like from exact general relativity — the outline of the shadow,
          the way light bends around it — and then checks the two agree. Every number here is a real
          observable; the verification panel re-derives them from the inside on every load.
        </p>
      </div>

      <div className="obs__grid">
        <section className="obs__panel obs__panel--shadow">
          <div className="obs__canvaswrap" ref={shadowWrap}>
            <canvas ref={shadowRef} />
          </div>
          <div className="obs__legend">
            <span>
              <i className="dot dot--curve" /> analytic critical curve (spherical photon orbits)
            </span>
            <span>
              <i className="dot dot--shadow" /> captured region (radial-potential test)
            </span>
            <span>
              <i className="dot dot--ref" /> Schwarzschild circle b = 3√3·M
            </span>
          </div>
        </section>

        <aside className="obs__side">
          <label className="row" title="Dimensionless spin a/M">
            <span className="row__label">Spin a/M</span>
            <input type="range" min={0} max={0.998} step={0.002} value={spin} onChange={(e) => setSpin(Number(e.target.value))} />
            <span className="row__value">{spin.toFixed(3)}</span>
          </label>
          <label className="row" title="Camera elevation above the disk plane (0 = edge-on)">
            <span className="row__label">Inclination</span>
            <input type="range" min={0} max={90} step={1} value={incl} onChange={(e) => setIncl(Number(e.target.value))} />
            <span className="row__value">{incl.toFixed(0)}°</span>
          </label>

          <div className="obs__readout">
            <div className="obs__readout-title">Shadow observables</div>
            <dl>
              <div><dt>Width (α extent)</dt><dd>{metrics.width.toFixed(3)} rs</dd></div>
              <div><dt>Height (β extent)</dt><dd>{metrics.height.toFixed(3)} rs</dd></div>
              <div><dt>Area</dt><dd>{metrics.area.toFixed(2)} rs²</dd></div>
              <div><dt>Displacement</dt><dd>{metrics.displacement.toFixed(3)} rs</dd></div>
              <div><dt>Asymmetry</dt><dd>{(metrics.asymmetry * 100).toFixed(1)}%</dd></div>
            </dl>
          </div>
          <div className="obs__readout">
            <div className="obs__readout-title">Geometry at a/M = {spin.toFixed(3)}</div>
            <dl>
              <div><dt>Outer horizon r₊</dt><dd>{rPlus.toFixed(3)} rs</dd></div>
              <div><dt>Prograde light ring</dt><dd>{photonRingRadius(spin, true).toFixed(3)} rs</dd></div>
              <div><dt>Retrograde light ring</dt><dd>{photonRingRadius(spin, false).toFixed(3)} rs</dd></div>
              <div><dt>Prograde ISCO</dt><dd>{kerrISCO(spin).toFixed(3)} rs</dd></div>
            </dl>
          </div>
          <p className="muted small">
            Spin the hole up and the cyan shadow slides sideways and flattens into the famous Kerr
            “D”. The prograde light ring (photons swept along with the rotation) shrinks toward the
            horizon while the retrograde one swells — the two set the shadow’s near and far edges. At
            a = 0 the curve is an exact circle of radius <strong>{B_CRIT.toFixed(3)} rs</strong>.
          </p>
        </aside>
      </div>

      <section className="obs__wide">
        <h3>Light bending &amp; the photon ring</h3>
        <p className="muted small">
          Total deflection of a Schwarzschild photon versus its impact parameter <em>b</em>, integrated
          on the CPU with the renderer’s own scheme. Far out it hugs the weak-field{' '}
          <span className="k-amber">4M/b</span> (Einstein’s light-bending law); as <em>b</em> falls
          toward <span className="k-red">b_crit</span> the bending diverges — each time it passes a{' '}
          multiple of <span className="k-cyan">π</span> the photon has looped once more around the
          hole, stacking the infinitely many higher-order images that make up the photon ring.
        </p>
        <div className="obs__canvaswrap obs__canvaswrap--wide" ref={deflWrap}>
          <canvas ref={deflRef} />
        </div>
      </section>

      <section className="obs__verify">
        <div className="obs__verify-head">
          <h3>Verification</h3>
          {suite ? (
            <span className={suite.passed === suite.total ? 'badge badge--ok' : 'badge badge--warn'}>
              {suite.passed}/{suite.total} passing
            </span>
          ) : (
            <span className="badge">running…</span>
          )}
        </div>
        <p className="muted small">
          These run in your browser right now — closed-form GR reproduced to tolerance, conserved
          quantities held along real integrated geodesics, and the analytic shadow cross-checked two
          independent ways (a radial-potential capture test and the renderer’s own equatorial
          integrator).
        </p>
        {suite &&
          suite.groups.map((group) => (
            <div className="obs__tgroup" key={group}>
              <div className="obs__tgroup-title">{group}</div>
              <ul className="obs__tests">
                {suite.results
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <li key={r.name} className={r.pass ? 'ok' : 'fail'}>
                      <span className="tmark">{r.pass ? '✓' : '✗'}</span>
                      <span className="tname">{r.name}</span>
                      <span className="tdetail">{r.detail}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
      </section>
    </div>
  )
}
