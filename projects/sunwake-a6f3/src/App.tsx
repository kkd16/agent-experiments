import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark, Icon, Modal, ShipArt } from './components'
import { SunwakeEngine } from './game/engine'
import { renderWorld } from './game/renderer'
import { SunwakeAudio } from './game/audio'
import {
  dailySeed,
  loadProgress,
  MISSIONS,
  saveProgress,
  settleRun,
  SHIPS,
} from './game/progress'
import type { Progress } from './game/progress'
import { BIOMES } from './game/types'
import type { GameInput, GameMode, GameState, ShipId } from './game/types'
import './App.css'

const today = () => new Date().toISOString().slice(0, 10)
const randomSeed = () => Math.floor(Math.random() * 2147483646) + 1
const number = (value: number) => Math.floor(value).toLocaleString('en-US')
const snapshot = (state: GameState): GameState => ({
  ...state,
  player: { ...state.player },
  events: [...state.events],
})
const MODES: { id: GameMode; label: string; description: string }[] = [
  {
    id: 'voyage',
    label: 'Voyage',
    description: 'An open horizon. A new adventure every time.',
  },
  {
    id: 'daily',
    label: 'Daily flight',
    description: 'One shared landscape today. Beat your own best.',
  },
  {
    id: 'zen',
    label: 'Free flight',
    description: 'Endless sunlight. No records or rewards. Just flow.',
  },
]

export default function App() {
  const [progress, setProgress] = useState(loadProgress)
  const progressRef = useRef(progress)
  const [engine] = useState(
    () =>
      new SunwakeEngine({
        mode: 'voyage',
        ship: progress.selected,
        seed: 92847,
      }),
  )
  const [audio] = useState(() => new SunwakeAudio())
  const [view, setView] = useState(() => snapshot(engine.state))
  const [mode, setMode] = useState<GameMode>('voyage')
  const [modal, setModal] = useState<'help' | 'hangar' | null>(null)
  const [result, setResult] = useState<ReturnType<typeof settleRun> | null>(
    null,
  )
  const [notice, setNotice] = useState('')
  const [storageAvailable, setStorageAvailable] = useState(true)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<GameInput>({ dive: false, boost: false })
  const settledRef = useRef(false)
  const runDateRef = useRef(today())
  const [runMissions, setRunMissions] = useState(() =>
    MISSIONS.filter(
      (mission) => !progress.completed.includes(mission.id),
    ).slice(0, 3),
  )

  const commitProgress = useCallback((next: Progress) => {
    progressRef.current = next
    setProgress(next)
    setStorageAvailable(saveProgress(next))
  }, [])

  const pause = useCallback(() => {
    inputRef.current = { dive: false, boost: false }
    engine.pause()
    setView(snapshot(engine.state))
  }, [engine])

  const startRun = useCallback(() => {
    const date = today()
    runDateRef.current = date
    engine.reset({
      mode,
      ship: progressRef.current.selected,
      seed: mode === 'daily' ? dailySeed(date) : randomSeed(),
    })
    inputRef.current = { dive: false, boost: false }
    settledRef.current = false
    setResult(null)
    setRunMissions(
      MISSIONS.filter(
        (mission) => !progressRef.current.completed.includes(mission.id),
      ).slice(0, 3),
    )
    engine.start()
    audio.setEnabled(progressRef.current.sound)
    void audio.unlock()
    setView(snapshot(engine.state))
    canvasRef.current?.focus({ preventScroll: true })
  }, [audio, engine, mode])

  const resume = useCallback(() => {
    engine.resume()
    setView(snapshot(engine.state))
    canvasRef.current?.focus({ preventScroll: true })
  }, [engine])

  const goHome = () => {
    engine.reset({ mode, ship: progressRef.current.selected, seed: 92847 })
    inputRef.current = { dive: false, boost: false }
    setResult(null)
    setView(snapshot(engine.state))
  }

  const selectMode = (next: GameMode) => {
    setMode(next)
    engine.reset({
      mode: next,
      ship: progress.selected,
      seed: next === 'daily' ? dailySeed(today()) : 92847,
    })
    setView(snapshot(engine.state))
  }

  const openModal = (next: 'help' | 'hangar') => {
    if (engine.state.phase === 'running') pause()
    setModal(next)
  }

  const toggleSound = () => {
    const enabled = !progressRef.current.sound
    audio.setEnabled(enabled)
    void audio.unlock()
    commitProgress({ ...progressRef.current, sound: enabled })
  }

  const selectShip = (id: ShipId) => {
    const ship = SHIPS.find((item) => item.id === id)!
    const current = progressRef.current
    const owned = current.owned.includes(id)
    if (!owned && current.bank < ship.price) return
    const next = {
      ...current,
      bank: current.bank - (owned ? 0 : ship.price),
      owned: owned ? current.owned : [...current.owned, id],
      selected: id,
    }
    commitProgress(next)
    if (engine.state.phase === 'ready') {
      engine.reset({ mode, ship: id, seed: engine.state.seed })
      setView(snapshot(engine.state))
    }
  }

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (stageRef.current?.requestFullscreen)
        await stageRef.current.requestFullscreen()
      else
        setNotice(
          'Fullscreen is unavailable here. Try rotating your device for a wider horizon.',
        )
    } catch {
      setNotice(
        'Fullscreen is unavailable here. Your flight is ready in this window.',
      )
    }
  }

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReducedMotion(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 4500)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = stageRef.current
    if (!canvas || !host) return
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    let width = 0
    let height = 0
    let dpr = 1
    const resize = () => {
      const bounds = host.getBoundingClientRect()
      width = bounds.width
      height = bounds.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    let frame = 0
    let previous = performance.now()
    let lastHud = 0
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.05)
      previous = now
      engine.step(dt, inputRef.current)
      audio.update(engine.state)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderWorld(
        context,
        engine.state,
        width,
        height,
        now / 1000,
        reducedMotion,
        progressRef.current.best,
      )
      if (engine.state.phase === 'ended' && !settledRef.current) {
        settledRef.current = true
        inputRef.current = { dive: false, boost: false }
        const settled = settleRun(
          progressRef.current,
          engine.state,
          runDateRef.current,
        )
        commitProgress(settled.progress)
        setResult(settled)
        setView(snapshot(engine.state))
      } else if (now - lastHud > 90) {
        setView(snapshot(engine.state))
        lastHud = now
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [audio, commitProgress, engine, reducedMotion])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (modal || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement
      if (target.closest('input, select, textarea, [contenteditable=true]'))
        return
      if (event.code === 'Space' && target.closest('button, a')) return
      if (
        [
          'Space',
          'ArrowDown',
          'ArrowUp',
          'ShiftLeft',
          'ShiftRight',
          'Escape',
          'KeyP',
        ].includes(event.code)
      )
        event.preventDefault()
      if (event.repeat) return
      if (event.code === 'Space' || event.code === 'ArrowDown') {
        if (engine.state.phase === 'ready' || engine.state.phase === 'ended')
          startRun()
        if (engine.state.phase === 'running') inputRef.current.dive = true
      }
      if (
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight' ||
        event.code === 'ArrowUp'
      )
        inputRef.current.boost = true
      if (event.code === 'Escape' || event.code === 'KeyP') {
        if (engine.state.phase === 'running') pause()
        else if (engine.state.phase === 'paused') resume()
      }
      if (event.code === 'KeyR' && engine.state.phase === 'ended') startRun()
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'ArrowDown')
        inputRef.current.dive = false
      if (
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight' ||
        event.code === 'ArrowUp'
      )
        inputRef.current.boost = false
    }
    const blur = () => {
      if (engine.state.phase === 'running') pause()
      inputRef.current = { dive: false, boost: false }
    }
    const visibility = () => {
      if (document.hidden) blur()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [engine, modal, pause, resume, startRun])

  useEffect(() => () => audio.dispose(), [audio])

  const playing = view.phase === 'running'
  const inRun = playing || view.phase === 'paused'
  const biome = BIOMES[view.biome % BIOMES.length]
  const nextMissions =
    view.phase === 'ready' || view.phase === 'ended'
      ? MISSIONS.filter((m) => !progress.completed.includes(m.id)).slice(0, 3)
      : runMissions
  const lastEvent = [...view.events]
    .reverse()
    .find((event) => event.kind !== 'spark' && view.time - event.time < 2.2)
  const boostReady = view.player.charge >= 65
  const modeDescription = MODES.find((item) => item.id === mode)!.description

  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          className="brand"
          href="#"
          aria-label="Sunwake home"
          onClick={(event) => {
            event.preventDefault()
            if (playing) pause()
            else if (!inRun) goHome()
          }}
        >
          <BrandMark />
          <span>
            sunwake<span className="brand-period">.</span>
          </span>
        </a>
        <div className="header-tagline">
          A little escape.
          <br />
          <strong>An endless horizon.</strong>
        </div>
        <div className="header-actions">
          <div className="personal-best">
            <Icon name="flag" size={17} />
            <span>
              PERSONAL BEST
              <strong>
                {number(progress.best)} <small>m</small>
              </strong>
            </span>
          </div>
          <button
            className="bank-pill"
            onClick={() => openModal('hangar')}
            title="Open the hangar"
          >
            <Icon name="spark" size={17} />
            <span>{number(progress.bank)}</span>
          </button>
          <button
            className="icon-button sound-button"
            onClick={toggleSound}
            aria-label={progress.sound ? 'Mute sound' : 'Enable sound'}
            aria-pressed={progress.sound}
          >
            <Icon name={progress.sound ? 'sound' : 'mute'} />
          </button>
          <button className="help-link" onClick={() => openModal('help')}>
            How to fly <span>↗</span>
          </button>
        </div>
      </header>

      <main>
        <div className="preflight-line">
          <span>
            <i /> MADE FOR ONE MORE RUN
          </span>
          <span>NO DOWNLOAD. JUST A LITTLE DAYDREAM.</span>
        </div>
        <section
          className={`flight-stage phase-${view.phase} ${view.biome >= 2 || (view.biome === 1 && view.distance % 1000 > 800) ? 'night-world' : ''} ${reducedMotion ? 'reduced-motion' : ''}`}
          ref={stageRef}
          aria-label="Sunwake game"
        >
          <canvas
            ref={canvasRef}
            className="world-canvas"
            tabIndex={0}
            role="img"
            aria-label="Dune surfing game. Hold Space or touch to dive. Release to soar. Shift for solar burst. P to pause."
            onPointerDown={(event) => {
              if (engine.state.phase !== 'running') return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
              event.currentTarget.setPointerCapture(event.pointerId)
              inputRef.current.dive = true
            }}
            onPointerUp={() => {
              inputRef.current.dive = false
            }}
            onPointerCancel={() => {
              inputRef.current.dive = false
            }}
            onLostPointerCapture={() => {
              inputRef.current.dive = false
            }}
          >
            Sunwake is an interactive dune-surfing game. Your browser needs
            canvas support to play.
          </canvas>
          <div className="world-topline">
            <div className="region-label">
              <Icon name={view.biome % 4 > 1 ? 'moon' : 'sun'} size={17} />
              <span>{biome.short}</span>
              {mode === 'daily' && <span className="daily-tag">DAILY</span>}
              {mode === 'zen' && <span className="daily-tag">FREE FLIGHT</span>}
            </div>
            <div className="world-tools">
              {inRun && (
                <button
                  className="stage-icon"
                  aria-label={playing ? 'Pause flight' : 'Resume flight'}
                  onClick={playing ? pause : resume}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={18} />
                </button>
              )}
              <button
                className="stage-icon"
                aria-label="Toggle fullscreen"
                onClick={() => void fullscreen()}
              >
                <Icon name="expand" size={17} />
              </button>
            </div>
          </div>

          {view.phase === 'ready' && (
            <div className="welcome-panel">
              <p className="eyebrow welcome-eyebrow">
                <span /> THE HORIZON IS CALLING
              </p>
              <h1>
                Ride the
                <br />
                <span>last light.</span>
              </h1>
              <p className="welcome-copy">
                A little courage. A little sunlight.
                <br />
                See how far the wind will take you.
              </p>
              <button
                className="button primary launch-button"
                onClick={startRun}
              >
                Let’s fly <Icon name="arrow" size={22} />
              </button>
              <div className="mode-selector" aria-label="Game mode">
                {MODES.map((item) => (
                  <button
                    key={item.id}
                    className={mode === item.id ? 'selected' : ''}
                    onClick={() => selectMode(item.id)}
                    aria-pressed={mode === item.id}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="mode-description">{modeDescription}</p>
              {mode === 'daily' && (
                <p className="daily-best">
                  {today()} · Your daily best:{' '}
                  {number(
                    progress.daily.date === today() ? progress.daily.best : 0,
                  )}{' '}
                  m
                </p>
              )}
            </div>
          )}
          {view.phase === 'ready' && (
            <div className="world-caption">
              <span className="tiny-star">✧</span>
              <span>
                Find your rhythm.
                <br />
                <strong>Leave a little stardust.</strong>
              </span>
            </div>
          )}
          {view.phase === 'ready' && (
            <div className="start-hint">
              <kbd>SPACE</kbd> or tap Let’s fly to begin
            </div>
          )}

          {inRun && (
            <>
              <div className="flight-hud">
                <div className="distance-readout">
                  <span className="hud-label">DISTANCE</span>
                  <strong>
                    {number(view.distance)}
                    <small>m</small>
                  </strong>
                  <span className="run-pickups">
                    <Icon name="spark" size={15} />
                    {view.sparks}
                    <span>·</span>
                    {number(view.score)} pts
                  </span>
                </div>
                <div className="sunlight-readout">
                  <span className="hud-label">
                    <Icon name="sun" size={13} /> SUNLIGHT{' '}
                    <b>
                      {mode === 'zen'
                        ? '∞'
                        : `${Math.ceil(view.player.energy)}%`}
                    </b>
                  </span>
                  <div
                    className={`energy-track ${view.player.energy < 25 ? 'low' : ''}`}
                  >
                    <i
                      style={{
                        width: `${Math.max(0, Math.min(100, view.player.energy))}%`,
                      }}
                    />
                  </div>
                  <span className="energy-hint">
                    {mode === 'zen'
                      ? 'The sun is yours. Take your time.'
                      : 'Collect light. Keep the dream alive.'}
                  </span>
                </div>
              </div>
              <div className="combo-display">
                {view.combo > 1 && (
                  <>
                    <strong>×{view.combo}</strong>
                    <span>FLOW</span>
                  </>
                )}
              </div>
              {lastEvent && (
                <div
                  className={`flight-event event-${lastEvent.kind}`}
                  key={lastEvent.id}
                >
                  {lastEvent.kind === 'hit' ? (
                    <Icon name="wind" size={17} />
                  ) : (
                    <Icon name="spark" size={17} />
                  )}
                  {lastEvent.text}
                </div>
              )}
              {playing && view.distance < 180 && (
                <div className="inflight-tip">
                  <kbd>HOLD</kbd> dive into the slope <span>·</span>{' '}
                  <kbd>RELEASE</kbd> catch the sky
                </div>
              )}
              <div className="flight-bottom">
                <div className="speed-readout">
                  <Icon name="wind" size={20} />
                  <strong>{Math.round(view.player.vx * 0.36)}</strong>
                  <span>km/h</span>
                </div>
                <div className="touch-dive">
                  <button
                    aria-label="Hold to dive, release to soar"
                    className="dive-button"
                    onKeyDown={(event) => {
                      if (event.code === 'Space' || event.code === 'Enter') {
                        event.preventDefault()
                        inputRef.current.dive = true
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.code === 'Space' || event.code === 'Enter') {
                        event.preventDefault()
                        inputRef.current.dive = false
                      }
                    }}
                    onBlur={() => {
                      inputRef.current.dive = false
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.currentTarget.setPointerCapture(event.pointerId)
                      inputRef.current.dive = true
                    }}
                    onPointerUp={() => {
                      inputRef.current.dive = false
                    }}
                    onPointerCancel={() => {
                      inputRef.current.dive = false
                    }}
                    onLostPointerCapture={() => {
                      inputRef.current.dive = false
                    }}
                  >
                    <Icon name="dive" /> HOLD TO DIVE
                  </button>
                </div>
                <button
                  className={`burst-button ${boostReady ? 'charged' : ''}`}
                  disabled={!boostReady || !playing}
                  onClick={() => {
                    inputRef.current.boost = true
                    window.setTimeout(() => {
                      inputRef.current.boost = false
                    }, 150)
                    canvasRef.current?.focus({ preventScroll: true })
                  }}
                  aria-label={`Solar burst, ${Math.min(100, Math.round((view.player.charge / 65) * 100))}% ready`}
                >
                  <span
                    className="burst-fill"
                    style={{
                      width: `${Math.min(100, (view.player.charge / 65) * 100)}%`,
                    }}
                  />
                  <Icon name="spark" size={19} />
                  <span>
                    {view.player.boostTime > 0
                      ? 'SUNWAKE!'
                      : boostReady
                        ? 'SOLAR BURST'
                        : 'BUILD YOUR FLOW'}
                  </span>
                  <kbd>SHIFT</kbd>
                </button>
              </div>
            </>
          )}

          {view.phase === 'paused' && (
            <div className="stage-overlay paused-overlay">
              <div className="pause-card">
                <span className="eyebrow">A MOMENT IN THE SUN</span>
                <h2>
                  The horizon
                  <br />
                  can wait.
                </h2>
                <p>Your flight is paused at {number(view.distance)} m.</p>
                <button className="button primary" onClick={resume}>
                  <Icon name="play" size={17} /> Keep flying
                </button>
                <button
                  className="quiet-button"
                  onClick={() => engine.finish()}
                >
                  End this flight
                </button>
              </div>
            </div>
          )}

          {view.phase === 'ended' && result && (
            <div className="stage-overlay results-overlay">
              <div className="results-card">
                <div className="result-kicker">
                  <Icon name={result.newBest ? 'flag' : 'sun'} size={18} />
                  {result.newBest
                    ? 'A NEW PERSONAL HORIZON'
                    : mode === 'zen'
                      ? 'A LITTLE TIME WELL SPENT'
                      : 'EVERY FLIGHT IS A NEW STORY'}
                </div>
                <h2>
                  {result.newBest
                    ? 'Look how far you flew.'
                    : 'The sky will miss you.'}
                </h2>
                <div className="result-distance">
                  {number(view.distance)}
                  <span>m</span>
                </div>
                <p className="result-reason">
                  {view.reason || 'The light fades. Another horizon awaits.'}
                </p>
                <div className="result-stats">
                  <div>
                    <strong>{number(view.score)}</strong>
                    <span>FLIGHT SCORE</span>
                  </div>
                  <div>
                    <strong>×{Math.max(1, view.bestCombo)}</strong>
                    <span>BEST FLOW</span>
                  </div>
                  <div>
                    <strong>{view.cleanLandings}</strong>
                    <span>CLEAN LANDINGS</span>
                  </div>
                  <div>
                    <strong>
                      +{result.earned}
                      <Icon name="spark" size={15} />
                    </strong>
                    <span>LIGHT EARNED</span>
                  </div>
                </div>
                {result.completed.length > 0 && (
                  <div className="completed-missions">
                    {result.completed.map((mission) => (
                      <span key={mission.id}>
                        <Icon name="check" size={14} />
                        {mission.title}
                        <b>+{mission.reward}</b>
                      </span>
                    ))}
                  </div>
                )}
                <div className="result-buttons">
                  <button className="button primary" onClick={startRun}>
                    One more horizon <Icon name="arrow" size={18} />
                  </button>
                  <button className="button secondary" onClick={goHome}>
                    Back to shore
                  </button>
                </div>
                <span className="saved-note">
                  {mode === 'zen'
                    ? 'Free flight: no records or rewards. Just the joy of flying.'
                    : storageAvailable
                      ? 'Your journey is saved on this device.'
                      : 'Storage is unavailable. Your journey lasts for this session.'}
                </span>
              </div>
            </div>
          )}
        </section>

        <div className="flight-guide">
          <div className="guide-title">
            <span className="small-caps">THE ART OF FLIGHT</span>
            <span>Easy to learn. Lovely to master.</span>
          </div>
          <div className="guide-step">
            <Icon name="dive" size={25} />
            <div>
              <strong>Hold to dive</strong>
              <span>
                <kbd>SPACE</kbd> or touch & hold
              </span>
            </div>
          </div>
          <div className="guide-step">
            <Icon name="soar" size={25} />
            <div>
              <strong>Release to soar</strong>
              <span>Catch a slope. Find your flow.</span>
            </div>
          </div>
          <div className="guide-step">
            <Icon name="spark" size={24} />
            <div>
              <strong>Build a solar burst</strong>
              <span>Clean landings + sun rings</span>
            </div>
          </div>
          <button
            className="guide-help"
            onClick={() => openModal('help')}
            aria-label="Read the flight guide"
          >
            <span>?</span>
          </button>
        </div>

        <section className="missions-section" aria-label="Flight challenges">
          <div className="section-heading">
            <div>
              <span className="eyebrow">SMALL WINS. BIG ADVENTURES.</span>
              <h2>
                Your next horizons<span>.</span>
              </h2>
            </div>
            <button className="hangar-link" onClick={() => openModal('hangar')}>
              <span className="hangar-ship">
                <ShipArt ship={progress.selected} />
              </span>
              <span>
                The hangar <Icon name="arrow" size={18} />
              </span>
            </button>
          </div>
          <div className="mission-list">
            {nextMissions.length === 0 ? (
              <div className="all-complete">
                <Icon name="flag" size={25} />
                <div>
                  <strong>Every horizon, discovered.</strong>
                  <p>
                    You’ve completed every challenge. How far can your next
                    flight go?
                  </p>
                </div>
              </div>
            ) : (
              nextMissions.map((mission, index) => {
                const value =
                  inRun && mode !== 'zen'
                    ? Math.min(view[mission.kind] as number, mission.target)
                    : 0
                const completed = value >= mission.target
                return (
                  <div
                    className={`mission-card ${completed ? 'mission-achieved' : ''}`}
                    key={mission.id}
                  >
                    <div className={`mission-symbol symbol-${index}`}>
                      <Icon
                        name={
                          completed
                            ? 'check'
                            : mission.kind === 'distance'
                              ? 'flag'
                              : mission.kind === 'rings'
                                ? 'ring'
                                : mission.kind === 'maxAirtime'
                                  ? 'wind'
                                  : 'spark'
                        }
                        size={23}
                      />
                    </div>
                    <div className="mission-content">
                      <h3>{mission.title}</h3>
                      <p>{mission.description}</p>
                      <div className="mission-meter">
                        <i
                          style={{
                            width: `${(value / mission.target) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                    <span className="mission-reward">
                      +{mission.reward}
                      <Icon name="spark" size={12} />
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section
          className="journey-section"
          aria-label="The four regions of Sunwake"
        >
          <div className="journey-intro">
            <Icon name="sun" size={25} />
            <div>
              <h2>There’s a whole world out there.</h2>
              <p>One endless journey. Four shades of wonder.</p>
            </div>
            <span className="journey-best">
              FURTHEST HORIZON{' '}
              <strong>
                {BIOMES[Math.min(3, Math.floor(progress.best / 1000))].short}
              </strong>
            </span>
          </div>
          <div className="region-map">
            {BIOMES.map((region, index) => (
              <div
                className={`map-region region-${index} ${progress.best >= index * 1000 ? 'discovered' : ''}`}
                key={region.name}
              >
                <div className="landscape-mini">
                  <span className="mini-sun" />
                  <svg
                    viewBox="0 0 280 70"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path d="M0 36Q40 0 88 26T170 24T280 10V70H0Z" />
                    <path d="M0 50Q52 4 130 44T280 23V70H0Z" />
                    <path d="M0 54Q53 78 123 51T280 53V70H0Z" />
                  </svg>
                </div>
                <div className="map-region-label">
                  <span>{region.mark}</span>
                  <strong>{region.short}</strong>
                  <small>
                    {index === 0
                      ? 'THE BEGINNING'
                      : `${number(index * 1000)} M`}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
      <footer>
        <span className="footer-brand">sunwake.</span>
        <span>Chase the light. Enjoy the in-between.</span>
        <span>
          Made for the joy of it <span className="footer-star">✧</span>
        </span>
      </footer>

      {modal === 'help' && (
        <Modal title="How to fly" onClose={() => setModal(null)}>
          <span className="eyebrow">A FIELD GUIDE TO THE SKY</span>
          <h2>
            A little less gravity.
            <br />A little more wonder.
          </h2>
          <p className="modal-intro">
            Your skiff follows the dunes. You decide when to let go.
          </p>
          <div className="help-steps">
            <div>
              <span>
                <Icon name="dive" size={27} />
              </span>
              <div>
                <h3>Lean into the descent</h3>
                <p>
                  Hold <kbd>SPACE</kbd>, <kbd>↓</kbd>, or touch the sky to dive.
                  Hold on a downhill slope to build speed.
                </p>
              </div>
            </div>
            <div>
              <span>
                <Icon name="soar" size={27} />
              </span>
              <div>
                <h3>Let the horizon lift you</h3>
                <p>
                  Release to soar from the dunes. A clean landing on a downhill
                  slope keeps your momentum and builds your flow multiplier.
                </p>
              </div>
            </div>
            <div>
              <span>
                <Icon name="ring" size={27} />
              </span>
              <div>
                <h3>Follow the light</h3>
                <p>
                  Golden sparks and sun rings refill sunlight. Avoid dark rocks
                  and electric storms; a hit costs sunlight and breaks your
                  flow.
                </p>
              </div>
            </div>
            <div>
              <span>
                <Icon name="spark" size={27} />
              </span>
              <div>
                <h3>Become a little comet</h3>
                <p>
                  Fill your burst meter with pickups and clean landings. Burst
                  near the top of a jump to stay aloft. Press <kbd>SHIFT</kbd>,{' '}
                  <kbd>↑</kbd>, or the burst button for a rush of speed and
                  protection.
                </p>
              </div>
            </div>
          </div>
          <div className="help-note">
            <Icon name="wind" size={20} />
            <p>
              Find your rhythm in <strong>Free flight</strong>: unlimited
              sunlight, no records or rewards. Press <kbd>P</kbd> or{' '}
              <kbd>ESC</kbd> to pause any flight.
            </p>
          </div>
          <button className="button primary" onClick={() => setModal(null)}>
            The sky is yours <Icon name="arrow" size={18} />
          </button>
        </Modal>
      )}

      {modal === 'hangar' && (
        <Modal
          title="The hangar"
          className="hangar-modal"
          onClose={() => setModal(null)}
        >
          <span className="eyebrow">A SKIFF TO CALL YOUR OWN</span>
          <div className="hangar-heading">
            <h2>
              The hangar<span>.</span>
            </h2>
            <div className="hangar-bank">
              <Icon name="spark" size={19} />
              {number(progress.bank)}
              <span>LIGHT</span>
            </div>
          </div>
          <p className="modal-intro">
            A different silhouette. The same free spirit.
            <br />
            Collect light and complete challenges to make one yours.
          </p>
          <div className="ship-list">
            {SHIPS.map((ship) => {
              const owned = progress.owned.includes(ship.id)
              const selected = progress.selected === ship.id
              return (
                <div
                  className={`ship-card ${selected ? 'ship-selected' : ''}`}
                  key={ship.id}
                >
                  <div className={`ship-display ship-${ship.id}`}>
                    <ShipArt ship={ship.id} large />
                    {selected && <span className="ship-badge">YOUR SKIFF</span>}
                  </div>
                  <h3>{ship.name}</h3>
                  <p>{ship.subtitle}</p>
                  <button
                    className={`button ${selected ? 'selected-ship' : 'secondary'}`}
                    disabled={
                      selected || (!owned && progress.bank < ship.price)
                    }
                    onClick={() => selectShip(ship.id)}
                  >
                    {selected ? (
                      <>
                        <Icon name="check" size={16} />
                        Selected
                      </>
                    ) : owned ? (
                      'Select skiff'
                    ) : (
                      <>
                        <Icon
                          name={progress.bank >= ship.price ? 'spark' : 'lock'}
                          size={15}
                        />
                        {ship.price} light
                      </>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
          <p className="hangar-note">
            All skiffs fly alike. Style is the only advantage.{' '}
            {inRun && 'Your selection takes flight next run.'}
          </p>
          <div className="lifetime-stats">
            <span>
              <strong>{number(progress.totalRuns)}</strong> flights
            </span>
            <span>
              <strong>{number(progress.totalDistance / 1000)}</strong> km
              travelled
            </span>
            <span>
              <strong>
                {progress.completed.length}/{MISSIONS.length}
              </strong>{' '}
              challenges
            </span>
          </div>
        </Modal>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
