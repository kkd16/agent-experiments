import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark, Icon, Modal, ShipArt } from './components'
import { SunwakeEngine } from './game/engine'
import { renderWorld } from './game/renderer'
import { SunwakeAudio } from './game/audio'
import {
  dailySeed,
  formatTime,
  loadProgress,
  MISSIONS,
  saveProgress,
  settleRun,
  SHIPS,
} from './game/progress'
import type { Progress } from './game/progress'
import { BIOMES } from './game/types'
import type { GameMode, GameState, ShipId } from './game/types'
import { FlightStatus, FlightDebrief } from './FlightExtras'
import { FlightPreferences } from './FlightPreferences'
import { displayScale } from './game/presentation'
import { FlightInput } from './game/input'
import {
  courseFromHash,
  courseHash,
  FlightRecorder,
  GhostLibrary,
  ghostAt,
} from './game/replay'
import type { GhostRun } from './game/replay'
import {
  AtlasInvitation,
  SunAtlas,
  ExpeditionObjectives,
  ExpeditionResult,
  WakeSelector,
} from './Atlas'
import {
  EXPEDITIONS,
  expeditionById,
  expeditionFromHash,
  expeditionHash,
  routeUnlocked,
  sealCount,
} from './game/expeditions'
import { ControllerInput } from './game/controller'
import { trailById } from './game/cosmetics'
import type { TrailId } from './game/cosmetics'
import './App.css'
import './Atlas.css'

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
  const [sharedSeed, setSharedSeed] = useState(() =>
    courseFromHash(window.location.hash),
  )
  const [controls] = useState(() => new FlightInput())
  const [controller] = useState(() => new ControllerInput())
  const [controllerConnected, setControllerConnected] = useState(false)
  const [atlasSelection, setAtlasSelection] = useState(
    () =>
      expeditionFromHash(window.location.hash)?.id ??
      EXPEDITIONS.find((route) => !(progress.expeditions[route.id]?.medals & 1))
        ?.id ??
      EXPEDITIONS[0].id,
  )
  const [ghosts] = useState(() => new GhostLibrary())
  const ghostRef = useRef<GhostRun | null>(null)
  const recorderRef = useRef(new FlightRecorder())
  const [ghostRun, setGhostRun] = useState<GhostRun | null>(null)
  const [flightTrace, setFlightTrace] = useState<GhostRun | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const progressRef = useRef(progress)
  const [engine] = useState(
    () =>
      new SunwakeEngine({
        mode: 'voyage',
        ship: progress.selected,
        seed: sharedSeed ?? 92847,
        trail: progress.trail,
      }),
  )
  const [audio] = useState(() => new SunwakeAudio())
  const [view, setView] = useState(() => snapshot(engine.state))
  const [mode, setMode] = useState<GameMode>('voyage')
  const [modal, setModal] = useState<
    'help' | 'hangar' | 'log' | 'share' | 'atlas' | 'settings' | null
  >(() => (expeditionFromHash(window.location.hash) ? 'atlas' : null))
  const [result, setResult] = useState<ReturnType<typeof settleRun> | null>(
    null,
  )
  const [notice, setNotice] = useState(() =>
    (window.location.hash.startsWith('#/course/') &&
      courseFromHash(window.location.hash) === null) ||
    (window.location.hash.startsWith('#/expedition/') &&
      !expeditionFromHash(window.location.hash))
      ? 'This course link is unsupported. Choose a new Voyage below.'
      : '',
  )
  const [storageAvailable, setStorageAvailable] = useState(true)
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const wakeRef = useRef(() => {})
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pauseReason, setPauseReason] = useState('')
  const reducedMotion =
    progress.motion === 'reduced' ||
    (progress.motion === 'system' && systemReducedMotion)
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

  const pause = useCallback(
    (reason = '') => {
      controls.clear()
      engine.pause()
      audio.update(engine.state)
      setPauseReason(reason)
      setView(snapshot(engine.state))
      wakeRef.current()
    },
    [audio, controls, engine],
  )

  const startRun = useCallback(
    (options?: { seed?: number; mode?: GameMode; expeditionId?: string }) => {
      const date = today()
      runDateRef.current = date
      const route = expeditionById(
        options?.expeditionId ??
          (mode === 'expedition' && !options?.mode
            ? engine.state.expeditionId
            : null),
      )
      if (route && !routeUnlocked(route.id, progressRef.current.expeditions)) {
        setAtlasSelection(route.id)
        setModal('atlas')
        return
      }
      const runMode = route
        ? 'expedition'
        : (options?.mode ?? (mode === 'expedition' ? 'voyage' : mode))
      const seed = route
        ? route.seed
        : runMode === 'daily'
          ? dailySeed(date)
          : (options?.seed ?? sharedSeed ?? randomSeed())
      setMode(runMode)
      engine.reset({
        mode: runMode,
        ship: progressRef.current.selected,
        seed,
        expeditionId: route?.id,
        trail: progressRef.current.trail,
      })
      if (route) setAtlasSelection(route.id)
      recorderRef.current = new FlightRecorder()
      recorderRef.current.record(engine.state)
      const ghost =
        runMode === 'zen' || runMode === 'expedition' ? null : ghosts.get(seed)
      ghostRef.current = ghost
      setGhostRun(ghost)
      setFlightTrace(null)
      setModal(null)
      controls.clear()
      settledRef.current = false
      setResult(null)
      setPauseReason('')
      setRunMissions(
        MISSIONS.filter(
          (mission) => !progressRef.current.completed.includes(mission.id),
        ).slice(0, 3),
      )
      engine.start()
      audio.setEnabled(progressRef.current.sound)
      void audio.unlock()
      setView(snapshot(engine.state))
      wakeRef.current()
    },
    [audio, controls, engine, ghosts, mode, sharedSeed],
  )

  const retryRun = useCallback(
    () =>
      startRun({
        seed: engine.state.seed,
        mode: engine.state.mode,
        expeditionId: engine.state.expeditionId ?? undefined,
      }),
    [engine, startRun],
  )

  const resume = useCallback(() => {
    controls.clear()
    engine.resume()
    void audio.unlock()
    setPauseReason('')
    setView(snapshot(engine.state))
    wakeRef.current()
  }, [audio, controls, engine])

  const goHome = () => {
    const homeMode = mode === 'expedition' ? 'voyage' : mode
    setMode(homeMode)
    if (mode === 'expedition') {
      setSharedSeed(null)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      )
    }
    engine.reset({
      mode: homeMode,
      ship: progressRef.current.selected,
      seed:
        mode === 'daily'
          ? dailySeed(today())
          : mode === 'expedition'
            ? 92847
            : (sharedSeed ?? 92847),
      trail: progressRef.current.trail,
    })
    controls.clear()
    setResult(null)
    setGhostRun(null)
    ghostRef.current = null
    setView(snapshot(engine.state))
  }

  const selectMode = (next: GameMode) => {
    setMode(next)
    setSharedSeed(null)
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    )
    engine.reset({
      mode: next,
      ship: progress.selected,
      seed: next === 'daily' ? dailySeed(today()) : 92847,
      trail: progress.trail,
    })
    setView(snapshot(engine.state))
  }

  const openModal = (
    next: 'help' | 'hangar' | 'log' | 'share' | 'atlas' | 'settings',
  ) => {
    if (engine.state.phase === 'running') pause()
    setModal(next)
  }

  const toggleSound = useCallback(() => {
    const enabled = !progressRef.current.sound
    audio.setEnabled(enabled)
    void audio.unlock()
    commitProgress({ ...progressRef.current, sound: enabled })
  }, [audio, commitProgress])

  const selectShip = (id: ShipId) => {
    const ship = SHIPS.find((item) => item.id === id)!
    const current = progressRef.current
    const owned = current.owned.includes(id)
    if (!owned && ship.seals && sealCount(current.expeditions) < ship.seals)
      return
    if (!owned && current.bank < ship.price) return
    const next = {
      ...current,
      bank: current.bank - (owned ? 0 : ship.price),
      owned: owned ? current.owned : [...current.owned, id],
      selected: id,
    }
    commitProgress(next)
    if (engine.state.phase === 'ready') {
      engine.reset({
        mode,
        ship: id,
        seed: engine.state.seed,
        trail: current.trail,
      })
      setView(snapshot(engine.state))
    }
  }

  const selectTrail = (id: TrailId) => {
    if (trailById(id).seals > sealCount(progressRef.current.expeditions)) return
    commitProgress({ ...progressRef.current, trail: id })
    if (engine.state.phase === 'ready') {
      engine.reset({
        mode,
        ship: progressRef.current.selected,
        seed: engine.state.seed,
        trail: id,
      })
      setView(snapshot(engine.state))
    }
  }

  const shareCourse = async () => {
    const url = new URL(window.location.href)
    url.hash = engine.state.expeditionId
      ? expeditionHash(engine.state.expeditionId)
      : courseHash(engine.state.seed)
    setShareUrl(url.href)
    if (engine.state.phase === 'running') pause()
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(url.href)
      setNotice(
        engine.state.expeditionId
          ? 'Expedition link copied. Find it in the Sun Atlas.'
          : 'Course link copied. Anyone can fly the same dunes.',
      )
    } catch {
      setModal('share')
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
    const navigate = () => {
      const route = expeditionFromHash(window.location.hash)
      if (route) {
        controls.clear()
        engine.pause()
        setAtlasSelection(route.id)
        setModal('atlas')
        setView(snapshot(engine.state))
        return
      }
      const seed = courseFromHash(window.location.hash)
      if (
        seed === null &&
        (window.location.hash.startsWith('#/course/') ||
          window.location.hash.startsWith('#/expedition/'))
      ) {
        setNotice('This course link is unsupported. Choose a new Voyage below.')
        return
      }
      controls.clear()
      setSharedSeed(seed)
      setMode('voyage')
      engine.reset({
        mode: 'voyage',
        ship: progressRef.current.selected,
        seed: seed ?? 92847,
        trail: progressRef.current.trail,
      })
      ghostRef.current = null
      setGhostRun(null)
      setResult(null)
      setModal(null)
      setView(snapshot(engine.state))
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [controls, engine])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setSystemReducedMotion(query.matches)
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
    let frame = 0
    let timer = 0
    let dirty = true
    let visible = true
    let previous = performance.now()
    let lastDraw = -Infinity
    let lastHud = 0
    let connected: boolean | null = null

    const cancel = () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frame = 0
      timer = 0
    }
    const wake = () => {
      cancel()
      dirty = true
      previous = performance.now()
      if (!document.hidden) frame = requestAnimationFrame(tick)
    }
    wakeRef.current = wake

    const resize = () => {
      const bounds = host.getBoundingClientRect()
      const scale = displayScale(
        bounds.width,
        bounds.height,
        window.devicePixelRatio,
        progress.detail,
      )
      if (width === bounds.width && height === bounds.height && dpr === scale)
        return
      width = bounds.width
      height = bounds.height
      dpr = scale
      const pixelsWide = Math.max(1, Math.round(width * dpr))
      const pixelsHigh = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelsWide) canvas.width = pixelsWide
      if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh
      wake()
    }
    const pollController = () => {
      let pads: (Gamepad | null)[] = []
      try {
        pads = Array.from(navigator.getGamepads?.() ?? [])
      } catch {
        /* Optional browser capability. */
      }
      const pad = controller.read(pads)
      if (connected !== pad.connected) {
        connected = pad.connected
        setControllerConnected(connected)
      }
      if (pad.disconnected && engine.state.phase === 'running') {
        pause(
          'Your controller disconnected. Reconnect it or use the keyboard to continue.',
        )
        return
      }
      if (!modal && !document.hidden && document.hasFocus()) {
        if (pad.pause) {
          if (engine.state.phase === 'running') pause()
          else if (engine.state.phase === 'paused') resume()
        } else if (pad.start && engine.state.phase === 'ready') startRun()
        else if (pad.start && engine.state.phase === 'ended') retryRun()
        controls.set(
          'dive',
          'gamepad',
          engine.state.phase === 'running' && pad.dive,
        )
        controls.set(
          'boost',
          'gamepad',
          engine.state.phase === 'running' && pad.boost,
        )
      } else controls.release('gamepad')
    }
    function tick(now: number) {
      frame = 0
      timer = 0
      // One clock owns input, simulation, sound, and drawing. Idle screens only
      // poll a controller; hidden tabs do not schedule any work.
      const dt = Math.min(Math.max(0, (now - previous) / 1000), 0.1)
      previous = now
      if (document.hidden) return
      pollController()
      const active = visible && !modal
      if (active) engine.step(dt, controls.value(now))
      if (engine.state.phase === 'running')
        recorderRef.current.record(engine.state)
      audio.update(engine.state)
      const running = engine.state.phase === 'running'
      const ambient = engine.state.phase === 'ready' && !reducedMotion
      if (
        visible &&
        (dirty || (active && (running || (ambient && now - lastDraw >= 32))))
      ) {
        context!.setTransform(dpr, 0, 0, dpr, 0, 0)
        const scene = engine.presentation()
        renderWorld(
          context!,
          scene,
          width,
          height,
          now / 1000,
          reducedMotion,
          scene.mode === 'daily' &&
            progressRef.current.daily.date === runDateRef.current
            ? progressRef.current.daily.best
            : progressRef.current.best,
          progressRef.current.ghost
            ? ghostAt(ghostRef.current, scene.time)
            : null,
        )
        dirty = false
        lastDraw = now
      }
      if (engine.state.phase === 'ended' && !settledRef.current) {
        settledRef.current = true
        controls.clear()
        const trace = recorderRef.current.finish(engine.state)
        ghosts.remember(trace, engine.state.mode)
        setFlightTrace(trace)
        const settled = settleRun(
          progressRef.current,
          engine.state,
          runDateRef.current,
        )
        commitProgress(settled.progress)
        setResult(settled)
        setView(snapshot(engine.state))
      } else if (running && now - lastHud > 90) {
        setView(snapshot(engine.state))
        lastHud = now
      }
      // An input edge may have called wake() during this tick. Keep one callback.
      cancel()
      if (active && running) frame = requestAnimationFrame(tick)
      else if (active && ambient) {
        timer = window.setTimeout(() => {
          frame = requestAnimationFrame(tick)
        }, 24)
      } else timer = window.setTimeout(() => tick(performance.now()), 100)
    }
    const visibility = () => {
      if (document.hidden) {
        if (engine.state.phase === 'running')
          pause('Your flight waited while you were away.')
        controls.clear()
        cancel()
      } else wake()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    const intersection = new IntersectionObserver(([entry]) => {
      const nextVisible = entry.isIntersecting
      if (visible === nextVisible) return
      visible = nextVisible
      if (!visible && engine.state.phase === 'running')
        pause('Your flight paused while the horizon was out of view.')
      wake()
    })
    intersection.observe(host)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', resize)
    window.addEventListener('gamepadconnected', wake)
    window.addEventListener('gamepaddisconnected', wake)
    resize()
    wake()
    return () => {
      cancel()
      observer.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', resize)
      window.removeEventListener('gamepadconnected', wake)
      window.removeEventListener('gamepaddisconnected', wake)
      controls.release('gamepad')
      wakeRef.current = () => {}
    }
  }, [
    audio,
    commitProgress,
    controller,
    controls,
    engine,
    ghosts,
    modal,
    pause,
    progress.detail,
    reducedMotion,
    resume,
    retryRun,
    startRun,
  ])

  useEffect(() => {
    wakeRef.current()
    if (modal) return
    const stage = stageRef.current
    if (view.phase === 'paused') {
      stage
        ?.querySelector<HTMLButtonElement>('.pause-card .primary')
        ?.focus({ preventScroll: true })
      return
    }
    if (view.phase !== 'running') return
    const bounds = stage?.getBoundingClientRect()
    if (bounds && (bounds.top < 0 || bounds.bottom > window.innerHeight)) {
      stage?.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
    canvasRef.current?.focus({ preventScroll: true })
  }, [view.phase, view.seed, view.ship, view.trail, modal])

  useEffect(() => {
    const changed = () => {
      const fullscreen = document.fullscreenElement === stageRef.current
      setIsFullscreen(fullscreen)
      if (!fullscreen && engine.state.phase === 'running')
        pause('Fullscreen closed. Your flight is waiting here.')
      if (!fullscreen)
        stageRef.current?.scrollIntoView({
          block: 'center',
          behavior: 'instant',
        })
      wakeRef.current()
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [engine, pause])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement
      if (target.closest('input, select, textarea, [contenteditable=true]'))
        return
      if (event.code === 'KeyM' && !event.repeat) {
        toggleSound()
        return
      }
      if (modal) return
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
        if (engine.state.phase === 'ready') startRun()
        else if (engine.state.phase === 'ended') retryRun()
        if (engine.state.phase === 'running')
          controls.set('dive', event.code, true)
      }
      if (
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight' ||
        event.code === 'ArrowUp'
      ) {
        if (engine.state.phase === 'running' && !target.closest('button, a'))
          controls.set('boost', event.code, true)
      }
      if (event.code === 'Escape' || event.code === 'KeyP') {
        if (engine.state.phase === 'running') pause()
        else if (engine.state.phase === 'paused') resume()
      }
      if (
        event.code === 'KeyR' &&
        (engine.state.phase === 'ended' || engine.state.phase === 'paused')
      )
        retryRun()
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.code === 'ArrowDown')
        controls.release(event.code)
      if (
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight' ||
        event.code === 'ArrowUp'
      )
        controls.release(event.code)
    }
    const blur = () => {
      if (engine.state.phase === 'running')
        pause('Your flight waited while you were away.')
      controls.clear()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [controls, engine, modal, pause, resume, startRun, retryRun, toggleSound])

  useEffect(() => () => audio.dispose(), [audio])

  const playing = view.phase === 'running'
  const inRun = playing || view.phase === 'paused'
  const biome = BIOMES[view.biome % BIOMES.length]
  const activeRoute = expeditionById(view.expeditionId)
  const seals = sealCount(progress.expeditions)
  const nextRoute = activeRoute
    ? EXPEDITIONS[EXPEDITIONS.indexOf(activeRoute) + 1]
    : null
  const nextMissions =
    view.phase === 'ready' || view.phase === 'ended'
      ? MISSIONS.filter((m) => !progress.completed.includes(m.id)).slice(0, 3)
      : runMissions
  const lastEvent = [...view.events]
    .filter((event) => event.kind !== 'spark' && view.time - event.time < 2.2)
    .sort((a, b) => {
      const priority = (kind: string) =>
        kind === 'hit'
          ? 6
          : ['checkpoint', 'biome', 'chain'].includes(kind)
            ? 5
            : ['power', 'perfect'].includes(kind)
              ? 3
              : 1
      return priority(b.kind) - priority(a.kind) || b.time - a.time
    })[0]
  const boostReady = view.player.charge >= 65 && view.player.boostTime <= 0
  const ghostPosition = progress.ghost ? ghostAt(ghostRun, view.time) : null
  const ghostDelta = ghostPosition
    ? (view.player.x - ghostPosition.x) / 10
    : null
  const modeDescription =
    MODES.find((item) => item.id === mode)?.description ?? activeRoute?.subtitle

  return (
    <div className={`app-shell ${reducedMotion ? 'reduced-motion' : ''}`}>
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
          <button
            className="icon-button log-button"
            onClick={() => openModal('log')}
            aria-label="Open flight log"
          >
            <Icon name="journal" size={19} />
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
          <span>SIX EXPEDITIONS · ONE ENDLESS HORIZON</span>
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
              if (
                engine.state.phase !== 'running' ||
                (event.pointerType === 'mouse' && event.button !== 0)
              )
                return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
              event.currentTarget.setPointerCapture(event.pointerId)
              controls.set('dive', `pointer-${event.pointerId}`, true)
            }}
            onPointerUp={(event) =>
              controls.release(`pointer-${event.pointerId}`)
            }
            onPointerCancel={(event) =>
              controls.release(`pointer-${event.pointerId}`)
            }
            onLostPointerCapture={(event) =>
              controls.release(`pointer-${event.pointerId}`)
            }
            onContextMenu={(event) => event.preventDefault()}
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
              {activeRoute && (
                <span className="daily-tag expedition-tag">
                  {activeRoute.name}
                </span>
              )}
            </div>
            <div className="world-tools">
              <button
                className="stage-icon"
                aria-label="Flight settings"
                title="Flight settings"
                onClick={() => openModal('settings')}
              >
                <Icon name="settings" size={18} />
              </button>
              {inRun && (
                <button
                  className="stage-icon"
                  aria-label={playing ? 'Pause flight' : 'Resume flight'}
                  onClick={() => (playing ? pause() : resume())}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={18} />
                </button>
              )}
              <button
                className="stage-icon"
                aria-label={
                  isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'
                }
                title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                aria-pressed={isFullscreen}
                onClick={() => void fullscreen()}
              >
                <Icon name={isFullscreen ? 'collapse' : 'expand'} size={17} />
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
                onClick={() => startRun()}
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
              <p className="mode-description">
                {sharedSeed
                  ? `Shared course · ${sharedSeed.toString(36).toUpperCase()}`
                  : modeDescription}
              </p>
              {sharedSeed && (
                <button
                  className="clear-course"
                  onClick={() => selectMode('voyage')}
                >
                  Return to random skies
                </button>
              )}
              {mode === 'daily' && (
                <p className="daily-best">
                  {today()} · Your daily best:{' '}
                  {number(
                    progress.daily.date === today() ? progress.daily.best : 0,
                  )}{' '}
                  m
                </p>
              )}
              <button
                className="atlas-shortcut"
                onClick={() => openModal('atlas')}
              >
                <Icon name="map" size={16} /> Six expeditions await{' '}
                <Icon name="arrow" size={14} />
              </button>
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
                <div
                  className={`sunlight-readout ${view.player.energy < 23 ? 'low-sun' : ''}`}
                >
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
                      : view.player.energy < 23
                        ? 'Sunlight fading · follow the gold'
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
              <FlightStatus
                state={view}
                coach={progress.coach}
                ghostDelta={ghostDelta}
              />
              <div className="flight-bottom">
                <div className="speed-readout">
                  <Icon name="wind" size={20} />
                  <strong>{Math.round(view.player.vx * 0.36)}</strong>
                  <span>km/h</span>
                </div>
                <div className="touch-dive">
                  <button
                    aria-label="Hold to dive, release to soar"
                    className={`dive-button ${view.diving ? 'is-held' : ''}`}
                    aria-pressed={view.diving}
                    disabled={!playing}
                    onKeyDown={(event) => {
                      if (event.code === 'Space' || event.code === 'Enter') {
                        event.preventDefault()
                        controls.set('dive', `button-${event.code}`, true)
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.code === 'Space' || event.code === 'Enter') {
                        event.preventDefault()
                        controls.release(`button-${event.code}`)
                      }
                    }}
                    onBlur={() => {
                      controls.release('button-Space')
                      controls.release('button-Enter')
                    }}
                    onPointerDown={(event) => {
                      if (
                        engine.state.phase !== 'running' ||
                        (event.pointerType === 'mouse' && event.button !== 0)
                      )
                        return
                      event.preventDefault()
                      event.currentTarget.setPointerCapture(event.pointerId)
                      controls.set('dive', `pointer-${event.pointerId}`, true)
                    }}
                    onPointerUp={(event) =>
                      controls.release(`pointer-${event.pointerId}`)
                    }
                    onPointerCancel={(event) =>
                      controls.release(`pointer-${event.pointerId}`)
                    }
                    onLostPointerCapture={(event) =>
                      controls.release(`pointer-${event.pointerId}`)
                    }
                  >
                    <Icon name="dive" /> HOLD TO DIVE
                  </button>
                </div>
                <button
                  className={`burst-button ${boostReady && playing ? 'charged' : ''}`}
                  disabled={!boostReady || !playing}
                  onClick={() => {
                    controls.pulse(performance.now())
                    canvasRef.current?.focus({ preventScroll: true })
                  }}
                  aria-label={
                    view.player.boostTime > 0
                      ? `Solar burst active, ${view.player.boostTime.toFixed(1)} seconds remaining`
                      : boostReady
                        ? 'Solar burst ready'
                        : `Solar burst charging, ${Math.min(100, Math.round((view.player.charge / 65) * 100))}%`
                  }
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
                      ? `BURST · ${view.player.boostTime.toFixed(1)}s`
                      : boostReady
                        ? 'SOLAR BURST'
                        : `CHARGE · ${Math.min(100, Math.round((view.player.charge / 65) * 100))}%`}
                  </span>
                  <kbd>SHIFT</kbd>
                </button>
              </div>
            </>
          )}

          {view.phase === 'paused' && (
            <div className="stage-overlay paused-overlay">
              <div
                className="pause-card"
                role="region"
                aria-label="Flight paused"
              >
                <span className="eyebrow">A MOMENT IN THE SUN</span>
                <h2>
                  The horizon <br />
                  can wait.
                </h2>
                <p>Your flight is paused at {number(view.distance)} m.</p>
                {pauseReason && (
                  <p className="pause-reason" role="status">
                    {pauseReason}
                  </p>
                )}
                <button className="button primary" onClick={resume}>
                  <Icon name="play" size={17} /> Keep flying
                </button>
                <button
                  className="quiet-button restart-route"
                  onClick={retryRun}
                >
                  <Icon name="restart" size={14} /> Restart this route{' '}
                  <kbd>R</kbd>
                </button>
                <button
                  className="quiet-button"
                  onClick={() => {
                    engine.finish()
                    wakeRef.current()
                  }}
                >
                  End this flight
                </button>
              </div>
            </div>
          )}

          {view.phase === 'ended' && result && (
            <div className="stage-overlay results-overlay">
              <div
                className={`results-card ${activeRoute ? 'expedition-results-card' : ''}`}
                role="region"
                aria-label="Flight results"
                aria-live="polite"
              >
                <div className="result-kicker">
                  <Icon name={result.newBest ? 'flag' : 'sun'} size={18} />
                  {activeRoute
                    ? activeRoute.name.toUpperCase()
                    : result.newBest
                      ? 'A NEW PERSONAL HORIZON'
                      : mode === 'zen'
                        ? 'A LITTLE TIME WELL SPENT'
                        : 'EVERY FLIGHT IS A NEW STORY'}
                </div>
                <h2>
                  {activeRoute
                    ? view.arrived
                      ? 'Beacon reached.'
                      : 'The route is waiting.'
                    : result.newBest
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
                {result.expedition ? (
                  <ExpeditionResult
                    state={view}
                    {...result.expedition}
                    onHangar={() => openModal('hangar')}
                  />
                ) : (
                  <FlightDebrief state={view} trace={flightTrace} />
                )}
                <div className="result-buttons">
                  <button
                    className="button primary"
                    onClick={() =>
                      activeRoute && view.arrived
                        ? nextRoute
                          ? startRun({ expeditionId: nextRoute.id })
                          : openModal('atlas')
                        : startRun()
                    }
                  >
                    {activeRoute
                      ? view.arrived
                        ? nextRoute
                          ? 'Next expedition'
                          : 'Back to the atlas'
                        : 'Try expedition again'
                      : 'One more horizon'}{' '}
                    <Icon name="arrow" size={18} />
                  </button>
                  <button className="button secondary" onClick={goHome}>
                    Back to shore
                  </button>
                </div>
                <div className="replay-actions">
                  <button onClick={retryRun}>
                    <Icon name={activeRoute ? 'restart' : 'ghost'} size={15} />
                    {activeRoute
                      ? 'Retry this expedition'
                      : mode === 'zen'
                        ? 'Fly this route again'
                        : 'Race this route'}
                  </button>
                  <button onClick={() => void shareCourse()}>
                    <Icon name="share" size={14} />
                    Copy course link
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
          {notice && isFullscreen && (
            <div className="notice stage-notice" role="status">
              {notice}
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

        {controllerConnected && (
          <p className="controller-connected">
            <Icon name="controller" size={18} /> Controller ready{' '}
            <span>A / RT dive · B / X burst · Menu pause</span>
          </p>
        )}
        <AtlasInvitation
          records={progress.expeditions}
          onOpen={() => openModal('atlas')}
        />

        {activeRoute && view.phase !== 'ready' ? (
          <ExpeditionObjectives state={view} route={activeRoute} />
        ) : (
          <section className="missions-section" aria-label="Flight challenges">
            <div className="section-heading">
              <div>
                <span className="eyebrow">SMALL WINS. BIG ADVENTURES.</span>
                <h2>
                  Your next horizons<span>.</span>
                </h2>
              </div>
              <button
                className="hangar-link"
                onClick={() => openModal('hangar')}
              >
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
                        <div
                          className="mission-meter"
                          role="progressbar"
                          aria-label={mission.title}
                          aria-valuenow={Math.floor(value)}
                          aria-valuemin={0}
                          aria-valuemax={mission.target}
                        >
                          <i
                            style={{
                              width: `${(value / mission.target) * 100}%`,
                            }}
                          />
                        </div>
                        {inRun && mode !== 'zen' && (
                          <span className="mission-count">
                            {Math.floor(value)} / {mission.target}
                          </span>
                        )}
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
        )}

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

      {modal === 'atlas' && (
        <SunAtlas
          records={progress.expeditions}
          initialId={atlasSelection}
          onClose={() => setModal(null)}
          onEmbark={(id) => startRun({ expeditionId: id })}
        />
      )}
      {modal === 'settings' && (
        <Modal
          title="Flight settings"
          className="settings-modal"
          onClose={() => setModal(null)}
        >
          <span className="eyebrow">YOUR OWN KIND OF FLIGHT</span>
          <h2>
            A little more
            <br />
            your speed.
          </h2>
          <p className="modal-intro">Tune the sights, sounds, and guidance.</p>
          <FlightPreferences
            progress={progress}
            onChange={commitProgress}
            onSound={toggleSound}
          />
          <button
            className="button primary"
            onClick={() => {
              setModal(null)
              if (engine.state.phase === 'paused') resume()
            }}
          >
            {inRun ? 'Keep flying' : 'Back to the sky'}{' '}
            <Icon name="arrow" size={18} />
          </button>
        </Modal>
      )}

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
          <div className="finds-guide">
            <h3>A few gifts from the sky</h3>
            <div>
              <span>
                <Icon name="shield" size={21} />
                <b>Sun shield</b>
                <small>Absorbs one hit. Keeps your flow.</small>
              </span>
              <span>
                <Icon name="magnet" size={21} />
                <b>Light magnet</b>
                <small>Draws nearby sparks toward you.</small>
              </span>
              <span>
                <Icon name="wind" size={21} />
                <b>Rising thermals</b>
                <small>Release inside the arrows to ride the lift.</small>
              </span>
              <span>
                <Icon name="ring" size={21} />
                <b>Sky chains</b>
                <small>
                  Link three rings within nine seconds without missing one for a
                  magnet and bonus.
                </small>
              </span>
            </div>
          </div>
          <FlightPreferences
            progress={progress}
            onChange={commitProgress}
            onSound={toggleSound}
          />
          <div className="controller-guide">
            <Icon name="controller" size={26} />
            <div>
              <h3>Bring a controller.</h3>
              <p>
                On a standard Xbox or PlayStation controller: hold the bottom
                face button or right trigger to dive; the right or left face
                button bursts. Menu pauses and resumes. Press the bottom button
                on the welcome screen to launch, or on the results screen to
                retry the same route.
              </p>
              <small>
                {controllerConnected
                  ? 'Controller connected and ready.'
                  : 'Connect a controller, then press a button to wake it.'}{' '}
                Disconnecting pauses your flight.
              </small>
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

      {modal === 'log' && (
        <Modal
          title="Flight log"
          className="log-modal"
          onClose={() => setModal(null)}
        >
          <span className="eyebrow">EVERY HORIZON LEAVES A TRACE</span>
          <h2>
            Your flight log<span>.</span>
          </h2>
          <p className="modal-intro">
            Your last twelve journeys. Revisit a course, find a better line.
          </p>
          <div className="log-summary">
            <div>
              <strong>
                {number(progress.best)}
                <small> m</small>
              </strong>
              <span>FURTHEST FLIGHT</span>
            </div>
            <div>
              <strong>{number(progress.bestScore)}</strong>
              <span>BEST SCORE</span>
            </div>
            <div>
              <strong>
                {progress.completed.length}
                <small> / {MISSIONS.length}</small>
              </strong>
              <span>CHALLENGES</span>
            </div>
          </div>
          {progress.history.length === 0 ? (
            <div className="log-empty">
              <Icon name="journal" size={32} />
              <h3>The first page is yours.</h3>
              <p>Finish a flight to start your collection of horizons.</p>
            </div>
          ) : (
            <div className="flight-log-list">
              {progress.history.map((run) => (
                <div className="flight-log-row" key={run.id}>
                  <span className={`log-mode log-${run.mode}`}>
                    <Icon
                      name={
                        run.mode === 'daily'
                          ? 'sun'
                          : run.mode === 'zen'
                            ? 'wind'
                            : 'flag'
                      }
                      size={18}
                    />
                  </span>
                  <div>
                    <strong>
                      {number(run.distance)} <small>m</small>
                    </strong>
                    <p>
                      {run.mode === 'daily'
                        ? 'Daily flight'
                        : run.mode === 'expedition'
                          ? expeditionById(run.expeditionId)?.name
                          : run.mode === 'zen'
                            ? 'Free flight'
                            : 'Voyage'}{' '}
                      · {run.date} · {formatTime(run.duration)}
                    </p>
                  </div>
                  <span className="log-score">
                    {number(run.score)}
                    <small>POINTS</small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`Replay ${number(run.distance)} meter course`}
                    title="Replay this course"
                    onClick={() =>
                      startRun({
                        seed: run.seed,
                        mode:
                          run.mode === 'zen'
                            ? 'zen'
                            : run.mode === 'expedition'
                              ? 'expedition'
                              : 'voyage',
                        expeditionId: run.expeditionId,
                      })
                    }
                  >
                    <Icon name="restart" size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="log-note">
            Replays use the original course. Your best ghost is kept for your
            four most recent improved courses. Past daily courses replay as
            Voyages.
          </p>
        </Modal>
      )}
      {modal === 'share' && (
        <Modal title="Share this course" onClose={() => setModal(null)}>
          <span className="eyebrow">A HORIZON WORTH SHARING</span>
          <h2>
            Same dunes.
            <br />A different story.
          </h2>
          <p className="modal-intro">
            Copy this link to challenge a friend to the same course. Your
            records and ghost stay on your device.
          </p>
          <label className="share-field">
            COURSE LINK
            <input
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button className="button primary" onClick={() => setModal(null)}>
            Back to the sky <Icon name="arrow" size={18} />
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
                      selected ||
                      (!owned &&
                        (progress.bank < ship.price ||
                          Boolean(ship.seals && seals < ship.seals)))
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
                    ) : ship.seals ? (
                      <>
                        <Icon name="seal" size={15} /> {ship.seals} atlas seals
                      </>
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
          <WakeSelector
            seals={seals}
            selected={progress.trail}
            onSelect={selectTrail}
          />
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
      {notice && !isFullscreen && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
