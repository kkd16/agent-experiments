import { useId } from 'react'
import type { CSSProperties } from 'react'

const paths: Record<string, React.ReactNode> = {
  ship: <><path d="m12 2 7 17-7-4-7 4L12 2Z"/><path d="M12 15v7M7 21l1-3m9 3-1-3"/></>,
  map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z"/><path d="M9 3v16m6-14v16"/></>,
  crosshair: <><circle cx="12" cy="12" r="7"/><path d="M12 1v6m0 10v6M1 12h6m10 0h6"/><circle cx="12" cy="12" r="1"/></>,
  shield: <><path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Z"/><path d="m8 11 3 3 5-6"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z"/>,
  fuel: <><path d="M4 21V4h10v17M2 21h14M6 7h6v5H6zM14 8h3l3 4v6a2 2 0 0 1-4 0v-4M17 4l4 4v4"/></>,
  coin: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="M15 8h-5v8h5M8 12h6"/></>,
  heart: <path d="M20.5 4.6a5.5 5.5 0 0 0-8.5 1 5.5 5.5 0 0 0-8.5-1c-4.5 5 2.8 11.5 8.5 16 5.7-4.5 13-11 8.5-16Z"/>,
  signal: <><path d="M8 16a6 6 0 0 1 0-8m8 0a6 6 0 0 1 0 8M5 19a10 10 0 0 1 0-14m14 0a10 10 0 0 1 0 14"/><circle cx="12" cy="12" r="2"/><path d="M12 14v8"/></>,
  layers: <><path d="m12 2 10 6-10 6L2 8l10-6Zm-10 11 10 6 10-6M2 18l10 5 10-5"/></>,
  hex: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m12 7 5 3v5l-5 3-5-3v-5l5-3Z"/></>,
  orbit: <><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="11" ry="6" transform="rotate(-35 12 12)"/><circle cx="5" cy="6" r="1.5"/></>,
  crown: <><path d="m2 6 5 5 5-8 5 8 5-5-3 13H5L2 6ZM5 22h14"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m8 16 8-8M13 8h3v3"/></>,
  wrench: <><path d="M14 3a6 6 0 0 0-7 7L2 18l4 4 8-8a6 6 0 0 0 7-7l-5 4-3-3 3-5h-2Z"/></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
  rocket: <><path d="M10 14S8 6 21 3c-1 13-10 12-10 12M9 9l-5 1-2 5 6-1m7 1-1 6-5 2 1-7M7 17l-4 4"/><circle cx="16" cy="8" r="1.5"/></>,
  radar: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 8-8M12 3v2M3 12h2m7 7v2m7-9h2"/></>,
  book: <><path d="M4 3h13l3 3v15H4V3ZM8 7h7M8 11h8m-8 4h5"/></>,
  arrow: <path d="M3 12h17m-6-6 6 6-6 6"/>,
  check: <path d="m4 12 5 5L20 6"/>,
  close: <path d="m5 5 14 14M5 19 19 5"/>,
  help: <><circle cx="12" cy="12" r="10"/><path d="M9 8a3 3 0 1 1 5 3l-2 2v2m0 2v1"/></>,
  sound: <><path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
  mute: <><path d="m11 4-6 5H2v6h3l6 5V4Zm5 5 6 6m0-6-6 6"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  refresh: <><path d="M20 8a9 9 0 1 0 1 8M20 2v6h-6"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3"/></>,
}
export function Icon({ name, size = 20, className = '', style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">{paths[name] ?? paths.hex}</svg>
}

export function ShipArt({ enemy = false, variant = 'wayfarer', className = '' }: { enemy?: boolean; variant?: string; className?: string }) {
  const id = useId().replace(/:/g, '')
  const accent = enemy ? '#e68d75' : variant === 'kestrel' ? '#efb47f' : variant === 'bulwark' ? '#b0a1d4' : '#8bc6c5'
  return <svg className={`ship-art ${className}`} viewBox="0 0 500 280" fill="none" aria-label={enemy ? 'Hostile warship' : `${variant} spacecraft`} role="img">
    <defs>
      <linearGradient id={`${id}-body`} x1="0" y1="40" x2="0" y2="230" gradientUnits="userSpaceOnUse"><stop stopColor={enemy ? '#68504c' : '#6c7b84'}/><stop offset=".44" stopColor={enemy ? '#393233' : '#3a4c5a'}/><stop offset="1" stopColor="#111d29"/></linearGradient>
      <linearGradient id={`${id}-engine`}><stop stopColor={accent} stopOpacity="0"/><stop offset=".75" stopColor={accent} stopOpacity=".6"/><stop offset="1" stopColor="#e2f4f4"/></linearGradient>
      <filter id={`${id}-glow`}><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    <g transform={enemy ? 'translate(500 0) scale(-1 1)' : undefined}>
      <path d="M18 96 120 89v24L18 106Z" fill={`url(#${id}-engine)`} filter={`url(#${id}-glow)`}/><path d="M18 175 120 168v24L18 185Z" fill={`url(#${id}-engine)`} filter={`url(#${id}-glow)`}/>
      <path d="m106 89 72-38 78 7 38 46 135 21 41 15-41 17-135 20-38 46-78 7-72-38 19-38v-28l-19-37Z" fill={`url(#${id}-body)`} stroke="#8897a0" strokeWidth="1.2"/>
      <path d="m173 55 26-27 41 6 50 59-77-14-40-24Zm0 170 26 27 41-6 50-59-77 14-40 24Z" fill="#263541" stroke="#70818c"/>
      <path d="m139 114 95-15 130 26 62 15-62 16-130 25-95-15v-52Z" fill="#263948" stroke="#768a96"/>
      <path d="m220 117 116 12 48 11-48 12-116 11-18-23 18-23Z" fill="#5a6c75" stroke="#92a2aa"/>
      <path d="m272 128 63 5 18 7-18 7-63 5 9-12-9-12Z" fill="#132c37" stroke={accent}/>
      <path d="m350 126 48 7 18 7-18 7-48 6 25-13-25-14Z" fill="#111f2c"/>
      <path d="M158 85h52v18h-52zM158 177h52v18h-52z" fill="#182a36" stroke="#84939a"/>
      <path d="M161 92h83m-83 94h83" stroke={accent} strokeWidth="3"/>
      <path d="M114 91h32v23h-32zM114 167h32v23h-32z" fill="#182431" stroke="#93a3aa"/>
      <path d="M118 95v15m0 61v15" stroke={accent} strokeWidth="4"/>
      <path d="M169 122h27v36h-27z" fill="#1c303f" stroke="#738c9b"/><path d="M175 129h15m-15 7h15m-15 7h15m-15 7h15" stroke="#84939a"/>
      <path d="m213 38 11 29m-11 175 11-29M256 89l20-9m-20 112 20 8m37-85v-9m0 59v9" stroke="#b1bdc3"/>
      <circle cx="251" cy="140" r="11" fill="#1a2c37" stroke="#849da6"/><circle cx="251" cy="140" r="5" fill={accent} fillOpacity=".7"/>
      <path d="M157 117v46m60-47v48M292 118v7m0 30v8M143 81l5-4m-5 126 5 4" stroke="#a4b1b6" strokeOpacity=".65"/>
      {variant === 'bulwark' && <><path d="m182 50 79 21 48 39-88-14-39-46Zm0 180 79-21 48-39-88 14-39 46Z" fill="#49566a" stroke="#b0a1d4"/><path d="M214 80h46m-46 120h46" stroke="#c9b5e7"/></>}
      {enemy && <><path d="m218 45 107 37 46 30-70-12-83-55Zm0 190 107-37 46-30-70 12-83 55Z" fill="#3f3135" stroke={accent}/><path d="M292 99h100m-100 82h100" stroke={accent} strokeWidth="3"/></>}
    </g>
  </svg>
}

export function Portrait({ index, size = 40 }: { index: number; size?: number }) {
  const colors = ['#8bc6c5', '#b8a6d9', '#f0ac73']
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="portrait"><rect width="64" height="64" rx="8" fill={`${colors[index]}15`}/><path d="M10 64V52c0-11 10-16 22-16s22 5 22 16v12" fill={`${colors[index]}50`}/>{index === 1 ? <><path d="M18 13h28v25L32 44 18 38V13Z" fill="#645875" stroke={colors[index]}/><path d="M22 25h20M27 34h10" stroke={colors[index]} strokeWidth="3"/><path d="M27 6v7m10-7v7" stroke={colors[index]}/></> : <><path d="M19 20c0-17 26-17 26 0v13c0 7-6 13-13 13s-13-6-13-13V20Z" fill={index === 0 ? '#ba927c' : '#886954'}/><path d={index === 0 ? 'M16 35V19C15 2 48 2 47 19v14l-7-15-19 7-5 10Z' : 'M18 23V17c0-16 28-16 28 0v6l-7-8-17 3-4 5Z'} fill={index === 0 ? '#3e3840' : '#25232b'}/><path d="M23 29h5m8 0h5m-14 8h10" stroke="#332d33" strokeWidth="2"/></>}<path d="m22 48 10 7 10-7M32 55v9" stroke={colors[index]}/></svg>
}
