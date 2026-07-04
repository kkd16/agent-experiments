import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  perft,
  parseFen,
  generateLegal,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  moveFrom,
  moveTo,
  movePromo,
  moveFlag,
  squareName as mbSquareName,
  castleKingDest,
  FLAG_CASTLE,
  type Undo,
} from '../engine'
import {
  initMagics,
  parseFenBB,
  bbPerft,
  bbPerftDivide,
  probeMagic,
  rookAttacks,
  bishopAttacks,
  queenAttacks,
  attacksFrom,
  occupied,
  pieceAt,
  pieceGlyphAt,
  bit,
  popcount,
  squareName as bbSquareName,
  PERFT_REF,
  refDepthUnder,
  type PerftRef,
  type MagicProbe,
  type BBState,
} from '../engine/bitboard'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Unicode chess glyphs by FEN letter.
const GLYPH: Record<string, string> = {
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
}

function nps(nodes: number, ms: number): string {
  if (ms <= 0) return '—'
  const v = (nodes / ms) * 1000
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M/s` : `${Math.round(v / 1e3)}k/s`
}

function hex64(bb: bigint): string {
  return '0x' + (bb & ((1n << 64n) - 1n)).toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------------------
// A reusable 8×8 board. `cell(sq)` returns the glyph + extra classes to paint.
// ---------------------------------------------------------------------------

interface CellInfo {
  glyph?: string
  white?: boolean
  cls?: string
}

function BBBoard({
  cell,
  onSquare,
  size = 'md',
}: {
  cell: (sq: number) => CellInfo
  onSquare?: (sq: number) => void
  size?: 'sm' | 'md'
}) {
  const rows = []
  for (let dispRow = 0; dispRow < 8; dispRow++) {
    const rank = 7 - dispRow
    for (let file = 0; file < 8; file++) {
      const sq = rank * 8 + file
      const info = cell(sq)
      const dark = (rank + file) % 2 === 0
      rows.push(
        <div
          key={sq}
          className={`bb-cell ${dark ? 'dark' : 'light'} ${info.cls ?? ''} ${onSquare ? 'click' : ''}`}
          onClick={onSquare ? () => onSquare(sq) : undefined}
          title={bbSquareName(sq)}
        >
          {info.glyph && <span className={`bb-piece ${info.white ? 'w' : 'b'}`}>{info.glyph}</span>}
        </div>,
      )
    }
  }
  return <div className={`bb-board ${size}`}>{rows}</div>
}

// ---------------------------------------------------------------------------
// Section 1 — the perft oracle
// ---------------------------------------------------------------------------

function mailboxUci(m: number): string {
  if (moveFlag(m) === FLAG_CASTLE) return mbSquareName(moveFrom(m)) + mbSquareName(castleKingDest(moveFrom(m), moveTo(m)))
  return mbSquareName(moveFrom(m)) + mbSquareName(moveTo(m)) + (movePromo(m) ? 'nbrq'[movePromo(m) - 2] : '')
}

function mailboxDivide(fen: string, depth: number): Map<string, number> {
  const pos = parseFen(fen)
  const moves = generateLegal(pos)
  const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
  const out = new Map<string, number>()
  for (const m of moves) {
    makeMoveOnBoard(pos, m, undo)
    out.set(mailboxUci(m), depth <= 1 ? 1 : perft(pos, depth - 1))
    unmakeMoveOnBoard(pos, m, undo)
  }
  return out
}

interface OracleRow {
  ref: PerftRef
  depth: number
  reference: number
  bb: number | null
  bbMs: number | null
  mb: number | null
  mbMs: number | null
  status: 'idle' | 'running' | 'ok' | 'bad'
}

const BUDGETS = { Fast: 250_000, Deep: 5_000_000 }

function PerftOracle() {
  const [budget, setBudget] = useState<keyof typeof BUDGETS>('Fast')
  const rowsInit = useCallback(
    (b: keyof typeof BUDGETS): OracleRow[] =>
      PERFT_REF.map((ref) => {
        const depth = refDepthUnder(ref, BUDGETS[b])
        return { ref, depth, reference: ref.counts[depth], bb: null, bbMs: null, mb: null, mbMs: null, status: 'idle' as const }
      }),
    [],
  )
  const [rows, setRows] = useState<OracleRow[]>(() => rowsInit('Fast'))
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const cancel = useRef(false)

  const chooseBudget = (b: keyof typeof BUDGETS) => {
    setBudget(b)
    if (!running) setRows(rowsInit(b))
  }

  const run = useCallback(async () => {
    initMagics()
    cancel.current = false
    setRunning(true)
    setExpanded(null)
    const fresh = rowsInit(budget)
    setRows(fresh)
    await sleep(30)
    for (let i = 0; i < fresh.length; i++) {
      if (cancel.current) break
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, status: 'running' } : r)))
      await sleep(15)
      const { ref, depth, reference } = fresh[i]
      // Independent bitboard engine.
      const st = parseFenBB(ref.fen)
      let t0 = performance.now()
      const bb = bbPerft(st, depth)
      const bbMs = Math.round(performance.now() - t0)
      await sleep(0)
      // 0x88 mailbox engine.
      const pos = parseFen(ref.fen)
      t0 = performance.now()
      const mb = perft(pos, depth)
      const mbMs = Math.round(performance.now() - t0)
      const status: OracleRow['status'] = bb === reference && mb === reference ? 'ok' : 'bad'
      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, bb, bbMs, mb, mbMs, status } : r)))
      await sleep(15)
    }
    setRunning(false)
  }, [budget, rowsInit])

  useEffect(() => () => { cancel.current = true }, [])

  const done = rows.filter((r) => r.status === 'ok' || r.status === 'bad')
  const passed = rows.filter((r) => r.status === 'ok').length

  return (
    <div className="bb-section">
      <p className="bb-lead">
        <strong>perft</strong> counts the exact leaf nodes of the move tree to a fixed depth. Here two engines that share
        no code — the <em>0x88 mailbox</em> generator the whole engine runs on, and this new <em>magic-bitboard</em>
        generator — compute it independently, and both are held against the published Chess-Programming-Wiki reference
        counts. Three numbers agreeing is what makes a move generator trustworthy.
      </p>
      <div className="bb-controls">
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run perft oracle'}
        </button>
        <div className="bb-seg">
          {(['Fast', 'Deep'] as const).map((b) => (
            <button key={b} className={budget === b ? 'active' : ''} disabled={running} onClick={() => chooseBudget(b)}>
              {b}
            </button>
          ))}
        </div>
        <span className="bb-muted">
          {budget === 'Fast' ? 'depths ≤ 250k nodes' : 'depths ≤ 5M nodes — the heavy rows take a couple of seconds'}
        </span>
        {!running && done.length === rows.length && (
          <span className={`bb-summary ${passed === rows.length ? 'ok' : 'bad'}`}>
            {passed === rows.length ? `✓ all ${rows.length} positions — both engines match the references exactly` : `${passed}/${rows.length} passed`}
          </span>
        )}
      </div>
      <table className="bb-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>Depth</th>
            <th>Reference</th>
            <th>Bitboard</th>
            <th>Mailbox</th>
            <th>Agree</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <BBOracleRow key={r.ref.name} row={r} expanded={expanded === i} onToggle={() => setExpanded(expanded === i ? null : i)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BBOracleRow({ row, expanded, onToggle }: { row: OracleRow; expanded: boolean; onToggle: () => void }) {
  const divide = useMemo(() => {
    if (!expanded) return null
    initMagics()
    const bb = bbPerftDivide(parseFenBB(row.ref.fen), row.depth)
    const mb = mailboxDivide(row.ref.fen, row.depth)
    return bb.map((e) => ({ uci: e.uci, bb: e.nodes, mb: mb.get(e.uci) ?? null }))
  }, [expanded, row.ref.fen, row.depth])

  return (
    <>
      <tr className={`bb-row ${row.status}`}>
        <td>{row.ref.name}</td>
        <td>{row.depth}</td>
        <td className="num">{row.reference.toLocaleString()}</td>
        <td className="num">
          {row.bb === null ? '—' : row.bb.toLocaleString()}
          {row.bbMs !== null && <span className="bb-sub">{row.bbMs}ms · {nps(row.bb ?? 0, row.bbMs)}</span>}
        </td>
        <td className="num">
          {row.mb === null ? '—' : row.mb.toLocaleString()}
          {row.mbMs !== null && <span className="bb-sub">{row.mbMs}ms · {nps(row.mb ?? 0, row.mbMs)}</span>}
        </td>
        <td className="bb-agree">
          {row.status === 'ok' && '✓'}
          {row.status === 'bad' && '✗'}
          {row.status === 'running' && '…'}
        </td>
        <td>
          <button className="btn tiny" onClick={onToggle}>
            {expanded ? 'hide' : 'divide'}
          </button>
        </td>
      </tr>
      {expanded && divide && (
        <tr className="bb-divide-row">
          <td colSpan={7}>
            <div className="bb-divide">
              <p className="bb-muted">
                Perft <em>divide</em> — nodes under each legal root move, bitboard vs mailbox. Every pair matching is
                proof the two generators agree move-for-move, not merely on the total.
              </p>
              <div className="bb-divide-grid">
                {divide.map((d) => (
                  <div key={d.uci} className={`bb-divide-cell ${d.bb === d.mb ? '' : 'mismatch'}`}>
                    <span className="mv">{d.uci}</span>
                    <span className="n">{d.bb.toLocaleString()}</span>
                    {d.bb !== d.mb && <span className="mm">≠ {d.mb === null ? '—' : d.mb.toLocaleString()}</span>}
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — the magic explorer
// ---------------------------------------------------------------------------

type Slider = 'rook' | 'bishop' | 'queen'

function MagicExplorer() {
  const [piece, setPiece] = useState<Slider>('rook')
  const [src, setSrc] = useState(27) // d4
  const [blockers, setBlockers] = useState<bigint>(0n)

  useEffect(() => { initMagics() }, [])

  const attacks = useMemo(() => {
    if (piece === 'rook') return rookAttacks(src, blockers)
    if (piece === 'bishop') return bishopAttacks(src, blockers)
    return queenAttacks(src, blockers)
  }, [piece, src, blockers])

  const probes: MagicProbe[] = useMemo(() => {
    if (piece === 'queen') return [probeMagic('rook', src, blockers), probeMagic('bishop', src, blockers)]
    return [probeMagic(piece, src, blockers)]
  }, [piece, src, blockers])

  const glyph = piece === 'rook' ? '♜' : piece === 'bishop' ? '♝' : '♛'

  const toggle = (sq: number) => {
    if (sq === src) return
    setBlockers((b) => b ^ bit(sq))
  }

  const cell = (sq: number): CellInfo => {
    if (sq === src) return { glyph, white: true, cls: 'src' }
    const isBlock = (blockers & bit(sq)) !== 0n
    const isAtt = (attacks & bit(sq)) !== 0n
    let cls = ''
    if (isBlock && isAtt) cls = 'block capt' // a blocker the slider can capture
    else if (isBlock) cls = 'block'
    else if (isAtt) cls = 'att'
    return { glyph: isBlock ? '●' : undefined, white: false, cls }
  }

  return (
    <div className="bb-section">
      <p className="bb-lead">
        A sliding piece's reachable squares depend on the blockers in its path — a 64-bit lookup problem. A{' '}
        <strong>magic bitboard</strong> solves it with one multiply: mask the board to the squares that matter, multiply
        by a hand-found 64-bit constant so those bits scatter into the top of the word, and shift them down to an index
        into a precomputed attack table. Pick a piece and square, then click to place blockers and watch the hash.
      </p>
      <div className="bb-explorer">
        <div>
          <BBBoard cell={cell} onSquare={toggle} />
          <div className="bb-explorer-ctl">
            <div className="bb-seg">
              {(['rook', 'bishop', 'queen'] as const).map((p) => (
                <button key={p} className={piece === p ? 'active' : ''} onClick={() => setPiece(p)}>
                  {p}
                </button>
              ))}
            </div>
            <label className="bb-src">
              square
              <select value={src} onChange={(e) => setSrc(Number(e.target.value))}>
                {Array.from({ length: 64 }, (_, i) => i).map((sq) => (
                  <option key={sq} value={sq}>{bbSquareName(sq)}</option>
                ))}
              </select>
            </label>
            <button className="btn tiny" onClick={() => setBlockers(0n)}>clear blockers</button>
          </div>
          <p className="bb-muted small">Click any square to toggle a blocker · the piece attacks the highlighted squares</p>
        </div>
        <div className="bb-hash">
          {probes.map((p, i) => (
            <div key={i} className="bb-hash-card">
              {piece === 'queen' && <div className="bb-hash-title">{i === 0 ? 'rook component' : 'bishop component'}</div>}
              <MagicPipeline p={p} />
            </div>
          ))}
          <div className="bb-hash-card total">
            <div className="bb-hash-title">attack set</div>
            <MiniGrid bb={attacks} highlight={src} />
            <div className="bb-kv"><span>attacked squares</span><code>{popcount(attacks)}</code></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function MagicPipeline({ p }: { p: MagicProbe }) {
  return (
    <div className="bb-pipe">
      <div className="bb-kv"><span>relevant occupancy</span><code>{hex64(p.relevant)}</code></div>
      <div className="bb-kv op"><span>× magic</span><code>{hex64(p.magic)}</code></div>
      <div className="bb-kv"><span>= product (mod 2⁶⁴)</span><code>{hex64(p.product)}</code></div>
      <div className="bb-kv op"><span>{'>>'} {p.shift} ({p.bits} relevant bits)</span><code></code></div>
      <div className="bb-kv result">
        <span>index into 2<sup>{p.bits}</sup>-entry table</span>
        <code>{p.index}</code>
      </div>
    </div>
  )
}

// A compact 8×8 rendering of a bitboard (for attack sets etc.).
function MiniGrid({ bb, highlight }: { bb: bigint; highlight?: number }) {
  const cells = []
  for (let dispRow = 0; dispRow < 8; dispRow++) {
    const rank = 7 - dispRow
    for (let file = 0; file < 8; file++) {
      const sq = rank * 8 + file
      const on = (bb & bit(sq)) !== 0n
      const hi = sq === highlight
      cells.push(<div key={sq} className={`bb-mini-cell ${on ? 'on' : ''} ${hi ? 'hi' : ''}`} />)
    }
  }
  return <div className="bb-mini">{cells}</div>
}

// ---------------------------------------------------------------------------
// Section 3 — the attack viewer (a real position, magic lookups per piece)
// ---------------------------------------------------------------------------

const VIEWER_PRESETS: { name: string; fen: string }[] = [
  { name: 'Start', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: 'Kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { name: 'Italian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
]
const PIECE_NAME = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']

function AttackViewer() {
  const [fen, setFen] = useState(VIEWER_PRESETS[1].fen)
  const [sel, setSel] = useState<number | null>(38)

  useEffect(() => { initMagics() }, [])

  const { st, err } = useMemo((): { st: BBState | null; err: string | null } => {
    try {
      return { st: parseFenBB(fen), err: null }
    } catch {
      return { st: null, err: 'Could not parse that FEN' }
    }
  }, [fen])

  const attacks = st && sel !== null ? attacksFrom(st, sel) : 0n
  const selPiece = st && sel !== null ? pieceAt(st, sel) : null

  const cell = (sq: number): CellInfo => {
    const g = st ? pieceGlyphAt(st, sq) : null
    const isAtt = (attacks & bit(sq)) !== 0n
    let cls = ''
    if (sq === sel) cls = 'src'
    else if (isAtt) cls = g ? 'att capt' : 'att'
    return { glyph: g ? GLYPH[g] : undefined, white: g ? g === g.toUpperCase() : false, cls }
  }

  return (
    <div className="bb-section">
      <p className="bb-lead">
        A whole position lives in twelve 64-bit boards. Click any piece to see exactly which squares it attacks — every
        sliding piece resolved by the same one-multiply magic lookup, against the live occupancy.
      </p>
      <div className="bb-explorer">
        <div>
          <BBBoard cell={cell} onSquare={(sq) => setSel(sq)} />
          <div className="bb-explorer-ctl">
            <div className="bb-seg">
              {VIEWER_PRESETS.map((p) => (
                <button key={p.name} className={fen === p.fen ? 'active' : ''} onClick={() => { setFen(p.fen); setSel(null) }}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <input className="bb-fen" value={fen} onChange={(e) => setFen(e.target.value)} spellCheck={false} />
          {err && <p className="bb-summary bad">{err}</p>}
        </div>
        <div className="bb-hash">
          <div className="bb-hash-card">
            <div className="bb-hash-title">selected piece</div>
            {selPiece ? (
              <>
                <div className="bb-kv"><span>square</span><code>{bbSquareName(sel!)}</code></div>
                <div className="bb-kv"><span>piece</span><code>{selPiece.color === 0 ? 'white' : 'black'} {PIECE_NAME[selPiece.type]}</code></div>
                <div className="bb-kv"><span>attacks</span><code>{popcount(attacks)} squares</code></div>
                <div className="bb-kv"><span>attack bitboard</span><code>{hex64(attacks)}</code></div>
              </>
            ) : (
              <p className="bb-muted small">Click a piece on the board.</p>
            )}
          </div>
          <div className="bb-hash-card total">
            <div className="bb-hash-title">occupancy (all pieces)</div>
            {st && <MiniGrid bb={occupied(st)} highlight={sel ?? undefined} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

type Sub = 'oracle' | 'magic' | 'attack'

export default function BitboardLab() {
  const [sub, setSub] = useState<Sub>('oracle')
  return (
    <div className="bb-lab">
      <div className="bb-intro">
        <p>
          The engine runs on a 0x88 mailbox generator. This is its independent second opinion: a from-scratch{' '}
          <strong>magic-bitboard</strong> move generator — a different representation, fully-legal generation (king-danger
          maps, check masks, pin rays), and its own FEN parser — that reproduces the exact same perft counts. It also
          lays the technique bare.
        </p>
      </div>
      <div className="bb-subtabs">
        <button className={sub === 'oracle' ? 'active' : ''} onClick={() => setSub('oracle')}>Perft oracle</button>
        <button className={sub === 'magic' ? 'active' : ''} onClick={() => setSub('magic')}>Magic explorer</button>
        <button className={sub === 'attack' ? 'active' : ''} onClick={() => setSub('attack')}>Attack viewer</button>
      </div>
      {sub === 'oracle' && <PerftOracle />}
      {sub === 'magic' && <MagicExplorer />}
      {sub === 'attack' && <AttackViewer />}
    </div>
  )
}
