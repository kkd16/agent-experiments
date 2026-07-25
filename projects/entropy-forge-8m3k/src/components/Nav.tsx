import { navigate } from '../hooks/useHashRoute'

const GROUPS: { label: string; items: { route: string; name: string }[] }[] = [
  {
    label: 'Start',
    items: [{ route: 'overview', name: 'Overview' }],
  },
  {
    label: 'Measure',
    items: [{ route: 'analyzer', name: 'Entropy Analyzer' }],
  },
  {
    label: 'Entropy coders',
    items: [
      { route: 'huffman', name: 'Huffman' },
      { route: 'adaptive', name: 'Adaptive Huffman' },
      { route: 'arithmetic', name: 'Arithmetic' },
      { route: 'rans', name: 'rANS' },
      { route: 'tans', name: 'tANS / FSE' },
      { route: 'rice', name: 'Rice · Elias · integer codes' },
    ],
  },
  {
    label: 'Modelling coders',
    items: [
      { route: 'ppm', name: 'PPM' },
      { route: 'cm', name: 'Context mixing' },
      { route: 'lempel', name: 'LZ77 & LZW' },
      { route: 'burrows', name: 'Burrows–Wheeler' },
      { route: 'suffix', name: 'Suffix Array' },
    ],
  },
  {
    label: 'The real thing',
    items: [
      { route: 'deflate', name: 'DEFLATE & gzip' },
      { route: 'lzma', name: 'LZMA' },
      { route: 'bzip2', name: 'bzip2 · real .bz2' },
      { route: 'png', name: 'PNG · Image Studio' },
      { route: 'jpeg', name: 'JPEG · Rate–Distortion' },
      { route: 'flac', name: 'FLAC · lossless audio' },
    ],
  },
  {
    label: 'The limits',
    items: [{ route: 'ratedistortion', name: 'Rate–Distortion · Quantisation' }],
  },
  {
    label: 'Channel coding',
    items: [
      { route: 'channel', name: 'The Noisy Channel' },
      { route: 'hamming', name: 'Hamming Codes' },
      { route: 'reedsolomon', name: 'Reed–Solomon' },
      { route: 'convolutional', name: 'Convolutional · Viterbi' },
      { route: 'ldpc', name: 'LDPC · Belief Prop.' },
      { route: 'polar', name: 'Polar · SC List' },
      { route: 'channellab', name: 'Channel Lab · end-to-end' },
    ],
  },
  {
    label: 'Use it',
    items: [{ route: 'workbench', name: 'Workbench' }],
  },
  {
    label: 'Prove it',
    items: [
      { route: 'benchmark', name: 'Benchmark' },
      { route: 'selftest', name: 'Self-test' },
    ],
  },
]

export function Nav({ route }: { route: string }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 40 40" fill="none">
          <rect x="1" y="1" width="38" height="38" rx="10" fill="#0e131c" stroke="var(--border-hi)" />
          {/* stylised shrinking bars -> a single bit */}
          <rect x="9" y="9" width="22" height="4" rx="2" fill="var(--teal)" />
          <rect x="9" y="17" width="15" height="4" rx="2" fill="var(--blue)" />
          <rect x="9" y="25" width="9" height="4" rx="2" fill="var(--violet)" />
          <circle cx="30" cy="27" r="3.4" fill="var(--amber)" />
        </svg>
        <div>
          <div className="brand-title">Entropy Forge</div>
          <div className="brand-sub">compression lab</div>
        </div>
      </div>
      <nav className="nav-scroll">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <div className="nav-group-label">{g.label}</div>
            {g.items.map((it) => (
              <button
                key={it.route}
                className={`nav-item${route === it.route ? ' active' : ''}`}
                onClick={() => navigate(it.route)}
              >
                <span className="dot" />
                {it.name}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="nav-group-label" style={{ marginTop: 22 }}>
        Zero deps · from scratch
      </div>
    </aside>
  )
}
