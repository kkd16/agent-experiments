import { useEffect, useMemo, useRef, useState } from 'react'
import { M, SUBEXTREMAL, kerrHorizon, kerrErgosphere, kerrPhotonOrbit, chargeQ2 } from '../state'
import { knPhotonRings, rnPhotonSphere } from '../physics/kerr'
import {
  traceOrbit,
  radialFunction,
  iscoSigned,
  marginallyBound,
  holeName,
  type OrbitTrace,
} from '../physics/orbits'

interface OrbitPreset {
  name: string
  blurb: string
  spin: number
  charge: number
  rPeri: number
  rApo: number
  prograde: boolean
}

// Internal presets — self-contained, independent of the render view's PRESETS.
const ORBIT_PRESETS: OrbitPreset[] = [
  { name: 'Precessing rosette', blurb: 'A moderately eccentric Schwarzschild orbit whose ellipse fails to close — the perihelion creeps forward every lap. The strong-field version of Mercury.', spin: 0, charge: 0, rPeri: 6, rApo: 17, prograde: true },
  { name: 'Zoom–whirl', blurb: 'Periapsis skims the light-ring of a fast Kerr hole: the star whirls several times around the throat, then zooms back out — an orbit with no Newtonian analogue.', spin: 0.9, charge: 0, rPeri: 2.2, rApo: 12, prograde: true },
  { name: 'Plunge', blurb: 'Periapsis lies inside the separatrix — the innermost orbit that still turns around — so there is no inner turning point: the star spirals straight through the horizon.', spin: 0, charge: 0, rPeri: 2.0, rApo: 11, prograde: true },
  { name: 'Near-circular', blurb: 'A gently eccentric orbit close to circular — the slow, steady precession of a nearly round strong-field orbit.', spin: 0.5, charge: 0, rPeri: 7.7, rApo: 8.5, prograde: true },
  { name: 'Retrograde', blurb: 'Counter-rotating against a rapidly spinning hole. Frame dragging fights the orbit: the ISCO sits far out and the precession is dramatic.', spin: 0.9, charge: 0, rPeri: 9, rApo: 22, prograde: false },
  { name: 'Charged (Kerr–Newman)', blurb: 'A spinning, electrically charged hole. Charge deepens the well and tightens the orbit alongside the spin.', spin: 0.6, charge: 0.6, rPeri: 5, rApo: 15, prograde: true },
]

const fmt = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const deg = (rad: number) => (rad * 180) / Math.PI

export default function OrbitLab() {
  const [spin, setSpin] = useState(0)
  const [charge, setCharge] = useState(0)
  const [rPeri, setRPeri] = useState(6)
  const [rApo, setRApo] = useState(17)
  const [prograde, setPrograde] = useState(true)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [size, setSize] = useState({ w: 800, h: 560 })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const potRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Spin and charge share the extremal budget a*² + Q*² ≤ 1.
  const chargeCeil = Math.sqrt(Math.max(SUBEXTREMAL * SUBEXTREMAL - spin * spin, 0))
  const q = Math.min(charge, chargeCeil)
  const q2 = chargeQ2(q)
  const a = spin * M

  // Keep apoapsis ≥ periapsis.
  const peri = Math.min(rPeri, rApo)
  const apo = Math.max(rPeri, rApo)

  // The traced orbit — recomputed only when the physical inputs change.
  const trace: OrbitTrace = useMemo(
    () => traceOrbit({ spin, charge: q, rPeri: peri, rApo: apo, prograde, maxPeriods: 6 }),
    [spin, q, peri, apo, prograde],
  )

  const applyPreset = (p: OrbitPreset) => {
    setSpin(p.spin)
    setCharge(p.charge)
    setRPeri(p.rPeri)
    setRApo(p.rApo)
    setPrograde(p.prograde)
  }

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Geometry reference radii, in world radius ρ = √(r²+a²) to match the traced path mapping.
  const geom = useMemo(() => {
    const rPlus = kerrHorizon(spin, q)
    const rho = (r: number) => Math.sqrt(r * r + a * a)
    const isco = iscoSigned(spin, prograde)
    const mb = marginallyBound(spin, prograde)
    const ergoEq = kerrErgosphere(spin, Math.PI / 2, q)
    const [rProK, rRetK] = q2 > 0 ? knPhotonRings(a, q2) : [kerrPhotonOrbit(spin, true), kerrPhotonOrbit(spin, false)]
    const rPh = spin < 0.02 ? (q2 > 0 ? rnPhotonSphere(q2) : 1.5) : NaN
    return {
      rPlus,
      rhoH: rho(rPlus),
      rhoErgo: rho(ergoEq),
      rhoIsco: rho(isco),
      rhoMb: rho(mb),
      rhoPro: rho(rProK),
      rhoRet: rho(rRetK),
      rhoPh: Number.isFinite(rPh) ? rho(rPh) : NaN,
      isco,
      mb,
      rho,
    }
  }, [spin, q, q2, a, prograde])

  // Static background layer (grid, rings, rosette, horizon) rendered offscreen; the animation loop
  // blits it and draws only the moving trail + star on top. Mapping is stashed for the loop.
  const mapRef = useRef<{ sx: (x: number) => number; sy: (y: number) => number; scale: number } | null>(null)
  const staticRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, size.w)
    const h = Math.max(1, size.h)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    // World window sized to comfortably hold the whole orbit and the ergosphere.
    const worldR = Math.max(apo * 1.18, geom.rhoErgo * 1.25, geom.rhoIsco * 1.3, 7)
    const scale = Math.min(w, h) / (2 * worldR)
    const cx = w / 2
    const cy = h / 2
    const sx = (x: number) => cx + x * scale
    const sy = (y: number) => cy - y * scale
    mapRef.current = { sx, sy, scale }

    // Prepare the offscreen static layer.
    const stat = staticRef.current ?? document.createElement('canvas')
    staticRef.current = stat
    stat.width = canvas.width
    stat.height = canvas.height
    const ctx = stat.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Background.
    ctx.fillStyle = '#05060b'
    ctx.fillRect(0, 0, w, h)

    // Concentric range rings every 5 rs.
    ctx.strokeStyle = 'rgba(120,140,200,0.08)'
    ctx.lineWidth = 1
    for (let rr = 5; rr <= worldR; rr += 5) {
      ctx.beginPath()
      ctx.arc(cx, cy, rr * scale, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Spin-sense arc.
    if (spin > 0.02) {
      ctx.strokeStyle = 'rgba(150,190,255,0.45)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(cx, cy, (geom.rhoErgo + 1.2) * scale, -0.9, 0.9)
      ctx.stroke()
      const ax = cx + Math.cos(0.9) * (geom.rhoErgo + 1.2) * scale
      const ay = cy - Math.sin(0.9) * (geom.rhoErgo + 1.2) * scale
      ctx.fillStyle = 'rgba(150,190,255,0.6)'
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax - 6, ay - 5)
      ctx.lineTo(ax + 1, ay - 9)
      ctx.closePath()
      ctx.fill()
    }

    // Marginally-bound circle (faint) — the E = 1 capture threshold.
    if (Number.isFinite(geom.rhoMb)) {
      ctx.strokeStyle = 'rgba(200,150,255,0.22)'
      ctx.setLineDash([2, 5])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, geom.rhoMb * scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Photon ring(s).
    ctx.setLineDash([3, 5])
    if (spin < 0.02 && Number.isFinite(geom.rhoPh)) {
      ctx.strokeStyle = 'rgba(255,230,150,0.6)'
      ctx.beginPath()
      ctx.arc(cx, cy, geom.rhoPh * scale, 0, Math.PI * 2)
      ctx.stroke()
    } else if (spin >= 0.02) {
      ctx.strokeStyle = 'rgba(150,255,190,0.5)'
      ctx.beginPath()
      ctx.arc(cx, cy, geom.rhoPro * scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,220,150,0.45)'
      ctx.beginPath()
      ctx.arc(cx, cy, geom.rhoRet * scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // ISCO ring — the stability watershed for matter. Solid, the brightest reference.
    ctx.strokeStyle = 'rgba(110,200,255,0.85)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(cx, cy, geom.rhoIsco * scale, 0, Math.PI * 2)
    ctx.stroke()

    // Ergosphere (static limit).
    if (spin > 0.02) {
      ctx.strokeStyle = 'rgba(150,120,255,0.6)'
      ctx.setLineDash([4, 5])
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(cx, cy, geom.rhoErgo * scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // The orbit rosette (full traced path, faint).
    if (trace.count > 1) {
      ctx.strokeStyle = 'rgba(255,196,120,0.28)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sx(trace.points[0]), sy(trace.points[1]))
      for (let i = 1; i < trace.count; i++) ctx.lineTo(sx(trace.points[i * 2]), sy(trace.points[i * 2 + 1]))
      ctx.stroke()

      // Periapsis & apoapsis markers.
      const markRadius = (rr: number, color: string) => {
        ctx.strokeStyle = color
        ctx.setLineDash([2, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(cx, cy, geom.rho(rr) * scale, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      markRadius(trace.rPeri, 'rgba(255,120,90,0.4)')
      if (trace.fate === 'bound') markRadius(trace.rApo, 'rgba(120,190,255,0.3)')
    }

    // Event horizon shadow.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, geom.rhoH * scale)
    grad.addColorStop(0, '#000')
    grad.addColorStop(0.82, '#000')
    grad.addColorStop(1, 'rgba(90,130,255,0.55)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, geom.rhoH * scale, 0, Math.PI * 2)
    ctx.fill()
  }, [size, trace, geom, spin, apo])

  // Animation loop: blit the static layer, then draw the moving trail + star, advancing along the
  // path by *proper time* (faithful: the star speeds up at periapsis, exactly as GR requires).
  useEffect(() => {
    const canvas = canvasRef.current
    const stat = staticRef.current
    const map = mapRef.current
    if (!canvas || !stat || !map) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const { sx, sy } = map

    const times = trace.times
    const pts = trace.points
    const n = trace.count
    const tauTotal = n > 1 ? times[n - 1] : 1
    const trailSpan = tauTotal / 7

    // Interpolate the world position at proper time τ (binary search + lerp).
    const posAt = (tau: number): [number, number] => {
      if (n < 2) return [0, 0]
      let lo = 0
      let hi = n - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (times[mid] <= tau) lo = mid
        else hi = mid
      }
      const t0 = times[lo]
      const t1 = times[hi]
      const f = t1 > t0 ? (tau - t0) / (t1 - t0) : 0
      const x = pts[lo * 2] + f * (pts[hi * 2] - pts[lo * 2])
      const y = pts[lo * 2 + 1] + f * (pts[hi * 2 + 1] - pts[lo * 2 + 1])
      return [x, y]
    }

    let tau = 0
    let last = performance.now()
    let raf = 0
    // Pace so a nominal orbit takes a few seconds regardless of its proper-time length.
    const rate = (tauTotal / 4200) * speed

    const draw = () => {
      const now = performance.now()
      const dt = Math.min(now - last, 60)
      last = now
      if (playing && n > 1) {
        tau += dt * rate
        if (tau >= tauTotal) tau -= tauTotal
      }

      // Blit the static layer (it is at device resolution; reset transform to copy 1:1).
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(stat, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (n > 1) {
        // Bright fading trail over the last `trailSpan` of proper time behind the star.
        const startTau = Math.max(tau - trailSpan, 0)
        // Find the first path index at or before startTau (binary search).
        let lo = 0
        let hi = n - 1
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if (times[mid] < startTau) lo = mid
          else hi = mid
        }
        const iStart = lo
        const [hx, hy] = posAt(tau)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (let i = iStart; i < n - 1 && times[i] <= tau; i++) {
          const age = (tau - times[i]) / trailSpan
          const alpha = Math.max(0, 1 - age)
          ctx.strokeStyle = `rgba(255,${Math.round(190 + 40 * alpha)},${Math.round(120 + 80 * alpha)},${0.85 * alpha})`
          ctx.lineWidth = 1 + 2.2 * alpha
          ctx.beginPath()
          ctx.moveTo(sx(pts[i * 2]), sy(pts[i * 2 + 1]))
          ctx.lineTo(sx(pts[(i + 1) * 2]), sy(pts[(i + 1) * 2 + 1]))
          ctx.stroke()
        }

        // The star.
        ctx.shadowBlur = 14
        ctx.shadowColor = 'rgba(255,210,140,0.9)'
        ctx.fillStyle = '#fff2d8'
        ctx.beginPath()
        ctx.arc(sx(hx), sy(hy), 4.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }

      // Live radius marker on the potential inset.
      const rNow = n > 1 ? Math.hypot(...posAt(tau)) : trace.rPeri
      drawPotential(potRef.current, trace, geom, Math.sqrt(Math.max(rNow * rNow - a * a, 0)), spin, q, apo)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [trace, geom, playing, speed, spin, q, a, apo])

  // ---- read-outs ----
  const ecc = trace.eccentricity
  const precDeg = deg(trace.precession)
  const classification =
    trace.fate === 'plunge'
      ? 'Plunges through the horizon'
      : trace.fate === 'invalid'
        ? 'No bound orbit for these apsides'
        : trace.fate === 'unbound'
          ? 'Unbound — escapes to infinity'
          : ecc < 0.03
            ? 'Near-circular'
            : precDeg > 150
              ? 'Zoom–whirl (whirls the throat)'
              : precDeg > 40
                ? 'Strongly precessing'
                : 'Precessing rosette'

  return (
    <div className="geo orbit">
      <div className="geo__stage" ref={wrapRef}>
        <canvas ref={canvasRef} />
        <div className="orbit__transport">
          <button className="hud__btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <label className="orbit__speed" title="Playback speed">
            <input type="range" min={0.15} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            <span>{speed.toFixed(2)}×</span>
          </label>
        </div>
        <div className={`orbit__fate orbit__fate--${trace.fate}`}>{classification}</div>
      </div>

      <div className="geo__side">
        <h2>Orbit Lab</h2>
        <p className="muted small">
          The rest of Event Horizon traces <em>light</em>. This traces <strong>matter</strong> — the
          world-line of a massive test particle on a real timelike geodesic of the same Kerr–Newman
          spacetime. Set its closest and farthest approach and watch it orbit: unlike a Newtonian
          ellipse, a relativistic orbit <strong>precesses</strong>, and below the ISCO it{' '}
          <strong>plunges</strong>.
        </p>

        <div className="presets">
          {ORBIT_PRESETS.map((p) => (
            <button key={p.name} className="preset" title={p.blurb} onClick={() => applyPreset(p)}>
              {p.name}
            </button>
          ))}
        </div>

        <label className="row" title="Black-hole spin a/M">
          <span className="row__label">Spin a/M</span>
          <input type="range" min={0} max={0.998} step={0.002} value={spin} onChange={(e) => setSpin(Number(e.target.value))} />
          <span className="row__value">{spin.toFixed(2)}</span>
        </label>
        <label className="row" title="Electric charge Q/M — capped by spin (a*² + Q*² ≤ 1)">
          <span className="row__label">Charge Q/M</span>
          <input type="range" min={0} max={1} step={0.005} value={q} onChange={(e) => setCharge(Math.min(Number(e.target.value), chargeCeil))} />
          <span className="row__value">{q.toFixed(2)}</span>
        </label>
        <label className="row" title="Closest approach (periapsis), in rs">
          <span className="row__label">Periapsis</span>
          <input type="range" min={1.2} max={30} step={0.05} value={rPeri} onChange={(e) => setRPeri(Number(e.target.value))} />
          <span className="row__value">{rPeri.toFixed(2)}</span>
        </label>
        <label className="row" title="Farthest approach (apoapsis), in rs">
          <span className="row__label">Apoapsis</span>
          <input type="range" min={2} max={60} step={0.1} value={rApo} onChange={(e) => setRApo(Number(e.target.value))} />
          <span className="row__value">{rApo.toFixed(1)}</span>
        </label>
        <label className="toggle" title="Co-rotating with the hole's spin, or against it">
          <input type="checkbox" checked={prograde} onChange={(e) => setPrograde(e.target.checked)} />
          <span>Prograde (co-rotating)</span>
        </label>

        <div className="orbit__pot">
          <div className="geo__readout-title">Radial function R(r) = (dr/dτ)²</div>
          <canvas ref={potRef} className="orbit__pot-canvas" />
          <p className="muted small">
            The particle is confined to where R ≥ 0; its zeros are the turning points (periapsis &amp;
            apoapsis) and the marker is its current radius. A double zero would be a circular orbit;
            no inner zero means a plunge.
          </p>
        </div>

        <ul className="legend">
          <li><span className="swatch" style={{ background: '#ffc478' }} /> the orbiting star</li>
          <li><span className="swatch" style={{ background: '#6ec8ff' }} /> ISCO (innermost stable circular orbit)</li>
          {spin >= 0.02 && <li><span className="swatch swatch--ergo" /> ergosphere (static limit)</li>}
          {spin >= 0.02 ? (
            <li><span className="swatch swatch--ring" /> prograde / retrograde light rings</li>
          ) : (
            <li><span className="swatch swatch--photon" /> photon sphere</li>
          )}
        </ul>

        <div className="geo__readout" aria-live="polite">
          <div className="geo__readout-title">{holeName(spin, q)} · a/M = {spin.toFixed(3)}{q > 0.001 ? `, Q/M = ${q.toFixed(3)}` : ''}</div>
          <dl>
            <div><dt>Specific energy E</dt><dd>{fmt(trace.E, 4)}{Number.isFinite(trace.E) && trace.E >= 1 ? ' (unbound)' : ''}</dd></div>
            <div><dt>Angular momentum L</dt><dd>{fmt(trace.L, 3)} rs</dd></div>
            <div><dt>Periapsis · apoapsis</dt><dd>{fmt(trace.rPeri, 2)} · {trace.fate === 'bound' ? fmt(trace.rApo, 2) : '—'} rs</dd></div>
            <div><dt>Eccentricity</dt><dd>{trace.fate === 'bound' ? fmt(ecc, 3) : '—'}</dd></div>
            <div><dt>Precession / orbit</dt><dd>{trace.closed ? `${precDeg >= 0 ? '+' : ''}${precDeg.toFixed(2)}°` : '—'}</dd></div>
            <div><dt>Radial period (τ)</dt><dd>{trace.closed ? `${fmt(trace.radialPeriodTau, 1)}` : '—'} rs</dd></div>
            <div><dt>Radial period (coord. t)</dt><dd>{trace.closed ? `${fmt(trace.radialPeriodT, 1)}` : '—'} rs</dd></div>
            <div><dt>Orbital period (t)</dt><dd>{trace.closed ? `${fmt(trace.azimuthalPeriodT, 1)}` : '—'} rs</dd></div>
            <div><dt>Time dilation dτ/dt</dt><dd>{fmt(trace.timeDilationAvg, 3)} (min {fmt(trace.timeDilationMin, 3)})</dd></div>
            <div><dt>ISCO ({prograde ? 'prograde' : 'retrograde'})</dt><dd>{fmt(geom.isco, 3)} rs</dd></div>
            <div><dt>Horizon r₊ · marg-bound</dt><dd>{fmt(geom.rPlus, 3)} · {fmt(geom.mb, 2)} rs</dd></div>
          </dl>
        </div>

        <p className="muted small">
          <strong>Precession</strong> is Einstein's first triumph: the perihelion of Mercury advances
          43″ per century because spacetime curves. Here the same effect is huge and immediate. In the
          weak field it tends to <span className="mono">6πM / [a(1−e²)]</span> per orbit; in the strong
          field it explodes into <strong>zoom–whirl</strong> orbits. The two clocks tell you the{' '}
          <strong>time dilation</strong>: the orbiting star's proper time runs at dτ/dt of a distant
          clock — slowest at periapsis, deep in the well and moving fastest.
        </p>
      </div>
    </div>
  )
}

// The effective-potential inset: R(r) = (dr/dτ)², shaded where the particle is forbidden (R < 0),
// with the turning points (zeros) and the live radius marked.
function drawPotential(
  canvas: HTMLCanvasElement | null,
  trace: OrbitTrace,
  geom: { rPlus: number; isco: number },
  rNow: number,
  spin: number,
  q: number,
  apo: number,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth || 288
  const h = 120
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.height = `${h}px`
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#080b12'
  ctx.fillRect(0, 0, w, h)

  if (!Number.isFinite(trace.E)) {
    ctx.fillStyle = 'rgba(160,170,190,0.6)'
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillText('no bound orbit', 10, h / 2)
    return
  }

  const a = spin * M
  const q2 = chargeQ2(q)
  const rLo = geom.rPlus + 0.05
  const rHi = Math.max(apo * 1.15, trace.rApo * 1.15, geom.isco * 1.2)
  const N = 220
  const xs: number[] = []
  const ys: number[] = []
  let ymin = Infinity
  let ymax = -Infinity
  for (let i = 0; i <= N; i++) {
    const r = rLo + ((rHi - rLo) * i) / N
    const R = radialFunction(r, trace.E, trace.L, a, q2)
    xs.push(r)
    ys.push(R)
    ymin = Math.min(ymin, R)
    ymax = Math.max(ymax, R)
  }
  // Symmetric-ish vertical range around zero so the R=0 axis is meaningful.
  const yr = Math.max(ymax, -ymin, 1e-3) * 1.1
  const px = (r: number) => ((r - rLo) / (rHi - rLo)) * (w - 8) + 4
  const py = (R: number) => h / 2 - (R / yr) * (h / 2 - 8)

  // Forbidden band (R < 0) shaded.
  ctx.fillStyle = 'rgba(255,90,60,0.10)'
  ctx.fillRect(0, h / 2, w, h / 2)
  // Zero axis.
  ctx.strokeStyle = 'rgba(150,160,190,0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()

  // Turning points (zeros) as vertical guides.
  for (const rt of [trace.rPeri, trace.rApo]) {
    if (rt < rLo || rt > rHi) continue
    if (rt === trace.rApo && trace.fate !== 'bound') continue
    ctx.strokeStyle = 'rgba(255,150,110,0.5)'
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(px(rt), 6)
    ctx.lineTo(px(rt), h - 6)
    ctx.stroke()
    ctx.setLineDash([])
  }
  // ISCO guide.
  if (geom.isco >= rLo && geom.isco <= rHi) {
    ctx.strokeStyle = 'rgba(110,200,255,0.4)'
    ctx.beginPath()
    ctx.moveTo(px(geom.isco), 6)
    ctx.lineTo(px(geom.isco), h - 6)
    ctx.stroke()
  }

  // R(r) curve.
  ctx.strokeStyle = '#ffc478'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(px(xs[0]), py(ys[0]))
  for (let i = 1; i <= N; i++) ctx.lineTo(px(xs[i]), py(ys[i]))
  ctx.stroke()

  // Live radius marker.
  if (rNow >= rLo && rNow <= rHi) {
    const Rn = radialFunction(rNow, trace.E, trace.L, a, q2)
    ctx.fillStyle = '#fff2d8'
    ctx.shadowBlur = 8
    ctx.shadowColor = 'rgba(255,210,140,0.9)'
    ctx.beginPath()
    ctx.arc(px(rNow), py(Rn), 3.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }
}
