import type { Engine } from '../logic/engine'
import { clockPeriod } from '../logic/engine'
import { kindMeta } from '../logic/kinds'

interface Props {
  engine: Engine
  compId: string
  commit: () => void
  beginMutation: () => void
  endMutation: () => void
  onDelete: () => void
}

// Naming is useful for anything the truth table or analyzer labels; the clock
// stores its period in `label`, and constants have nothing to name.
const NAMEABLE = new Set(['INPUT', 'OUTPUT', 'BUF', 'NOT', 'AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR', 'MUX2', 'DFF', 'TFF', 'JKFF', 'DLATCH', 'SRLATCH', 'SEG7'])

export default function Inspector({ engine, compId, commit, beginMutation, endMutation, onDelete }: Props) {
  const comp = engine.comps.get(compId)
  if (!comp) return null
  const m = kindMeta(comp.kind)

  // Mutations fetch the live component inside the handler (not the render-scope
  // `comp`) so we mutate engine state, never a value React tracks for rendering.
  const setLabel = (value: string) => {
    const c = engine.comps.get(compId)
    if (c) c.label = value
    commit()
  }
  const toggleValue = () => {
    const c = engine.comps.get(compId)
    if (!c) return
    beginMutation()
    c.outs[0] = !c.outs[0]
    engine.solve()
    endMutation()
    commit()
  }

  return (
    <div className="inspector">
      <header>
        <span className="ikind">{m.short}</span>
        <b>{m.label}</b>
        <button className="btn ghost close" onClick={onDelete} title="Delete this part (Del)">
          🗑
        </button>
      </header>
      <div className="ibody">
        {NAMEABLE.has(comp.kind) && (
          <label className="ifield">
            <span>label</span>
            <input
              type="text"
              value={comp.label ?? ''}
              placeholder="name…"
              maxLength={12}
              onFocus={beginMutation}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={endMutation}
            />
          </label>
        )}

        {comp.kind === 'CLOCK' && (
          <label className="ifield">
            <span>period</span>
            <span className="irow">
              <input
                type="number"
                min={0.05}
                step={0.05}
                value={clockPeriod(comp)}
                onFocus={beginMutation}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={endMutation}
              />
              <small>s · {(1 / clockPeriod(comp)).toFixed(2)} Hz</small>
            </span>
          </label>
        )}

        {comp.kind === 'INPUT' && (
          <label className="ifield">
            <span>value</span>
            <button className={`toggle${comp.outs[0] ? ' on' : ''}`} onClick={toggleValue}>
              {comp.outs[0] ? '1' : '0'}
            </button>
          </label>
        )}

        <p className="ihint">{m.blurb}</p>
      </div>
    </div>
  )
}
