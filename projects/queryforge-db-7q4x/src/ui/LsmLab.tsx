// The LSM Lab — a living Log-Structured Merge tree you can poke.
//
// QueryForge's read-optimized storage engine is the B+Tree (the Storage Lab).
// This is its write-optimized mirror image — the structure behind LevelDB,
// RocksDB and Cassandra. Insert and delete keys and watch them land in the
// in-memory skip-list **memtable**, **flush** to an immutable L0 SSTable when it
// fills, and **compact** down a hierarchy of levels as the budgets overflow —
// each step narrated from the tree's own trace, re-proven a valid LSM after every
// mutation. A point lookup lights up the exact read path — which SSTables it read
// and which it skipped by Bloom filter or fence pointer — so read amplification is
// something you can see. Toggle between leveled and size-tiered compaction and
// watch the write/read/space-amplification trade-off move. The tenth Lab, sibling
// to Storage / IVM / Sketch / WCOJ / Optimizer / Execution / Vectorize / Compile /
// Fuzz / Concurrency / Recovery.

import { useCallback, useMemo, useRef, useState } from 'react'
import { LsmTree, type LsmSnapshot, type GetResult, type Strategy, type TableView } from '../db/lsm/tree'
import { runBench, type BenchResult } from '../db/lsm/bench'
import { Rng } from '../db/fuzz/rng'
import type { IndexKey } from '../db/storage/btree'

const MEM_LIMITS = [8, 16, 32] as const

interface View {
  snap: LsmSnapshot
  invariant: string | null
  trace: { kind: string; text: string }[]
}

function fmtKey(k: IndexKey): string {
  return k.length === 1 ? String(k[0]) : `(${k.join(',')})`
}

// Colour a table by what a lookup did with it.
const OUTCOME_CLASS: Record<string, string> = {
  'read-hit': 'hit',
  'read-miss': 'miss',
  'bloom-skip': 'bloom',
  'fence-skip': 'fence',
  'memtable-hit': 'hit',
}

export function LsmLab() {
  const treeRef = useRef<LsmTree>(new LsmTree({ strategy: 'leveled', memtableLimit: 16 }))
  // Mirror of the live key→value set, so we can rebuild on a config change and
  // pick real keys to delete.
  const liveRef = useRef<Map<string, number>>(new Map())
  const rngRef = useRef<Rng>(new Rng(0xbeef))

  const [strategy, setStrategy] = useState<Strategy>('leveled')
  const [memLimit, setMemLimit] = useState<number>(16)
  const [keyInput, setKeyInput] = useState('')
  const [valInput, setValInput] = useState('')
  const [getInput, setGetInput] = useState('')
  const [rangeLo, setRangeLo] = useState('')
  const [rangeHi, setRangeHi] = useState('')
  const [lastGet, setLastGet] = useState<{ key: number; res: GetResult } | null>(null)
  const [rangeResult, setRangeResult] = useState<{ lo: string; hi: string; rows: { key: IndexKey; value: unknown }[] } | null>(null)
  const [message, setMessage] = useState('Insert keys (or run a workload) and watch the memtable flush and levels compact.')
  const [bench, setBench] = useState<BenchResult | null>(null)

  const runBenchmark = useCallback(() => {
    // A fixed seed so the race is reproducible; the same op stream feeds all three.
    setBench(runBench(4000, 0xf00d))
  }, [])

  const [view, setView] = useState<View>(() => {
    // A fresh, empty tree with the default config — identical to the ref's, but
    // not read from the ref during render (refs are event-/effect-only).
    const t = new LsmTree({ strategy: 'leveled', memtableLimit: 16 })
    return { snap: t.snapshot(), invariant: t.checkInvariants(), trace: [] }
  })
  const commit = useCallback((msg?: string) => {
    const t = treeRef.current
    setView({ snap: t.snapshot(), invariant: t.checkInvariants(), trace: t.trace.slice(-14).reverse() })
    if (msg) setMessage(msg)
  }, [])

  // --- primitive ops ------------------------------------------------------
  const doPut = useCallback(
    (k: number, v: number) => {
      treeRef.current.put([k], v)
      liveRef.current.set(String(k), v)
    },
    [],
  )
  const doDel = useCallback((k: number) => {
    treeRef.current.del([k])
    liveRef.current.delete(String(k))
  }, [])

  const putManual = useCallback(() => {
    const k = parseInt(keyInput, 10)
    if (Number.isNaN(k)) return
    const v = valInput.trim() === '' ? k : parseInt(valInput, 10)
    doPut(k, Number.isNaN(v) ? k : v)
    commit(`put ${k} = ${Number.isNaN(v) ? k : v} → memtable (${treeRef.current.snapshot().memSize}/${treeRef.current.cfg.memtableLimit} full).`)
  }, [keyInput, valInput, doPut, commit])

  const delManual = useCallback(() => {
    const k = parseInt(keyInput, 10)
    if (Number.isNaN(k)) return
    doDel(k)
    commit(`delete ${k} → a tombstone travels down the tree until it reaches the bottom level and is reclaimed.`)
  }, [keyInput, doDel, commit])

  const runGet = useCallback(() => {
    const k = parseInt(getInput, 10)
    if (Number.isNaN(k)) return
    const res = treeRef.current.get([k])
    setLastGet({ key: k, res })
    const where = res.hitLevel === -1 ? 'the memtable' : res.hitLevel === -2 ? 'nowhere' : `L${res.hitLevel}`
    commit(
      res.found
        ? `get ${k} = ${String(res.value)} — found in ${where} after reading ${res.tablesConsulted} table(s); Bloom skipped ${res.bloomSkips}, fences skipped ${res.fenceSkips}.`
        : `get ${k} — not found (${res.hitLevel === -2 ? 'absent' : 'tombstone in ' + where}); read ${res.tablesConsulted} table(s), Bloom skipped ${res.bloomSkips}, fences skipped ${res.fenceSkips}.`,
    )
  }, [getInput, commit])

  const runRange = useCallback(() => {
    const lo = rangeLo.trim() === '' ? null : [parseInt(rangeLo, 10)]
    const hi = rangeHi.trim() === '' ? null : [parseInt(rangeHi, 10)]
    const rows = treeRef.current.range(lo, hi)
    setRangeResult({ lo: rangeLo.trim() || '−∞', hi: rangeHi.trim() || '+∞', rows })
    setLastGet(null)
    commit(`range ${rangeLo.trim() || '−∞'} … ${rangeHi.trim() || '+∞'}: the merging iterator reconciled every level into ${rows.length} live row(s).`)
  }, [rangeLo, rangeHi, commit])

  // --- workloads ----------------------------------------------------------
  const insertRandom = useCallback(
    (n: number) => {
      const rng = rngRef.current
      for (let i = 0; i < n; i++) doPut(rng.int(0, 199), rng.int(0, 9999))
      commit(`Inserted ${n} random keys — ${treeRef.current.metrics.flushes} flush(es), ${treeRef.current.metrics.compactions} compaction(s) so far.`)
    },
    [doPut, commit],
  )
  const insertSequential = useCallback(
    (n: number) => {
      const base = liveRef.current.size
      for (let i = 0; i < n; i++) doPut(base + i, (base + i) * 3)
      commit(`Inserted ${n} sequential keys — sequential inserts pack levels tightly (minimal overlap).`)
    },
    [doPut, commit],
  )
  const churn = useCallback(
    (n: number) => {
      const rng = rngRef.current
      for (let i = 0; i < n; i++) {
        const keys = [...liveRef.current.keys()]
        if (keys.length && rng.chance(0.4)) doDel(parseInt(rng.pick(keys), 10))
        else doPut(rng.int(0, 199), rng.int(0, 9999))
      }
      commit(`Churned ${n} mixed put/delete ops — overwrites and tombstones reconcile as compaction runs.`)
    },
    [doPut, doDel, commit],
  )
  const deleteRandom = useCallback(
    (n: number) => {
      const rng = rngRef.current
      let done = 0
      for (let i = 0; i < n; i++) {
        const keys = [...liveRef.current.keys()]
        if (!keys.length) break
        doDel(parseInt(rng.pick(keys), 10))
        done++
      }
      commit(`Deleted ${done} random keys — each leaves a tombstone that shadows the older value until the bottom level.`)
    },
    [doDel, commit],
  )

  const forceFlush = useCallback(() => {
    treeRef.current.flush()
    commit('Forced a flush: the active memtable was sealed into a new L0 SSTable, then compaction ran.')
  }, [commit])

  const majorCompact = useCallback(() => {
    treeRef.current.majorCompaction()
    setLastGet(null)
    commit('Major compaction: merged every SSTable into one sorted run — all tombstones and shadowed versions reclaimed, exactly one entry per live key.')
  }, [commit])

  const reset = useCallback(() => {
    treeRef.current.reset()
    liveRef.current.clear()
    rngRef.current = new Rng(0xbeef)
    setLastGet(null)
    setRangeResult(null)
    commit('Reset. Insert keys to begin.')
  }, [commit])

  // Rebuild on a config change, replaying the current live set into a fresh tree.
  const rebuild = useCallback(
    (nextStrategy: Strategy, nextLimit: number) => {
      const entries = [...liveRef.current.entries()]
      const t = new LsmTree({ strategy: nextStrategy, memtableLimit: nextLimit })
      for (const [k, v] of entries) t.put([parseInt(k, 10)], v)
      treeRef.current = t
      setLastGet(null)
      setRangeResult(null)
      setView({ snap: t.snapshot(), invariant: t.checkInvariants(), trace: t.trace.slice(-14).reverse() })
      const blurb =
        nextStrategy === 'leveled'
          ? 'Leveled: each level ≥ L1 is one sorted non-overlapping run — low read/space amp, higher write amp.'
          : nextStrategy === 'tiered'
            ? 'Size-tiered: each tier holds several overlapping runs merged wholesale — low write amp, higher read/space amp.'
            : 'Lazy-leveled (Dostoevsky): tiered shallow levels, one leveled run at the largest level — near-tiered writes, near-leveled reads/space.'
      setMessage(`Rebuilt as a ${nextStrategy} tree (memtable ${nextLimit}) from ${entries.length} live key(s). ${blurb}`)
    },
    [],
  )
  const changeStrategy = useCallback(
    (s: Strategy) => {
      setStrategy(s)
      rebuild(s, memLimit)
    },
    [memLimit, rebuild],
  )
  const changeLimit = useCallback(
    (l: number) => {
      setMemLimit(l)
      rebuild(strategy, l)
    },
    [strategy, rebuild],
  )

  const snap = view.snap
  const m = snap.metrics
  const ok = view.invariant === null
  const touched = useMemo(() => {
    const map = new Map<number, string>()
    if (lastGet) for (const step of lastGet.res.path) if (step.tableId) map.set(step.tableId, OUTCOME_CLASS[step.outcome] ?? 'miss')
    return map
  }, [lastGet])

  return (
    <div className="lab lsm-lab">
      <div className="lab-head">
        <h2>LSM Lab</h2>
        <p className="lab-sub">
          The write-optimized <em>Log-Structured Merge tree</em> — the engine behind LevelDB, RocksDB and Cassandra.
          Writes land in a skip-list <em>memtable</em>, <em>flush</em> to immutable sorted <em>SSTables</em>, and{' '}
          <em>compact</em> down the levels. Watch flushes, compaction, Bloom-filtered reads and the amplification
          trade-off, each step re-proven a valid LSM.
        </p>
      </div>

      {/* controls */}
      <div className="lsm-controls">
        <div className="lsm-ctl-group">
          <span className="lsm-ctl-label">strategy</span>
          <div className="lsm-seg">
            <button className={strategy === 'leveled' ? 'on' : ''} onClick={() => changeStrategy('leveled')}>
              leveled
            </button>
            <button className={strategy === 'tiered' ? 'on' : ''} onClick={() => changeStrategy('tiered')}>
              size-tiered
            </button>
            <button className={strategy === 'lazy' ? 'on' : ''} onClick={() => changeStrategy('lazy')}>
              lazy-leveled
            </button>
          </div>
        </div>
        <div className="lsm-ctl-group">
          <span className="lsm-ctl-label">memtable</span>
          <div className="lsm-seg">
            {MEM_LIMITS.map((l) => (
              <button key={l} className={memLimit === l ? 'on' : ''} onClick={() => changeLimit(l)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="lsm-ctl-group grow">
          <button className="btn" onClick={() => insertRandom(50)}>
            +50 random
          </button>
          <button className="btn" onClick={() => insertSequential(50)}>
            +50 sequential
          </button>
          <button className="btn" onClick={() => churn(100)}>
            churn ×100
          </button>
          <button className="btn" onClick={() => deleteRandom(25)}>
            delete ×25
          </button>
          <button className="btn ghost" onClick={forceFlush}>
            flush
          </button>
          <button className="btn ghost" onClick={majorCompact}>
            major compact
          </button>
          <button className="btn ghost" onClick={reset}>
            reset
          </button>
        </div>
      </div>

      <div className="lsm-manual">
        <span className="lsm-ctl-label">key</span>
        <input className="lsm-input" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="e.g. 42" />
        <span className="lsm-ctl-label">value</span>
        <input className="lsm-input" value={valInput} onChange={(e) => setValInput(e.target.value)} placeholder="opt" />
        <button className="btn" onClick={putManual}>
          put
        </button>
        <button className="btn" onClick={delManual}>
          delete
        </button>
        <span className="lsm-sep" />
        <span className="lsm-ctl-label">get</span>
        <input className="lsm-input" value={getInput} onChange={(e) => setGetInput(e.target.value)} placeholder="key" />
        <button className="btn" onClick={runGet}>
          get ▸
        </button>
        <span className="lsm-sep" />
        <span className="lsm-ctl-label">range</span>
        <input className="lsm-input sm" value={rangeLo} onChange={(e) => setRangeLo(e.target.value)} placeholder="lo" />
        <input className="lsm-input sm" value={rangeHi} onChange={(e) => setRangeHi(e.target.value)} placeholder="hi" />
        <button className="btn" onClick={runRange}>
          scan ▸
        </button>
      </div>

      <div className={`lsm-badge ${ok ? 'ok' : 'bad'}`}>
        {ok ? '✓ valid LSM' : `✗ ${view.invariant}`}
      </div>

      <p className="lsm-message">{message}</p>

      {/* metrics */}
      <div className="lsm-metrics">
        <Metric label="live keys" value={m.liveKeys} />
        <Metric label="stored entries" value={m.totalEntries} hint="incl. shadowed + tombstones" />
        <Metric label="flushes" value={m.flushes} />
        <Metric label="compactions" value={m.compactions} />
        <Metric label="write amp" value={m.writeAmp.toFixed(2) + '×'} hint="bytes written / user bytes" />
        <Metric label="space amp" value={m.spaceAmp.toFixed(2) + '×'} hint="on-disk / live bytes" />
        {lastGet && (
          <Metric
            label="last read"
            value={`${lastGet.res.tablesConsulted} read`}
            hint={`${lastGet.res.bloomSkips} bloom-skip · ${lastGet.res.fenceSkips} fence-skip`}
          />
        )}
      </div>

      {/* memtable */}
      <div className="lsm-section-title">
        Memtable <span className="lsm-dim">skip list · {snap.memSize}/{snap.memLimit} entries</span>
        <div className="lsm-memfill">
          <div className="lsm-memfill-bar" style={{ width: `${Math.min(100, (snap.memSize / snap.memLimit) * 100)}%` }} />
        </div>
      </div>
      <SkipListView snap={snap} />

      {/* levels */}
      <div className="lsm-section-title">
        {strategy === 'leveled' ? 'Levels' : 'Tiers'} <span className="lsm-dim">immutable SSTables, newest at the top</span>
      </div>
      <div className="lsm-levels">
        {snap.levels.map((level, i) => (
          <LevelRow key={i} index={i} tables={level} strategy={strategy} touched={touched} />
        ))}
        {snap.levels.every((l) => l.length === 0) && <div className="lsm-empty">No SSTables yet — insert enough keys to fill and flush the memtable.</div>}
      </div>

      {/* read path + range result + trace */}
      <div className="lsm-lower">
        <div className="lsm-panel">
          <div className="lsm-panel-title">Read path {lastGet && <span className="lsm-dim">get {lastGet.key}</span>}</div>
          {lastGet ? (
            <div className="lsm-readpath">
              {lastGet.res.path.length === 0 && <div className="lsm-dim">Found immediately in the memtable.</div>}
              {lastGet.res.path.map((step, i) => (
                <div key={i} className={`lsm-probe ${OUTCOME_CLASS[step.outcome] ?? 'miss'}`}>
                  <span className="lsm-probe-loc">{step.level === -1 ? 'memtable' : `L${step.level} #${step.tableId}`}</span>
                  <span className="lsm-probe-out">{step.outcome.replace('-', ' ')}</span>
                </div>
              ))}
              <div className="lsm-readpath-summary">
                {lastGet.res.found ? (
                  <span className="ok">value = {String(lastGet.res.value)}</span>
                ) : (
                  <span className="bad">not found</span>
                )}
                {' · '}read {lastGet.res.tablesConsulted}, bloom-skipped {lastGet.res.bloomSkips}, fence-skipped {lastGet.res.fenceSkips}
              </div>
            </div>
          ) : (
            <div className="lsm-dim">Run a <em>get</em> to trace which SSTables it reads and which the Bloom filter / fence pointers skip.</div>
          )}
          {rangeResult && (
            <div className="lsm-rangeres">
              <div className="lsm-panel-title" style={{ marginTop: 10 }}>
                Range {rangeResult.lo} … {rangeResult.hi} <span className="lsm-dim">{rangeResult.rows.length} live rows (merged, tombstones removed)</span>
              </div>
              <div className="lsm-rangerows">
                {rangeResult.rows.slice(0, 40).map((r, i) => (
                  <span key={i} className="lsm-rangecell">
                    {fmtKey(r.key)}<span className="lsm-dim">={String(r.value)}</span>
                  </span>
                ))}
                {rangeResult.rows.length > 40 && <span className="lsm-dim">… +{rangeResult.rows.length - 40}</span>}
                {rangeResult.rows.length === 0 && <span className="lsm-dim">(empty)</span>}
              </div>
            </div>
          )}
        </div>
        <div className="lsm-panel">
          <div className="lsm-panel-title">Trace <span className="lsm-dim">most recent first</span></div>
          <div className="lsm-trace">
            {view.trace.length === 0 && <div className="lsm-dim">Operations will be narrated here.</div>}
            {view.trace.map((t, i) => (
              <div key={i} className={`lsm-trace-line ${t.kind}`}>
                <span className={`lsm-trace-tag ${t.kind}`}>{t.kind}</span>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* amplification benchmark */}
      <div className="lsm-section-title">
        Amplification benchmark <span className="lsm-dim">the RUM trade-off — same workload, three strategies</span>
      </div>
      <div className="lsm-bench">
        <div className="lsm-bench-head">
          <button className="btn" onClick={runBenchmark}>
            race leveled vs tiered vs lazy ▸
          </button>
          {bench && (
            <span className={`lsm-badge ${bench.identical ? 'ok' : 'bad'}`}>
              {bench.identical ? '✓ identical live state' : '✗ strategies disagreed'}
            </span>
          )}
          {bench && <span className="lsm-dim">{bench.ops} ops · {bench.probes} point probes</span>}
        </div>
        {!bench ? (
          <div className="lsm-dim">
            Run the same deterministic op stream through all three compaction strategies and compare write /
            read / space amplification. Whatever the cost profile, the answers must be byte-identical.
          </div>
        ) : (
          <BenchTable bench={bench} />
        )}
      </div>
    </div>
  )
}

function BenchTable({ bench }: { bench: BenchResult }) {
  const maxW = Math.max(...bench.results.map((r) => r.writeAmp), 1)
  const maxR = Math.max(...bench.results.map((r) => r.avgReadTables), 0.01)
  const maxS = Math.max(...bench.results.map((r) => r.spaceAmp), 1)
  const label: Record<Strategy, string> = { leveled: 'leveled', tiered: 'size-tiered', lazy: 'lazy-leveled' }
  return (
    <div className="lsm-bench-grid">
      <div className="lsm-bench-row lsm-bench-hd">
        <span>strategy</span>
        <span>write amp</span>
        <span>read amp (tables/lookup)</span>
        <span>space amp</span>
        <span>flush / compact</span>
      </div>
      {bench.results.map((r) => (
        <div key={r.strategy} className="lsm-bench-row">
          <span className={`lsm-bench-name ${r.strategy}`}>{label[r.strategy]}</span>
          <BenchBar value={r.writeAmp} max={maxW} suffix="×" kind="write" />
          <BenchBar value={r.avgReadTables} max={maxR} suffix="" kind="read" />
          <BenchBar value={r.spaceAmp} max={maxS} suffix="×" kind="space" />
          <span className="lsm-bench-fc">
            {r.flushes} / {r.compactions}
          </span>
        </div>
      ))}
      <div className="lsm-bench-note">
        Leveled minimizes read + space amp (one run per level) at the cost of write amp; size-tiered minimizes
        write amp at the cost of read + space; lazy-leveled sits between — near-tiered writes, near-leveled reads.
      </div>
    </div>
  )
}

function BenchBar({ value, max, suffix, kind }: { value: number; max: number; suffix: string; kind: string }) {
  return (
    <span className="lsm-bench-cell">
      <span className={`lsm-bench-bar ${kind}`} style={{ width: `${Math.max(4, (value / max) * 100)}%` }} />
      <span className="lsm-bench-val">
        {value.toFixed(2)}
        {suffix}
      </span>
    </span>
  )
}

function Metric({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="lsm-metric">
      <div className="lsm-metric-value">{value}</div>
      <div className="lsm-metric-label">{label}</div>
      {hint && <div className="lsm-metric-hint">{hint}</div>}
    </div>
  )
}

function LevelRow({ index, tables, strategy, touched }: { index: number; tables: TableView[]; strategy: Strategy; touched: Map<number, string> }) {
  const entries = tables.reduce((n, t) => n + t.count, 0)
  const label = index === 0 ? 'L0' : `L${index}`
  const kind = index === 0 || strategy === 'tiered' ? 'overlapping' : 'sorted run'
  return (
    <div className="lsm-level">
      <div className="lsm-level-head">
        <span className="lsm-level-name">{label}</span>
        <span className="lsm-dim">
          {tables.length} table{tables.length === 1 ? '' : 's'} · {entries} entries · {kind}
        </span>
      </div>
      <div className="lsm-level-tables">
        {tables.length === 0 && <span className="lsm-level-empty">—</span>}
        {tables.map((t) => (
          <div key={t.id} className={`lsm-sst ${touched.get(t.id) ?? ''}`} title={`SSTable #${t.id}: ${t.count} entries, ${t.blocks} blocks, Bloom ${t.bloomBits}b @ ${(t.bloomFpr * 100).toFixed(1)}% FPR`}>
            <div className="lsm-sst-top">
              <span className="lsm-sst-id">#{t.id}</span>
              {t.hasTombstones && <span className="lsm-sst-tomb" title="contains tombstones">⊘</span>}
              <span className="lsm-sst-n">{t.count}</span>
            </div>
            <div className="lsm-sst-range">
              {fmtKey(t.minKey)}‥{fmtKey(t.maxKey)}
            </div>
            <div className="lsm-sst-bloom" title={`Bloom fill ${(t.bloomFill * 100).toFixed(0)}%`}>
              <div className="lsm-sst-bloom-fill" style={{ width: `${Math.min(100, t.bloomFill * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// The skip-list memtable drawn as express lanes: each node is a tower whose
// height is its level; a lane at height L connects a node to the next node also
// reaching height L (visualizing the "skips").
function SkipListView({ snap }: { snap: LsmSnapshot }) {
  const nodes = snap.memtable.nodes
  const shown = nodes.slice(0, 48)
  const levelCount = Math.max(1, snap.memtable.levelCount)
  const NODEW = 26
  const GAP = 6
  const LANEH = 12
  const PAD = 8
  const width = PAD * 2 + shown.length * (NODEW + GAP)
  const height = PAD * 2 + levelCount * LANEH + 22
  const xOf = (i: number) => PAD + i * (NODEW + GAP) + NODEW / 2
  const yOf = (lvl: number) => PAD + (levelCount - 1 - lvl) * LANEH

  // For each lane level, connect consecutive reaching nodes.
  const lanes: { x1: number; x2: number; y: number }[] = []
  for (let lvl = 0; lvl < levelCount; lvl++) {
    let prev = -1
    for (let i = 0; i < shown.length; i++) {
      if (shown[i].height > lvl) {
        if (prev >= 0) lanes.push({ x1: xOf(prev), x2: xOf(i), y: yOf(lvl) })
        prev = i
      }
    }
  }

  if (nodes.length === 0) return <div className="lsm-empty">Memtable is empty.</div>

  return (
    <div className="lsm-skip-wrap">
      <svg width={width} height={height} className="lsm-skip">
        {lanes.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y + 4} x2={l.x2} y2={l.y + 4} className="lsm-lane" />
        ))}
        {shown.map((n, i) => {
          const x = PAD + i * (NODEW + GAP)
          const top = yOf(n.height - 1)
          const h = n.height * LANEH
          return (
            <g key={i}>
              <rect x={x} y={top} width={NODEW} height={h} rx={3} className={`lsm-node ${n.tombstone ? 'tomb' : ''}`} />
              <text x={x + NODEW / 2} y={height - PAD - 2} className="lsm-node-key">
                {fmtKey(n.key)}
              </text>
            </g>
          )
        })}
      </svg>
      {nodes.length > shown.length && <div className="lsm-dim">… +{nodes.length - shown.length} more nodes</div>}
    </div>
  )
}
