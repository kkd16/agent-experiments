import { CORPUS } from '../lib/corpus'

// A shared input surface: a text box plus one-click sample loaders. Pages own
// their own text state and pass it here; the corpus chips make the differences
// between codecs immediately explorable.
export function InputPanel({
  value,
  onChange,
  rows = 4,
  label = 'Input text',
  maxNote,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  label?: string
  maxNote?: string
}) {
  return (
    <div>
      <div className="row spread" style={{ marginBottom: 8 }}>
        <div className="stat-label">{label}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {value.length} chars{maxNote ? ` · ${maxNote}` : ''}
        </div>
      </div>
      <textarea value={value} rows={rows} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <div className="chip-row" style={{ marginTop: 10 }}>
        {CORPUS.map((s) => (
          <button
            key={s.id}
            className={`chip${value === s.text ? ' active' : ''}`}
            onClick={() => onChange(s.text)}
            title={s.note}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  )
}
