import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Compass, Copy, Flower2, Grid2X2, Headphones, Leaf, Lightbulb, Maximize, Moon, RotateCcw, Settings2, Shuffle, Sparkles, Sprout, Sun, Trophy, Undo2, Volume2, VolumeX, WandSparkles, Wind, X } from 'lucide-react'
import Board from './Board'
import { CHAPTERS, LEVELS, dailyLevel, generateLevel, getHint, rotateTile, simulate } from './game'
import type { Level, Tile } from './game'
import { exportProgress, importProgress, loadProgress, saveProgress } from './progress'
import type { Progress } from './progress'
import { GardenAudio } from './audio'
import './App.css'

type Page = 'play' | 'atlas' | 'daily' | 'workshop' | 'journal'
type Modal = 'guide' | 'settings' | 'achievements' | null
type Snapshot = { tiles: Tile[]; moves: number }
type Session = Snapshot & { level: Level; history: Snapshot[]; hints: number; hintId: string | null; hintRotation: number | null; won: boolean }
const SESSION_KEY = 'lumen-garden-session-v1'
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI']
const MECHANICS = ['Light & turns', 'Branching paths', 'Rooted stones', 'One-way gates', 'Woven channels', 'Paired portals']
const today = () => new Date().toISOString().slice(0, 10)
const countCompleted = (progress: Progress) => LEVELS.filter(level => progress.completed[level.id]).length

function makeSession(level: Level, restore = false): Session {
  const base: Session = { level, tiles: level.tiles.map(tile => ({ ...tile })), moves: 0, history: [], hints: 0, hintId: null, hintRotation: null, won: false }
  if (restore) {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
      if (saved?.id === level.id && Array.isArray(saved.rotations) && saved.rotations.length === level.tiles.length && saved.rotations.every((n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 3) && Number.isInteger(saved.moves) && saved.moves >= 0 && Number.isInteger(saved.hints) && saved.hints >= 0) {
        base.tiles = base.tiles.map((tile, i) => ({ ...tile, rotation: tile.fixed || ['source', 'crystal', 'rock'].includes(tile.kind) ? tile.rotation : saved.rotations[i] }))
        base.moves = saved.moves
        base.hints = saved.hints
        base.won = simulate(base.tiles).solved
      }
    } catch { /* A damaged session must never prevent a fresh garden. */ }
  }
  return base
}

function parseRoute(hash: string, progress: Progress): { page: Page; level: Level } {
  const parts = hash.replace(/^#\/?/, '').split('/')
  const fallback = LEVELS.find(level => level.id === progress.currentLevel) || LEVELS[0]
  if (parts[0] === 'daily') return { page: 'daily', level: dailyLevel(/^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : today()) }
  if (parts[0] === 'seed') {
    const seed = /^\d{1,10}$/.test(parts[1] || '') ? Number(parts[1]) >>> 0 : 108
    const chapter = /^[0-5]$/.test(parts[2] || '') ? Number(parts[2]) : 0
    return { page: 'play', level: generateLevel(seed, chapter) }
  }
  if (['atlas', 'workshop', 'journal'].includes(parts[0])) return { page: parts[0] as Page, level: fallback }
  return { page: 'play', level: LEVELS.find(level => level.id === parts[1]) || fallback }
}

function Sigil({ chapter = 0, className = '' }: { chapter?: number; className?: string }) {
  return <svg viewBox="0 0 100 100" fill="none" className={`sigil ${className}`} aria-hidden="true">
    <circle cx="50" cy="50" r="38" stroke="currentColor" strokeWidth=".6" opacity=".35" />
    <circle cx="50" cy="50" r="29" stroke="currentColor" strokeWidth=".6" opacity=".3" strokeDasharray="2 5" />
    {Array.from({ length: 4 + chapter }, (_, i) => <g key={i} transform={`rotate(${i * 360 / (4 + chapter)} 50 50)`}><path d="M50 50C29 31 34 19 50 13C66 29 60 38 50 50Z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity=".045" /><path d="M50 50V14" stroke="currentColor" strokeWidth=".5" opacity=".5" /></g>)}
    <path d="m50 37 8 13-8 13-8-13Z" fill="currentColor" fillOpacity=".85" /><circle cx="50" cy="5" r="1.5" fill="currentColor" /><circle cx="50" cy="95" r="1.5" fill="currentColor" />
  </svg>
}

function Blooms({ count, className = '' }: { count: number; className?: string }) {
  return <span className={`blooms ${className}`} aria-label={`${count} of 3 blooms`}>{[1, 2, 3].map(n => <Flower2 key={n} size={17} className={n <= count ? 'filled' : ''} />)}</span>
}

function SettingRow({ title, description, enabled, onToggle, icon }: { title: string; description: string; enabled: boolean; onToggle: () => void; icon: ReactNode }) {
  return <div className="setting-row">{icon}<div><strong>{title}</strong><p>{description}</p></div><button role="switch" aria-checked={enabled} aria-label={title} onClick={onToggle} className={`switch ${enabled ? 'on' : ''}`}><span /></button></div>
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = ref.current
    element?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !element) return
      const items = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]'))
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', trap); document.body.style.overflow = oldOverflow; previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <header className="dialog-header"><div><span className="eyebrow">THE GARDENER’S COMPANION</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></header>
      {children}
    </div>
  </div>
}

const memories = [
  ['The first keeper', 'Before there were roads between the stars, there were gardens. Their keepers left a light burning for anyone who had lost their way. You have found the first.'],
  ['What light remembers', 'The gardener never planted a seed alone. One light became two; two became a thousand. Here, generosity was a kind of architecture.'],
  ['The patient stones', 'Some stones have stood in the same place for centuries. Do not ask them to move. Listen to the shape of the space they leave you.'],
  ['A river only forward', 'A traveler asked the keeper how to go back. She offered a seed instead. Some paths only open when we stop looking behind us.'],
  ['Almost touching', 'Two rivers of light cross without meeting. Perhaps this is what it means to share a sky: to make room for another journey beside your own.'],
  ['The distance between', 'The last garden was never far away. It was waiting on the other side of an impossible door. You brought the light. The garden remembered the rest.'],
]

export default function App() {
  const [initial] = useState(() => {
    const saved = loadProgress()
    const route = parseRoute(window.location.hash, saved)
    const currentLevel = route.page === 'play' && LEVELS.some(level => level.id === route.level.id)
      ? route.level.id : saved.currentLevel
    return { route, progress: { ...saved, currentLevel } }
  })
  const [progress, setProgress] = useState<Progress>(initial.progress)
  const [page, setPage] = useState<Page>(initial.route.page)
  const [session, setSession] = useState<Session>(() => makeSession(initial.route.level, true))
  const [modal, setModal] = useState<Modal>(null)
  const [toast, setToast] = useState('')
  const [focusMode, setFocusMode] = useState(false)
  const [atlasChapter, setAtlasChapter] = useState<number | null>(null)
  const [workshopChapter, setWorkshopChapter] = useState(2)
  const [seed, setSeed] = useState('314159')
  const [importText, setImportText] = useState('')
  const [backupText, setBackupText] = useState('')
  const [progressStorageOk, setProgressStorageOk] = useState(true)
  const [sessionStorageOk, setSessionStorageOk] = useState(true)
  const storageOk = progressStorageOk && sessionStorageOk
  const ambient = progress.ambience
  const [mobileChapters, setMobileChapters] = useState(false)
  const audio = useRef<GardenAudio | null>(null)
  const gameArea = useRef<HTMLDivElement>(null)
  const progressRef = useRef(progress)
  const stateRef = useRef(session)
  const simulation = useMemo(() => simulate(session.tiles), [session.tiles])
  const chapter = CHAPTERS[session.level.chapter] || CHAPTERS[0]
  const completed = countCompleted(progress)
  const totalBlooms = LEVELS.reduce((sum, level) => sum + (progress.completed[level.id]?.stars || 0), 0)
  const isGarden = page === 'play' || page === 'daily'
  const isCampaign = LEVELS.some(level => level.id === session.level.id)
  const chapterLevels = LEVELS.filter(level => level.chapter === session.level.chapter)
  const chapterComplete = chapterLevels.filter(level => progress.completed[level.id]).length
  const activeLevelNumber = isCampaign ? session.level.index % 8 + 1 : null
  const earnedStars = session.hints > 0 ? 1 : session.moves <= session.level.par ? 3 : 2
  const allRecords = Object.values(progress.completed)
  const achievements = [
    { title: 'A little light', detail: 'Restore your first garden.', achieved: completed >= 1, icon: Sprout },
    { title: 'In full bloom', detail: 'Earn three blooms in a garden.', achieved: allRecords.some(record => record.stars === 3), icon: Flower2 },
    { title: 'The patient keeper', detail: 'Restore eight campaign gardens.', achieved: completed >= 8, icon: Leaf },
    { title: 'Morning ritual', detail: 'Restore a daily garden.', achieved: Object.keys(progress.completed).some(id => id.startsWith('daily-')), icon: Sun },
    { title: 'Uncharted paths', detail: 'Restore a workshop garden.', achieved: Object.keys(progress.completed).some(id => !id.startsWith('daily-') && !LEVELS.some(level => level.id === id)), icon: Compass },
    { title: 'A sky of gardens', detail: 'Restore all 48 campaign gardens.', achieved: completed === 48, icon: Sparkles },
    { title: 'Golden hands', detail: 'Earn 72 campaign blooms.', achieved: totalBlooms >= 72, icon: Trophy },
    { title: 'A perfect constellation', detail: 'Earn all 144 campaign blooms.', achieved: totalBlooms === 144, icon: Moon },
  ]

  useEffect(() => { progressRef.current = progress }, [progress])
  useEffect(() => { stateRef.current = session }, [session])
  useEffect(() => {
    const handleHash = () => {
      const route = parseRoute(window.location.hash, progressRef.current)
      setPage(route.page)
      setMobileChapters(false)
      if (route.page === 'play' || route.page === 'daily') {
        setSession(makeSession(route.level, true))
        if (LEVELS.some(level => level.id === route.level.id)) setProgress(current => ({ ...current, currentLevel: route.level.id }))
      }
    }
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])
  useEffect(() => {
    const engine = new GardenAudio()
    audio.current = engine
    return () => { engine.dispose(); audio.current = null }
  }, [])
  useEffect(() => {
    const saved = saveProgress(progress)
    let active = true
    queueMicrotask(() => { if (active) setProgressStorageOk(saved) })
    audio.current?.setSound(progress.sound)
    audio.current?.setAmbience(progress.ambience)
    return () => { active = false }
  }, [progress])
  useEffect(() => {
    if (!isGarden) return
    let saved = true
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ id: session.level.id, rotations: session.tiles.map(tile => tile.rotation), moves: session.moves, hints: session.hints })) } catch { saved = false }
    let active = true
    queueMicrotask(() => { if (active) setSessionStorageOk(saved) })
    return () => { active = false }
  }, [session, isGarden])
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  function navigate(path: string) {
    setModal(null)
    setFocusMode(false)
    setMobileChapters(false)
    if (window.location.hash === `#/${path}`) {
      const route = parseRoute(`#/${path}`, progress)
      setPage(route.page)
      setSession(makeSession(route.level, true))
    } else window.location.hash = `/${path}`
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  function rememberWin(next: Session) {
    const stars = next.hints > 0 ? 1 : next.moves <= next.level.par ? 3 : 2
    setProgress(current => {
      const old = current.completed[next.level.id]
      const updated = { ...current, completed: { ...current.completed, [next.level.id]: { moves: old ? Math.min(old.moves, next.moves) : next.moves, stars: old ? Math.max(old.stars, stars) : stars, hints: old ? Math.min(old.hints, next.hints) : next.hints, date: today() } } }
      return updated
    })
    audio.current?.play('complete')
  }

  function commitRotation(id: string, delta = 1, target?: number) {
    const current = stateRef.current
    if (current.won) return
    const tile = current.tiles.find(item => item.id === id)
    if (!tile || tile.fixed || ['source', 'crystal', 'rock'].includes(tile.kind)) return
    const difference = target === undefined ? 1 : Math.min((target - tile.rotation + 4) % 4, (tile.rotation - target + 4) % 4)
    const tiles = current.tiles.map(item => item.id === id ? target === undefined ? rotateTile(item, delta) : { ...item, rotation: target } : item)
    const next: Session = { ...current, tiles, moves: current.moves + difference, history: [...current.history.slice(-499), { tiles: current.tiles, moves: current.moves }], hintId: null, hintRotation: null, won: simulate(tiles).solved }
    stateRef.current = next
    setSession(next)
    if (next.won) rememberWin(next)
    else audio.current?.play('rotate')
  }

  function undo() {
    const current = stateRef.current
    const previous = current.history.at(-1)
    if (!previous) return
    const next = { ...current, ...previous, history: current.history.slice(0, -1), won: false, hintId: null, hintRotation: null }
    stateRef.current = next
    setSession(next)
    audio.current?.play('rotate')
  }

  function restart() {
    const next = makeSession(stateRef.current.level)
    stateRef.current = next
    setSession(next)
    audio.current?.play('reset')
    setToast('A fresh start. The light is waiting for you.')
  }

  function hint() {
    const current = stateRef.current
    if (current.won) return
    if (current.hintId && current.hintRotation !== null) {
      commitRotation(current.hintId, 1, current.hintRotation)
      return
    }
    const nextHint = getHint(current.level, current.tiles)
    if (!nextHint) return
    const next = { ...current, hintId: nextHint.tileId, hintRotation: nextHint.rotation, hints: current.hints + 1 }
    stateRef.current = next
    setSession(next)
    audio.current?.play('hint')
    setToast('Try the highlighted stone. Tap the hint again to turn it into place.')
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || modal || !isGarden || (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return
      if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'u') { event.preventDefault(); undo() }
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); restart() }
      if (event.key.toLowerCase() === 'h') { event.preventDefault(); hint() }
      if (event.key === '?') setModal('guide')
      if (event.key === 'Escape') setFocusMode(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  function changeSetting<K extends keyof Progress>(key: K, value: Progress[K]) {
    const next = { ...progress, [key]: value }
    setProgress(next)
    setProgressStorageOk(saveProgress(next))
    if (key === 'sound') audio.current?.setSound(Boolean(value))
  }

  function toggleAmbience() {
    const next = !ambient
    changeSetting('ambience', next)
    audio.current?.setAmbience(next)
  }

  async function copyText(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setToast(message) }
    catch { setBackupText(value); setModal('settings'); setToast('Copy the text in the backup field below.') }
  }

  function shareGarden() {
    const hash = session.level.id.startsWith('daily-') ? `/daily/${session.level.id.slice(6)}` : window.location.hash.slice(1) || `/play/${session.level.id}`
    void copyText(`${window.location.href.split('#')[0]}#${hash}`, 'Garden link copied. Share a little light.')
  }

  function nextGarden() {
    if (!isCampaign) { navigate(page === 'daily' ? 'atlas' : 'workshop'); return }
    const next = LEVELS[session.level.index + 1]
    if (next) navigate(`play/${next.id}`)
    else navigate('journal')
  }

  function launchWorkshop() {
    if (!/^\d{1,10}$/.test(seed) || Number(seed) > 4294967295) { setToast('Choose a seed from 0 to 4,294,967,295.'); return }
    navigate(`seed/${Number(seed)}/${workshopChapter}`)
  }

  const onCloseModal = useMemo(() => () => setModal(null), [])

  return <div className={`app-shell ${focusMode ? 'focus-mode' : ''} ${progress.reduceMotion ? 'reduce-motion' : ''} ${progress.highContrast ? 'high-contrast' : ''}`}>
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to garden</a>
    <header className="topbar">
      <button className="brand" onClick={() => navigate('atlas')} aria-label="Lumen, all gardens"><span className="brand-mark"><span /></span><span className="brand-type">LUMEN<small>THE LOST GARDENS</small></span></button>
      <nav className="main-nav" aria-label="Main navigation">
        <button className={page === 'play' || page === 'atlas' ? 'active' : ''} onClick={() => navigate(`play/${progress.currentLevel}`)}><Compass size={16} /><span>The journey</span></button>
        <button className={page === 'daily' ? 'active' : ''} onClick={() => navigate(`daily/${today()}`)}><Sun size={16} /><span>Daily ritual</span><span className="nav-dot" /></button>
        <button className={page === 'workshop' ? 'active' : ''} onClick={() => navigate('workshop')}><WandSparkles size={16} /><span>Workshop</span></button>
      </nav>
      <div className="topbar-tools"><button className={`icon-button ambience-button ${ambient ? 'enabled' : ''}`} onClick={toggleAmbience} aria-label={ambient ? 'Pause garden ambience' : 'Play garden ambience'} title="Garden ambience"><Headphones size={18} /></button><button className="icon-button" onClick={() => setModal('guide')} aria-label="How to play" title="How to play"><CircleHelp size={19} /></button><button className="icon-button" onClick={() => setModal('settings')} aria-label="Settings" title="Settings"><Settings2 size={18} /></button></div>
    </header>

    <div className="app-body">
      <aside className={`sidebar ${mobileChapters ? 'mobile-open' : ''}`} aria-label="Chapters">
        <div className="sidebar-title"><span className="eyebrow">YOUR EXPEDITION</span><button className="icon-button mobile-toggle" aria-label="Toggle chapter list" onClick={() => setMobileChapters(!mobileChapters)}><ChevronDown size={17} /></button><span className="sidebar-count">{String(completed).padStart(2, '0')} / 48</span></div>
        <div className="journey-progress"><span style={{ width: `${completed / 48 * 100}%` }} /></div>
        <div className="chapter-list">
          {CHAPTERS.map((item, i) => {
            const levels = LEVELS.filter(level => level.chapter === i)
            const done = levels.filter(level => progress.completed[level.id]).length
            const active = isGarden && session.level.chapter === i
            return <button key={item.id} className={`chapter-button ${active ? 'selected' : ''}`} onClick={() => navigate(`play/${(levels.find(level => !progress.completed[level.id]) || levels[0]).id}`)}>
              <span className="chapter-icon"><Sigil chapter={i} />{done === 8 && <span className="chapter-check"><Check size={9} /></span>}</span>
              <span className="chapter-copy"><small>CHAPTER {ROMAN[i]}</small><strong>{item.title}</strong><span>{done === 8 ? 'In full bloom' : `${done} of 8 gardens restored`}</span></span>
              {active && <span className="chapter-active-dot" />}
            </button>
          })}
        </div>
        <button className={`sidebar-link ${page === 'atlas' ? 'active' : ''}`} onClick={() => navigate('atlas')}><Grid2X2 size={16} />All gardens<ArrowRight size={14} /></button>
        <div className="sidebar-bottom"><button className={`sidebar-link ${page === 'journal' ? 'active' : ''}`} onClick={() => navigate('journal')}><BookOpen size={17} />The keeper’s journal<span className="small-count">{CHAPTERS.filter((_, i) => LEVELS.some(level => level.chapter === i && progress.completed[level.id])).length}/6</span></button><button className="sidebar-link" onClick={() => setModal('achievements')}><Flower2 size={17} />Collected blooms<span className="small-count">{totalBlooms}</span></button><div className="sidebar-note"><Sprout size={23} strokeWidth={1} /><p>Nothing here is in a hurry.<br />Neither should you be.</p></div></div>
      </aside>

      <main id="main-content" className="main-content" tabIndex={-1}>
        {isGarden && <>
          <div className="page-heading"><div><button className="breadcrumb" onClick={() => navigate('atlas')}><span>{page === 'daily' ? 'THE DAILY RITUAL' : !isCampaign ? 'AN UNCHARTED GARDEN' : `CHAPTER ${ROMAN[session.level.chapter]}`}</span><span className="breadcrumb-line" /><span>{page === 'daily' ? session.level.id.slice(6) : chapter.title}</span></button><h1>{session.level.title}<span className="title-flower">✳</span></h1><p>{session.level.subtitle}</p></div><button className="quiet-button guide-link" onClick={() => setModal('guide')}><BookOpen size={16} />Field guide<ArrowRight size={14} /></button></div>

          <div className="play-layout">
            <section className={`garden-container ${session.won ? 'garden-complete' : ''}`} aria-label="Puzzle garden" ref={gameArea}>
              <div className="garden-stage" style={{ '--chapter-color': chapter.color } as CSSProperties}>
                <div className="stage-top"><div className="stage-coordinate"><span className="live-dot" />{page === 'daily' ? 'TODAY’S GARDEN' : isCampaign ? `GARDEN ${String(session.level.index + 1).padStart(2, '0')}` : 'THE WORKSHOP'}<small>{session.level.size} × {session.level.size} · {MECHANICS[session.level.chapter]}</small></div><button className="stage-focus" onClick={() => setFocusMode(!focusMode)} title={focusMode ? 'Leave focus mode' : 'Focus mode'} aria-label={focusMode ? 'Leave focus mode' : 'Focus mode'}>{focusMode ? <X size={17} /> : <Maximize size={17} />}</button></div>
                <Board level={session.level} tiles={session.tiles} simulation={simulation} onRotate={commitRotation} hintId={session.hintId} disabled={session.won} />
                <div className="stage-bottom"><span className="light-status"><span className={`status-beacon ${simulation.litCrystals > 0 ? 'lit' : ''}`} /><strong>{simulation.litCrystals}<span> / {simulation.totalCrystals}</span></strong> crystals awake</span><span className="stage-weather"><Wind size={14} /><span>{session.won ? 'The garden remembers.' : 'Follow the light.'}</span></span></div>
                {session.won && <div className="restored-banner" role="status"><Sparkles size={16} /> A little corner of the world, alight.</div>}
              </div>
              <div className="garden-toolbar"><div className="tool-group"><button onClick={undo} disabled={!session.history.length} title="Undo (Z)"><Undo2 size={17} /><span>Undo</span><kbd>Z</kbd></button><span className="tool-divider" /><button onClick={restart} title="Restart (R)"><RotateCcw size={16} /><span>Restart</span><kbd>R</kbd></button></div><div className="toolbar-end"><button className="sound-toggle" onClick={() => changeSetting('sound', !progress.sound)} title="Toggle sound" aria-label={progress.sound ? 'Mute sound effects' : 'Enable sound effects'}>{progress.sound ? <Volume2 size={17} /> : <VolumeX size={17} />}</button><button className="hint-button" onClick={hint} disabled={session.won} title="Hint (H)"><Lightbulb size={16} /><span>{session.hintId ? 'Turn this stone' : 'A gentle nudge'}</span><kbd>H</kbd></button></div></div>
              <p className="interaction-note"><span><span className="mouse-symbol" /> Click a stone to rotate</span><i /><span>Shift + click to turn back</span><i /><span>Take your time.</span></p>
            </section>

            <aside className="garden-notes" aria-label="Garden objective">
              <div className="level-counter"><span>{page === 'daily' ? 'ONE GARDEN, EVERY DAY' : isCampaign ? `GARDEN ${String(activeLevelNumber).padStart(2, '0')}` : 'A GARDEN OF YOUR OWN'}</span>{isCampaign && <span> / 08</span>}</div>
              <Sigil chapter={session.level.chapter} className={`objective-sigil ${session.won ? 'is-awake' : ''}`} />
              <span className="eyebrow">{session.won ? 'LIGHT HAS FOUND ITS WAY' : 'A SMALL ACT OF RESTORATION'}</span>
              <h2>{session.won ? 'A garden, reborn.' : 'Let there be light.'}</h2>
              <p className="objective-copy">{session.won ? completed === 48 ? 'Every garden is awake. You have carried the light all the way home.' : 'Every crystal is awake. Somewhere, an old keeper is smiling.' : 'Turn the stone channels. Guide the light from its source to every sleeping crystal.'}</p>
              {session.won ? <div className="win-panel"><Blooms count={earnedStars} /><p>{earnedStars === 3 ? 'A beautiful, effortless restoration.' : earnedStars === 2 ? 'You found your own way through.' : 'A little help. A little light.'}</p><button className="primary-button" onClick={nextGarden}>{isCampaign ? session.level.index === 47 ? 'Read the final memory' : 'Next garden' : page === 'daily' ? 'Explore the journey' : 'Create another garden'}<ArrowRight size={17} /></button><button className="text-button" onClick={shareGarden}><Copy size={13} />Share this garden</button></div> : <>
                <div className="objective-progress"><span>{simulation.litCrystals === simulation.totalCrystals ? 'All crystals restored' : 'Crystals restored'}<strong>{simulation.litCrystals} / {simulation.totalCrystals}</strong></span><div>{Array.from({ length: simulation.totalCrystals }, (_, i) => <span key={i} className={i < simulation.litCrystals ? 'lit' : ''} />)}</div></div>
                <div className="move-stats"><div><span className="stat-number" data-testid="move-count">{String(session.moves).padStart(2, '0')}</span><small>YOUR TURNS</small></div><span className="stat-separator" /><div><span className="stat-number target">{String(session.level.par).padStart(2, '0')}</span><small>GARDENER’S GUIDE</small></div></div>
                <div className="reward-guide"><Blooms count={3} /><span>Within {session.level.par} turns, without hints.<br />Every solution is a good solution.</span></div>
              </>}
              <div className="garden-story"><span className="story-leaf"><Leaf size={16} strokeWidth={1} /></span><p>“{session.level.story}”</p><span>— THE KEEPER’S NOTES</span></div>
              {session.hintId && !session.won && <div className="hint-note"><Lightbulb size={15} /><p>The marked stone needs a turn. Tap “Turn this stone” to place it.</p></div>}
              {!session.won && session.level.index === 0 && isCampaign && <button className="first-help" onClick={() => setModal('guide')}>New here? Open the field guide <ArrowRight size={13} /></button>}
            </aside>
          </div>

          {isCampaign ? <section className="chapter-trail" aria-label="Gardens in this chapter"><div className="trail-heading"><span className="eyebrow">{chapter.title.toUpperCase()}</span><span>{chapterComplete} of 8 restored</span></div><div className="trail-levels">{chapterLevels.map((level, i) => <button key={level.id} onClick={() => navigate(`play/${level.id}`)} className={`trail-level ${session.level.id === level.id ? 'current' : ''} ${progress.completed[level.id] ? 'completed' : ''}`} aria-label={`Garden ${i + 1}: ${level.title}${progress.completed[level.id] ? ', restored' : ''}`} aria-current={session.level.id === level.id ? 'step' : undefined}><span className="trail-node">{progress.completed[level.id] ? <Sprout size={19} /> : <span>{String(i + 1).padStart(2, '0')}</span>}</span><span className="trail-name">{level.title}</span>{progress.completed[level.id] ? <Blooms count={progress.completed[level.id].stars} /> : <span className="trail-dots">···</span>}</button>)}</div></section> : <section className="special-footer"><div><Sun size={20} /><span>{page === 'daily' ? 'The same sky. The same garden. A new possibility every day.' : 'Every seed is a different place to begin.'}</span></div><button className="quiet-button" onClick={shareGarden}><Copy size={15} />Share garden</button></section>}
        </>}

        {page === 'atlas' && <>
          <div className="page-heading"><div><span className="eyebrow">AN EXPEDITION IN SIX CHAPTERS</span><h1>A world waiting for light.</h1><p>Forty-eight quiet places. A thousand ways to begin.</p></div><div className="atlas-total"><strong>{completed}<span>/48</span></strong><small>GARDENS RESTORED</small></div></div>
          <div className="atlas-intro"><Sprout size={20} /><p>Every chapter is open. Follow the journey, or wander wherever your curiosity takes you.</p><span>{totalBlooms} / 144 blooms</span></div>
          <div className="atlas-grid">{CHAPTERS.map((item, i) => {
            const levels = LEVELS.filter(level => level.chapter === i)
            const done = levels.filter(level => progress.completed[level.id]).length
            return <article key={item.id} className={`chapter-card chapter-card-${i}`}><button className="chapter-card-art" onClick={() => { setAtlasChapter(atlasChapter === i ? null : i) }} aria-label={`Explore ${item.title}`} aria-expanded={atlasChapter === i}><span className="card-roman">{ROMAN[i]}</span><div className="card-orbit" /><Sigil chapter={i} /><span className="art-caption">{MECHANICS[i]}</span><span className="art-arrow"><ArrowRight size={20} /></span></button><div className="chapter-card-body"><span className="eyebrow">CHAPTER {ROMAN[i]} · 8 GARDENS</span><h2>{item.title}</h2><p>{item.description}</p><div className="card-progress"><span><span style={{ width: `${done / 8 * 100}%` }} /></span><small>{done} / 8</small></div><button className="text-button" onClick={() => navigate(`play/${(levels.find(level => !progress.completed[level.id]) || levels[0]).id}`)}>{done === 8 ? 'Return to the garden' : done > 0 ? 'Continue exploring' : 'Begin this chapter'}<ArrowRight size={15} /></button></div>{atlasChapter === i && <div className="card-level-list">{levels.map((level, n) => <button key={level.id} onClick={() => navigate(`play/${level.id}`)}><span>{String(n + 1).padStart(2, '0')}</span>{level.title}{progress.completed[level.id] ? <Check size={14} /> : <ChevronRight size={14} />}</button>)}</div>}</article>
          })}</div>
        </>}

        {page === 'workshop' && <>
          <div className="page-heading"><div><span className="eyebrow">BEYOND THE KNOWN GARDENS</span><h1>Make room for wonder.</h1><p>A seed, a little curiosity, and a garden that has never been yours before.</p></div><WandSparkles className="page-heading-icon" size={34} strokeWidth={1} /></div>
          <div className="workshop-layout"><div className="workshop-art"><div className="workshop-orbit orbit-one" /><div className="workshop-orbit orbit-two" /><Sigil chapter={workshopChapter} /><span className="eyebrow">POSSIBILITY TAKES ROOT</span><h2>One seed.<br /><i>Endless beginnings.</i></h2><span className="seed-art-number">Nº {seed || '0'}</span></div><div className="workshop-form"><span className="eyebrow">YOUR GARDEN RECIPE</span><h2>Plant a new puzzle.</h2><p>Choose a chapter’s rules and give your garden a seed. The same recipe always grows the same puzzle, ready to share.</p><label htmlFor="chapter-style">Garden style</label><div className="select-wrap"><select id="chapter-style" value={workshopChapter} onChange={event => setWorkshopChapter(Number(event.target.value))}>{CHAPTERS.map((item, i) => <option key={item.id} value={i}>{ROMAN[i]} · {item.title} — {MECHANICS[i]}</option>)}</select><ChevronDown size={16} /></div><label htmlFor="garden-seed">Seed number</label><div className="seed-input"><input id="garden-seed" value={seed} inputMode="numeric" maxLength={10} onChange={event => setSeed(event.target.value.replace(/\D/g, ''))} onKeyDown={event => { if (event.key === 'Enter') launchWorkshop() }} /><button className="icon-button" aria-label="Choose a random seed" title="Surprise me" onClick={() => setSeed(String(crypto.getRandomValues(new Uint32Array(1))[0]))}><Shuffle size={18} /></button></div><p className="input-note">Any whole number from 0 to 4,294,967,295.</p><button className="primary-button" onClick={launchWorkshop}><Sprout size={18} />Grow this garden<ArrowRight size={17} /></button><div className="workshop-promise"><Check size={15} /><span>Every garden has a verified path to the light.</span></div></div></div>
          <section className="workshop-presets"><span className="eyebrow">A FEW SEEDS TO GET YOU STARTED</span><div>{[{ seed: 1729, chapter: 0, title: 'An easy morning', description: 'A small, quiet place to find your rhythm.' }, { seed: 271828, chapter: 3, title: 'The long way home', description: 'One-way paths reward a patient eye.' }, { seed: 1618033, chapter: 5, title: 'Somewhere, elsewhere', description: 'Step through a door in the light.' }].map(item => <button key={item.seed} onClick={() => navigate(`seed/${item.seed}/${item.chapter}`)}><Sigil chapter={item.chapter} /><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={17} /></button>)}</div></section>
        </>}

        {page === 'journal' && <>
          <div className="page-heading"><div><span className="eyebrow">FRAGMENTS FROM AN OLD FIELD BOOK</span><h1>The keeper’s journal.</h1><p>Some things return slowly. A garden. A memory. A little hope.</p></div><BookOpen className="page-heading-icon" size={35} strokeWidth={1} /></div>
          <div className="journal-intro"><span className="journal-dropcap">Y</span><p>ou arrived with nothing but a lantern and a feeling that something here was still alive. With every garden you restore, another page finds its way back into this book.</p><div><strong>{completed}</strong><span>GARDENS REMEMBERED</span></div></div>
          <div className="memory-grid">{memories.map(([title, text], i) => {
            const unlocked = LEVELS.some(level => level.chapter === i && progress.completed[level.id])
            return <article className={`memory ${unlocked ? 'unlocked' : ''}`} key={title}><div className="memory-top"><span className="eyebrow">MEMORY {ROMAN[i]}</span><Sigil chapter={i} /></div><h2>{unlocked ? title : 'A page yet to return.'}</h2><p>{unlocked ? text : `Restore a garden in ${CHAPTERS[i].title} to recover this memory.`}</p><button className="text-button" onClick={() => navigate(`play/${LEVELS[i * 8].id}`)}>{unlocked ? 'Return to this chapter' : 'Find this memory'}<ArrowRight size={15} /></button></article>
          })}</div>
          {completed === 48 && <div className="final-memory"><Sigil chapter={5} /><span className="eyebrow">THE LAST PAGE</span><h2>The keeper was always you.</h2><p>Forty-eight gardens. Forty-eight small acts of care. There is no grand secret at the end of this journey, only this: a world becomes beautiful when someone chooses to tend it.</p><p>Thank you for bringing the light.</p><button className="primary-button" onClick={() => navigate('workshop')}>There are more gardens to find<ArrowRight size={17} /></button></div>}
        </>}

        <footer className="page-footer"><span><span className="footer-diamond" />A QUIET ADVENTURE IN LIGHT</span><span>{storageOk ? 'Your journey is saved on this device' : 'Storage unavailable — keep a backup in Settings'}<span className={`save-dot ${storageOk ? '' : 'warning'}`} /></span></footer>
      </main>
    </div>

    {modal && <Dialog title={modal === 'guide' ? 'A field guide to light.' : modal === 'settings' ? 'Make yourself at home.' : 'Small things, beautifully done.'} onClose={onCloseModal} wide={modal === 'guide'}>
      {modal === 'guide' && <div className="guide-content"><p className="dialog-intro">Nothing is lost. Nothing is timed. Turn the channels until the light reaches every crystal.</p><div className="guide-steps"><div><span>01</span><Sun /><h3>Find the source</h3><p>The golden lantern is always alight. Follow its channel into the garden.</p></div><div><span>02</span><RotateCcw /><h3>Turn the stones</h3><p>Click a stone to rotate it clockwise. Its channel must meet the next stone’s channel.</p></div><div><span>03</span><Sparkles /><h3>Wake every crystal</h3><p>Connect all the crystals to the source. Light travels automatically along joined channels.</p></div></div><h3 className="guide-section-title">The shapes of a garden</h3><div className="mechanics-grid">{[{ symbol: '└', name: 'Channels', text: 'Straight stones and corners carry light through their open ends.' }, { symbol: '┬', name: 'Branches', text: 'A branch sends light down every connected arm. Find more than one path.' }, { symbol: '◈', name: 'Rooted stones', text: 'Stones marked with small pins cannot turn. Sources and crystals stay still, too.' }, { symbol: '↑', name: 'One-way gates', text: 'Light can only pass in the arrow’s direction. Turning the gate changes its direction.' }, { symbol: '╪', name: 'Bridges', text: 'Two channels cross but never join. North connects south; east connects west.' }, { symbol: '◎', name: 'Portals', text: 'Matching letters share a doorway. Light entering one leaves through its partner.' }].map(item => <div key={item.name}><span className="mechanic-symbol">{item.symbol}</span><div><h4>{item.name}</h4><p>{item.text}</p></div></div>)}</div><div className="guide-bottom"><div><h3>A little help is always here.</h3><p>Hints first mark a stone, then offer to turn it for you. Earn three blooms within the gardener’s guide without hints; two for any unassisted solution; one with a helping hand. Every garden remains open.</p></div><div className="keyboard-guide"><span><kbd>Tab</kbd> Select stone</span><span><kbd>Enter</kbd> / <kbd>Space</kbd> Turn</span><span><kbd>Shift</kbd> + click / Enter · Reverse</span><span><kbd>Z</kbd> Undo <kbd>R</kbd> Restart <kbd>H</kbd> Hint</span></div></div><button className="primary-button" onClick={onCloseModal}>Let’s find the light<ArrowRight size={17} /></button></div>}
      {modal === 'settings' && <div className="settings-content"><p className="dialog-intro">A little space, just the way you like it.</p><SettingRow title="Sound effects" description="Soft notes when the stones turn and crystals wake." enabled={progress.sound} onToggle={() => changeSetting('sound', !progress.sound)} icon={<Volume2 size={19} />} /><SettingRow title="Garden ambience" description="A quiet, drifting soundscape. Starts only when you choose." enabled={ambient} onToggle={toggleAmbience} icon={<Headphones size={19} />} /><SettingRow title="Reduce motion" description="Still the drifting light and decorative animations." enabled={progress.reduceMotion} onToggle={() => changeSetting('reduceMotion', !progress.reduceMotion)} icon={<Wind size={19} />} /><SettingRow title="Stronger contrast" description="Darker text and more distinct garden outlines." enabled={progress.highContrast} onToggle={() => changeSetting('highContrast', !progress.highContrast)} icon={<Sun size={19} />} /><div className="backup-section"><h3>Keep your journey close.</h3><p>Your progress stays in this browser. Copy a backup to take your completed gardens to another device.</p><div className="backup-actions"><button className="secondary-button" onClick={() => { const text = exportProgress(progress); setBackupText(text); void copyText(text, 'Progress backup copied.') }}><ArrowDownToLine size={15} />Export progress</button><label className="secondary-button file-input"><ArrowUpFromLine size={15} />Read backup file<input type="file" accept=".json,.txt,application/json,text/plain" onChange={async event => { const file = event.target.files?.[0]; if (file && file.size < 1000000) setImportText(await file.text()); else if (file) setToast('Please choose a backup smaller than 1 MB.') }} /></label></div>{backupText && <><label htmlFor="backup-output">Copy this backup or garden link</label><textarea id="backup-output" readOnly value={backupText} onFocus={event => event.target.select()} /></>}<label htmlFor="backup-import">Paste a progress backup</label><textarea id="backup-import" value={importText} onChange={event => setImportText(event.target.value)} placeholder="Your Lumen backup goes here…" /><button className="secondary-button" disabled={!importText.trim()} onClick={() => { const imported = importProgress(importText); if (!imported) { setToast('That backup could not be read. Check that you copied the entire Lumen backup.'); return } const merged = { ...progress.completed }; for (const [id, record] of Object.entries(imported.completed)) { const old = merged[id]; merged[id] = old ? { ...record, stars: Math.max(record.stars, old.stars), moves: Math.min(record.moves, old.moves), hints: Math.min(record.hints, old.hints) } : record } const next = { ...progress, completed: merged }; setProgress(next); setProgressStorageOk(saveProgress(next)); setImportText(''); setToast('Your gardens are safely restored. Existing progress was kept.') }}><Check size={15} />Import and keep existing progress</button></div><p className="settings-footnote">Made for unhurried minds. No accounts, no ads, no clocks.</p></div>}
      {modal === 'achievements' && <div className="achievements-content"><p className="dialog-intro">{totalBlooms} of 144 campaign blooms collected. Every little light counts.</p><div className="achievement-grid">{achievements.map(item => <div key={item.title} className={`achievement ${item.achieved ? 'achieved' : ''}`}><span className="achievement-icon"><item.icon size={25} strokeWidth={1.3} /></span><div><h3>{item.title}</h3><p>{item.detail}</p></div>{item.achieved && <Check size={17} />}</div>)}</div><div className="achievement-total"><Flower2 size={22} /><span>{achievements.filter(item => item.achieved).length} of {achievements.length} keepsakes found</span></div></div>}
    </Dialog>}
    {toast && <div className="toast" role="status"><Leaf size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>
}
