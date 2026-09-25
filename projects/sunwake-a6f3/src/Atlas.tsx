import { useState } from 'react'
import { Icon, Modal } from './components'
import {
  EXPEDITIONS,
  expeditionById,
  medalCount,
  routeUnlocked,
  sealCount,
  skillMet,
  swiftMet,
} from './game/expeditions'
import type { Expedition, ExpeditionRecords } from './game/expeditions'
import type { GameState } from './game/types'
import { TRAILS } from './game/cosmetics'
import type { TrailId } from './game/cosmetics'

function Seals({ mask, size = 18 }: { mask: number; size?: number }) {
  return (
    <span
      className="seal-row"
      aria-label={`${medalCount(mask)} of 3 seals earned`}
    >
      {[1, 2, 4].map((bit) => (
        <i key={bit} className={mask & bit ? 'earned' : ''}>
          <Icon name="seal" size={size} />
        </i>
      ))}
    </span>
  )
}

function AtlasArt() {
  return (
    <svg
      className="atlas-art"
      viewBox="0 0 600 390"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect width="600" height="390" fill="#ede4da" />
      <path d="M0 142Q110 13 257 129T600 102V390H0Z" fill="#dbbfae" />
      <path d="M0 210Q109 100 267 230T600 136V390H0Z" fill="#c99598" />
      <path d="M0 312Q99 184 258 280T600 217V390H0Z" fill="#b19bbd" />
      <path d="M0 386Q160 275 348 342T600 278V390H0Z" fill="#8eafbb" />
      <g stroke="#fff1dc" strokeWidth=".8" opacity=".24" fill="none">
        {[0, 1, 2, 3].map((i) => (
          <path
            key={i}
            d={`M-20 ${195 + i * 19}Q120 ${120 + i * 25} 270 ${235 + i * 17}T630 ${198 + i * 27}`}
          />
        ))}
      </g>
      <path
        d="M75 120C124 53 195 230 210 183S333 30 337 105 530 74 507 203 268 185 337 278 486 352 521 311"
        fill="none"
        stroke="#fff5e1"
        strokeWidth="2"
        strokeDasharray="4 6"
        opacity=".9"
      />
      <g fill="none" stroke="#745b70" opacity=".35">
        <path d="M39 34v25m-12-12h24m-19-7 14 14m0-14-14 14" />
        <circle cx="39" cy="47" r="9" />
      </g>
      <text x="58" y="50" fill="#745b70" fontSize="9" letterSpacing="3">
        THE SUN ATLAS
      </text>
      <text x="29" y="369" fill="#f7eedf" fontSize="8" letterSpacing="2">
        FOLLOW THE BEACONS
      </text>
    </svg>
  )
}
const positions = [
  [12.5, 30.7],
  [35, 47],
  [56.2, 27],
  [84.5, 52],
  [56.2, 71.3],
  [86.8, 79.7],
]

export function AtlasInvitation({
  records,
  onOpen,
}: {
  records: ExpeditionRecords
  onOpen: () => void
}) {
  const seals = sealCount(records)
  return (
    <section className="atlas-invitation" aria-label="Sun Atlas expeditions">
      <div className="atlas-invitation-mark">
        <Icon name="map" size={32} />
        <span>
          {seals}
          <small>/18</small>
        </span>
      </div>
      <div>
        <span className="eyebrow">SIX ROUTES. A WORLD TO EARN.</span>
        <h2>
          Give the horizon a destination<span>.</span>
        </h2>
        <p>Follow the beacons. Collect seals. Leave a wake of your own.</p>
      </div>
      <button className="button secondary" onClick={onOpen}>
        Open the Sun Atlas <Icon name="arrow" size={17} />
      </button>
    </section>
  )
}

export function SunAtlas({
  records,
  initialId,
  onClose,
  onEmbark,
}: {
  records: ExpeditionRecords
  initialId: string
  onClose: () => void
  onEmbark: (id: string) => void
}) {
  const [selected, setSelected] = useState(initialId)
  const route = expeditionById(selected) ?? EXPEDITIONS[0]
  const index = EXPEDITIONS.indexOf(route)
  const record = records[route.id]
  const unlocked = routeUnlocked(route.id, records)
  const seals = sealCount(records)
  return (
    <Modal title="The Sun Atlas" className="atlas-modal" onClose={onClose}>
      <div className="atlas-heading">
        <div>
          <span className="eyebrow">SOME HORIZONS ARE WORTH RETURNING TO</span>
          <h2>
            The Sun Atlas<span>.</span>
          </h2>
        </div>
        <span className="atlas-total">
          <Icon name="seal" size={23} />
          <b>{seals}</b>
          <span>/ 18 seals</span>
        </span>
      </div>
      <p className="modal-intro">
        Six crossings, each with its own rhythm. Reach a destination to open the
        next.
      </p>
      <div className="atlas-layout">
        <div className="atlas-map">
          <AtlasArt />
          <div className="atlas-sun" aria-hidden="true" />
          {EXPEDITIONS.map((item, i) => (
            <button
              key={item.id}
              className={`atlas-node ${selected === item.id ? 'current' : ''} ${routeUnlocked(item.id, records) ? '' : 'locked'}`}
              style={{
                left: `${positions[i][0]}%`,
                top: `${positions[i][1]}%`,
              }}
              onClick={() => setSelected(item.id)}
              aria-label={`${item.name}, ${medalCount(records[item.id]?.medals ?? 0)} of 3 seals${routeUnlocked(item.id, records) ? '' : ', locked'}`}
              aria-pressed={selected === item.id}
            >
              <span>
                {String(i + 1).padStart(2, '0')}
                {!routeUnlocked(item.id, records) && (
                  <i className="atlas-node-lock">
                    <Icon name="lock" size={11} />
                  </i>
                )}
              </span>
              <b>{item.name}</b>
              <Seals mask={records[item.id]?.medals ?? 0} size={11} />
            </button>
          ))}
        </div>
        <div
          className="atlas-detail"
          style={{ '--route-color': route.color } as React.CSSProperties}
        >
          <div className="atlas-route-kicker">
            <span>EXPEDITION {String(index + 1).padStart(2, '0')}</span>
            <Seals mask={record?.medals ?? 0} />
          </div>
          <h3>{route.name}</h3>
          <p className="atlas-subtitle">{route.subtitle}</p>
          <p className="atlas-story">{route.story}</p>
          <div className="atlas-condition">
            <Icon name="wind" size={20} />
            <div>
              <b>{route.condition}</b>
              <span>{route.conditionNote}</span>
            </div>
          </div>
          <div className="atlas-seal-targets">
            {[
              `Reach the ${route.distance.toLocaleString('en-US')} m beacon`,
              route.skill.label,
              `Arrive within ${route.par} seconds`,
            ].map((label, i) => (
              <div
                key={label}
                className={(record?.medals ?? 0) & (1 << i) ? 'done' : ''}
              >
                <Icon
                  name={(record?.medals ?? 0) & (1 << i) ? 'check' : 'seal'}
                  size={17}
                />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="atlas-departure">
            <span>
              {record?.bestTime
                ? `Best crossing · ${record.bestTime.toFixed(2)}s`
                : '+40 light for each new seal'}
              <small>
                Skill and speed seals require reaching the finish. Earn them
                across different attempts.
              </small>
            </span>
            <button
              className="button primary"
              disabled={!unlocked}
              onClick={() => onEmbark(route.id)}
            >
              {unlocked
                ? 'Fly this expedition'
                : `Finish ${EXPEDITIONS[Math.max(0, index - 1)].name}`}
              <Icon name={unlocked ? 'arrow' : 'lock'} size={17} />
            </button>
          </div>
        </div>
      </div>
      <div className="atlas-rewards">
        <span>
          <Icon name="spark" size={17} /> YOUR SEALS LEAVE A WAKE
        </span>
        <p>
          <b>3</b> Seafoam · <b>6</b> Wild violet · <b>12</b> Kestrel + Aurora ·{' '}
          <b>18</b> Stardust
        </p>
        <small>
          Each new seal earns 40 light. Seals add up across attempts.
          <br />
          Choose your unlocked skiff and wake in the hangar.
        </small>
        <button className="atlas-close-bottom" onClick={onClose}>
          Back to the sky <Icon name="arrow" size={14} />
        </button>
      </div>
    </Modal>
  )
}

export function ExpeditionObjectives({
  state,
  route,
}: {
  state: GameState
  route: Expedition
}) {
  const finished = state.arrived
  const rows = [
    {
      label: `Reach ${route.distance.toLocaleString('en-US')} m`,
      value: `${Math.min(route.distance, Math.floor(state.distance))} / ${route.distance} m`,
      progress: state.distance / route.distance,
      met: finished,
    },
    {
      label: route.skill.label,
      value: route.skill.maximum
        ? `${state.hits} hits`
        : `${Math.min(route.skill.target, state[route.skill.kind])} / ${route.skill.target}`,
      progress: route.skill.maximum
        ? Number(state.hits === 0)
        : state[route.skill.kind] / route.skill.target,
      met: skillMet(route, state),
    },
    {
      label: `Arrive within ${route.par} seconds`,
      value: `${state.time.toFixed(state.phase === 'ended' ? 2 : 1)} / ${route.par} s`,
      progress: state.time / route.par,
      met: swiftMet(route, state.time),
    },
  ]
  return (
    <section
      className="expedition-objectives"
      aria-label="Expedition objectives"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR NEXT DESTINATION</span>
          <h2>
            {route.name}
            <span>.</span>
          </h2>
        </div>
        <span className="expedition-condition-label">{route.condition}</span>
      </div>
      <div className="objective-list">
        {rows.map((row, i) => (
          <div
            className={`objective-item ${row.met ? 'met' : ''} ${i === 2 && !row.met ? 'missed' : ''}`}
            key={row.label}
          >
            <Icon name={finished && row.met ? 'check' : 'seal'} size={22} />
            <div>
              <b>{row.label}</b>
              <span>{row.value}</span>
              <i>
                <em
                  style={{ width: `${Math.min(100, row.progress * 100)}%` }}
                />
              </i>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function ExpeditionResult({
  state,
  medals,
  newMedals,
  totalMedals,
  unlocked,
  onHangar,
}: {
  state: GameState
  medals: number
  newMedals: number
  totalMedals: number
  unlocked: string[]
  onHangar: () => void
}) {
  const route = expeditionById(state.expeditionId)!
  return (
    <div className="expedition-result">
      <div className="expedition-seal-results">
        {['Arrival', 'Finesse', 'Swift'].map((name, i) => (
          <div
            key={name}
            className={
              medals & (1 << i)
                ? 'earned'
                : totalMedals & (1 << i)
                  ? 'collected'
                  : ''
            }
          >
            <Icon name="seal" size={27} />
            <b>{name}</b>
            <span>
              {newMedals & (1 << i)
                ? 'NEW · +40'
                : medals & (1 << i)
                  ? 'THIS FLIGHT'
                  : totalMedals & (1 << i)
                    ? 'COLLECTED'
                    : 'NEXT TIME'}
            </span>
          </div>
        ))}
      </div>
      <p>
        {state.arrived
          ? `${state.time.toFixed(2)}s crossing · ${medalCount(totalMedals)}/3 route seals collected`
          : `Try again: ${Math.max(0, Math.ceil(route.distance - state.distance))} m left to the beacon.`}
      </p>
      {unlocked.length > 0 && (
        <button className="unlock-announcement" onClick={onHangar}>
          <Icon name="spark" size={14} />
          <span>Unlocked: {unlocked.join(' + ')}</span>
          <Icon name="arrow" size={13} />
        </button>
      )}
    </div>
  )
}

export function WakeSelector({
  seals,
  selected,
  onSelect,
}: {
  seals: number
  selected: TrailId
  onSelect: (id: TrailId) => void
}) {
  return (
    <section className="wake-selector" aria-label="Choose your wake">
      <div>
        <h3>Leave your own kind of light.</h3>
        <span>{seals}/18 atlas seals</span>
      </div>
      <div className="wake-options">
        {TRAILS.map((trail) => (
          <button
            key={trail.id}
            className={selected === trail.id ? 'selected' : ''}
            disabled={seals < trail.seals}
            aria-pressed={selected === trail.id}
            onClick={() => onSelect(trail.id)}
          >
            <span
              className="wake-sample"
              style={
                {
                  '--wake': trail.color,
                  '--wake-accent': trail.accent,
                } as React.CSSProperties
              }
            >
              <i />
              <Icon
                name={
                  seals < trail.seals
                    ? 'lock'
                    : selected === trail.id
                      ? 'check'
                      : 'spark'
                }
                size={17}
              />
            </span>
            <b>{trail.name}</b>
            <small>
              {seals < trail.seals
                ? `${trail.seals} seals`
                : selected === trail.id
                  ? 'Selected'
                  : 'Choose wake'}
            </small>
          </button>
        ))}
      </div>
    </section>
  )
}
