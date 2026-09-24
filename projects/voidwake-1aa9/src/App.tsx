import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CARDS, CREW, EVENTS, NODE_INFO, RELICS, SECTORS, SHIPS } from './content'
import type { ShipKey } from './content'
import { achievements, choiceAvailable, currentIntent, jumpCost, newGame, parseSave, passiveShield, reachable, reducer, score, upgradeCost, weaponBonus } from './game'
import type { Action, Card, Game, MapNode, Upgrade } from './game'
import { Icon, Portrait, ShipArt } from './Art'
import { playSound } from './audio'
import '@fontsource/barlow-condensed/latin-500.css'
import '@fontsource/barlow-condensed/latin-600.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import './App.css'

const SAVE_KEY = 'voidwake-1aa9-save-v1'
type View = 'bridge' | 'ship' | 'archive'
type Modal = 'help' | 'new' | 'deck' | null
function loadGame() { try { return parseSave(localStorage.getItem(SAVE_KEY)) ?? newGame() } catch { return newGame() } }
function loadSound() { try { return localStorage.getItem('voidwake-sound') === 'on' } catch { return false } }
const pad = (n: number) => String(n).padStart(2, '0')
const css = (values: Record<string, string | number>) => values as CSSProperties

function Meter({ value, max, tone = 'teal', label }: { value: number; max: number; tone?: string; label: string }) {
  return <div className={`meter ${tone}`} role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}><span style={{ width: `${Math.min(100, Math.max(0, value / max * 100))}%` }}/></div>
}
function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span> }
function PanelTitle({ icon, children, trailing }: { icon: string; children: ReactNode; trailing?: ReactNode }) { return <div className="panel-title"><span><Icon name={icon} size={15}/>{children}</span>{trailing}</div> }

export default function App() {
  const [game, setGame] = useState<Game>(loadGame)
  const [view, setView] = useState<View>('bridge')
  const [selected, setSelected] = useState('1-0')
  const [modal, setModal] = useState<Modal>(null)
  const [sound, setSound] = useState(loadSound)
  const [saveStatus, setSaveStatus] = useState('Saved locally')
  const [best, setBest] = useState(() => { try { const n = Number(localStorage.getItem('voidwake-best')); return Number.isFinite(n) ? n : 0 } catch { return 0 } })
  const [flash, setFlash] = useState({ id: 0, kind: 'system' })
  const act = (action: Action) => {
    const next = reducer(game, action)
    if (next !== game) {
      playSound(action.type === 'jump' ? 'jump' : action.type === 'play' || action.type === 'crew' ? 'attack' : action.type === 'endTurn' ? 'end' : action.type === 'claim' ? 'reward' : 'click', sound)
      setGame(next)
      if (action.type === 'play' || action.type === 'crew' || action.type === 'endTurn') setFlash(f => ({ id: f.id + 1, kind: action.type === 'endTurn' ? 'incoming' : next.battle && game.battle && next.battle.enemy.hull < game.battle.enemy.hull ? 'outgoing' : 'system' }))
      if (next.sector !== game.sector) setSelected('1-0')
      else if (next.phase === 'map' && action.type !== 'sos') setSelected(reachable(next)[0] ?? next.current)
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(game)); setSaveStatus('Saved locally')
        if (game.phase === 'won' || game.phase === 'lost') { const nextBest = Math.max(best, score(game)); localStorage.setItem('voidwake-best', String(nextBest)); setBest(nextBest) }
      } catch { setSaveStatus('Storage unavailable · keep this tab open') }
    }, 100)
    return () => window.clearTimeout(timer)
  }, [game, best])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
      if (event.key === 'Escape') { setModal(null); return }
      if (modal) return
      if (event.key === '?') { setModal('help'); return }
      if (event.key.toLowerCase() === 'm') { setView('bridge'); return }
      if (event.key.toLowerCase() === 'd') { setModal('deck'); return }
      if (game.phase === 'combat' && view === 'bridge') {
        if (/^[1-9]$/.test(event.key)) { event.preventDefault(); act({ type: 'play', index: Number(event.key) - 1 }) }
        if (event.key.toLowerCase() === 'e') { event.preventDefault(); act({ type: 'endTurn' }) }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  })
  const toggleSound = () => { const enabled = !sound; setSound(enabled); playSound('click', enabled); try { localStorage.setItem('voidwake-sound', enabled ? 'on' : 'off') } catch { /* Optional preference. */ } }
  const sector = SECTORS[game.sector]
  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Voidwake bridge" onClick={e => { e.preventDefault(); setView('bridge') }}><span className="brand-mark"><Icon name="orbit" size={31}/></span><span>VOIDWAKE<span className="brand-dot">.</span><small>THE LAST SIGNAL</small></span></a>
      <div className="voyage-id"><span className="live-dot"/>VOYAGE {game.seed}<span className="muted"> / </span>DAY {pad(game.stats.jumps + 1)}</div>
      <div className="top-resources">
        <div className="resource" title="Credits purchase repairs, cards, and ship upgrades at stations"><Icon name="coin"/><div><small>CREDITS</small><strong>{game.credits.toLocaleString()}</strong></div></div>
        <div className={`resource ${game.fuel <= 2 ? 'warning' : ''}`} title="Each jump uses 1 fuel. Salvage fields and stations replenish it."><Icon name="fuel"/><div><small>FUEL CELLS</small><strong>{pad(game.fuel)}<span> jumps</span></strong></div></div>
        <button className="icon-button sound-button" onClick={toggleSound} aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'}><Icon name={sound ? 'sound' : 'mute'}/></button>
        <button className="icon-button" onClick={() => setModal('help')} aria-label="How to play" title="How to play (?)"><Icon name="help"/></button>
      </div>
    </header>

    <aside className="sidebar">
      <div className="ship-identity"><div className="eyebrow">YOUR VESSEL</div><h2>{SHIPS[game.ship].name}</h2><div className="ship-mini"><ShipArt variant={game.ship}/></div><span className="micro">{SHIPS[game.ship].class}</span></div>
      <div className="ship-vitals"><div className="vital-label"><span><Icon name="heart" size={14}/> Hull integrity</span><strong className={game.hull < game.maxHull * .3 ? 'danger-text' : ''}>{game.hull}<small> / {game.maxHull}</small></strong></div><Meter value={game.hull} max={game.maxHull} tone={game.hull < game.maxHull * .3 ? 'red' : 'teal'} label="Ship hull"/><div className="vital-small"><span><Icon name="shield" size={14}/> Base shield</span><strong>{passiveShield(game)}</strong></div><div className="vital-small"><span><Icon name="bolt" size={14}/> Reactor output</span><strong>{3 + game.upgrades.reactor}<small> EN</small></strong></div></div>
      <div className="nav-label micro">COMMAND</div>
      <nav className="main-nav" aria-label="Command views">
        {([{ id: 'bridge', label: 'Sector map', icon: 'map' }, { id: 'ship', label: 'Ship & crew', icon: 'ship' }, { id: 'archive', label: 'Captain’s log', icon: 'book' }] as const).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><Icon name={item.icon} size={18}/><span>{item.id === 'bridge' && game.phase === 'combat' ? 'Combat bridge' : item.label}</span>{item.id === 'bridge' ? <span className={`nav-indicator ${game.phase === 'combat' ? 'hostile' : ''}`}/> : <Icon name="chevron" size={12}/>}</button>)}
      </nav>
      <button className="deck-nav" onClick={() => setModal('deck')}><Icon name="layers" size={17}/><span>Combat deck</span><span className="count">{game.deck.length}</span></button>
      <div className="mission-card"><div className="eyebrow"><Icon name="signal" size={13}/> PRIMARY DIRECTIVE</div><h3>Follow the signal.</h3><p>Cross three sectors. Find the source. Bring your crew home.</p><div className="mission-progress">{SECTORS.map((s, i) => <span key={s.code} className={i <= game.sector ? 'complete' : ''}/>)}</div><div className="micro">SECTOR {pad(game.sector + 1)} OF 03 <span>{Math.round(((game.sector * 6 + (game.nodes.find(n => n.id === game.current)?.col ?? 0)) / 18) * 100)}%</span></div></div>
      <div className="sidebar-bottom"><button className="text-button" onClick={() => setModal('new')}><Icon name="refresh" size={14}/> New voyage</button><div className="save-label"><span className="live-dot"/>{saveStatus === 'Saved locally' ? saveStatus : 'Local save unavailable'}</div></div>
    </aside>

    <main id="main-content" className={`main-content view-${view}`}>
      {saveStatus !== 'Saved locally' && <div className="storage-warning" role="status"><Icon name="book" size={15}/>{saveStatus}</div>}
      <div className="page-heading"><div><div className="eyebrow">{view === 'bridge' ? `EXPEDITION / SECTOR ${pad(game.sector + 1)}` : view === 'ship' ? 'VESSEL / PERSONNEL & SYSTEMS' : 'ARCHIVE / EXPEDITION RECORD'}</div><h1>{view === 'bridge' ? game.phase === 'combat' ? 'Battle stations' : game.phase === 'station' ? 'A moment of sanctuary' : sector.name : view === 'ship' ? 'A ship. A crew. A chance.' : 'Every light leaves a trace.'}</h1><p>{view === 'bridge' ? game.phase === 'combat' ? 'Read their intentions. Make every command count.' : game.phase === 'station' ? 'Repair, refit, and prepare for the dark ahead.' : sector.subtitle : view === 'ship' ? 'The only things between you and the void.' : 'Your journey, one impossible decision at a time.'}</p></div><div className="heading-status"><span className="live-dot"/>{game.phase === 'combat' ? 'HOSTILES ENGAGED' : game.phase === 'station' ? 'DOCKING COMPLETE' : 'LONG-RANGE COMMS ONLINE'}<span className="coordinates">{sector.code} · {pad(game.stats.jumps)}:47:09</span></div></div>

      {view === 'bridge' && <>
        {game.phase === 'map' && <MapView game={game} selected={selected} onSelect={setSelected} act={act} onHelp={() => setModal('help')}/>}
        {game.phase === 'combat' && <Combat game={game} act={act} flash={flash} onDeck={() => setModal('deck')}/>}
        {game.phase === 'event' && <EventView game={game} act={act}/>}
        {game.phase === 'station' && <Station game={game} act={act}/>}
        {game.phase === 'reward' && <RewardView game={game} act={act}/>}
        {(game.phase === 'won' || game.phase === 'lost') && <Ending game={game} best={best} onNew={() => setModal('new')} onLog={() => setView('archive')}/>}
        {!['combat', 'won', 'lost'].includes(game.phase) && <div className="bridge-bottom"><CrewStrip game={game}/><RecentLog game={game} onFull={() => setView('archive')}/></div>}
      </>}
      {view === 'ship' && <ShipView game={game} onDeck={() => setModal('deck')} onBridge={() => setView('bridge')}/>}
      {view === 'archive' && <Archive game={game} best={best}/>}
      <footer className="page-footer"><span><Icon name="orbit" size={13}/> IN THE DARK, WE GO TOGETHER.</span><span><kbd>M</kbd> bridge <kbd>D</kbd> deck <kbd>?</kbd> help</span><span>FLIGHT COMPUTER v.01</span></footer>
    </main>
    <div className="sr-only" role="status" aria-live="polite">{game.notice}</div>
    {modal && <Dialog title={modal === 'help' ? 'Your captain’s handbook' : modal === 'new' ? 'Every voyage begins with a choice.' : 'Your combat deck'} onClose={() => setModal(null)} wide={modal !== 'help'}>
      {modal === 'help' && <><Help/><div className="manual-options"><button className="secondary-button" onClick={toggleSound}><Icon name={sound ? 'sound' : 'mute'} size={16}/>{sound ? 'Mute sound' : 'Enable sound'}</button><button className="secondary-button" onClick={() => setModal('new')}><Icon name="refresh" size={16}/>New voyage</button></div></>}
      {modal === 'deck' && <><p className="dialog-intro">{game.deck.length} systems installed. Draw 5 cards each turn. Spent and unplayed cards return when your draw pile empties. Exhausted cards return next battle.</p><div className="deck-grid">{game.deck.map(c => <GameCard key={c.uid} card={c}/>)}</div></>}
      {modal === 'new' && <NewVoyage game={game} onLaunch={g => { setGame(g); setSelected('1-0'); setView('bridge'); setModal(null); playSound('jump', sound) }}/>}
    </Dialog>}
  </div>
}

function MapView({ game, selected, onSelect, act, onHelp }: { game: Game; selected: string; onSelect: (id: string) => void; act: (a: Action) => void; onHelp: () => void }) {
  const node = game.nodes.find(n => n.id === selected) ?? game.nodes[1]
  const available = reachable(game), canJump = available.includes(node.id), info = NODE_INFO[node.kind]
  return <div className="map-layout">
    <section className="chart-panel">
      <div className="chart-toolbar"><span><Icon name="radar" size={16}/> NAVIGATION CHART <span className="muted">/ {pad(game.sector + 1)}</span></span><span className="chart-scale">1 GRID = 4.2 LIGHT YEARS <Icon name="plus" size={13}/></span></div>
      <StarMap game={game} selected={node.id} onSelect={onSelect}/>
      <div className="map-legend">{(['battle', 'elite', 'salvage', 'event', 'station', 'relay'] as const).map(kind => <span key={kind}><Icon name={NODE_INFO[kind].icon} size={13} style={{ color: NODE_INFO[kind].color }}/>{kind === 'event' ? 'Signal' : kind === 'battle' ? 'Hostile' : kind[0].toUpperCase() + kind.slice(1)}</span>)}</div>
      <div className="map-instruction"><span className="live-dot"/><span>{game.stats.jumps === 0 ? 'Your voyage starts here. Select a connected destination, then engage the jump drive.' : 'Highlighted routes are reachable. Every jump takes you closer to the signal.'}</span><button className="text-button" onClick={onHelp}>Flight manual <Icon name="arrow" size={13}/></button></div>
    </section>
    <aside className="destination-panel">
      <PanelTitle icon="crosshair" trailing={<span className="micro">{pad(node.col)}.{pad(node.row)}</span>}>DESTINATION</PanelTitle>
      <div className="destination-scene" style={css({ '--node-color': info.color })}><div className={`destination-orbit kind-${node.kind}`}><Icon name={info.icon} size={38}/></div><span className="scene-coordinate">{node.col * 17 + 104}° {node.row * 14 + 9}′ N</span></div>
      <div className="destination-copy"><Badge tone={node.kind === 'battle' || node.kind === 'elite' || node.kind === 'boss' ? 'orange' : 'teal'}>{info.label}</Badge><h2>{node.name}</h2><p>{info.description}</p>
        <div className="destination-facts"><div><span>Threat level</span><strong className={['battle', 'elite', 'boss'].includes(node.kind) ? 'orange-text' : 'teal-text'}>{node.kind === 'boss' ? 'EXTREME' : node.kind === 'elite' ? 'HIGH' : node.kind === 'battle' ? 'MODERATE' : 'LOW'}</strong></div><div><span>Jump cost</span><strong><Icon name="fuel" size={13}/>{jumpCost(game)} fuel cell</strong></div><div><span>Route status</span><strong>{node.visited ? 'VISITED' : canJump ? 'IN RANGE' : 'OUT OF RANGE'}</strong></div></div>
        <button className="primary-button jump-button" disabled={!canJump || game.fuel < jumpCost(game)} onClick={() => act({ type: 'jump', id: node.id })}><Icon name="ship" size={17}/>{canJump ? 'Engage jump drive' : node.visited ? 'Sector explored' : 'No direct route'}<Icon name="arrow" size={17}/></button>
        {game.fuel === 0 && <button className="sos-button" onClick={() => act({ type: 'sos' })}>Emergency refuel · {game.credits >= 25 ? '25 credits' : 'up to 12 hull'}</button>}
        <p className="jump-note">{canJump ? 'Jumping commits your route. Choose carefully.' : 'Select a connected node on the chart.'}</p>
      </div>
    </aside>
  </div>
}

function StarMap({ game, selected, onSelect }: { game: Game; selected: string; onSelect: (id: string) => void }) {
  const available = reachable(game), current = game.nodes.find(n => n.id === game.current)!
  const colors = ['#e4a16f', '#a39ccc', '#86baba']
  return <div className="starmap"><svg viewBox="0 0 900 490" role="group" aria-label="Sector navigation chart">
    <defs><radialGradient id="nebula"><stop stopColor="#4e537a" stopOpacity=".18"/><stop offset="1" stopColor="#1b2438" stopOpacity="0"/></radialGradient><radialGradient id="planet"><stop stopColor={colors[game.sector]} stopOpacity=".2"/><stop offset=".72" stopColor={colors[game.sector]} stopOpacity=".08"/><stop offset="1" stopColor="#09121e"/></radialGradient><linearGradient id="planet-edge" x1="0" y1="0" x2="1" y2="1"><stop stopColor={colors[game.sector]} stopOpacity=".6"/><stop offset=".7" stopColor="#132133" stopOpacity=".1"/></linearGradient><pattern id="map-grid" width="90" height="70" patternUnits="userSpaceOnUse"><path d="M90 0H0v70" fill="none" stroke="#8996a1" strokeOpacity=".07" strokeWidth=".6"/><path d="M0 0h4m-4 0v4" stroke="#91a6b5" strokeOpacity=".25"/></pattern></defs>
    <rect width="900" height="490" fill="#0b1420"/><ellipse cx="480" cy="215" rx="480" ry="220" fill="url(#nebula)"/>
    {Array.from({ length: 155 }, (_, i) => <circle key={i} cx={(i * 139.7 + 27) % 900} cy={(i * i * 17.3 + 11) % 490} r={i % 17 === 0 ? 1.3 : .65} fill="#bbcfda" opacity={.12 + i % 7 / 14}/>)}
    <circle cx="755" cy="483" r="196" fill="url(#planet)" stroke="url(#planet-edge)" strokeWidth="1.5"/><ellipse cx="755" cy="483" rx="230" ry="66" transform="rotate(-25 755 483)" stroke={colors[game.sector]} strokeOpacity=".09" fill="none"/>
    <rect width="900" height="490" fill="url(#map-grid)"/>
    <text x="30" y="31" className="map-caption">LOCAL CLUSTER / {SECTORS[game.sector].code}</text><text x="870" y="31" textAnchor="end" className="map-caption">DEEP SPACE TELEMETRY</text>
    <text x="585" y="444" className="planet-label">{['ORPHEUS B', 'VESPER PRIME', 'THE MERIDIAN'][game.sector]}</text><text x="586" y="460" className="map-caption">{['GAS GIANT · UNINHABITABLE', 'SHATTERED WORLD · CLASS IV', 'ORIGIN SIGNAL · CONFIRMED'][game.sector]}</text>
    {game.nodes.flatMap(n => n.links.map(id => { const target = game.nodes.find(other => other.id === id)!; const active = n.id === current.id, past = n.visited && target.visited; return <line key={`${n.id}-${id}`} x1={n.x * 9} y1={n.y * 4.9} x2={target.x * 9} y2={target.y * 4.9} stroke={past ? '#8bc6c5' : active ? '#ddba87' : '#66798e'} strokeWidth={active || past ? 1.3 : .8} strokeOpacity={past ? .7 : active ? .6 : .25} strokeDasharray={past ? undefined : active ? '5 5' : '3 7'}/> }))}
    {game.nodes.map(node => <MapPoint key={node.id} node={node} selected={node.id === selected} current={node.id === current.id} available={available.includes(node.id)} passed={node.col < current.col && !node.visited} onSelect={onSelect}/>)}
    <g className="you-marker" transform={`translate(${current.x * 9},${current.y * 4.9 - 46})`}><rect x="-23" y="-10" width="46" height="17" rx="3" fill="#8bc6c5"/><text y="2" textAnchor="middle" fill="#0b1922" fontSize="8" fontWeight="600" letterSpacing="1">YOU</text><path d="m-4 7 4 5 4-5" fill="#8bc6c5"/></g>
    <path d="M27 440v20h20m806-20v20h20" stroke="#93a4b6" strokeOpacity=".3" fill="none"/><text x="35" y="475" className="map-caption">↗ GALACTIC NORTH</text>
  </svg></div>
}
function MapPoint({ node, selected, current, available, passed, onSelect }: { node: MapNode; selected: boolean; current: boolean; available: boolean; passed: boolean; onSelect: (id: string) => void }) {
  const info = NODE_INFO[node.kind], size = node.kind === 'boss' ? 23 : 17
  return <g className={`map-node ${selected ? 'selected' : ''} ${available ? 'reachable' : ''} ${passed ? 'passed' : ''}`} transform={`translate(${node.x * 9},${node.y * 4.9})`} role="button" tabIndex={0} aria-label={`${node.name}, ${info.label}${available ? ', reachable' : ''}${current ? ', current location' : ''}`} aria-pressed={selected} onClick={() => onSelect(node.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.id) } }}>
    <title>{node.name} · {info.label}{available ? ' · Reachable' : ''}</title><circle r="32" fill="transparent"/>
    {selected && <><circle r={size + 12} fill={info.color} fillOpacity=".07" stroke={info.color} strokeOpacity=".5" strokeDasharray="3 5" className="selection-ring"/><path d={`M${-size - 16} -4v8m${(size + 16) * 2} -8v8`} stroke={info.color}/></>}
    <path d={`M0 ${-size} ${size * .87} ${-size * .5} ${size * .87} ${size * .5} 0 ${size} ${-size * .87} ${size * .5} ${-size * .87} ${-size * .5}Z`} fill={selected ? '#293341' : '#111f2d'} stroke={node.visited ? '#8bc6c5' : info.color} strokeOpacity={available || selected || current ? 1 : .5} strokeWidth={selected || current ? 1.7 : 1}/>
    <g transform="translate(-9,-9)" style={{ color: node.visited && !current ? '#8bc6c5' : info.color }}><Icon name={node.visited && !current ? 'check' : current ? 'ship' : info.icon} size={18}/></g>
    <text textAnchor="middle" y={size + 19} className="node-name" fill={selected || current ? '#ece8e0' : '#97a7b5'}>{node.name.length > 19 ? node.name.slice(0, 18) + '…' : node.name}</text>
    {node.kind === 'boss' && <text textAnchor="middle" y={size + 34} className="map-caption" fill="#d4a07a">JUMP GATE</text>}
  </g>
}

function CrewStrip({ game, act }: { game: Game; act?: (a: Action) => void }) {
  const inCombat = game.phase === 'combat', used = game.battle?.crewUsed
  return <section className="crew-panel"><PanelTitle icon="heart" trailing={<span className="micro">{inCombat ? used ? 'ABILITY USED' : '1 ABILITY / BATTLE' : `TRUST ${game.reputation >= 0 ? '+' : ''}${game.reputation}`}</span>}>THE PEOPLE YOU BRING HOME</PanelTitle><div className="crew-list">{CREW.map((c, i) => <div className="crew-person" key={c.id}><Portrait index={i}/><div><strong>{c.name}</strong><span className="micro">{c.role}<span className="crew-dot" style={{ background: c.color }}/></span>{inCombat && <button disabled={!!used} onClick={() => act?.({ type: 'crew', id: c.id })} title={c.text} className="crew-ability">{c.ability}<small>{c.text}</small></button>}</div></div>)}</div></section>
}
function RecentLog({ game, onFull }: { game: Game; onFull: () => void }) {
  return <section className="recent-log"><PanelTitle icon="book" trailing={<button onClick={onFull} className="text-button">Full log <Icon name="arrow" size={13}/></button>}>FLIGHT RECORDER</PanelTitle><div className="recent-log-list">{game.journal.slice(0, 2).map((entry, i) => <div key={`${entry.text}-${i}`}><span className="micro">{pad(entry.day)}:04</span><p className={entry.tone === 'success' ? 'teal-text' : ''}>{entry.text}</p></div>)}</div></section>
}

function GameCard({ card, onPlay, disabled, index, compact = false }: { card: Card; onPlay?: () => void; disabled?: boolean; index?: number; compact?: boolean }) {
  const def = CARDS[card.key]
  const body = <><div className="card-top"><span className="energy-cost">{def.cost}</span><span className="micro">{def.type}</span>{index !== undefined && <kbd>{index + 1}</kbd>}</div><div className="card-illustration"><div className="card-orbit"/><Icon name={def.icon} size={compact ? 26 : 34}/></div><div className="card-content"><h3>{def.name}{card.rank ? <span> +</span> : ''}</h3><p>{card.rank ? def.enhanced : def.text}</p></div><div className="card-footer"><span>{def.rarity}</span><span>{card.rank ? 'ENHANCED' : 'MK. I'}</span></div></>
  return onPlay ? <button className={`game-card ${def.type} ${compact ? 'compact' : ''}`} disabled={disabled} onClick={onPlay} aria-label={`Play ${def.name}${card.rank ? ' enhanced' : ''}, ${def.cost} energy. ${card.rank ? def.enhanced : def.text}`}>{body}</button> : <article className={`game-card ${def.type} ${compact ? 'compact' : ''}`}>{body}</article>
}

function Combat({ game, act, flash, onDeck }: { game: Game; act: (a: Action) => void; flash: { id: number; kind: string }; onDeck: () => void }) {
  const b = game.battle!, e = b.enemy, intent = currentIntent(game)!
  const intentText = { attack: 'Incoming attack', guard: 'Reinforcing shields', charge: 'Charging weapons', drain: 'Shield siphon', repair: 'Repairing hull' }[intent.kind]
  return <div className="combat-view">
    <section className="combat-arena">
      <div className="chart-toolbar"><span><span className="live-dot hostile"/> TACTICAL DISPLAY</span><span className="micro">ROUND {pad(b.turn)} <span className="muted"> / </span> {SECTORS[game.sector].code}</span></div>
      <div className="combat-ships">{flash.id > 0 && <div key={flash.id} className={`combat-fx ${flash.kind}`} aria-hidden="true"><span/></div>}<div className="combat-vessel friendly"><div className="combat-name"><span className="micro">YOUR VESSEL</span><h2>{SHIPS[game.ship].name}</h2><div className="combat-health"><Icon name="heart" size={13}/>{game.hull} / {game.maxHull}<span><Icon name="shield" size={13}/>{b.shield} shield</span></div><Meter value={game.hull} max={game.maxHull} label="Player hull"/></div><ShipArt variant={game.ship}/><div className="vessel-effects">{b.evade > 0 && <Badge tone="teal"><Icon name="eye" size={12}/>{b.evade} evade</Badge>}<span className="micro">WEAPON BONUS +{weaponBonus(game)}</span></div></div>
        <div className="versus"><span/><Icon name="crosshair" size={26}/><span/></div>
        <div className="combat-vessel enemy"><div className="combat-name"><span className="micro">{e.faction}</span><h2>{e.name}</h2><div className="combat-health"><Icon name="heart" size={13}/>{e.hull} / {e.maxHull}<span><Icon name="shield" size={13}/>{e.shield} shield</span></div><Meter value={e.hull} max={e.maxHull} tone="red" label="Enemy hull"/></div><ShipArt enemy/><div className="vessel-effects">{e.burn > 0 && <Badge tone="orange"><Icon name="sun" size={12}/>{e.burn} burn</Badge>}{e.vulnerable > 0 && <Badge tone="purple">Vulnerable {e.vulnerable} turns</Badge>}{e.power > 0 && <Badge tone="orange">+{e.power} power</Badge>}</div></div>
      </div>
      <div className="combat-readout"><div className="intent"><Icon name={intent.kind === 'guard' ? 'shield' : intent.kind === 'repair' ? 'wrench' : 'crosshair'} size={22}/><div><span className="micro">ENEMY INTENT</span><strong>{intentText} <span>{intent.value}</span></strong></div></div><div className="battle-message" role="status" aria-live="polite" key={flash.id}>{b.log[0]}</div><span className="micro intent-tip">{intent.kind === 'attack' || intent.kind === 'drain' ? `${b.evade ? 0 : Math.max(0, intent.value - b.shield)} projected hull damage${b.evade ? ' · evade ready' : ''}` : 'A window to strike.'}</span></div>
    </section>
    <section className="hand-panel"><div className="hand-toolbar"><div className="energy-display"><span><Icon name="bolt" size={22}/>{b.energy}</span><div><strong>Reactor energy</strong><small>Refills to {b.maxEnergy} each turn</small></div></div><button onClick={onDeck} className="text-button"><Icon name="layers" size={17}/>{b.draw.length} draw <span className="muted">/</span> {b.discard.length} discard <span className="muted">/</span> {b.exhaust.length} exhausted</button><button className="primary-button end-turn" onClick={() => act({ type: 'endTurn' })}>End turn <kbd>E</kbd><Icon name="arrow" size={15}/></button></div>
      <div className="hand-cards">{b.hand.map((c, i) => <GameCard key={`${b.turn}-${c.uid}`} card={c} index={i} onPlay={() => act({ type: 'play', index: i })} disabled={CARDS[c.key].cost > b.energy}/>)}{b.hand.length === 0 && <div className="empty-hand"><Icon name="layers" size={30}/><h3>All commands executed.</h3><p>End your turn to refill energy and draw a new hand.</p></div>}</div><div className="hand-hint">Click a card or press its number to play. Shields reset to {passiveShield(game)} at the start of your next turn.</div>
    </section>
    <CrewStrip game={game} act={act}/>
    <details className="battle-log"><summary>Combat transcript <span>{b.log.length} entries</span></summary>{b.log.map((line, i) => <p key={i}>{line}</p>)}</details>
  </div>
}

function EventView({ game, act }: { game: Game; act: (a: Action) => void }) {
  const event = EVENTS[game.event]
  return <section className="story-panel"><div className="story-art"><div className="signal-rings"><span/><span/><span/><Icon name={game.event === 2 ? 'sun' : 'signal'} size={56}/></div><span className="micro">TRANSMISSION RECEIVED</span><div className="waveform">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ height: `${8 + ((i * 17) % 37)}px` }}/>)}</div></div><div className="story-content"><div className="eyebrow">{event.eyebrow}</div><h2>{event.title}</h2><p className="story-prose">{event.text}</p><div className="event-choices">{event.choices.map((choice, i) => <button key={choice.title} onClick={() => act({ type: 'choice', index: i })} disabled={!choiceAvailable(game, i)}><span className="choice-number">{pad(i + 1)}</span><span><strong>{choice.title}</strong><small>{choice.text}</small></span><Icon name="arrow" size={18}/></button>)}</div><p className="micro">EVERY DECISION BECOMES PART OF YOUR STORY.</p></div></section>
}

function RewardView({ game, act }: { game: Game; act: (a: Action) => void }) {
  const r = game.reward!, relic = RELICS.find(a => a.id === r.relic)
  return <section className="reward-panel"><div className="reward-emblem"><Icon name="check" size={34}/></div><div className="eyebrow">CONTACT NEUTRALIZED · SALVAGE SECURED</div><h2>{r.boss ? 'The way forward is open.' : 'Another light stays on.'}</h2><p>Your crew catches their breath. Choose one recovered system to install.</p><div className="reward-loot"><Badge tone="orange"><Icon name="coin" size={15}/>+{r.credits} credits</Badge>{relic && <Badge tone="purple"><Icon name={relic.icon} size={15}/>{relic.name}</Badge>}</div>{relic && <p className="relic-explanation">{relic.text}</p>}<div className="reward-cards">{r.cards.map((key, i) => <div key={key}><GameCard card={{ key, uid: i, rank: 0 }}/><button className="secondary-button" onClick={() => act({ type: 'claim', key })}>Install system <Icon name="plus" size={15}/></button></div>)}</div><button className="text-button skip-reward" onClick={() => act({ type: 'claim', key: null })}>{r.boss ? game.sector === 2 ? 'Keep deck · follow the signal' : 'Keep deck · enter next sector' : 'Keep current deck · continue'}<Icon name="arrow" size={16}/></button>{r.boss && game.sector < 2 && <div className="micro">GATE TRANSIT RESTORES 25 HULL AND 6 FUEL</div>}</section>
}

function Station({ game, act }: { game: Game; act: (a: Action) => void }) {
  const node = game.nodes.find(n => n.id === game.current)!
  return <div className="station-view"><div className="station-welcome"><div className="station-symbol"><Icon name="hex" size={35}/></div><div><div className="eyebrow">INDEPENDENT TRADING POST</div><h2>{node.name}</h2><p>“You made it this far. Let’s get you a little further.”</p></div><button className="primary-button" onClick={() => act({ type: 'leave' })}>Undock <Icon name="arrow" size={16}/></button></div>
    <div className="station-services"><Service icon="wrench" title="Hull repair" text="Restore 30 hull integrity." cost={20} disabled={game.credits < 20 || game.hull === game.maxHull} onBuy={() => act({ type: 'buy', item: 'repair' })}/><Service icon="fuel" title="Refuel" text="Load 3 additional fuel cells." cost={15} disabled={game.credits < 15} onBuy={() => act({ type: 'buy', item: 'fuel' })}/>{(['weapons', 'shields', 'reactor'] as Upgrade[]).map(u => <Service key={u} icon={u === 'weapons' ? 'crosshair' : u === 'shields' ? 'shield' : 'bolt'} title={`${u[0].toUpperCase() + u.slice(1)} ${game.upgrades[u] >= (u === 'reactor' ? 2 : 3) ? 'maxed' : `MK. ${game.upgrades[u] + 2}`}`} text={u === 'weapons' ? '+2 damage per weapon hit.' : u === 'shields' ? '+3 passive shield every turn.' : '+1 energy every turn.'} cost={upgradeCost(game, u)} disabled={game.credits < upgradeCost(game, u) || game.upgrades[u] >= (u === 'reactor' ? 2 : 3)} onBuy={() => act({ type: 'buy', item: u })}/>)}</div>
    <PanelTitle icon="layers" trailing={<span className="micro">ONE OF EACH IN STOCK</span>}>SYSTEMS EXCHANGE</PanelTitle><div className="shop-cards">{game.shop.map((key, i) => <div key={key}><GameCard card={{ key, uid: i, rank: 0 }}/><button className="secondary-button" disabled={game.bought.includes(key) || game.credits < (CARDS[key].rarity === 'rare' ? 50 : 30)} onClick={() => act({ type: 'buy', item: key })}>{game.bought.includes(key) ? 'Installed' : <><Icon name="coin" size={14}/>{CARDS[key].rarity === 'rare' ? 50 : 30} credits</>}</button></div>)}</div>
    <details className="refit-deck"><summary><span><Icon name="wrench" size={16}/> Deck workshop</span><span>Enhance a card · 25 cr / Remove · 20 cr</span></summary><p>Enhance a system once for a stronger effect, or remove a card to draw your best systems more often. Keep at least 5 cards.</p><div className="refit-list">{game.deck.map(c => <div key={c.uid}><Icon name={CARDS[c.key].icon} size={19}/><span><strong>{CARDS[c.key].name}{c.rank ? ' +' : ''}</strong><small>{c.rank ? CARDS[c.key].enhanced : CARDS[c.key].text}</small></span><button className="secondary-button" disabled={!!c.rank || game.credits < 25} title={CARDS[c.key].enhanced} onClick={() => act({ type: 'upgradeCard', uid: c.uid })}>{c.rank ? 'Enhanced' : 'Enhance · 25'}</button><button className="text-button" disabled={game.deck.length <= 5 || game.credits < 20} onClick={() => act({ type: 'removeCard', uid: c.uid })}>Remove · 20</button></div>)}</div></details><div className="station-notice" role="status">{game.notice}</div>
  </div>
}
function Service({ icon, title, text, cost, disabled, onBuy }: { icon: string; title: string; text: string; cost: number; disabled: boolean; onBuy: () => void }) { return <article className="service"><Icon name={icon} size={26}/><h3>{title}</h3><p>{text}</p><button className="secondary-button" disabled={disabled} onClick={onBuy}><Icon name="coin" size={13}/>{cost} credits</button></article> }

function ShipView({ game, onDeck, onBridge }: { game: Game; onDeck: () => void; onBridge: () => void }) {
  return <div className="ship-view"><section className="hangar"><div className="hangar-heading"><div><span className="eyebrow">{SHIPS[game.ship].class}</span><h2>{SHIPS[game.ship].name}</h2></div><Badge tone="teal">FLIGHTWORTHY</Badge></div><ShipArt variant={game.ship}/><p>{SHIPS[game.ship].description}</p><div className="hangar-stats"><div><small>HULL</small><strong>{game.hull}<span>/{game.maxHull}</span></strong></div><div><small>SHIELD / TURN</small><strong>{passiveShield(game)}</strong></div><div><small>ENERGY / TURN</small><strong>{3 + game.upgrades.reactor}</strong></div><div><small>WEAPON BONUS</small><strong>+{weaponBonus(game)}</strong></div></div><button className="secondary-button" onClick={onDeck}><Icon name="layers" size={16}/> Inspect {game.deck.length} combat systems</button></section>
    <section className="crew-roster"><PanelTitle icon="heart">CREW MANIFEST</PanelTitle>{CREW.map((c, i) => <article key={c.id}><Portrait index={i} size={58}/><div><div className="micro" style={{ color: c.color }}>{c.role}</div><h3>{c.name}</h3><p>{c.quote}</p><strong>{c.ability}</strong><small>{c.text}</small></div></article>)}<p className="roster-note">Choose one crew ability per battle. Their expertise may turn an impossible fight into a narrow escape.</p></section>
    <section className="artifact-vault"><PanelTitle icon="orbit" trailing={<span className="micro">{game.relics.length} / {RELICS.length} RECOVERED</span>}>ARTIFACT VAULT</PanelTitle><div className="artifact-grid">{RELICS.map(r => <article key={r.id} className={game.relics.includes(r.id) ? 'discovered' : ''}><Icon name={r.icon} size={27}/><div><h3>{r.name}</h3><p>{r.text}</p></div>{!game.relics.includes(r.id) && <Icon name="lock" size={13}/>}</article>)}</div><p>Artifacts are recovered from ancient relays, elite enemies, guardians, and certain story choices.</p></section><button className="primary-button back-bridge" onClick={onBridge}>Return to bridge <Icon name="arrow" size={16}/></button></div>
}
function Archive({ game, best }: { game: Game; best: number }) {
  return <div className="archive-view"><div className="archive-stats">{[{ label: 'VOYAGE SCORE', value: score(game) }, { label: 'JUMPS MADE', value: game.stats.jumps }, { label: 'BATTLES WON', value: game.stats.battles }, { label: 'DAMAGE DEALT', value: game.stats.damage }, { label: 'PERSONAL BEST', value: best }].map(item => <div key={item.label}><span className="micro">{item.label}</span><strong>{item.value.toLocaleString()}</strong></div>)}</div><section className="achievements"><PanelTitle icon="crown">EXPEDITION MILESTONES</PanelTitle><div>{achievements(game).map(a => <article key={a.name} className={a.done ? 'unlocked' : ''}><Icon name={a.icon} size={24}/><span><strong>{a.name}</strong><small>{a.text}</small></span><Icon name={a.done ? 'check' : 'lock'} size={14}/></article>)}</div></section><section className="full-log"><PanelTitle icon="book" trailing={<span className="micro">VOYAGE {game.seed}</span>}>CAPTAIN’S LOG</PanelTitle>{game.journal.map((entry, i) => <article key={`${entry.day}-${i}`}><div className="log-date">DAY <strong>{pad(entry.day)}</strong></div><span className={`log-dot ${entry.tone}`}/><p>{entry.text}</p></article>)}</section></div>
}
function Ending({ game, best, onNew, onLog }: { game: Game; best: number; onNew: () => void; onLog: () => void }) {
  const won = game.phase === 'won'
  return <section className={`ending ${won ? 'won' : 'lost'}`}><div className="ending-stars"><Icon name={won ? 'sun' : 'orbit'} size={65}/></div><div className="eyebrow">{won ? 'TRANSMISSION COMPLETE · THE MERIDIAN' : 'TRANSMISSION LOST · FLIGHT RECORDER RECOVERED'}</div><h2>{won ? 'You were never alone.' : 'Even stars go quiet.'}</h2><p>{won ? game.reputation >= 5 ? 'Beyond the sentinel, the sleepers wake. The people you saved carry your signal across the Reach. This time, no one has to make the journey alone.' : 'The signal opens a door in the dark. On the other side, a thousand sleeping ships begin to wake. You have found them. Now the journey home can begin.' : 'The void keeps your vessel, but not your story. Somewhere in the Reach, another crew picks up the signal. There is still a way through.'}</p><div className="ending-score"><span className="micro">FINAL VOYAGE SCORE</span><strong>{score(game).toLocaleString()}</strong><span className="micro">PERSONAL BEST {Math.max(best, score(game)).toLocaleString()}</span></div><div className="ending-stats"><span>{game.stats.jumps} jumps</span><span>{game.stats.battles} victories</span><span>{game.relics.length} artifacts</span><span>{game.reputation} trust</span></div><div className="ending-actions"><button className="primary-button" onClick={onNew}>Begin another voyage <Icon name="arrow" size={17}/></button><button className="secondary-button" onClick={onLog}>Read captain’s log</button></div></section>
}

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement; dialog?.showModal(); return () => { dialog?.close(); previous?.focus() } }, [])
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose() } }} aria-labelledby="dialog-title"><div className="dialog-heading"><div><span className="eyebrow">VOIDWAKE / FLIGHT COMPUTER</span><h2 id="dialog-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></div><div className="dialog-body">{children}</div></dialog>
}
function Help() {
  return <div className="help-content"><p>Follow a strange transmission through <strong>three sectors</strong>. Defeat each sector’s guardian to open the next jump gate. Your hull, fuel, deck, and choices carry forward.</p><div className="help-step"><Icon name="map"/><div><h3>Plot a route</h3><p>Select any destination connected to your current location, then engage the jump drive. Each jump costs 1 fuel. Routes only go forward. Salvage repairs 4 hull and grants credits and 2 fuel. Relays repair 5 hull and grant an artifact.</p></div></div><div className="help-step"><Icon name="crosshair"/><div><h3>Command the fight</h3><p>Play cards using reactor energy. Read the enemy’s next intention, attack, and build shields before ending your turn. Each turn refills energy and draws a new hand. Unused cards are discarded. Shields reset to your passive value at the start of your turn.</p></div></div><div className="help-step"><Icon name="heart"/><div><h3>Trust your crew</h3><p>Use one crew ability per battle: Mara evades an attack, Ada repairs 10 hull, or Ren deals 15 piercing damage. Choose when their help matters most.</p></div></div><div className="help-step"><Icon name="hex"/><div><h3>Make the ship your own</h3><p>Stations sell repairs, fuel, cards, and permanent upgrades. The workshop enhances or removes cards. Combat victories offer one optional card. Artifacts grant passive bonuses for the whole voyage.</p></div></div><div className="glossary"><h3>Combat terms</h3><p><strong>Burn</strong> damages enemy hull before their action, then decreases by 2. <strong>Vulnerable</strong> increases damage taken by 50%. <strong>Exhaust</strong> removes a card for the rest of the current battle. <strong>Evade</strong> prevents one attack entirely.</p></div><div className="help-keys"><span><kbd>1</kbd>–<kbd>9</kbd> Play card</span><span><kbd>E</kbd> End turn</span><span><kbd>M</kbd> Bridge</span><span><kbd>D</kbd> Deck</span><span><kbd>Esc</kbd> Close</span></div><p className="help-save">Your voyage saves automatically in this browser. If you run out of fuel, use Emergency refuel on the sector map. Guardians restore 25 hull and 6 fuel before the next sector.</p></div>
}
function NewVoyage({ game, onLaunch }: { game: Game; onLaunch: (g: Game) => void }) {
  const [ship, setShip] = useState<ShipKey>(game.ship), [difficulty, setDifficulty] = useState<Game['difficulty']>(game.difficulty), [seed, setSeed] = useState('')
  return <form onSubmit={e => { e.preventDefault(); onLaunch(newGame(seed.trim() || `V-${Date.now().toString(36).slice(-6)}`, ship, difficulty)) }}><p className="dialog-intro">Three ships. Three sectors. One last signal. Launching replaces your current voyage; your personal best remains.</p><div className="ship-choices" role="group" aria-label="Choose your ship">{(Object.keys(SHIPS) as ShipKey[]).map(key => <button type="button" key={key} className={`ship-choice ${ship === key ? 'chosen' : ''}`} onClick={() => setShip(key)} aria-pressed={ship === key}><ShipArt variant={key}/><div className="micro">{SHIPS[key].class}</div><h3>{SHIPS[key].name}</h3><p>{SHIPS[key].description}</p><span>{SHIPS[key].hull} HULL <span>·</span> {SHIPS[key].shield} SHIELD</span>{ship === key && <Icon name="check" size={18} className="ship-chosen-mark"/>}</button>)}</div><div className="new-voyage-settings"><fieldset><legend>Difficulty</legend><label><input type="radio" name="difficulty" checked={difficulty === 'explorer'} onChange={() => setDifficulty('explorer')}/><span><strong>Explorer</strong><small>Gentler enemies. Repair 3 hull after every victory.</small></span></label><label><input type="radio" name="difficulty" checked={difficulty === 'captain'} onChange={() => setDifficulty('captain')}/><span><strong>Captain</strong><small>Full-strength enemies. Every resource matters.</small></span></label></fieldset><label className="seed-field">Voyage seed <input maxLength={24} value={seed} onChange={e => setSeed(e.target.value)} placeholder="Random signal"/><small>Share a seed to explore the same sector routes.</small></label></div><button className="primary-button launch-button" type="submit">Launch new voyage <Icon name="arrow" size={17}/></button></form>
}
