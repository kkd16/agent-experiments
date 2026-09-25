import { useId, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { ports, type Level, type Tile, type simulate } from './game'
import { BOARD_THEMES } from './boardThemes'
import './Board.css'

type BoardProps = {
  level: Level
  tiles: Tile[]
  simulation: ReturnType<typeof simulate>
  onRotate: (id: string, delta?: number) => void
  hintId: string | null
  disabled?: boolean
  flat?: boolean
}

type Point = [number, number]
const directionNames = ['north', 'east', 'south', 'west']
const directionSteps: Point[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
const tileNames: Record<Tile['kind'], string> = {
  source: 'Sun well', crystal: 'Garden crystal', straight: 'Straight channel',
  elbow: 'Curved channel', tee: 'Three-way channel', cross: 'Four-way channel',
  bridge: 'Channel bridge', gate: 'One-way gate', portal: 'Moon gate', rock: 'Wild garden',
}
const isRotatable = (tile: Tile) => !tile.fixed && !['source', 'crystal', 'rock'].includes(tile.kind)

function channelPaths(tile: Tile, half: number) {
  const p: Point[] = [[0, -half], [half, 0], [0, half], [-half, 0]]
  const directions = ports(tile)
  if (directions.length === 2 && tile.kind !== 'gate') {
    const [a, b] = directions
    return [{ d: `M ${p[a]} Q 0 0 ${p[b]}`, directions }]
  }
  if (tile.kind === 'bridge') {
    return [
      { d: `M 0 ${-half} L 0 ${half}`, directions: [0, 2] },
      { d: `M ${-half} 0 L ${-half * .3} 0 Q 0 ${-half * .45} ${half * .3} 0 L ${half} 0`, directions: [1, 3] },
    ]
  }
  return directions.map(direction => ({ d: `M ${p[direction]} L 0 0`, directions: [direction] }))
}

function Plant({ x = 0, y = 0, scale = 1, flower = false }: { x?: number; y?: number; scale?: number; flower?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} aria-hidden="true">
    <path d="M 0 2 Q -3 -11 0 -25 M 0 -3 Q 7 -13 13 -16 M -1 -8 Q -10 -16 -13 -18" stroke="var(--garden-stem)" strokeWidth="1.5" fill="none" />
    <path d="M 0 -16 Q -15 -30 -13 -14 Q -4 -9 0 -16 M 0 -9 Q 15 -26 15 -11 Q 8 -4 0 -9 M 0 -23 Q -9 -35 0 -34 Q 7 -31 0 -23 M -4 -2 Q -21 -15 -17 -3 Q -10 4 -4 -2" fill="var(--garden-leaf)" />
    <path d="M 0 -15 Q 12 -31 11 -20 Q 8 -12 0 -15 M -1 1 Q 12 -13 15 -4 Q 11 5 -1 1" fill="var(--garden-leafDark)" />
    {flower && <g className="garden-flower"><g transform="translate(0 -34)"><path d="M 0 0 Q -14 -13 -8 -16 Q -2 -18 0 -4 Q 0 -20 6 -17 Q 14 -14 3 -3 Q 19 -7 17 -1 Q 13 5 2 2 Q 10 14 4 14 Q -3 11 -1 3 Q -14 12 -15 4 Q -15 -2 0 0" fill="var(--garden-petal)" /><circle r="3" fill="#eac886" /></g></g>}
  </g>
}

export default function Board({ level, tiles, simulation, onRotate, hintId, disabled = false, flat = false }: BoardProps) {
  const unique = useId().replace(/:/g, '')
  const tileRefs = useRef<Record<string, SVGGElement | null>>({})
  const gridSize = level.size
  const theme = BOARD_THEMES[level.chapter] ?? BOARD_THEMES[0]
  const themeStyle = Object.fromEntries(Object.entries(theme).filter(([name]) => name !== 'name').map(([name, value]) => [`--garden-${name}`, value])) as CSSProperties
  const step = flat ? Math.min(102, 536 / gridSize) : Math.min(57, 304 / gridSize)
  const half = step * .465
  const rise = half * 1.04
  const centerY = 354
  const left = 400 - gridSize * step * (flat ? .5 : 1)
  const right = 400 + gridSize * step * (flat ? .5 : 1)
  const top = centerY - gridSize * step * (flat ? .5 : .52)
  const bottom = centerY + gridSize * step * (flat ? .5 : .52)
  const depth = 23
  const activeCount = simulation.lit.size
  const id = (name: string) => `${unique}-${name}`
  const coords = (x: number, y: number): Point => flat
    ? [400 + (x - (gridSize - 1) / 2) * step, centerY + (y - (gridSize - 1) / 2) * step]
    : [400 + (x - y) * step, centerY + (x + y - gridSize + 1) * step * .52]
  const sorted = [...tiles].sort((a, b) => a.x + a.y - b.x - b.y || a.x - b.x)
  const cells = new Map(tiles.map(tile => [`${tile.x},${tile.y}`, tile]))
  const surface = flat
    ? `M ${-half} ${-half} H ${half} V ${half} H ${-half} Z`
    : `M 0 ${-rise} L ${half * 2} 0 L 0 ${rise} L ${-half * 2} 0 Z`

  function handleKey(event: KeyboardEvent<SVGGElement>, tile: Tile) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!disabled && isRotatable(tile)) onRotate(tile.id, event.shiftKey ? -1 : 1)
      return
    }
    const moves: Record<string, Point> = { ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1], ArrowLeft: [-1, 0] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    let [x, y] = [tile.x + move[0], tile.y + move[1]]
    while (x >= 0 && y >= 0 && x < gridSize && y < gridSize) {
      const next = tiles.find(item => item.x === x && item.y === y && isRotatable(item))
      if (next) { tileRefs.current[next.id]?.focus(); return }
      x += move[0]
      y += move[1]
    }
  }

  return <div className={`garden-scene garden-scene--${theme.name}${simulation.solved ? ' garden-scene--awakened' : ''}${flat ? ' garden-scene--flat' : ''}`} style={themeStyle} data-view={flat ? 'overhead' : 'isometric'} data-chapter={level.chapter}>
    <svg className="garden-board" viewBox={flat ? '105 30 590 620' : '0 70 800 580'} aria-label="Interactive light garden puzzle. Rotate the stone channels to connect the sun well to every crystal." role="group">
      <defs>
        <radialGradient id={id('atmosphere')}><stop offset="0" stopColor="var(--garden-atmosphere)" stopOpacity=".3" /><stop offset="1" stopColor="var(--garden-base)" stopOpacity="0" /></radialGradient>
        <radialGradient id={id('ground-glow')}><stop offset="0" stopColor="#f4d386" stopOpacity=".13" /><stop offset="1" stopColor="#edc578" stopOpacity="0" /></radialGradient>
        <linearGradient id={id('stone')} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="var(--garden-stone)" /><stop offset="1" stopColor="var(--garden-stoneShade)" /></linearGradient>
        <linearGradient id={id('stone-lit')} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="var(--garden-lit)" /><stop offset="1" stopColor="var(--garden-litShade)" /></linearGradient>
        <linearGradient id={id('stone-left')} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--garden-side)" /><stop offset="1" stopColor="var(--garden-deep)" /></linearGradient>
        <linearGradient id={id('stone-right')} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--garden-rim)" /><stop offset="1" stopColor="var(--garden-side)" /></linearGradient>
        <linearGradient id={id('base')} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--garden-deep)" /><stop offset="1" stopColor="var(--garden-base)" /></linearGradient>
        <linearGradient id={id('beam')} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#f1d494" stopOpacity="0" /><stop offset="1" stopColor="#f1d494" stopOpacity=".4" /></linearGradient>
        <linearGradient id={id('crystal')}><stop stopColor="#fff4be" /><stop offset=".5" stopColor="#eacb87" /><stop offset="1" stopColor="#a67b41" /></linearGradient>
        <filter id={id('glow')} x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3.5" /></filter>
        <filter id={id('bloom')} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="12" /></filter>
        <filter id={id('shadow')} x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur stdDeviation="15" /></filter>
      </defs>

      <g className="scene-atmosphere" aria-hidden="true">
        <ellipse cx="400" cy="353" rx="370" ry={flat ? 350 : 278} fill={`url(#${id('atmosphere')})`} />
        <ellipse cx="400" cy={bottom + 51} rx="219" ry="40" fill="#0c241c" opacity=".58" filter={`url(#${id('shadow')})`} />
        <ellipse cx="400" cy="377" rx="356" ry={flat ? 310 : 189} className="orbit-line" />
        <ellipse cx="400" cy="377" rx="339" ry={flat ? 300 : 180} className="orbit-line orbit-line--inner" />
        <path d="M 86 428 Q 55 370 87 326 M 713 327 Q 745 375 713 423" fill="none" stroke="var(--garden-leaf)" strokeOpacity=".19" strokeWidth="1" />
        <path d="M 397 176 L 400 170 L 403 176 L 400 182 Z M 397 576 L 400 570 L 403 576 L 400 582 Z" fill="#b7b798" opacity=".4" />
        <path d="M 47 374 L 53 374 M 747 374 L 753 374 M 400 147 L 400 153 M 400 596 L 400 602" stroke="#b7b798" opacity=".4" />
        <ellipse cx="400" cy="373" rx="270" ry="187" fill={`url(#${id('ground-glow')})`} opacity={.3 + activeCount / (gridSize * gridSize)} />
        {Array.from({ length: 20 }, (_, index) => <circle key={index} className="garden-mote" cx={93 + ((index * 137) % 614)} cy={130 + ((index * 83) % 407)} r={index % 4 === 0 ? 1.8 : 1} fill={index % 3 === 0 ? '#e4c98c' : 'var(--garden-leaf)'} style={{ animationDelay: `${-index * 1.6}s`, animationDuration: `${7 + index % 5}s` }} />)}
      </g>

      <g aria-hidden="true" className="garden-island">
        <path d={flat ? `M ${left} ${bottom} H ${right} L ${right - 5} ${bottom + 13} H ${left + 5} Z` : `M ${left} ${centerY + 6} L 400 ${bottom + 6} L ${right} ${centerY + 6} L ${right - 9} ${centerY + depth + 3} L 400 ${bottom + depth + 9} L ${left + 9} ${centerY + depth + 3} Z`} fill={`url(#${id('base')})`} />
        <path d={flat ? `M ${left} ${top} H ${right} V ${bottom} H ${left} Z` : `M ${left} ${centerY + 6} L 400 ${top + 6} L ${right} ${centerY + 6} L 400 ${bottom + 6} Z`} fill="var(--garden-base)" stroke="var(--garden-rim)" strokeWidth="1" />
        {!flat && <>
          <path d={`M ${left + 1} ${centerY + 17} L 400 ${bottom + 17} L ${right - 1} ${centerY + 17}`} fill="none" stroke="var(--garden-rim)" strokeOpacity=".35" />
          <path d={`M ${left + 12} ${centerY + 28} L 400 ${bottom + 28} L ${right - 12} ${centerY + 28}`} fill="none" stroke="#172f26" strokeWidth="2" opacity=".7" />
          <path d={`M ${left + 94} ${centerY + 76} Q ${left + 96} ${centerY + 117} ${left + 117} ${centerY + 113} M ${left + 100} ${centerY + 80} Q ${left + 122} ${centerY + 113} ${left + 111} ${centerY + 133} M ${right - 105} ${centerY + 79} Q ${right - 136} ${centerY + 126} ${right - 113} ${centerY + 128} M 424 ${bottom + 9} Q 409 ${bottom + 53} 422 ${bottom + 59}`} fill="none" stroke="var(--garden-leafDark)" strokeWidth="2.2" />
        </>}
        <Plant x={left + 35} y={centerY + 9} scale={.9} />
        <Plant x={right - 30} y={centerY + 7} scale={1} flower />
        {!flat && <><Plant x={left + 101} y={centerY + 90} scale={.52} /><Plant x={right - 107} y={centerY + 104} scale={.55} />
          <path d={`M 395 ${bottom + 29} L 400 ${bottom + 36} L 405 ${bottom + 29}`} fill="none" stroke="#c6b883" strokeWidth="1.5" opacity=".7" /></>}
      </g>

      {sorted.map(tile => {
        const [x, y] = coords(tile.x, tile.y)
        const lit = simulation.lit.has(tile.id)
        const litPorts = simulation.litPorts.get(tile.id) ?? new Set<number>()
        const tilePorts = ports(tile)
        const rotatable = isRotatable(tile)
        const paths = channelPaths(tile, half + 1)
        const selected = hintId === tile.id
        const label = `${tileNames[tile.kind]}${tile.kind === 'portal' && tile.pair ? ` ${tile.pair.toUpperCase()}` : ''}, row ${tile.y + 1}, column ${tile.x + 1}. ${tile.kind === 'rock' ? '' : `${lit ? 'Lit' : 'Unlit'}. Channels ${tilePorts.map(direction => directionNames[direction]).join(' and ')}.`}${rotatable ? ' Press Enter to rotate clockwise, Shift Enter counterclockwise.' : ' Fixed.'}`
        const crystalColor = lit ? '#f5d68f' : '#8caab0'
        const tinySeed = ((tile.x * 13 + tile.y * 29) % 7)
        const frontier = simulation.solved || tile.kind === 'crystal' ? [] : [...litPorts].filter(direction => {
          const [dx, dy] = directionSteps[direction]
          const neighbor = cells.get(`${tile.x + dx},${tile.y + dy}`)
          const entry = (direction + 2) % 4
          return !neighbor || !ports(neighbor).includes(entry) || (neighbor.kind === 'gate' && entry !== (neighbor.rotation + 2) % 4)
        })
        return <g key={tile.id} transform={`translate(${x} ${y})`} className={`garden-tile${rotatable ? ' garden-tile--rotatable' : ''}${lit ? ' garden-tile--lit' : ''}${selected ? ' garden-tile--hint' : ''}`} data-tile-id={tile.id}>
          <g className="tile-lift">
            <path d={flat ? `M ${-half} ${half} H ${half} V ${half + 5} H ${-half} Z` : `M ${-half * 2} 0 L 0 ${rise} L 0 ${rise + 13} L ${-half * 2} 13 Z`} fill={`url(#${id('stone-left')})`} />
            {!flat && <><path d={`M 0 ${rise} L ${half * 2} 0 L ${half * 2} 13 L 0 ${rise + 13} Z`} fill={`url(#${id('stone-right')})`} />
              <path d={`M ${-half * 2} 9 L 0 ${rise + 9} L ${half * 2} 9`} fill="none" stroke="var(--garden-base)" strokeOpacity=".22" /></>}
            <path className="tile-surface" d={surface} fill={`url(#${id(lit ? 'stone-lit' : 'stone')})`} stroke="var(--garden-edge)" strokeWidth=".8" />
            <g transform={flat ? undefined : 'matrix(1 .52 -1 .52 0 0)'} aria-hidden="true">
              <path d={`M ${-half + 4} ${-half + 9} L ${-half + 4} ${-half + 4} L ${-half + 9} ${-half + 4} M ${half - 9} ${half - 4} L ${half - 4} ${half - 4} L ${half - 4} ${half - 9}`} fill="none" stroke="var(--garden-rim)" strokeWidth=".8" opacity=".55" />
              {tinySeed < 2 && <path d={`M ${half - 5} ${-half} L ${half - 7} ${-half + 5} L ${half - 4} ${-half + 8}`} fill="none" stroke="var(--garden-rim)" opacity=".4" />}
              {paths.map((path, pathIndex) => <g key={pathIndex}>
                <path d={path.d} fill="none" stroke="var(--garden-edge)" strokeWidth="10" strokeLinecap="round" />
                <path d={path.d} fill="none" stroke="var(--garden-rim)" strokeWidth="8" strokeLinecap="round" />
                <path d={path.d} fill="none" stroke="var(--garden-groove)" strokeWidth="5" strokeLinecap="round" />
                {path.directions.every(direction => litPorts.has(direction)) && <>
                  <path d={path.d} className="channel-bloom" fill="none" stroke="#f4c778" strokeWidth="9" filter={`url(#${id('glow')})`} />
                  <path d={path.d} fill="none" stroke="#e9bc6a" strokeWidth="4" strokeLinecap="round" />
                  <path d={path.d} className="channel-light" fill="none" stroke="#fff2bc" strokeWidth="1.8" strokeLinecap="round" />
                  <path d={path.d} className="channel-flow" fill="none" stroke="#fffbed" strokeWidth="2.5" strokeLinecap="round" pathLength="100" style={{ animationDelay: `${-(tile.x + tile.y) * .11}s` }} />
                </>}
              </g>)}
              {tile.kind === 'gate' && <g transform={`rotate(${tile.rotation * 90})`}><path d="M -7 2 L 0 -6 L 7 2 M -7 9 L 0 1 L 7 9" fill="none" stroke={lit ? '#fff1b1' : 'var(--garden-edge)'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></g>}
              {tile.kind === 'bridge' && <path d={`M ${-half * .28} -6 L ${-half * .28} 5 M ${half * .28} -6 L ${half * .28} 5`} stroke="var(--garden-edge)" strokeWidth="1.7" />}
              {tile.fixed && !['rock', 'source', 'crystal'].includes(tile.kind) && <g transform={`translate(${half - 10} ${-half + 10})`}><rect x="-3.5" y="-1" width="7" height="5.5" rx="1" fill="var(--garden-deep)" /><path d="M -2 -1 L -2 -3 A 2 2 0 0 1 2 -3 L 2 -1" fill="none" stroke="var(--garden-deep)" strokeWidth="1.5" /><circle cy="1.5" r=".8" fill="var(--garden-edge)" /></g>}
              {frontier.map(direction => <g key={direction} className="light-frontier" transform={`rotate(${direction * 90})`}>
                <path d={`M -4 ${-half + 3} H 4`} stroke="#f8dca0" strokeWidth="2.5" strokeLinecap="round" />
                <circle cy={-half - 2} r="1.8" fill="#fff7d5" />
              </g>)}
            </g>

            {tile.kind === 'rock' && <g aria-hidden="true">
              <ellipse cx="0" cy="5" rx={half * 1.1} ry={half * .43} fill="var(--garden-leafDark)" opacity=".5" />
              <g transform={`translate(${tinySeed % 3 - 1} 2) scale(${.7 + (tinySeed % 4) * .1} ${level.chapter === 2 ? 1.1 + (tinySeed % 3) * .25 : .62 + (tinySeed % 3) * .19})`}>
                <path d="M -16 1 L -11 -14 L 0 -21 L 11 -10 L 13 3 L 0 11 Z" fill="var(--garden-side)" />
                <path d="M -11 -14 L 0 -21 L 11 -10 L 0 -5 L -16 1 Z" fill="var(--garden-stoneShade)" />
                <path d="M 0 -5 L 11 -10 L 13 3 L 0 11 Z" fill="var(--garden-deep)" />
              </g>
              <Plant x={-11} y={5} scale={.5 + (tinySeed % 3) * .1} flower={simulation.solved || tinySeed === 0 || tinySeed === 4} />
              <Plant x={12} y={4} scale={.28 + (tinySeed % 2) * .12} />
              {level.chapter === 3 && tinySeed < 3 && <g stroke="var(--garden-stem)" strokeWidth="1.3" fill="none"><path d="M 10 5 Q 5 -14 9 -30 M 13 4 Q 12 -12 18 -24 M 7 4 Q -1 -7 2 -21" /><path d="M 9 -30 L 9 -36 M 18 -24 L 20 -29 M 2 -21 L 1 -26" stroke="var(--garden-petal)" strokeWidth="3" strokeLinecap="round" /></g>}
              {level.chapter === 5 && tinySeed < 3 && <path d="M -8 0 L -8 -13 A 8 10 0 0 1 8 -13 L 8 0" fill="none" stroke="var(--garden-edge)" strokeWidth="3" opacity=".65" />}
              <circle cx="-6" cy="9" r="1.8" fill="var(--garden-petal)" />
            </g>}

            {tile.kind === 'source' && <g className="sun-well" aria-hidden="true">
              <ellipse cy="-1" rx="21" ry="11" fill="#c6c9a7" stroke="#738567" strokeWidth="2" />
              <ellipse cy="-4" rx="16" ry="8" fill="#536b4e" stroke="#ded9a9" strokeWidth="2" />
              <ellipse cy="-6" rx="10" ry="5" fill="#edd189" />
              {!flat && <path d="M -12 -8 L -21 -119 L 21 -119 L 12 -8 Z" fill={`url(#${id('beam')})`} />}
              <ellipse cy="-12" rx="23" ry="15" fill="#f4d289" opacity=".5" filter={`url(#${id('bloom')})`} />
              <path d="M -7 -8 L -7 -40 L 0 -47 L 7 -40 L 7 -8 L 0 -4 Z" fill="#a9ae7e" />
              <path d="M -7 -40 L 0 -47 L 0 -11 L -7 -8 Z" fill="#e3d699" />
              <path d="M 0 -47 L 7 -40 L 7 -8 L 0 -11 Z" fill="#8c9769" />
              <g className="sun-halo">
                <circle cy="-54" r="19" fill="none" stroke="#c4ac6b" strokeWidth="1" opacity=".65" />
                <circle cy="-54" r="14" fill="none" stroke="#ead49d" strokeWidth=".8" />
                <path d="M 0 -78 L 0 -75 M 0 -33 L 0 -30 M -24 -54 L -21 -54 M 21 -54 L 24 -54" stroke="#ead49d" />
              </g>
              <circle cy="-54" r="11" fill="#f9e0a1" filter={`url(#${id('glow')})`} />
              <circle cy="-54" r="8" fill="#fff0bb" />
              <circle cx="-2" cy="-56" r="3" fill="#fff9df" />
            </g>}

            {tile.kind === 'crystal' && <g className={`garden-crystal${lit ? ' garden-crystal--lit' : ''}`} aria-hidden="true">
              <ellipse cy="2" rx="17" ry="8" fill="var(--garden-side)" opacity=".5" />
              <path d="M -13 0 L 0 -7 L 13 0 L 0 7 Z" fill="var(--garden-stoneShade)" stroke="var(--garden-edge)" strokeWidth="1.5" />
              {lit && <>
                <ellipse className="crystal-awakening-ring" cy="1" rx="22" ry={flat ? 19 : 11} fill="none" stroke="#ffdf9e" strokeWidth="1.5" />
                <ellipse className="crystal-aura" cy="-20" rx="23" ry="24" fill="#f4d289" opacity=".43" filter={`url(#${id('bloom')})`} />
                <g className="crystal-petals"><Plant x={-16} y={5} scale={.32} flower /><Plant x={18} y={5} scale={.26} flower /></g>
              </>}
              <g className="crystal-float">
                <path d="M 0 -45 L 11 -28 L 0 -9 L -11 -28 Z" fill={lit ? `url(#${id('crystal')})` : 'var(--garden-crystal)'} stroke={lit ? '#ffe9ae' : 'var(--garden-edge)'} strokeWidth="1" />
                <path d="M 0 -45 L 0 -25 L -11 -28 Z" fill={lit ? '#fff3c7' : 'var(--garden-stone)'} />
                <path d="M 0 -25 L 11 -28 L 0 -9 Z" fill={lit ? '#c29752' : 'var(--garden-deep)'} />
                <path d="M -11 -28 L 0 -25 L 11 -28 M 0 -45 L 0 -9" fill="none" stroke={lit ? '#fce3a9' : 'var(--garden-rim)'} strokeWidth=".7" />
                {lit && <path d="M 18 -44 L 18 -38 M 15 -41 L 21 -41 M -18 -21 L -18 -17 M -20 -19 L -16 -19" stroke={crystalColor} strokeWidth="1" />}
              </g>
              <path d="M -17 1 Q -24 -8 -20 -10 Q -13 -9 -14 -1 M 15 2 Q 24 -6 24 -2 Q 24 4 15 5" fill="var(--garden-leafDark)" />
            </g>}

            {tile.kind === 'portal' && <g className={`moon-gate${lit ? ' moon-gate--lit' : ''}`} aria-hidden="true">
              <ellipse cy="2" rx="17" ry="9" fill="var(--garden-stoneShade)" stroke="var(--garden-edge)" />
              <ellipse cy="-8" rx="10" ry="16" fill={lit ? 'var(--garden-deep)' : 'var(--garden-side)'} fillOpacity=".6" stroke={lit ? 'var(--garden-petal)' : 'var(--garden-crystal)'} strokeWidth="4" />
              <ellipse cy="-8" rx="7" ry="13" fill="none" stroke={lit ? 'var(--garden-edge)' : 'var(--garden-rim)'} strokeWidth="1" />
              <text className="portal-pair-label" x="0" y="-3.5" textAnchor="middle" fill={lit ? '#fff0bc' : 'var(--garden-edge)'} fontFamily="DM Sans, sans-serif" fontSize="13" fontWeight="700">{tile.pair?.toUpperCase()}</text>
              <path d="M -16 -16 L -18 -18 M 16 -16 L 18 -18" stroke="var(--garden-rim)" />
            </g>}
          </g>

          <g ref={node => { tileRefs.current[tile.id] = node }} className="tile-hit" role={rotatable ? 'button' : 'img'} tabIndex={rotatable && !disabled ? 0 : undefined} aria-label={label} aria-disabled={rotatable ? disabled : undefined} onClick={event => { if (rotatable && !disabled) onRotate(tile.id, event.shiftKey ? -1 : 1) }} onContextMenu={event => { if (rotatable && !disabled) { event.preventDefault(); onRotate(tile.id, -1) } }} onKeyDown={event => handleKey(event, tile)}>
            <title>{label}</title>
            <path className="tile-interaction-outline" d={surface} fill="transparent" stroke="transparent" strokeWidth="2" />
            {selected && <g className="tile-hint-mark" pointerEvents="none"><path d={`M -7 ${-rise - 14} L 0 ${-rise - 7} L 7 ${-rise - 14}`} fill="none" stroke="#fff0af" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /><path d={`M 0 ${-rise - 8} L 0 ${-rise - 24}`} stroke="#fff0af" strokeWidth="2.5" strokeLinecap="round" /></g>}
          </g>
        </g>
      })}

      <g className="scene-footer" aria-hidden="true" visibility={flat ? 'hidden' : undefined}>
        <path d="M 366 627 L 388 627 M 412 627 L 434 627" stroke="var(--garden-rim)" strokeWidth=".7" opacity=".55" />
        <path d="M 400 621 L 406 627 L 400 633 L 394 627 Z" fill="none" stroke="#c8bc8b" strokeWidth=".8" opacity=".8" />
        <circle cx="400" cy="627" r="1.7" fill="#c8bc8b" />
      </g>
    </svg>
  </div>
}
