import type { Engine } from '../logic/engine'
import { buildTruthTable } from '../logic/truth'

type Tab = 'truth' | 'help' | null

interface Props {
  tab: Tab
  engine: Engine
  onClose: () => void
}

export default function Drawer({ tab, engine, onClose }: Props) {
  if (!tab) return null
  return (
    <div className="drawer">
      <header>
        <h3>{tab === 'truth' ? 'Truth table' : 'Guide'}</h3>
        <button className="btn ghost close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="body">{tab === 'truth' ? <TruthView engine={engine} /> : <HelpView />}</div>
    </div>
  )
}

function TruthView({ engine }: { engine: Engine }) {
  const tt = buildTruthTable(engine.snapshot())
  if (!tt) {
    return (
      <p className="msg">
        Add at least one <b>Input</b> switch and one <b>LED</b> output, wire them through some gates, and
        the full truth table appears here.
      </p>
    )
  }
  if (tt.reason === 'sequential') {
    return (
      <p className="msg">
        This circuit has memory (a clock, flip-flop or latch), so a static truth table doesn't apply. Press{' '}
        <b>Run</b> and watch it evolve over time instead.
      </p>
    )
  }
  return (
    <>
      <p className="msg" style={{ marginTop: 0 }}>
        {tt.rows.length} rows over {tt.inputs.length} input{tt.inputs.length > 1 ? 's' : ''}.
        {tt.truncated && ' (limited to the first 8 inputs)'}
      </p>
      <table className="tt">
        <thead>
          <tr>
            {tt.inputs.map((i) => (
              <th key={i.id}>{i.name}</th>
            ))}
            {tt.outputs.map((o) => (
              <th key={o.id} className="outcol">
                {o.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tt.rows.map((r, ri) => (
            <tr key={ri}>
              {r.in.map((v, ci) => (
                <td key={`i${ci}`} className={v ? 'one' : 'zero'}>
                  {v ? 1 : 0}
                </td>
              ))}
              {r.out.map((v, ci) => (
                <td key={`o${ci}`} className={v ? 'one' : 'zero'}>
                  {v ? 1 : 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function HelpView() {
  const rows: [string, string][] = [
    ['Place a part', 'Click a palette tile, then click the board'],
    ['Wire two pins', 'Click an output dot, then an input dot'],
    ['Cancel a wire', 'Esc, or click empty space'],
    ['Flip an input', 'Click the input switch'],
    ['Move a part', 'Drag its body'],
    ['Select / delete', 'Click it, then press Del'],
    ['Pan the board', 'Drag empty space'],
    ['Zoom', 'Mouse wheel'],
  ]
  return (
    <>
      <p className="msg" style={{ marginTop: 0 }}>
        <b>LogicLab</b> is a gate-level digital circuit sandbox. Build combinational and sequential logic,
        press <b>Run</b> to bring the clocks to life, and read the signal colours: green wires carry a 1,
        grey wires a 0.
      </p>
      <h4>Controls</h4>
      {rows.map(([a, b]) => (
        <div className="kbdrow" key={a}>
          <span style={{ color: 'var(--muted)' }}>{a}</span>
          <span>{b}</span>
        </div>
      ))}
      <h4>Try this</h4>
      <p className="msg">
        Load <b>4-bit hex counter</b> from the examples menu and press Run — four flip-flops ripple-divide the
        clock and drive a seven-segment digit through 0–F. Or open <b>Half adder</b> and hit the truth table
        to see A ⊕ B and A · B enumerated.
      </p>
      <h4>How the simulator works</h4>
      <p className="msg">
        Every step, combinational gates are solved to a fixed point, then flip-flops sample their inputs on
        rising clock edges, then the network re-settles. That loop is what lets a ripple counter's stages
        cascade correctly inside a single tick.
      </p>
    </>
  )
}
