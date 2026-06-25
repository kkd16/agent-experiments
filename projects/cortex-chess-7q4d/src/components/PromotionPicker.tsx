import { type Color, WHITE } from '../engine'
import { GLYPH, PROMO_CHOICES } from '../pieces'

interface PromotionPickerProps {
  color: Color
  onSelect: (type: number) => void
  onCancel: () => void
}

export default function PromotionPicker({ color, onSelect, onCancel }: PromotionPickerProps) {
  return (
    <div className="promo-overlay" onClick={onCancel}>
      <div className="promo-box" onClick={(e) => e.stopPropagation()}>
        <div className="promo-title">Promote to…</div>
        <div className="promo-choices">
          {PROMO_CHOICES.map((type) => (
            <button key={type} className="promo-choice" onClick={() => onSelect(type)}>
              <span className={`piece ${color === WHITE ? 'white' : 'black'}`}>{GLYPH[type]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
