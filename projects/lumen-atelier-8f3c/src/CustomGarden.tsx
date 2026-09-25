import { useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { ArrowRight, Check, Copy, Eraser, LockKeyhole, Pencil, RotateCcw, RotateCw, Sprout, Undo2 } from 'lucide-react'
import { LEVELS, ports, simulate } from './game'
import type { Tile, TileKind } from './game'
import { CUSTOM_KINDS, CUSTOM_TITLE_LIMIT, encodeCustomGarden, validateCustomGarden } from './custom'
import './CustomGarden.css'

type Draft = { title: string; size: number; tiles: Tile[] }
type Tool = 'paint' | 'turn' | 'erase'
type CustomGardenProps = { onPlay: (code: string) => void; onNotice: (message: string) => void; onShare: (code: string) => void }
const STORAGE_KEY = 'lumen-garden-draft-v1'
const NAMES: Record<TileKind, string> = { source: 'Sun well', crystal: 'Crystal', straight: 'Channel', elbow: 'Bend', tee: 'Branch', cross: 'Cross', bridge: 'Bridge', gate: 'Gate', portal: 'Portal', rock: 'Ground' }
const DESCRIPTIONS: Record<TileKind, string> = {
  source: 'The beginning of the light. Its single socket points out.', crystal: 'The destination. Its single socket receives light.',
  straight: 'A straight channel with two opposite sockets.', elbow: 'A quarter-turn bend between two sockets.', tee: 'Three sockets let the light branch.',
  cross: 'Four sockets join and share their light.', bridge: 'Two crossing channels keep their light separate.',
  gate: 'Light enters behind the arrow and leaves at its tip.', portal: 'Two portals in the same pair carry light across the garden.', rock: 'Empty ground. Light cannot cross it.',
}
const DIRECTIONS = ['north', 'east', 'south', 'west']
const essentialFixed = (kind: TileKind) => ['source', 'crystal', 'rock', 'cross', 'bridge'].includes(kind)
const ground = (x: number, y: number): Tile => ({ id: `cell-${x}-${y}`, x, y, kind: 'rock', rotation: 0, fixed: true })
function exampleDraft(): Draft {
  const example = LEVELS[0]
  return { title: 'A Little Light', size: example.size, tiles: example.tiles.map((tile) => ({ ...tile, rotation: example.solution[tile.id] })) }
}
function loadDraft(): Draft {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored || stored.length > 16000) return exampleDraft()
    const draft: unknown = JSON.parse(stored)
    if (!draft || typeof draft !== 'object') return exampleDraft()
    const value = draft as Record<string, unknown>
    if (value.v !== 1 || typeof value.title !== 'string' || value.title.length > CUSTOM_TITLE_LIMIT || Array.from(value.title).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || ![5, 6, 7].includes(value.size as number) || !Array.isArray(value.tiles) || value.tiles.length !== Number(value.size) ** 2) return exampleDraft()
    const size = value.size as number
    const cells = new Set<string>()
    const tiles: Tile[] = []
    for (const candidate of value.tiles) {
      if (!candidate || typeof candidate !== 'object') return exampleDraft()
      const tile = candidate as Tile
      if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size || tile.id !== `cell-${tile.x}-${tile.y}` || cells.has(tile.id) || !CUSTOM_KINDS.includes(tile.kind) || !Number.isInteger(tile.rotation) || tile.rotation < 0 || tile.rotation > 3 || typeof tile.fixed !== 'boolean' || (tile.kind === 'portal' ? tile.pair !== 'a' && tile.pair !== 'b' : tile.pair !== undefined)) return exampleDraft()
      cells.add(tile.id)
      tiles.push({ id: tile.id, x: tile.x, y: tile.y, kind: tile.kind, rotation: tile.rotation, fixed: essentialFixed(tile.kind) || tile.fixed, ...(tile.pair ? { pair: tile.pair } : {}) })
    }
    return { title: value.title, size, tiles: tiles.sort((a, b) => a.y - b.y || a.x - b.x) }
  } catch { return exampleDraft() }
}

function StoneGlyph({ tile, lit = false, litPorts }: { tile: Tile; lit?: boolean; litPorts?: Set<number> }) {
  const color = lit ? '#f6d488' : '#9bb9a1'
  return <svg viewBox="0 0 48 48" aria-hidden="true" className="designer-stone-glyph">
    {ports(tile).map((port) => {
      const [x, y] = [[24, 0], [48, 24], [24, 48], [0, 24]][port]
      return <path key={port} d={`M24 24 L${x} ${y}`} stroke={litPorts ? litPorts.has(port) ? '#f6d488' : '#79988b' : color} strokeWidth="4" fill="none" strokeLinecap="round" />
    })}
    {tile.kind === 'rock' && <><path d="M17 31 Q17 19 29 17 Q29 29 17 31Z" fill="#718d7940" /><path d="M17 31 L26 21" stroke="#879a794a" fill="none" /></>}
    {tile.kind === 'source' && <><circle cx="24" cy="24" r="9" fill="#ddba6a" stroke="#ffdc8f" strokeWidth="1.5" /><circle cx="24" cy="24" r="4" fill="#f9e6ab" /><g stroke="#ddba6a" strokeWidth="1.5">{[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => <path key={angle} d="M24 10 V7" transform={`rotate(${angle} 24 24)`} />)}</g></>}
    {tile.kind === 'crystal' && <><path d="M24 11 L33 24 L24 37 L15 24Z" fill={lit ? '#e1e4a2' : '#8ab9b0'} stroke={lit ? '#fff1b0' : '#afd3c5'} strokeWidth="1.5" /><path d="M24 11 V37 L33 24Z" fill={lit ? '#f9d980' : '#527f7f'} /></>}
    {tile.kind === 'gate' && <g transform={`rotate(${tile.rotation * 90} 24 24)`}><path d="M16 23 L24 15 L32 23" stroke="#173f3a" strokeWidth="7" fill="none" /><path d="M16 23 L24 15 L32 23" stroke={color} strokeWidth="2.5" fill="none" /></g>}
    {tile.kind === 'bridge' && <><path d="M15 24 Q24 7 33 24" stroke="#163c38" strokeWidth="8" fill="none" /><path d="M15 24 Q24 7 33 24" stroke={litPorts?.has(1) || litPorts?.has(3) ? '#f6d488' : color} strokeWidth="4" fill="none" /></>}
    {tile.kind === 'portal' && <><circle cx="24" cy="24" r="11" fill="#284b49" stroke={lit ? '#f8d383' : '#c5b6d6'} strokeWidth="2" /><text x="24" y="28" textAnchor="middle" fontFamily="sans-serif" fontSize="11" fontWeight="600" fill={lit ? '#f8d383' : '#d2c6e1'}>{tile.pair?.toUpperCase()}</text></>}
    {tile.fixed && !essentialFixed(tile.kind) && <g transform="translate(34 4)"><rect x="0" y="4" width="7" height="6" rx="1" fill="#d4dcbe" /><path d="M1.5 4 V2.5 A2 2 0 0 1 5.5 2.5 V4" stroke="#d4dcbe" strokeWidth="1.4" fill="none" /></g>}
  </svg>
}

export default function CustomGarden({ onPlay, onNotice, onShare }: CustomGardenProps) {
  const [draft, setDraft] = useState<Draft>(loadDraft)
  const [history, setHistory] = useState<Draft[]>([])
  const [kind, setKind] = useState<TileKind>('elbow')
  const [rotation, setRotation] = useState(0)
  const [fixed, setFixed] = useState(false)
  const [pair, setPair] = useState('a')
  const [tool, setTool] = useState<Tool>('paint')
  const [focusedCell, setFocusedCell] = useState(0)
  const [saveMessage, setSaveMessage] = useState('Your draft stays on this device.')
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const light = simulate(draft.tiles)
  const problems = validateCustomGarden(draft.size, draft.tiles)
  const titleValid = Boolean(draft.title.trim()) && !Array.from(draft.title).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  const encoded = titleValid && problems.length === 0 ? encodeCustomGarden(draft.title, draft.size, draft.tiles) : null
  const brush: Tile = { id: 'brush', x: 0, y: 0, kind, rotation, fixed: essentialFixed(kind) || fixed, ...(kind === 'portal' ? { pair } : {}) }
  const selected = draft.tiles[focusedCell]

  function save(next: Draft) {
    setDraft(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...next }))
      setSaveMessage('Draft saved on this device.')
    } catch {
      setSaveMessage('Draft cannot be saved on this device.')
      onNotice('Device storage is unavailable. Keep this page open and copy your puzzle link when it is ready.')
    }
  }
  function commit(next: Draft) {
    setHistory((previous) => [...previous.slice(-79), draft])
    save(next)
  }
  function undo() {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((entries) => entries.slice(0, -1))
    setFocusedCell((current) => Math.min(current, previous.tiles.length - 1))
    save(previous)
  }
  function apply(index: number, turning = false, backwards = false) {
    const tile = draft.tiles[index]
    let next: Tile
    if (turning || tool === 'turn') next = { ...tile, rotation: (tile.rotation + (backwards ? 3 : 1)) % 4 }
    else if (tool === 'erase') next = ground(tile.x, tile.y)
    else next = { ...brush, id: tile.id, x: tile.x, y: tile.y }
    if (JSON.stringify(next) === JSON.stringify(tile)) return
    commit({ ...draft, tiles: draft.tiles.map((stone, i) => i === index ? next : stone) })
  }
  function resize(size: number) {
    if (size === draft.size) return
    const existing = new Map(draft.tiles.map((tile) => [tile.id, tile]))
    const tiles = Array.from({ length: size * size }, (_, i) => existing.get(`cell-${i % size}-${Math.floor(i / size)}`) ?? ground(i % size, Math.floor(i / size)))
    commit({ ...draft, size, tiles })
    setFocusedCell(0)
    if (size < draft.size) onNotice('The garden was trimmed to fit. Undo edit restores the previous size and stones.')
  }
  function handleCellKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -draft.size, ArrowDown: draft.size }
    if (event.key in offsets) {
      event.preventDefault()
      const tile = draft.tiles[index]
      if ((event.key === 'ArrowLeft' && tile.x === 0) || (event.key === 'ArrowRight' && tile.x === draft.size - 1)) return
      const target = index + offsets[event.key]
      if (target >= 0 && target < draft.tiles.length) cells.current[target]?.focus()
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault()
      apply(index, true, event.shiftKey)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      commit({ ...draft, tiles: draft.tiles.map((tile, i) => i === index ? ground(tile.x, tile.y) : tile) })
    }
  }

  return <section className="custom-designer" aria-label="Garden designer" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); undo() }
  }}>
    <div className="designer-intro"><div><span className="eyebrow">THE KEEPER’S DRAFTING TABLE</span><h2>Leave a little light<br /><i>for someone else.</i></h2></div><p>Arrange a garden with every crystal awake. We’ll turn the loose stones into a puzzle you can play and share.</p></div>
    <div className="designer-layout">
      <div className="designer-workspace">
        <div className="designer-canvas-header"><span><Sprout size={15} /> Your living blueprint</span><span className={light.solved ? 'all-lit' : ''}>{light.litCrystals} / {light.totalCrystals} crystals awake</span></div>
        <div className="designer-quick-brush" aria-label="Quick drawing controls">
          <span className="quick-brush-preview"><StoneGlyph tile={brush} lit /></span>
          <label><span className="sr-only">Quick stone choice</span><select value={kind} onChange={event => { setKind(event.target.value as TileKind); setTool('paint') }}>{CUSTOM_KINDS.map(stoneKind => <option key={stoneKind} value={stoneKind}>{NAMES[stoneKind]}</option>)}</select></label>
          <button type="button" onClick={() => setRotation(value => (value + 1) % 4)} aria-label="Rotate quick brush"><RotateCw size={16} /><span>{rotation * 90}°</span></button>
          {kind === 'portal' && <label><span className="sr-only">Quick portal pair</span><select value={pair} onChange={event => setPair(event.target.value)}><option value="a">Pair A</option><option value="b">Pair B</option></select></label>}
        </div>
        <div className="designer-canvas">
          <div className="designer-coordinate-top" style={{ '--garden-size': draft.size } as CSSProperties}>{Array.from({ length: draft.size }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
          <div className="designer-grid" role="group" aria-label={`${draft.size} by ${draft.size} editable garden`} style={{ '--garden-size': draft.size } as CSSProperties}>
            {draft.tiles.map((tile, index) => <button type="button" key={tile.id} ref={(element) => { cells.current[index] = element }} className={`designer-cell ${tile.kind === 'rock' ? 'ground' : ''} ${light.lit.has(tile.id) ? 'illuminated' : ''}`} tabIndex={index === focusedCell ? 0 : -1} aria-label={`Row ${tile.y + 1}, column ${tile.x + 1}: ${NAMES[tile.kind]}${tile.kind === 'portal' ? ` ${tile.pair?.toUpperCase()}` : ''}, sockets ${ports(tile).map((port) => DIRECTIONS[port]).join(' and ') || 'none'}${tile.fixed ? ', fixed in play' : ', turnable in play'}`} onFocus={() => setFocusedCell(index)} onClick={(event) => apply(index, event.shiftKey, event.shiftKey)} onKeyDown={(event) => handleCellKey(event, index)}><StoneGlyph tile={tile} lit={light.lit.has(tile.id)} litPorts={light.litPorts.get(tile.id)} /></button>)}
          </div>
          <div className="designer-canvas-caption"><span>{tool === 'paint' ? `Placing ${NAMES[kind].toLowerCase()}` : tool === 'turn' ? 'Turning existing stones' : 'Clearing stones'}</span><span>{selected ? `${selected.x + 1} · ${selected.y + 1}` : ''}</span></div>
        </div>
        <div className="designer-tools" role="group" aria-label="Editing tool">
          <button type="button" aria-pressed={tool === 'paint'} onClick={() => setTool('paint')}><Pencil size={14} /> Place</button>
          <button type="button" aria-pressed={tool === 'turn'} onClick={() => setTool('turn')}><RotateCw size={14} /> Turn</button>
          <button type="button" aria-pressed={tool === 'erase'} onClick={() => setTool('erase')}><Eraser size={14} /> Erase</button>
          <button type="button" className="designer-undo" disabled={!history.length} onClick={undo}><Undo2 size={14} /> Undo edit</button>
        </div>
        <p className="designer-shortcuts">Tap to use your tool. Shift + tap turns a stone backward.<br />Keyboard: arrow keys move, R turns, Delete clears.</p>
        <div className="designer-starts"><button type="button" onClick={() => { commit(exampleDraft()); setFocusedCell(0); onNotice('Example restored. Undo edit returns to your draft.') }}><RotateCcw size={12} /> Load example</button><button type="button" onClick={() => { commit({ ...draft, tiles: draft.tiles.map((tile) => ground(tile.x, tile.y)) }); onNotice('All stones cleared. Undo edit restores your garden.') }}>Clear all stones</button></div>
      </div>
      <aside className="designer-palette" aria-label="Garden design controls">
        <div className="designer-field"><label htmlFor="custom-garden-name">Garden name</label><input id="custom-garden-name" value={draft.title} maxLength={CUSTOM_TITLE_LIMIT} onChange={(event) => commit({ ...draft, title: event.target.value })} placeholder="Give your garden a name" autoComplete="off" /></div>
        <div className="designer-size"><span>Garden size</span><div role="group" aria-label="Garden size">{[5, 6, 7].map((size) => <button type="button" key={size} aria-pressed={draft.size === size} onClick={() => resize(size)}>{size} × {size}</button>)}</div></div>
        <div className="designer-palette-heading"><span className="eyebrow">YOUR STONES</span><span>Choose, then place</span></div>
        <div className="designer-stones" role="group" aria-label="Stone palette">{CUSTOM_KINDS.map((stoneKind) => <button type="button" key={stoneKind} aria-pressed={kind === stoneKind && tool === 'paint'} title={DESCRIPTIONS[stoneKind]} onClick={() => { setKind(stoneKind); setTool('paint') }}><StoneGlyph tile={{ ...brush, kind: stoneKind, rotation: 0, fixed: essentialFixed(stoneKind), pair: stoneKind === 'portal' ? pair : undefined }} /><span>{NAMES[stoneKind]}</span></button>)}</div>
        <div className="designer-brush"><div className="designer-brush-preview"><StoneGlyph tile={brush} lit /><button type="button" onClick={() => setRotation((value) => (value + 1) % 4)} aria-label="Rotate selected stone clockwise"><RotateCw size={17} /></button></div><div><strong>{NAMES[kind]} <span>{rotation * 90}°</span></strong><p>{DESCRIPTIONS[kind]}</p></div></div>
        {kind === 'portal' && <div className="designer-portal-pair"><span>Portal pair</span><div role="group" aria-label="Portal pair">{['a', 'b'].map((value) => <button type="button" key={value} aria-pressed={pair === value} onClick={() => setPair(value)}>Pair {value.toUpperCase()}</button>)}</div></div>}
        <label className="designer-lock"><input type="checkbox" checked={essentialFixed(kind) || fixed} disabled={essentialFixed(kind)} onChange={(event) => setFixed(event.target.checked)} /><LockKeyhole size={13} /><span>{essentialFixed(kind) ? 'This stone stays fixed during play' : 'Fix placed stones during play'}</span></label>
        <p className="designer-lock-note">The Turn tool can orient any stone while you design.</p>
      </aside>
    </div>
    <div className={`designer-validation ${encoded ? 'ready' : ''}`} aria-live="polite">
      <div className="designer-validation-copy"><span className="designer-validation-icon">{encoded ? <Check size={20} /> : <Sprout size={20} />}</span><div><h3>{encoded ? 'A new garden is ready to awaken.' : 'A little more tending.'}</h3>{encoded ? <p>Every crystal has a path. Your puzzle begins with the loose stones turned.</p> : <ul>{!titleValid && <li>Give your garden a name.</li>}{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}</div></div>
      <div className="designer-actions"><button type="button" className="primary-button" disabled={!encoded} onClick={() => { if (encoded) { save(draft); onPlay(encoded.code) } }}>Test this garden <ArrowRight size={15} /></button><button type="button" className="secondary-button" disabled={!encoded} onClick={() => { if (encoded) { save(draft); onShare(encoded.code) } }}><Copy size={13} /> Copy puzzle link</button></div>
    </div>
    <p className="designer-save-note">{saveMessage} Shared links contain the complete puzzle.</p>
  </section>
}
