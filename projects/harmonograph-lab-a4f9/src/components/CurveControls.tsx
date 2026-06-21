// Per-kind parameter editors for the Curve tab. Each component receives the
// active source params plus a patch function and renders the sliders that shape
// that family of curve. The harmonograph editor keeps the original pendulum +
// rotary controls; the rest drive the new parametric sources in `curves.ts`.

import type {
  AttractorParams,
  Layer,
  LissajousParams,
  LSystemParams,
  RoseParams,
  SpirographParams,
  SuperformulaParams,
} from '../types'
import { ATTRACTOR_KINDS, attractorBounded, defaultsForAttractor } from '../curves'
import { LSYSTEM_KINDS, lsystemById } from '../lsystem'
import { Slider } from './Slider'
import { Segmented } from './Segmented'

const TWO_PI = Math.PI * 2
const deg = (v: number) => `${((v / Math.PI) * 180).toFixed(0)}°`
const PEND_KEYS = ['x1', 'x2', 'y1', 'y2'] as const

interface HarmProps {
  theme: Layer
  updateParams: (patch: Partial<Layer['params']>) => void
  updatePend: (key: (typeof PEND_KEYS)[number], field: 'freq' | 'phase' | 'amp' | 'damp', v: number) => void
}

export function CurveHarmonograph({ theme, updateParams, updatePend }: HarmProps) {
  const rotary = theme.params.rotary
  return (
    <>
      <section className="group">
        <Slider
          label="Trace length"
          value={theme.params.duration}
          min={40}
          max={420}
          step={1}
          onChange={(v) => updateParams({ duration: v })}
          fmt={(v) => v.toFixed(0)}
        />
      </section>

      {PEND_KEYS.map((key) => (
        <section className="group" key={key}>
          <div className="group-title">
            Pendulum <span className="tag">{key.toUpperCase()}</span>
          </div>
          <Slider
            label="Frequency"
            value={theme.params[key].freq}
            min={0.5}
            max={8}
            step={0.001}
            onChange={(v) => updatePend(key, 'freq', v)}
          />
          <Slider
            label="Phase"
            value={theme.params[key].phase}
            min={0}
            max={TWO_PI}
            step={0.01}
            onChange={(v) => updatePend(key, 'phase', v)}
            fmt={deg}
          />
          <Slider
            label="Amplitude"
            value={theme.params[key].amp}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => updatePend(key, 'amp', v)}
          />
          <Slider
            label="Damping"
            value={theme.params[key].damp}
            min={0}
            max={0.05}
            step={0.0005}
            onChange={(v) => updatePend(key, 'damp', v)}
            fmt={(v) => v.toFixed(4)}
          />
        </section>
      ))}

      <section className="group">
        <label className="check">
          <input
            type="checkbox"
            checked={rotary.enabled}
            onChange={(e) => updateParams({ rotary: { ...rotary, enabled: e.target.checked } })}
          />
          Rotary frame (rotating paper)
        </label>
        {rotary.enabled && (
          <>
            <Slider
              label="Rot. frequency"
              value={rotary.freq}
              min={0.2}
              max={6}
              step={0.001}
              onChange={(v) => updateParams({ rotary: { ...rotary, freq: v } })}
            />
            <Slider
              label="Rot. amplitude"
              value={rotary.amp}
              min={0}
              max={3}
              step={0.01}
              onChange={(v) => updateParams({ rotary: { ...rotary, amp: v } })}
            />
            <Slider
              label="Rot. phase"
              value={rotary.phase}
              min={0}
              max={TWO_PI}
              step={0.01}
              onChange={(v) => updateParams({ rotary: { ...rotary, phase: v } })}
              fmt={deg}
            />
            <Slider
              label="Rot. damping"
              value={rotary.damp}
              min={0}
              max={0.03}
              step={0.0005}
              onChange={(v) => updateParams({ rotary: { ...rotary, damp: v } })}
              fmt={(v) => v.toFixed(4)}
            />
          </>
        )}
      </section>
    </>
  )
}

export function CurveSpirograph({
  spiro,
  update,
}: {
  spiro: SpirographParams
  update: (patch: Partial<SpirographParams>) => void
}) {
  // The number of petals/cusps for a closed figure is R / gcd(R, r) — surfaced
  // as a hint so tweaking r feels intentional rather than random.
  return (
    <section className="group">
      <div className="group-title">Spirograph</div>
      <label className="check">
        <input
          type="checkbox"
          checked={spiro.outer}
          onChange={(e) => update({ outer: e.target.checked })}
        />
        Roll outside (epitrochoid)
      </label>
      <Slider
        label="Rolling radius r"
        value={spiro.r}
        min={0.05}
        max={0.95}
        step={0.005}
        onChange={(v) => update({ r: v })}
        fmt={(v) => v.toFixed(3)}
      />
      <Slider
        label="Pen offset d"
        value={spiro.d}
        min={0}
        max={1.2}
        step={0.01}
        onChange={(v) => update({ d: v })}
      />
      <Slider
        label="Turns"
        value={spiro.turns}
        min={1}
        max={60}
        step={1}
        onChange={(v) => update({ turns: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Spiral inward"
        value={spiro.decay}
        min={0}
        max={0.04}
        step={0.0005}
        onChange={(v) => update({ decay: v })}
        fmt={(v) => v.toFixed(4)}
      />
      <Slider
        label="Phase"
        value={spiro.phase}
        min={0}
        max={TWO_PI}
        step={0.01}
        onChange={(v) => update({ phase: v })}
        fmt={deg}
      />
    </section>
  )
}

export function CurveRose({
  rose,
  update,
}: {
  rose: RoseParams
  update: (patch: Partial<RoseParams>) => void
}) {
  const k = rose.d === 0 ? rose.n : rose.n / rose.d
  return (
    <section className="group">
      <div className="group-title">
        Rose <span className="tag">k = {k.toFixed(2)}</span>
      </div>
      <Slider
        label="Numerator n"
        value={rose.n}
        min={1}
        max={16}
        step={1}
        onChange={(v) => update({ n: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Denominator d"
        value={rose.d}
        min={1}
        max={12}
        step={1}
        onChange={(v) => update({ d: v, cycles: Math.max(rose.cycles, v) })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Wraps"
        value={rose.cycles}
        min={1}
        max={16}
        step={1}
        onChange={(v) => update({ cycles: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Phase"
        value={rose.phase}
        min={0}
        max={TWO_PI}
        step={0.01}
        onChange={(v) => update({ phase: v })}
        fmt={deg}
      />
      <Slider
        label="2nd harmonic"
        value={rose.c2}
        min={0}
        max={0.8}
        step={0.01}
        onChange={(v) => update({ c2: v })}
      />
      <Slider
        label="2nd frequency"
        value={rose.k2}
        min={1}
        max={20}
        step={1}
        onChange={(v) => update({ k2: v })}
        fmt={(v) => v.toFixed(0)}
      />
    </section>
  )
}

export function CurveLissajous({
  liss,
  update,
}: {
  liss: LissajousParams
  update: (patch: Partial<LissajousParams>) => void
}) {
  return (
    <section className="group">
      <div className="group-title">Lissajous</div>
      <Slider
        label="X frequency a"
        value={liss.a}
        min={1}
        max={12}
        step={1}
        onChange={(v) => update({ a: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Y frequency b"
        value={liss.b}
        min={1}
        max={12}
        step={1}
        onChange={(v) => update({ b: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Phase δ"
        value={liss.delta}
        min={0}
        max={TWO_PI}
        step={0.01}
        onChange={(v) => update({ delta: v })}
        fmt={deg}
      />
      <Slider
        label="Damping"
        value={liss.decay}
        min={0}
        max={0.1}
        step={0.001}
        onChange={(v) => update({ decay: v })}
        fmt={(v) => v.toFixed(3)}
      />
      <Slider
        label="Wraps"
        value={liss.cycles}
        min={1}
        max={8}
        step={1}
        onChange={(v) => update({ cycles: v })}
        fmt={(v) => v.toFixed(0)}
      />
    </section>
  )
}

export function CurveSuperformula({
  sf,
  update,
}: {
  sf: SuperformulaParams
  update: (patch: Partial<SuperformulaParams>) => void
}) {
  return (
    <section className="group">
      <div className="group-title">Superformula</div>
      <Slider
        label="Symmetry m"
        value={sf.m}
        min={1}
        max={20}
        step={1}
        onChange={(v) => update({ m: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider label="n₁" value={sf.n1} min={0.1} max={4} step={0.01} onChange={(v) => update({ n1: v })} />
      <Slider label="n₂" value={sf.n2} min={0.1} max={4} step={0.01} onChange={(v) => update({ n2: v })} />
      <Slider label="n₃" value={sf.n3} min={0.1} max={4} step={0.01} onChange={(v) => update({ n3: v })} />
      <Slider
        label="Loops"
        value={sf.cycles}
        min={1}
        max={12}
        step={1}
        onChange={(v) => update({ cycles: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Twist / loop"
        value={sf.twist}
        min={0}
        max={3}
        step={0.01}
        onChange={(v) => update({ twist: v })}
      />
    </section>
  )
}

// Sensible slider ranges per map: the four bounded maps read their constants as
// angular frequencies (wide range); the unbounded classics live in much tighter
// parameter windows where they stay structured rather than diverging.
function attractorRanges(type: AttractorParams['type']): {
  a: [number, number]
  b: [number, number]
  c: [number, number]
  d: [number, number]
} {
  switch (type) {
    case 'clifford':
    case 'fractaldream':
      return { a: [-3, 3], b: [-3, 3], c: [-1.5, 1.5], d: [-1.5, 1.5] }
    case 'hopalong':
      return { a: [-8, 8], b: [0, 2], c: [0, 3], d: [-1, 1] }
    case 'gumowski':
      return { a: [-1, 1], b: [0.8, 1.0], c: [-1, 1], d: [-1, 1] }
    case 'bedhead':
      return { a: [-1, 1], b: [-1, 1], c: [-1, 1], d: [-1, 1] }
    case 'tinkerbell':
      return { a: [0.5, 1], b: [-1, 0], c: [1, 2.4], d: [0, 1] }
    default:
      return { a: [-3, 3], b: [-3, 3], c: [-3, 3], d: [-3, 3] }
  }
}

const ATTRACTOR_NOTES: Record<string, string> = {
  dejong: 'Peter de Jong\'s four-frequency map — a lacy, symmetric web.',
  clifford: 'Clifford Pickover\'s map — c/d set the amplitudes; flowing ribbons.',
  svensson: 'Johnny Svensson\'s variant — sharp, blade-like filaments.',
  fractaldream: 'Pickover\'s "Fractal Dream" — soft, dreamlike interleaving.',
  hopalong: "Barry Martin's Hopalong — a sprayed spiral of fine filaments.",
  gumowski: 'Gumowski–Mira — near-conservative; gorgeous concentric shells.',
  bedhead: 'The Bedhead map — tight swirling knots.',
  tinkerbell: 'The Tinkerbell map — a folded, wing-like basin.',
}

export function CurveAttractor({
  attractor,
  update,
}: {
  attractor: AttractorParams
  update: (patch: Partial<AttractorParams>) => void
}) {
  const r = attractorRanges(attractor.type)
  const bounded = attractorBounded(attractor.type)
  return (
    <section className="group">
      <div className="group-title">Strange attractor</div>
      <div className="seg-label">Map</div>
      <Segmented
        value={attractor.type}
        options={ATTRACTOR_KINDS}
        // Switching map resets the constants to that map's canonical values, so
        // a de Jong's frequencies don't get reinterpreted as a diverging map.
        onChange={(type) => update(defaultsForAttractor(type))}
        wrap
      />
      <Slider label="a" value={attractor.a} min={r.a[0]} max={r.a[1]} step={0.001} onChange={(v) => update({ a: v })} fmt={(v) => v.toFixed(3)} />
      <Slider label="b" value={attractor.b} min={r.b[0]} max={r.b[1]} step={0.001} onChange={(v) => update({ b: v })} fmt={(v) => v.toFixed(3)} />
      <Slider label="c" value={attractor.c} min={r.c[0]} max={r.c[1]} step={0.001} onChange={(v) => update({ c: v })} fmt={(v) => v.toFixed(3)} />
      <Slider label="d" value={attractor.d} min={r.d[0]} max={r.d[1]} step={0.001} onChange={(v) => update({ d: v })} fmt={(v) => v.toFixed(3)} />
      <p className="hint">
        {ATTRACTOR_NOTES[attractor.type]}{' '}
        {bounded ? '' : 'Framed by robust bounds (outliers clipped). '}
        Switch this layer to the <strong>Density</strong> render style (Color tab) to
        see it as a luminous nebula. Try <em>Live</em> to watch it morph.
      </p>
    </section>
  )
}

export function CurveLSystem({
  lsystem,
  update,
}: {
  lsystem: LSystemParams
  update: (patch: Partial<LSystemParams>) => void
}) {
  const def = lsystemById(lsystem.system) ?? lsystemById(LSYSTEM_KINDS[0].value)!
  return (
    <section className="group">
      <div className="group-title">L-system fractal</div>
      <div className="seg-label">Rule set</div>
      <Segmented
        value={lsystem.system}
        options={LSYSTEM_KINDS}
        // Switching systems resets depth + angle to that fractal's canonical
        // values, so the slider ranges always match the selected rule set.
        onChange={(system) => {
          const d = lsystemById(system)
          update({ system, iterations: d?.defaultIter ?? 4, angle: d?.angle ?? Math.PI / 2 })
        }}
        wrap
      />
      <Slider
        label="Iterations"
        value={lsystem.iterations}
        min={0}
        max={def.maxIter}
        step={1}
        onChange={(v) => update({ iterations: v })}
        fmt={(v) => v.toFixed(0)}
      />
      <Slider
        label="Fold angle"
        value={lsystem.angle}
        min={5 * (Math.PI / 180)}
        max={175 * (Math.PI / 180)}
        step={0.5 * (Math.PI / 180)}
        onChange={(v) => update({ angle: v })}
        fmt={deg}
      />
      <p className="hint">
        {def.note ?? 'A turtle walks a rewritten string, turning by the fold angle.'}{' '}
        Hit <em>Live</em> (🌀) to sweep the fold angle and watch it morph.
      </p>
    </section>
  )
}
