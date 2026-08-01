import { kindMeta } from '../logic/kinds'
import type { Kind } from '../logic/kinds'

const GROUPS: { title: string; kinds: Kind[] }[] = [
  { title: 'Sources & I/O', kinds: ['INPUT', 'OUTPUT', 'CLOCK', 'CONST1', 'CONST0', 'SEG7'] },
  { title: 'Logic gates', kinds: ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR', 'BUF'] },
  { title: 'Blocks', kinds: ['MUX2', 'DFF', 'TFF', 'JKFF', 'DLATCH', 'SRLATCH'] },
]

interface Props {
  tool: Kind | null
  setTool: (k: Kind | null) => void
}

export default function Palette({ tool, setTool }: Props) {
  return (
    <aside className="sidebar">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="cat">{g.title}</div>
          <div className="palette">
            {g.kinds.map((k) => {
              const m = kindMeta(k)
              const sel = tool === k
              return (
                <button
                  key={k}
                  className={`chip${sel ? ' sel' : ''}`}
                  title={m.blurb}
                  onClick={() => setTool(sel ? null : k)}
                >
                  {m.short}
                  <small>{m.label}</small>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="hint">
        {tool ? (
          <>
            Placing <b style={{ color: 'var(--accent)' }}>{kindMeta(tool).label}</b> — click the board to
            drop it. <kbd>Esc</kbd> or click the tile to stop.
          </>
        ) : (
          <>
            Pick a part, then click the board. Drag an output pin's dot to an input to wire them. Click an{' '}
            <b>Input</b> to flip it. <kbd>Shift</kbd>-drag to box-select; <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates,{' '}
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Del</kbd> removes.
          </>
        )}
      </div>
    </aside>
  )
}
