// The Hash Index Lab — three living dynamic-hashing access methods you can poke.
//
// QueryForge's ordered access method is the B+Tree (Storage Lab) and its
// write-optimized one is the LSM tree (LSM Lab). This Lab makes the *hash-based*
// access methods visible: an **Extendible Hash** (a directory of 2^G slots over
// buckets that split and double / merge and halve), a **Linear Hash** (a
// directory-free array of buckets swept by a single split pointer, with overflow
// chains), and a **Cuckoo Hash** (two tables and two hash functions, a key in one
// of two slots with worst-case two-probe lookup, eviction chains and rehashing).
// Insert, delete and look keys up and watch each structure grow and shrink — every
// step narrated from its own trace, with an invariant checker that shows a green
// badge only while the structure is provably valid. The hash-table sibling of the
// Storage / LSM Labs.

import { useCallback, useRef, useState } from 'react'
import { ExtendibleHash, type EhSnapshot, type EhStats, type EhTrace } from '../db/hashindex/extendible'
import { LinearHash, type LhSnapshot, type LhStats, type LhTrace } from '../db/hashindex/linear'
import { CuckooHash, type CkSnapshot, type CkStats, type CkTrace } from '../db/hashindex/cuckoo'

type Mode = 'extendible' | 'linear' | 'cuckoo'
const CAPS = [2, 3, 4, 6] as const

type Trace = (EhTrace | LhTrace | CkTrace)[]

interface EhView {
  mode: 'extendible'
  snap: EhSnapshot
  stats: EhStats
  invariants: string[]
}
interface LhView {
  mode: 'linear'
  snap: LhSnapshot
  stats: LhStats
  invariants: string[]
}
interface CkView {
  mode: 'cuckoo'
  snap: CkSnapshot
  stats: CkStats
  invariants: string[]
}
type View = EhView | LhView | CkView

// A highlight is a set of opaque cell ids: `b<id>` for a bucket (extendible /
// linear), `c<table>-<slot>` for a cuckoo cell.
function highlightIdsFor(tr: Trace): Set<string> {
  const s = new Set<string>()
  for (const e of tr) {
    if ('bucketIds' in e) for (const id of e.bucketIds) s.add('b' + id)
    else for (const [t, slot] of e.cells) s.add(`c${t}-${slot}`)
  }
  return s
}

function kindLabel(k: EhTrace['kind'] | LhTrace['kind'] | CkTrace['kind']): string {
  switch (k) {
    case 'double':
      return 'double'
    case 'halve':
      return 'halve'
    case 'split':
      return 'split'
    case 'merge':
      return 'merge'
    case 'level-up':
      return 'level ▲'
    case 'level-down':
      return 'level ▼'
    case 'overflow':
      return 'overflow'
    case 'insert':
      return 'insert'
    case 'update':
      return 'update'
    case 'remove':
      return 'remove'
    case 'found':
      return 'found'
    case 'not-found':
      return 'miss'
    case 'place':
      return 'place'
    case 'evict':
      return 'evict'
    case 'rehash':
      return 'rehash'
    case 'grow':
      return 'grow'
    case 'shrink':
      return 'shrink'
    default:
      return String(k)
  }
}

export function HashIndexLab() {
  const [mode, setMode] = useState<Mode>('extendible')
  const [capacity, setCapacity] = useState<number>(3)

  const ehRef = useRef<ExtendibleHash>(new ExtendibleHash(3))
  const lhRef = useRef<LinearHash>(new LinearHash({ base: 2, capacity: 3 }))
  const ckRef = useRef<CuckooHash>(new CuckooHash({ size: 4 }))
  const keysRef = useRef<Set<number>>(new Set())

  const buildView = useCallback((m: Mode): View => {
    if (m === 'extendible') {
      const t = ehRef.current
      return { mode: 'extendible', snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() }
    }
    if (m === 'linear') {
      const t = lhRef.current
      return { mode: 'linear', snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() }
    }
    const t = ckRef.current
    return { mode: 'cuckoo', snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() }
  }, [])

  const [view, setView] = useState<View>(() => {
    // Build the initial view from a fresh empty structure so we never read a ref
    // during render (the refs are seeded with the same capacity below).
    const t = new ExtendibleHash(3)
    return { mode: 'extendible', snap: t.snapshot(), stats: t.stats(), invariants: t.checkInvariants() }
  })
  const commit = useCallback((m: Mode) => setView(buildView(m)), [buildView])

  const [trace, setTrace] = useState<Trace>([])
  const [highlight, setHighlight] = useState<Set<string>>(new Set())
  const [keyInput, setKeyInput] = useState('')
  const [message, setMessage] = useState<string>('Insert keys and watch the hash index grow; delete them and watch it shrink back.')

  const [demo, setDemo] = useState<{ ops: { op: 'ins' | 'del'; key: number }[]; i: number } | null>(null)

  const highlightFrom = useCallback((tr: Trace) => {
    setHighlight(highlightIdsFor(tr))
  }, [])

  const doInsert = useCallback(
    (key: number) => {
      const tr: Trace = []
      const existed = keysRef.current.has(key)
      if (mode === 'extendible') ehRef.current.insert([key], key, tr as EhTrace[])
      else if (mode === 'linear') lhRef.current.insert([key], key, tr as LhTrace[])
      else ckRef.current.insert([key], key, tr as CkTrace[])
      keysRef.current.add(key)
      setTrace(tr)
      highlightFrom(tr)
      const quiet = new Set(['insert', 'update', 'place', 'found', 'not-found'])
      const events = tr.filter((e) => !quiet.has(e.kind)).map((e) => kindLabel(e.kind))
      setMessage(existed ? `Key ${key} already present — added a row id.` : `Inserted ${key}${events.length ? ' — ' + [...new Set(events)].join(', ') : ''}.`)
      commit(mode)
    },
    [mode, highlightFrom, commit],
  )

  const doDelete = useCallback(
    (key: number) => {
      const tr: Trace = []
      let ok: boolean
      if (mode === 'extendible') ok = ehRef.current.remove([key], key, tr as EhTrace[])
      else if (mode === 'linear') ok = lhRef.current.remove([key], key, tr as LhTrace[])
      else ok = ckRef.current.remove([key], key, tr as CkTrace[])
      keysRef.current.delete(key)
      setTrace(tr)
      highlightFrom(tr)
      const events = tr.filter((e) => e.kind === 'merge' || e.kind === 'halve' || e.kind === 'level-down' || e.kind === 'shrink').map((e) => kindLabel(e.kind))
      setMessage(!ok ? `Key ${key} not present.` : `Deleted ${key}${events.length ? ' — ' + [...new Set(events)].join(', ') : ''}.`)
      commit(mode)
    },
    [mode, highlightFrom, commit],
  )

  const doLookup = useCallback(
    (key: number) => {
      const tr: Trace = []
      let rows: number[]
      if (mode === 'extendible') rows = ehRef.current.lookup([key], tr as EhTrace[])
      else if (mode === 'linear') rows = lhRef.current.lookup([key], tr as LhTrace[])
      else rows = ckRef.current.lookup([key], tr as CkTrace[])
      setTrace(tr)
      highlightFrom(tr)
      setMessage(rows.length ? `Looked up ${key}: found (rows ${rows.join(', ')}).` : `Looked up ${key}: not present — candidate slot(s) probed, then done.`)
      commit(mode)
    },
    [mode, highlightFrom, commit],
  )

  const parseKey = useCallback(() => {
    const n = parseInt(keyInput, 10)
    return Number.isFinite(n) ? n : null
  }, [keyInput])

  const doInsertInput = useCallback(() => {
    const n = parseKey()
    if (n !== null) doInsert(n)
    setKeyInput('')
  }, [parseKey, doInsert])
  const doDeleteInput = useCallback(() => {
    const n = parseKey()
    if (n !== null) doDelete(n)
    setKeyInput('')
  }, [parseKey, doDelete])
  const doLookupInput = useCallback(() => {
    const n = parseKey()
    if (n !== null) doLookup(n)
  }, [parseKey, doLookup])

  // Deterministic spread of keys (no Math.random in the engine path).
  const seedRef = useRef(0x51f3)
  const nextRand = useCallback((n: number) => {
    seedRef.current = (Math.imul(seedRef.current ^ (seedRef.current >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0
    return Math.abs(seedRef.current) % n
  }, [])

  const insertRandom = useCallback(() => {
    let key = nextRand(99) + 1
    let guard = 0
    while (keysRef.current.has(key) && guard++ < 200) key = nextRand(99) + 1
    doInsert(key)
  }, [nextRand, doInsert])

  const deleteRandom = useCallback(() => {
    const present = [...keysRef.current]
    if (!present.length) return
    doDelete(present[nextRand(present.length)])
  }, [nextRand, doDelete])

  const rebuild = useCallback(
    (m: Mode, cap: number) => {
      const sorted = [...keysRef.current].sort((a, b) => a - b)
      if (m === 'extendible') {
        const t = new ExtendibleHash(cap)
        for (const key of sorted) t.insert([key], key)
        ehRef.current = t
      } else if (m === 'linear') {
        const t = new LinearHash({ base: 2, capacity: cap })
        for (const key of sorted) t.insert([key], key)
        lhRef.current = t
      } else {
        const t = new CuckooHash({ size: 4 })
        for (const key of sorted) t.insert([key], key)
        ckRef.current = t
      }
    },
    [],
  )

  const changeMode = useCallback(
    (m: Mode) => {
      setMode(m)
      rebuild(m, capacity)
      setTrace([])
      setHighlight(new Set())
      setMessage(
        m === 'extendible'
          ? 'Extendible hashing: a directory of 2^G slots over buckets that split (and double the directory) on overflow, and merge (and halve) as they drain.'
          : m === 'linear'
            ? 'Linear hashing: no directory — a bucket array swept by a single split pointer, with overflow chains paid down by later splits.'
            : 'Cuckoo hashing: two tables, two hash functions — a key lives in one of two slots (worst-case two-probe lookup); a full slot evicts its incumbent, and a kick loop rehashes into bigger tables.',
      )
      setView(buildView(m))
    },
    [capacity, rebuild, buildView],
  )

  const changeCapacity = useCallback(
    (cap: number) => {
      setCapacity(cap)
      rebuild(mode, cap)
      setTrace([])
      setHighlight(new Set())
      setMessage(`Rebuilt at bucket capacity ${cap} (a bucket holds up to ${cap} keys before it splits / overflows).`)
      setView(buildView(mode))
    },
    [mode, rebuild, buildView],
  )

  const clear = useCallback(() => {
    keysRef.current = new Set()
    ehRef.current = new ExtendibleHash(capacity)
    lhRef.current = new LinearHash({ base: 2, capacity })
    ckRef.current = new CuckooHash({ size: 4 })
    setTrace([])
    setHighlight(new Set())
    setDemo(null)
    setMessage('Cleared. Insert keys to begin.')
    setView(buildView(mode))
  }, [capacity, mode, buildView])

  const loadDemo = useCallback(() => {
    keysRef.current = new Set()
    ehRef.current = new ExtendibleHash(capacity)
    lhRef.current = new LinearHash({ base: 2, capacity })
    ckRef.current = new CuckooHash({ size: 4 })
    const ops: { op: 'ins' | 'del'; key: number }[] = []
    for (let i = 1; i <= 24; i++) ops.push({ op: 'ins', key: i })
    for (let i = 1; i <= 20; i++) ops.push({ op: 'del', key: i })
    setDemo({ ops, i: 0 })
    setTrace([])
    setHighlight(new Set())
    setMessage('Guided demo loaded. Step through to watch the index grow (splits, doublings / level bumps) then drain (merges, halvings).')
    setView(buildView(mode))
  }, [capacity, mode, buildView])

  const stepDemo = useCallback(() => {
    if (!demo) return
    const step = demo.ops[demo.i]
    if (!step) return
    if (step.op === 'ins') doInsert(step.key)
    else doDelete(step.key)
    setDemo({ ...demo, i: demo.i + 1 })
  }, [demo, doInsert, doDelete])

  const ok = view.invariants.length === 0

  return (
    <div className="lab hashindex-lab">
      <div className="lab-head">
        <h2>Hash Index Lab</h2>
        <p className="lab-sub">
          Three dynamic hashing access methods — <em>extendible</em> (a doubling directory), <em>linear</em> (a split-pointer sweep) and <em>cuckoo</em> (two tables,
          worst-case two-probe lookup) — grow and shrink incrementally, <em>never</em> a naïve global rehash. Insert, delete and look up keys and watch every split,
          double, merge, halve, evict and rehash, each step proven valid.
        </p>
      </div>

      <div className="sl-controls">
        <div className="sl-ctrl-group">
          <span className="sl-ctrl-label">method</span>
          <button className={`sl-chip ${mode === 'extendible' ? 'active' : ''}`} onClick={() => changeMode('extendible')}>
            extendible
          </button>
          <button className={`sl-chip ${mode === 'linear' ? 'active' : ''}`} onClick={() => changeMode('linear')}>
            linear
          </button>
          <button className={`sl-chip ${mode === 'cuckoo' ? 'active' : ''}`} onClick={() => changeMode('cuckoo')}>
            cuckoo
          </button>
        </div>
        <div className="sl-ctrl-group">
          <span className="sl-ctrl-label">bucket cap</span>
          {CAPS.map((c) => (
            <button key={c} className={`sl-chip ${capacity === c ? 'active' : ''}`} onClick={() => changeCapacity(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="sl-ctrl-group">
          <input
            className="sl-input"
            type="number"
            placeholder="key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doInsertInput()
            }}
          />
          <button className="sl-btn accent" onClick={doInsertInput}>
            Insert
          </button>
          <button className="sl-btn" onClick={doDeleteInput}>
            Delete
          </button>
          <button className="sl-btn" onClick={doLookupInput}>
            Look up
          </button>
        </div>
        <div className="sl-ctrl-group">
          <button className="sl-btn" onClick={insertRandom}>
            + random
          </button>
          <button className="sl-btn" onClick={deleteRandom}>
            − random
          </button>
          <button className="sl-btn ghost" onClick={clear}>
            Clear
          </button>
        </div>
        <div className="sl-ctrl-group">
          {!demo ? (
            <button className="sl-btn accent" onClick={loadDemo}>
              ▶ Guided demo
            </button>
          ) : (
            <>
              <button className="sl-btn accent" onClick={stepDemo} disabled={demo.i >= demo.ops.length}>
                Step ▸ ({demo.i}/{demo.ops.length})
              </button>
              <button className="sl-btn ghost" onClick={() => setDemo(null)}>
                Exit demo
              </button>
            </>
          )}
        </div>
      </div>

      <StatBar view={view} ok={ok} />

      <div className="sl-message">{message}</div>

      <div className="sl-canvas-wrap hx-canvas-wrap">
        {view.stats.keys === 0 ? (
          <div className="sl-empty">Empty — a single bucket. Insert a key to begin.</div>
        ) : view.mode === 'extendible' ? (
          <ExtendibleView snap={view.snap} highlight={highlight} />
        ) : view.mode === 'linear' ? (
          <LinearView snap={view.snap} highlight={highlight} />
        ) : (
          <CuckooView snap={view.snap} highlight={highlight} />
        )}
      </div>

      <div className="sl-lower">
        <div className="sl-trace">
          <div className="sl-panel-title">Operation trace</div>
          {trace.length === 0 ? (
            <div className="sl-trace-empty">Run an operation to see the structural steps it took.</div>
          ) : (
            <ol className="sl-trace-list">
              {trace.map((e, i) => (
                <li key={i} className={`sl-trace-item k-${kindLabel(e.kind).replace(/[^a-z]/g, '')}`}>
                  <span className="sl-trace-kind">{kindLabel(e.kind)}</span>
                  <span className="sl-trace-detail">{e.detail}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="sl-notes">
          <div className="sl-panel-title">How it grows &amp; shrinks</div>
          {view.mode === 'extendible' ? (
            <ul className="sl-note-list">
              <li>The <strong>directory</strong> has 2^G slots; a key's low <strong>G</strong> hash bits index it, then one <strong>bucket</strong> is scanned — worst case two touches.</li>
              <li>A full bucket <strong>splits</strong> by its next hash bit; if it was already as deep as the directory (d = G) the directory first <strong>doubles</strong> — a pointer copy, never a data rehash.</li>
              <li>A bucket and its <strong>buddy</strong> (split image) recombine on delete — a <strong>merge</strong> — and once every bucket is shallower than G the directory <strong>halves</strong>.</li>
              <li>The <span className="sl-inline-badge">✓ valid</span> badge re-proves the directory↔bucket coupling after every step.</li>
            </ul>
          ) : view.mode === 'linear' ? (
            <ul className="sl-note-list">
              <li>No directory: a key's address is <strong>arithmetic</strong> — <code>h mod base·2^L</code>, bumped to the finer <code>mod base·2^(L+1)</code> when it falls before the split pointer.</li>
              <li>Crossing the load threshold <strong>splits</strong> bucket <code>next</code> — <em>independent</em> of which bucket overflowed — and advances the pointer; a full sweep bumps the <strong>level</strong>.</li>
              <li>A full bucket keeps an <strong>overflow chain</strong>, paid down by later splits rather than all at once.</li>
              <li>Draining <strong>contracts</strong>: the last bucket merges back and the pointer (and level) step down.</li>
            </ul>
          ) : (
            <ul className="sl-note-list">
              <li><strong>Two tables, two hash functions.</strong> A key lives at <code>T0[h0]</code> <em>or</em> <code>T1[h1]</code> — so a lookup is a <strong>worst-case two probes</strong>, never a chain walk.</li>
              <li>An occupied slot <strong>evicts</strong> its incumbent to that key's <em>other</em> table — the cuckoo kick — which may cascade a few hops before settling.</li>
              <li>If a kick chain <strong>loops</strong>, the tables are too dense: they <strong>rehash</strong> into larger tables (two-table cuckoo stays under ~50% full).</li>
              <li>Deletes clear a slot and, as the tables drain, <strong>shrink</strong> them back down. The badge re-proves every key sits in one of its two candidate slots.</li>
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function StatBar({ view, ok }: { view: View; ok: boolean }) {
  const s = view.stats
  return (
    <div className="sl-statbar">
      <span className={`sl-badge ${ok ? 'good' : 'bad'}`}>{ok ? `✓ valid ${view.mode} hash` : `✗ ${view.invariants.length} violation(s)`}</span>
      <span className="sl-stat">keys <strong>{s.keys}</strong></span>
      {view.mode === 'extendible' ? (
        <>
          <span className="sl-stat">buckets <strong>{view.stats.buckets}</strong></span>
          <span className="sl-stat">global depth <strong>{view.stats.globalDepth}</strong></span>
          <span className="sl-stat">dir slots <strong>{view.stats.dirSlots}</strong></span>
          <span className="sl-stat">splits <strong>{view.stats.splits}</strong></span>
          <span className="sl-stat">doublings <strong>{view.stats.doublings}</strong></span>
          <span className="sl-stat">merges <strong>{view.stats.merges}</strong></span>
          <span className="sl-stat">halvings <strong>{view.stats.halvings}</strong></span>
          <span className="sl-stat">fill <strong>{(view.stats.fill * 100).toFixed(0)}%</strong></span>
        </>
      ) : view.mode === 'linear' ? (
        <>
          <span className="sl-stat">buckets <strong>{view.stats.buckets}</strong></span>
          <span className="sl-stat">level <strong>{view.stats.level}</strong></span>
          <span className="sl-stat">next <strong>{view.stats.next}</strong></span>
          <span className="sl-stat">splits <strong>{view.stats.splits}</strong></span>
          <span className="sl-stat">merges <strong>{view.stats.merges}</strong></span>
          <span className="sl-stat">overflow <strong>{view.stats.overflowKeys}</strong></span>
          <span className="sl-stat">load <strong>{(view.stats.loadFactor * 100).toFixed(0)}%</strong></span>
        </>
      ) : (
        <>
          <span className="sl-stat">table size <strong>{view.stats.size}</strong></span>
          <span className="sl-stat">slots <strong>{view.stats.slots}</strong></span>
          <span className="sl-stat">evictions <strong>{view.stats.evictions}</strong></span>
          <span className="sl-stat">rehashes <strong>{view.stats.rehashes}</strong></span>
          <span className="sl-stat">grows <strong>{view.stats.grows}</strong></span>
          <span className="sl-stat">shrinks <strong>{view.stats.shrinks}</strong></span>
          <span className="sl-stat">max kick <strong>{view.stats.maxKick}</strong></span>
          <span className="sl-stat">load <strong>{(view.stats.loadFactor * 100).toFixed(0)}%</strong></span>
        </>
      )}
    </div>
  )
}

// --- Extendible: directory column ↦ bucket boxes ---------------------------
const DIR_W = 92
const SLOTH = 24
const BUCKET_X = 260
const BUCKET_W = 240
const ROW_PAD = 22
const CHIP_H = 22

function ExtendibleView({ snap, highlight }: { snap: EhSnapshot; highlight: Set<string> }) {
  // Assign each distinct bucket a vertical slot, ordered by its first directory
  // appearance so the connecting lines cross as little as possible.
  const order: number[] = []
  const seen = new Set<number>()
  for (const d of snap.directory) if (!seen.has(d.bucketId)) { seen.add(d.bucketId); order.push(d.bucketId) }
  const bucketById = new Map(snap.buckets.map((b) => [b.id, b]))
  const bucketRowH = (id: number) => {
    const b = bucketById.get(id)
    return Math.max(SLOTH + 8, ROW_PAD + Math.max(1, b?.keys.length ?? 1) * (CHIP_H + 2))
  }
  let by = ROW_PAD
  const bucketY = new Map<number, number>()
  for (const id of order) {
    bucketY.set(id, by)
    by += bucketRowH(id) + 14
  }
  const dirHeight = ROW_PAD + snap.directory.length * SLOTH
  const height = Math.max(dirHeight, by) + ROW_PAD
  const width = BUCKET_X + BUCKET_W + 40

  return (
    <svg className="sl-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Extendible hash structure">
      {/* connectors */}
      <g className="hx-edges">
        {snap.directory.map((d, i) => {
          const y1 = ROW_PAD + i * SLOTH + SLOTH / 2
          const by2 = (bucketY.get(d.bucketId) ?? 0) + bucketRowH(d.bucketId) / 2
          const touched = highlight.has('b' + d.bucketId)
          return <path key={i} d={`M ${DIR_W} ${y1} C ${DIR_W + 60} ${y1}, ${BUCKET_X - 60} ${by2}, ${BUCKET_X} ${by2}`} className={`hx-edge ${touched ? 'touched' : ''}`} />
        })}
      </g>
      {/* directory */}
      <g className="hx-dir">
        <text x={DIR_W / 2} y={14} textAnchor="middle" className="hx-caption">
          directory · G={snap.globalDepth}
        </text>
        {snap.directory.map((d, i) => (
          <g key={i}>
            <rect x={2} y={ROW_PAD + i * SLOTH} width={DIR_W - 4} height={SLOTH - 3} rx={4} className={`hx-slot ${highlight.has('b' + d.bucketId) ? 'touched' : ''}`} />
            <text x={10} y={ROW_PAD + i * SLOTH + SLOTH / 2 + 3} className="hx-slot-bits">
              {d.bits}
            </text>
            <text x={DIR_W - 10} y={ROW_PAD + i * SLOTH + SLOTH / 2 + 3} textAnchor="end" className="hx-slot-ptr">
              #{d.bucketId}
            </text>
          </g>
        ))}
      </g>
      {/* buckets */}
      <g className="hx-buckets">
        <text x={BUCKET_X + BUCKET_W / 2} y={14} textAnchor="middle" className="hx-caption">
          buckets
        </text>
        {order.map((id) => {
          const b = bucketById.get(id)
          if (!b) return null
          const y = bucketY.get(id) ?? 0
          const h = bucketRowH(id)
          const touched = highlight.has('b' + id)
          return (
            <g key={id}>
              <rect x={BUCKET_X} y={y} width={BUCKET_W} height={h} rx={6} className={`hx-bucket ${touched ? 'touched' : ''} ${b.overfull ? 'overfull' : ''}`} />
              <text x={BUCKET_X + 8} y={y + 15} className="hx-bucket-tag">
                #{b.id} · d={b.localDepth}
              </text>
              <text x={BUCKET_X + BUCKET_W - 8} y={y + 15} textAnchor="end" className="hx-bucket-fill">
                {b.count}/{b.capacity}
              </text>
              {b.keys.map((kStr, j) => (
                <g key={j}>
                  <rect x={BUCKET_X + 8 + (j % 4) * ((BUCKET_W - 16) / 4)} y={y + 20 + Math.floor(j / 4) * (CHIP_H + 2)} width={(BUCKET_W - 16) / 4 - 3} height={CHIP_H} rx={4} className={`hx-key ${j >= b.capacity ? 'overflow' : ''}`} />
                  <text x={BUCKET_X + 8 + (j % 4) * ((BUCKET_W - 16) / 4) + ((BUCKET_W - 16) / 4 - 3) / 2} y={y + 20 + Math.floor(j / 4) * (CHIP_H + 2) + CHIP_H / 2 + 4} textAnchor="middle" className="hx-key-text">
                    {kStr}
                  </text>
                </g>
              ))}
            </g>
          )
        })}
      </g>
    </svg>
  )
}

// --- Linear: bucket columns swept by the split pointer ---------------------
const COLW = 62
const COLGAP = 12
const CELLH2 = 24
const TOPPAD = 40

function LinearView({ snap, highlight }: { snap: LhSnapshot; highlight: Set<string> }) {
  const maxCells = snap.buckets.reduce((m, b) => Math.max(m, Math.max(b.capacity, b.count)), 1)
  const colH = TOPPAD + maxCells * (CELLH2 + 2) + 24
  const width = 20 + snap.buckets.length * (COLW + COLGAP)
  const height = colH + 20
  return (
    <svg className="sl-svg" width={Math.max(width, 320)} height={height} viewBox={`0 0 ${Math.max(width, 320)} ${height}`} role="img" aria-label="Linear hash structure">
      <text x={12} y={16} className="hx-caption">
        level {snap.level} · split pointer → bucket {snap.next} · base {snap.base}
      </text>
      {snap.buckets.map((b, a) => {
        const x = 16 + a * (COLW + COLGAP)
        const touched = highlight.has('b' + b.id)
        const alreadySplit = a < snap.next
        return (
          <g key={b.id}>
            {b.isNext && <polygon points={`${x + COLW / 2 - 6},${TOPPAD - 12} ${x + COLW / 2 + 6},${TOPPAD - 12} ${x + COLW / 2},${TOPPAD - 3}`} className="hx-next-marker" />}
            <text x={x + COLW / 2} y={TOPPAD - 16} textAnchor="middle" className={`hx-addr ${alreadySplit ? 'split' : ''}`}>
              {a}
            </text>
            <rect x={x} y={TOPPAD} width={COLW} height={colH - TOPPAD - 4} rx={6} className={`hx-col ${touched ? 'touched' : ''} ${alreadySplit ? 'split' : ''}`} />
            {Array.from({ length: Math.max(b.capacity, b.count) }).map((_, j) => {
              const cy = TOPPAD + 4 + j * (CELLH2 + 2)
              const kStr = b.keys[j]
              const isOverflow = j >= b.capacity
              return (
                <g key={j}>
                  {j === b.capacity && b.count > b.capacity && <line x1={x + 3} y1={cy - 1} x2={x + COLW - 3} y2={cy - 1} className="hx-overflow-div" />}
                  {kStr !== undefined ? (
                    <>
                      <rect x={x + 4} y={cy} width={COLW - 8} height={CELLH2} rx={4} className={`hx-key ${isOverflow ? 'overflow' : ''}`} />
                      <text x={x + COLW / 2} y={cy + CELLH2 / 2 + 4} textAnchor="middle" className="hx-key-text">
                        {kStr}
                      </text>
                    </>
                  ) : (
                    <rect x={x + 4} y={cy} width={COLW - 8} height={CELLH2} rx={4} className="hx-key empty" />
                  )}
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

// --- Cuckoo: two tables of slots, a key in one of its two candidate cells ----
const CKCELL = 44
const CKGAP = 6
const CKTOP = 34
const CKROWGAP = 30

function CuckooView({ snap, highlight }: { snap: CkSnapshot; highlight: Set<string> }) {
  const cellsByTable = (t: number) => snap.cells.filter((c) => c.table === t).sort((a, b) => a.slot - b.slot)
  const width = 60 + snap.size * (CKCELL + CKGAP)
  const height = CKTOP + 2 * CKCELL + CKROWGAP + 30
  const rowY = (t: number) => CKTOP + t * (CKCELL + CKROWGAP)
  return (
    <svg className="sl-svg" width={Math.max(width, 320)} height={height} viewBox={`0 0 ${Math.max(width, 320)} ${height}`} role="img" aria-label="Cuckoo hash structure">
      {[0, 1].map((t) => (
        <g key={t}>
          <text x={8} y={rowY(t) + CKCELL / 2 + 4} className="hx-caption">
            T{t}
          </text>
          {/* slot-index ruler on the top row */}
          {t === 0 &&
            cellsByTable(0).map((c) => (
              <text key={`idx-${c.slot}`} x={52 + c.slot * (CKCELL + CKGAP) + CKCELL / 2} y={CKTOP - 8} textAnchor="middle" className="hx-addr">
                {c.slot}
              </text>
            ))}
          {cellsByTable(t).map((c) => {
            const x = 52 + c.slot * (CKCELL + CKGAP)
            const y = rowY(t)
            const touched = highlight.has(`c${t}-${c.slot}`)
            return (
              <g key={c.slot}>
                <rect x={x} y={y} width={CKCELL} height={CKCELL} rx={6} className={`hx-ckcell ${c.key !== null ? 'full' : ''} ${touched ? 'touched' : ''}`} />
                {c.key !== null && (
                  <text x={x + CKCELL / 2} y={y + CKCELL / 2 + 4} textAnchor="middle" className="hx-key-text">
                    {c.key}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      ))}
    </svg>
  )
}
