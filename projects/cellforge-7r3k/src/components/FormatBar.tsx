import type { CellFormat, NumberFormat, Align } from '../engine/format'

interface Props {
  current: CellFormat | undefined
  onApply: (patch: CellFormat) => void
  onClear: () => void
}

const NF_OPTIONS: Array<{ value: NumberFormat; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'plain', label: 'Number' },
  { value: 'thousands', label: 'Number (1,000)' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'scientific', label: 'Scientific' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'datetime', label: 'Date time' },
  { value: 'text', label: 'Plain text' },
]

const TEXT_SWATCHES = ['', '#e7eaf3', '#7c9cff', '#5fd0ff', '#58d39b', '#ffce6b', '#ff8a8a', '#c89bff']
const FILL_SWATCHES = ['', '#1d2335', '#27314f', '#2a3a2e', '#3a342166', '#3a2730', '#2e2a40', '#22343a']

/** The formatting toolbar — applies a format patch to the whole selection. */
export default function FormatBar({ current, onApply, onClear }: Props) {
  const f = current ?? {}
  const tgl = (key: 'bold' | 'italic' | 'underline') => () => onApply({ [key]: !f[key] })
  const setAlign = (a: Align) => () => onApply({ align: f.align === a ? undefined : a })
  const decimals = f.decimals
  const bumpDecimals = (d: number) => () => {
    const base = decimals ?? defaultDecimals(f.nf)
    onApply({ decimals: Math.max(0, Math.min(10, base + d)) })
  }

  return (
    <div className="formatbar">
      <div className="fb-group">
        <button className={'fb-btn' + (f.bold ? ' on' : '')} title="Bold" onClick={tgl('bold')} style={{ fontWeight: 700 }}>
          B
        </button>
        <button className={'fb-btn' + (f.italic ? ' on' : '')} title="Italic" onClick={tgl('italic')} style={{ fontStyle: 'italic' }}>
          I
        </button>
        <button className={'fb-btn' + (f.underline ? ' on' : '')} title="Underline" onClick={tgl('underline')} style={{ textDecoration: 'underline' }}>
          U
        </button>
      </div>

      <div className="fb-group">
        <button className={'fb-btn' + (f.align === 'left' ? ' on' : '')} title="Align left" onClick={setAlign('left')}>
          ⌫
        </button>
        <button className={'fb-btn' + (f.align === 'center' ? ' on' : '')} title="Align center" onClick={setAlign('center')}>
          ≡
        </button>
        <button className={'fb-btn' + (f.align === 'right' ? ' on' : '')} title="Align right" onClick={setAlign('right')}>
          ⌦
        </button>
      </div>

      <div className="fb-group">
        <select className="fb-select" value={f.nf ?? 'auto'} title="Number format" onChange={(e) => onApply({ nf: e.target.value as NumberFormat })}>
          {NF_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="fb-btn mono" title="Currency" onClick={() => onApply({ nf: 'currency' })}>
          $
        </button>
        <button className="fb-btn mono" title="Percent" onClick={() => onApply({ nf: 'percent' })}>
          %
        </button>
        <button className="fb-btn mono" title="Decrease decimals" onClick={bumpDecimals(-1)}>
          .0
        </button>
        <button className="fb-btn mono" title="Increase decimals" onClick={bumpDecimals(1)}>
          .00
        </button>
      </div>

      <div className="fb-group">
        <Swatches label="A" title="Text color" swatches={TEXT_SWATCHES} active={f.color} onPick={(c) => onApply({ color: c || undefined })} />
        <Swatches label="▦" title="Fill color" swatches={FILL_SWATCHES} active={f.bg} onPick={(c) => onApply({ bg: c || undefined })} />
        <button className="fb-btn" title="Clear formatting" onClick={onClear}>
          ⌫✦
        </button>
      </div>
    </div>
  )
}

function Swatches({
  label,
  title,
  swatches,
  active,
  onPick,
}: {
  label: string
  title: string
  swatches: string[]
  active: string | undefined
  onPick: (color: string) => void
}) {
  return (
    <div className="fb-swatch-wrap" title={title}>
      <button className="fb-btn" style={{ color: active || undefined }}>
        {label} <span className="fb-caret">▾</span>
      </button>
      <div className="fb-swatch-menu">
        {swatches.map((c, i) => (
          <button
            key={i}
            className={'fb-swatch' + (c === '' ? ' none' : '') + (active === c ? ' sel' : '')}
            style={{ background: c || 'transparent' }}
            title={c || 'default'}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
    </div>
  )
}

function defaultDecimals(nf: NumberFormat | undefined): number {
  if (nf === 'currency') return 2
  if (nf === 'percent') return 0
  if (nf === 'scientific') return 2
  return 2
}
