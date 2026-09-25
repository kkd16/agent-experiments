import { Icon } from './components'
import { formatTime } from './game/progress'
import { BIOMES } from './game/types'
import type { GameState } from './game/types'
import type { GhostRun } from './game/replay'
import { expeditionById, swiftMet } from './game/expeditions'

export function FlightStatus({
  state,
  coach,
  ghostDelta,
}: {
  state: GameState
  coach: boolean
  ghostDelta: number | null
}) {
  const route = expeditionById(state.expeditionId)
  const next =
    route?.distance ?? (Math.floor(state.worldDistance / 1000) + 1) * 1000
  const remaining = next - (route ? state.distance : state.worldDistance)
  const upcoming = BIOMES[(state.biome + 1) % 4]
  const cue =
    state.flightCue === 'release'
      ? 'Release now · catch the crest'
      : state.flightCue === 'dive'
        ? 'Hold · lean into the slope'
        : state.player.vy < 0
          ? 'Let go · enjoy the lift'
          : 'Hold to meet the downhill'
  return (
    <>
      <div
        className="route-progress"
        aria-label={`${Math.ceil(remaining)} meters to ${route ? 'the destination' : upcoming.short}`}
      >
        <div>
          <span>{route?.name ?? BIOMES[state.biome].short}</span>
          <span>
            {route ? 'Destination' : upcoming.short}{' '}
            <b>{Math.ceil(remaining)} m</b>
          </span>
        </div>
        <div className="route-track">
          <i
            style={{
              width: `${route ? Math.min(100, (state.distance / route.distance) * 100) : (state.worldDistance % 1000) / 10}%`,
            }}
          />
        </div>
      </div>
      <div className="flight-benefits">
        {route && (
          <span
            className={`expedition-clock ${!swiftMet(route, state.time) ? 'over-par' : ''}`}
          >
            <Icon name="seal" size={15} />
            <b>{state.time.toFixed(1)}s</b>
            <span>/ {route.par}s swift seal</span>
          </span>
        )}
        {state.player.shield && (
          <span className="benefit-shield">
            <Icon name="shield" size={15} /> Shield ready
          </span>
        )}
        {state.player.magnetTime > 0 && (
          <span className="benefit-magnet">
            <Icon name="magnet" size={15} /> Magnet{' '}
            <b>{Math.ceil(state.player.magnetTime)}s</b>
          </span>
        )}
        {ghostDelta !== null && (
          <span className={`ghost-gap ${ghostDelta >= 0 ? 'ghost-ahead' : ''}`}>
            <Icon name="ghost" size={15} />
            <b>
              {ghostDelta >= 0 ? '+' : '−'}
              {Math.abs(Math.round(ghostDelta))} m
            </b>
            <span>{ghostDelta >= 0 ? 'ahead' : 'behind'}</span>
          </span>
        )}
      </div>
      <div
        className="sky-chain"
        aria-label={`${state.ringChain} of 3 sun rings linked`}
      >
        <span>SKY CHAIN</span>
        <div>
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < state.ringChain ? 'lit' : ''}>
              <Icon name="ring" size={16} />
            </i>
          ))}
        </div>
        <small>3 rings → light magnet</small>
      </div>
      {coach && state.phase === 'running' && (
        <div className={`flight-coach cue-${state.flightCue}`}>
          <Icon name={state.flightCue === 'dive' ? 'dive' : 'soar'} size={19} />
          <span>{cue}</span>
          {state.diving && <i>DIVING</i>}
        </div>
      )}
    </>
  )
}

export function FlightDebrief({
  state,
  trace,
}: {
  state: GameState
  trace: GhostRun | null
}) {
  const points = trace?.points ?? []
  const path = points
    .map(
      (point, i) =>
        `${i === 0 ? 'M' : 'L'}${((point[0] / Math.max(1, state.time)) * 430).toFixed(1)},${(8 + (point[2] / 720) * 40).toFixed(1)}`,
    )
    .join(' ')
  const advice =
    state.mode === 'zen'
      ? 'Take that rhythm into Voyage when you’re ready.'
      : state.hits > 2
        ? 'Release before the rocks. Save a burst for a tight escape.'
        : state.perfectLandings === 0
          ? 'Meet a downhill slope gently for a perfect landing.'
          : state.skyChains === 0
            ? 'Link three rings without a miss to call in a light magnet.'
            : 'Beautiful rhythm. Try this course again against your ghost.'
  return (
    <div className="flight-debrief">
      <div className="flight-chart">
        <span>{formatTime(state.time)} IN THE SKY</span>
        <svg
          viewBox="0 0 430 60"
          preserveAspectRatio="none"
          role="img"
          aria-label="Your flight's height over time"
        >
          <path d={`${path} L430,60 L0,60Z`} fill="#b88eaa16" />
          <path d={path} fill="none" stroke="#b78ba4" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="debrief-details">
        <span>
          <b>{state.perfectLandings}</b> perfect
        </span>
        <span>
          <b>{state.skyChains}</b> sky chains
        </span>
        <span>
          <b>{state.maxAirtime.toFixed(1)}s</b> longest glide
        </span>
        <span>
          <b>{Math.round(state.maxSpeed * 0.36)}</b> km/h top speed
        </span>
      </div>
      <p className="flight-advice">{advice}</p>
    </div>
  )
}
