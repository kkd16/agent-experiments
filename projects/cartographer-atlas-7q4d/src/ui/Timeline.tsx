// The timeline studio for "The Ages". A docked scrubber that plays the history simulation
// back — every turn is a frame — while a live leaderboard tracks the great realms of the
// scrubbed year and a ticker lists what happened on that turn. All of it just re-reads the
// current `HistoryFrame`; the heavy lifting is done once, in `core/simulation.ts`.

import { useEffect } from 'react'
import type { ReactElement } from 'react'
import type { ChronicleKind, WorldMap } from '../core/types'

interface Props {
  world: WorldMap
  frameIdx: number
  setFrameIdx: (updater: number | ((i: number) => number)) => void
  playing: boolean
  setPlaying: (updater: boolean | ((p: boolean) => boolean)) => void
  speed: number
  setSpeed: (s: number) => void
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
  collapse: '🏚️',
  secession: '⚑',
}

const SPEEDS = [0.5, 1, 2, 4]

function fmtPop(p: number): string {
  if (p >= 1_000_000) return `${(p / 1_000_000).toFixed(1)}M`
  if (p >= 1_000) return `${Math.round(p / 1000)}k`
  return `${p}`
}

export default function Timeline({
  world,
  frameIdx,
  setFrameIdx,
  playing,
  setPlaying,
  speed,
  setSpeed,
  onClose,
}: Props): ReactElement {
  const frames = world.history.frames
  const last = frames.length - 1
  const idx = Math.min(Math.max(0, frameIdx), last)
  const frame = frames[idx]
  const msPerFrame = 460 / speed

  // Auto-advance while playing; stop at the present.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setFrameIdx((i) => {
        if (i >= last) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, msPerFrame)
    return () => clearInterval(id)
  }, [playing, msPerFrame, last, setFrameIdx, setPlaying])

  const togglePlay = (): void => {
    if (!playing && idx >= last) setFrameIdx(0)
    setPlaying((p) => !p)
  }

  const realms = world.history.realms
  const board = frame.realms.slice(0, 7)
  const totalPop = frame.realms.reduce((s, r) => s + r.population, 0)
  const turnEvents = frame.events.map((i) => world.history.events[i]).filter(Boolean)

  return (
    <div className="timeline">
      <div className="tl-head">
        <div className="tl-titles">
          <span className="tl-title">The Ages</span>
          <span className="tl-era">{world.history.era}</span>
        </div>
        <div className="tl-year">
          <span className="tl-year-n">Year {frame.year}</span>
          <span className="tl-year-sub">
            {frame.realms.length} realm{frame.realms.length === 1 ? '' : 's'} ·{' '}
            {fmtPop(totalPop)} souls
          </span>
        </div>
        <button className="insp-close" onClick={onClose} aria-label="Close timeline">
          ×
        </button>
      </div>

      <div className="tl-transport">
        <button
          className="tl-btn"
          onClick={() => {
            setPlaying(false)
            setFrameIdx(0)
          }}
          title="To the founding"
          aria-label="To the founding"
        >
          ⏮
        </button>
        <button className="tl-btn tl-play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className="tl-btn"
          onClick={() => {
            setPlaying(false)
            setFrameIdx(last)
          }}
          title="To the present age"
          aria-label="To the present age"
        >
          ⏭
        </button>
        <input
          className="tl-slider"
          type="range"
          min={0}
          max={last}
          step={1}
          value={idx}
          onChange={(e) => {
            setPlaying(false)
            setFrameIdx(Number(e.target.value))
          }}
          aria-label="History timeline"
        />
        <div className="tl-speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`tl-speed ${speed === s ? 'active' : ''}`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="tl-panels">
        <div className="tl-board">
          <div className="tl-board-head">Great realms of the age</div>
          {board.length === 0 && <div className="tl-empty">No realm yet holds the land.</div>}
          {board.map((s) => {
            const meta = realms[s.id]
            const shareW = totalPop > 0 ? Math.max(3, (s.population / (board[0]?.population || 1)) * 100) : 3
            return (
              <div className="tl-realm" key={s.id}>
                <span className="tl-swatch" style={{ background: `hsl(${meta?.hue ?? 0} 58% 52%)` }} />
                <span className="tl-realm-name" title={meta?.name}>
                  {meta?.name ?? '—'}
                </span>
                <span className="tl-bar-wrap">
                  <span
                    className="tl-bar"
                    style={{ width: `${shareW}%`, background: `hsl(${meta?.hue ?? 0} 58% 52%)` }}
                  />
                </span>
                <span className="tl-realm-stat">{fmtPop(s.population)}</span>
              </div>
            )
          })}
        </div>

        <div className="tl-events">
          <div className="tl-board-head">This turn</div>
          {turnEvents.length === 0 && <div className="tl-empty">A quiet age passes.</div>}
          <ul className="tl-event-list">
            {turnEvents.slice(0, 6).map((e, i) => (
              <li key={i} className={`tl-event ${e.kind}`}>
                <span className="tl-event-icon">{ICON[e.kind]}</span>
                <span className="tl-event-text">
                  <b>{e.title}.</b> {e.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
