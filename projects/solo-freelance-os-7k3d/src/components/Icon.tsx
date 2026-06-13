// Lightweight inline SVG icon set (stroke-based, currentColor). No icon-font dependency.

export type IconName =
  | 'dashboard'
  | 'clients'
  | 'invoices'
  | 'time'
  | 'expenses'
  | 'settings'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'copy'
  | 'download'
  | 'upload'
  | 'print'
  | 'check'
  | 'play'
  | 'pause'
  | 'stop'
  | 'x'
  | 'sun'
  | 'moon'
  | 'arrow-left'
  | 'send'
  | 'logo'
  | 'search'
  | 'chevron-down'
  | 'reports'
  | 'link'
  | 'estimates'

const paths: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z',
  clients:
    'M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4zM8 13a3 3 0 1 0-3-3 3 3 0 0 0 3 3zM2 21v-1a4 4 0 0 1 4-4h2M22 21v-2a4 4 0 0 0-4-4h-3a4 4 0 0 0-4 4v2',
  invoices: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h6M9 9h2',
  time: 'M12 7v5l3 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
  expenses: 'M3 6h18v12H3zM3 10h18M7 15h4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  print: 'M6 9V2h12v7M6 18H4v-7h16v7h-2M8 14h8v8H8z',
  check: 'M20 6L9 17l-5-5',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M6 6h12v12H6z',
  x: 'M18 6L6 18M6 6l12 12',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  logo: 'M4 18V7l8-4 8 4v11M4 18h16M9 18v-5h6v5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  'chevron-down': 'M6 9l6 6 6-6',
  reports:
    'M21 21H4a1 1 0 0 1-1-1V3M7 14l4-4 3 3 5-6M19 10V7h-3',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  estimates: 'M6 2h9l5 5v15H6zM15 2v5h5M9 14l2 2 4-4',
}

const filled: Partial<Record<IconName, boolean>> = { play: true, pause: true, stop: true }

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}) {
  const isFilled = filled[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={isFilled ? 'currentColor' : 'none'}
      stroke={isFilled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
