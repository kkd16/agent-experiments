// The Chronicle panel: a scrollable timeline of the world's generated history. Each
// event carries a year, a title and a line of flavour; the icons key the kind of event.

import type { ReactElement } from 'react'
import type { ChronicleKind, WorldMap } from '../core/types'

interface Props {
  world: WorldMap
  onClose: () => void
}

const ICON: Record<ChronicleKind, string> = {
  founding: '⚓',
  realm: '👑',
  war: '⚔️',
  eruption: '🌋',
  flood: '🌊',
  plague: '☠️',
  golden: '✨',
  famine: '🥀',
  road: '🛤️',
}

export default function Chronicle({ world, onClose }: Props): ReactElement {
  const events = world.chronicle
  return (
    <div className="chronicle">
      <div className="chron-head">
        <div>
          <span className="chron-title">The Chronicle</span>
          <span className="chron-era">of {world.era}</span>
        </div>
        <button className="insp-close" onClick={onClose} aria-label="Close chronicle">
          ×
        </button>
      </div>
      <div className="chron-body">
        {events.length === 0 && <div className="chron-empty">No history recorded — settle some cities first.</div>}
        <ol className="chron-list">
          {events.map((e, i) => (
            <li key={i} className={`chron-item ${e.kind}`}>
              <span className="chron-year">{e.year}</span>
              <span className="chron-icon">{ICON[e.kind]}</span>
              <div className="chron-text">
                <div className="chron-evt-title">{e.title}</div>
                <div className="chron-evt-body">{e.text}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
