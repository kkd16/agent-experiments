import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ShipId } from './game/types'

type IconName =
  | 'sun'
  | 'arrow'
  | 'spark'
  | 'sound'
  | 'mute'
  | 'pause'
  | 'play'
  | 'expand'
  | 'close'
  | 'flag'
  | 'wind'
  | 'check'
  | 'lock'
  | 'moon'
  | 'dive'
  | 'soar'
  | 'ring'
  | 'restart'
  | 'shield'
  | 'magnet'
  | 'ghost'
  | 'journal'
  | 'share'
  | 'map'
  | 'seal'
  | 'controller'

export function Icon({
  name,
  size = 20,
  className = '',
}: {
  name: IconName
  size?: number
  className?: string
}) {
  const paths: Record<IconName, ReactNode> = {
    map: (
      <>
        <path d="m3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3Zm6-3v17m6-14v17" />
      </>
    ),
    seal: (
      <>
        <circle cx="12" cy="10" r="7" />
        <path d="m8 16-2 6 6-3 6 3-2-6M12 6l1.2 2.5L16 9l-2 2 .5 3-2.5-1.5L9.5 14l.5-3-2-2 2.8-.5Z" />
      </>
    ),
    controller: (
      <>
        <path d="M8 6h8c4 0 5 4 6 10s-4 5-6 1H8c-2 4-7 5-6-1S4 6 8 6Z" />
        <path d="M8 9v6m-3-3h6m5-2h.1m3 3h.1" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 8 4-1 9-7 7-7-7-1-9Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    magnet: (
      <>
        <path d="M5 3v11a7 7 0 0 0 14 0V3h-5v11a2 2 0 0 1-4 0V3Z" />
        <path d="M5 8h5m4 0h5" />
      </>
    ),
    ghost: (
      <>
        <path d="M5 21V9a7 7 0 0 1 14 0v12l-3-3-4 3-4-3Z" />
        <path d="M9 9v2m6-2v2" />
      </>
    ),
    journal: (
      <>
        <path d="M6 3h13v18H6a3 3 0 0 1 0-6h13M6 3a3 3 0 0 0-3 3v12m5-11h7m-7 4h5" />
      </>
    ),
    share: (
      <>
        <path d="M12 15V2m-5 5 5-5 5 5M5 12H3v9h18v-9h-2" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    spark: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />,
    sound: (
      <>
        <path d="m11 4-6 5H2v6h3l6 5ZM15 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14" />
      </>
    ),
    mute: (
      <>
        <path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6m0-6-6 6" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" strokeWidth="3.5" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8Z" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    flag: <path d="M5 22V3c5-5 9 5 15 0v11c-6 5-10-5-15 0" />,
    wind: (
      <path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M5 17h5a2 2 0 1 1-2 2" />
    ),
    check: <path d="m5 12 4 4L19 6" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
    dive: <path d="M3 5c9 0 5 13 17 13m-5-5 5 5-5 3" />,
    soar: <path d="M3 18C11 18 8 6 20 6m-5-3 5 3-5 5" />,
    ring: (
      <>
        <ellipse cx="12" cy="12" rx="6" ry="10" transform="rotate(25 12 12)" />
        <path d="m17 3 1-2m-9 22 1-2" />
      </>
    ),
    restart: (
      <>
        <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />
      </>
    ),
  }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

export function BrandMark() {
  return (
    <svg
      viewBox="0 0 44 44"
      width="44"
      height="44"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="23" cy="17" r="8" fill="currentColor" />
      <path
        d="M4 30c11-10 23-10 36-3M5 37c11-10 23-10 35-3"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M23 2v3M9 8l2 2m24-2-2 2M3 19h4m32 0h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ShipArt({
  ship,
  large = false,
}: {
  ship: ShipId
  large?: boolean
}) {
  const colors = {
    sol: ['#77d3c7', '#b7eee1'],
    manta: ['#b798db', '#dfcbf3'],
    comet: ['#ec8a67', '#ffe0a6'],
    kestrel: ['#e9bb72', '#fff0ca'],
  }
  const [main, light] = colors[ship]
  return (
    <svg
      viewBox="0 0 220 130"
      className={`ship-art ${large ? 'large' : ''}`}
      aria-hidden="true"
    >
      <ellipse cx="110" cy="115" rx="59" ry="5" fill="#342c40" opacity=".09" />
      <path
        d="M7 97q40-22 73-5M20 108q33-19 59-13"
        stroke={main}
        strokeWidth="2"
        fill="none"
        opacity=".5"
      />
      {ship === 'kestrel' ? (
        <>
          <path d="m109 23 60 38-60 7-46-34 46 48 54-3-54 15Z" fill={main} />
          <path d="m109 23 18 38 42 0-60 7-46-34Z" fill={light} />
          <path
            d="m72 37 37 27 48-2M109 24v66"
            stroke="#876840"
            strokeWidth="2"
            fill="none"
          />
        </>
      ) : ship === 'manta' ? (
        <>
          <path d="m64 91 36-57 15 39 53-43-24 59-30 11Z" fill={main} />
          <path d="m100 34 15 39 53-43-54 65Z" fill={light} />
        </>
      ) : ship === 'comet' ? (
        <>
          <path d="m107 21 2 71 57-33Z" fill={main} />
          <path d="m107 21 3 50 56-12Z" fill={light} />
          <path d="m83 74-18 13 35 1Z" fill={main} />
        </>
      ) : (
        <>
          <path d="m107 17 1 75 54-17Z" fill={main} />
          <path d="m107 17 6 51 49 7Z" fill={light} />
          <path d="m108 40 27 43" stroke="#4c9d99" fill="none" />
        </>
      )}
      <path d="m106 20 3 74" stroke="#3c374b" strokeWidth="2.5" />
      <path d="M74 92q39 8 84-9l-9 13q-42 16-75 3Z" fill="#403549" />
      <path d="M73 92q39 8 84-9" stroke={light} strokeWidth="3" fill="none" />
      <circle cx="94" cy="71" r="5" fill="#403549" />
      <path
        d="m94 77-4 10 10 4m-6-12 13 2"
        stroke="#403549"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path d="m90 74-19-3 14 8Z" fill="#f7bd74" />
    </svg>
  )
}

export function Modal({
  title,
  children,
  onClose,
  className = '',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-inner">
        <button
          className="icon-button modal-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        {children}
      </div>
    </dialog>
  )
}
