import { useRef } from 'react'
import { DEMOS } from '../data'

interface Props {
  onLoadDemo: (id: string) => void
  onClear: () => void
  onExportCSV: () => void
  onImportText: (text: string) => void
  onFillDown: () => void
  onFillRight: () => void
  heatOn: boolean
  onToggleHeat: () => void
}

export default function Toolbar(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null)

  return (
    <div className="toolbar">
      <div className="tb-group">
        <span className="tb-label">Demos</span>
        {DEMOS.map((d) => (
          <button key={d.id} className="btn" title={d.blurb} onClick={() => props.onLoadDemo(d.id)}>
            {d.name}
          </button>
        ))}
        <button className="btn ghost" onClick={props.onClear} title="Empty the whole sheet">
          Clear
        </button>
      </div>

      <div className="tb-group">
        <span className="tb-label">Fill</span>
        <button className="btn" onClick={props.onFillDown} title="Fill down (Ctrl+D)">
          ↓ Down
        </button>
        <button className="btn" onClick={props.onFillRight} title="Fill right (Ctrl+R)">
          → Right
        </button>
        <button className={'btn' + (props.heatOn ? ' on' : '')} onClick={props.onToggleHeat} title="Color-scale the selection">
          Heatmap
        </button>
      </div>

      <div className="tb-group">
        <span className="tb-label">Data</span>
        <button className="btn" onClick={props.onExportCSV}>
          Export CSV
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Import CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,text/csv,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            file.text().then((t) => props.onImportText(t))
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
