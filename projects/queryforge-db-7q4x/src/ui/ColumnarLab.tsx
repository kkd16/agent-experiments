// The Columnar Lab — the fourteenth Lab. The storage format behind every
// analytical engine (Parquet, ORC, DuckDB, ClickHouse, Vertica) made legible:
// a table sliced into row groups, each column encoded independently, each group
// fronted by a min/max zone map. Watch the auto-encoder pick a *different*
// codec per column (DICTIONARY for a category, DELTA for a monotone key, RLE
// for a run-heavy column, frame-of-reference BITPACK for a wide integer) and
// see the compression it buys; then run a predicate and watch zone-map pruning
// skip whole row groups without decoding them — the "data skipping" that lets a
// column store answer a needle-in-a-haystack query while touching a fraction of
// the data. Every byte and every skip comes from `db/columnar/*`, the same
// module the self-tests prove is a byte-for-byte round-trip.

import { useMemo, useState } from 'react'
import { generateDataset } from '../db/columnar/bench'
import { ColumnStore, canMatch, type CompareOp, type Predicate } from '../db/columnar/store'
import { encodeColumnAs, availableEncodings } from '../db/columnar/encodings'
import { ENCODING_LABEL, plainSize, type EncodingKind } from '../db/columnar/types'
import { formatValue, orderValues, type SqlValue } from '../db/types'

const ROW_OPTIONS = [1000, 4000, 8000] as const
const GROUP_OPTIONS = [64, 256, 1024] as const
const OPS: CompareOp[] = ['=', '<>', '<', '<=', '>', '>=']

const ENC_COLOR: Record<EncodingKind, string> = {
  plain: 'var(--txt-faint)',
  dict: 'var(--accent)',
  rle: 'var(--green)',
  bitpack: 'var(--accent-2)',
  delta: '#e0a458',
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${Math.round(b)} B`
}
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString()
}
function short(v: SqlValue): string {
  const s = formatValue(v)
  return s.length > 14 ? s.slice(0, 13) + '…' : s
}

function plainBytesOf(values: SqlValue[]): number {
  let b = values.length > 0 ? (values.length + 7) >> 3 : 0
  for (const v of values) b += plainSize(v)
  return b
}

export function ColumnarLab() {
  const [rows, setRows] = useState<number>(4000)
  const [groupSize, setGroupSize] = useState<number>(256)
  const [predCol, setPredCol] = useState<string>('id')
  const [op, setOp] = useState<CompareOp>('>=')
  const [valInput, setValInput] = useState<string>('')

  const data = useMemo(() => generateDataset(0xc0_1d, rows), [rows])
  const store = useMemo(() => new ColumnStore(data.columns, data.rows, groupSize), [data, groupSize])

  // Per-column encoding analysis (over the whole column, like a Parquet writer).
  const columnInfo = useMemo(() => {
    return data.columns.map((name, c) => {
      const values = data.rows.map((r) => r[c])
      const present = values.filter((v) => v !== null)
      const distinct = new Set(present.map((v) => formatValue(v))).size
      const plainB = plainBytesOf(values)
      const candidates = availableEncodings(values).map((k) => ({
        kind: k,
        bytes: encodeColumnAs(k, values).byteSize,
      }))
      candidates.sort((a, b) => a.bytes - b.bytes)
      const chosen = candidates[0]
      const maxBytes = Math.max(...candidates.map((x) => x.bytes), plainB)
      return { name, distinct, nulls: values.length - present.length, plainB, candidates, chosen, maxBytes }
    })
  }, [data])

  const totals = useMemo(() => {
    const rowStore = store.rowStoreBytes()
    const columnar = store.columnarBytes()
    return { rowStore, columnar, ratio: rowStore / columnar }
  }, [store])

  // The predicate scan + its per-group pruning verdict.
  const scan = useMemo(() => {
    const values = data.rows.map((r) => r[data.columns.indexOf(predCol)])
    const sample = values.find((v) => v !== null) ?? 0
    const numeric = typeof sample === 'number'
    let value: SqlValue
    if (valInput.trim() === '') {
      // default to a selective value: the 90th percentile of the column
      const present = values.filter((v) => v !== null) as SqlValue[]
      present.sort((a, b) => orderValues(a, b))
      value = present[Math.floor(present.length * 0.9)] ?? sample
    } else {
      value = numeric ? Number(valInput) : valInput
    }
    const pred: Predicate = { kind: 'cmp', col: predCol, op, value }
    const res = store.scan([pred], data.columns)
    const groups = store.groups.map((g, i) => {
      const zone = g.chunks[predCol].zone
      const kept = canMatch(pred, zone)
      return { i, rows: g.rows, min: zone.min, max: zone.max, kept }
    })
    return { pred, value, numeric, res, groups }
  }, [store, data, predCol, op, valInput])

  return (
    <div className="cs-lab">
      <div className="cs-head">
        <h2>Columnar Lab</h2>
        <p>
          The storage layout behind every analytical database — <em>Parquet, ORC, DuckDB, ClickHouse</em>. A table is
          sliced into <em>row groups</em>; each column is encoded on its own, and each group carries a min/max{' '}
          <em>zone map</em>. The auto-encoder picks a different codec per column, and a predicate skips whole groups the
          zone map rules out — <em>data skipping</em> — so a selective query touches a fraction of the data. Every byte
          is from <code>db/columnar/*</code>, proven a byte-for-byte round-trip.
        </p>
      </div>

      <div className="cs-controls">
        <div className="cs-control">
          <label>Rows</label>
          <div className="cs-seg">
            {ROW_OPTIONS.map((r) => (
              <button key={r} className={r === rows ? 'active' : ''} onClick={() => setRows(r)}>
                {fmtNum(r)}
              </button>
            ))}
          </div>
        </div>
        <div className="cs-control">
          <label>Row-group size</label>
          <div className="cs-seg">
            {GROUP_OPTIONS.map((g) => (
              <button key={g} className={g === groupSize ? 'active' : ''} onClick={() => setGroupSize(g)}>
                {g}
              </button>
            ))}
          </div>
        </div>
        <div className="cs-control">
          <label>Compression</label>
          <div className="cs-ratio">
            {totals.ratio.toFixed(2)}× <span>smaller than a row store</span>
          </div>
        </div>
      </div>

      {/* ---- per-column encodings ---- */}
      <div className="cs-panel">
        <h3>Per-column encoding — the auto-encoder specialises each column</h3>
        <div className="cs-cols">
          {columnInfo.map((ci) => (
            <div className="cs-col" key={ci.name}>
              <div className="cs-col-head">
                <span className="cs-col-name">{ci.name}</span>
                <span className="cs-chip" style={{ background: ENC_COLOR[ci.chosen.kind] }}>
                  {ENCODING_LABEL[ci.chosen.kind]}
                </span>
              </div>
              <div className="cs-col-meta">
                {fmtNum(ci.distinct)} distinct · {fmtNum(ci.nulls)} null · {(ci.plainB / ci.chosen.bytes).toFixed(1)}×
              </div>
              <div className="cs-bars">
                {ci.candidates.map((cand) => (
                  <div className="cs-bar-row" key={cand.kind}>
                    <span className="cs-bar-label">{ENCODING_LABEL[cand.kind].split(' ')[0]}</span>
                    <div className="cs-bar-track">
                      <div
                        className="cs-bar-fill"
                        style={{
                          width: `${(cand.bytes / ci.maxBytes) * 100}%`,
                          background: cand.kind === ci.chosen.kind ? ENC_COLOR[cand.kind] : 'var(--line-2)',
                        }}
                      />
                    </div>
                    <span className="cs-bar-num">{fmtBytes(cand.bytes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="cs-total">
          <div className="cs-total-item">
            <span className="cs-k">Row store</span>
            <span className="cs-v">{fmtBytes(totals.rowStore)}</span>
          </div>
          <div className="cs-total-bar">
            <div className="cs-total-fill row" style={{ width: '100%' }} />
            <div className="cs-total-fill col" style={{ width: `${(totals.columnar / totals.rowStore) * 100}%` }} />
          </div>
          <div className="cs-total-item">
            <span className="cs-k">Column store</span>
            <span className="cs-v accent">{fmtBytes(totals.columnar)}</span>
          </div>
        </div>
      </div>

      {/* ---- zone-map pruning ---- */}
      <div className="cs-panel">
        <h3>Zone-map pruning — a predicate skips whole row groups</h3>
        <div className="cs-pred">
          <span>WHERE</span>
          <select value={predCol} onChange={(e) => setPredCol(e.target.value)}>
            {data.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value as CompareOp)}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <input
            value={valInput}
            onChange={(e) => setValInput(e.target.value)}
            placeholder={short(scan.value)}
            className="cs-val"
          />
          <span className="cs-pred-hint">
            scanning <b>{short(scan.value)}</b>
          </span>
        </div>

        <div className="cs-stat-row">
          <Stat k="Row groups" v={fmtNum(scan.res.metrics.totalGroups)} />
          <Stat k="Pruned (skipped)" v={fmtNum(scan.res.metrics.groupsPruned)} accent />
          <Stat k="Scanned" v={fmtNum(scan.res.metrics.groupsScanned)} />
          <Stat
            k="Data skipped"
            v={`${((scan.res.metrics.groupsPruned / Math.max(1, scan.res.metrics.totalGroups)) * 100).toFixed(0)}%`}
            accent
          />
          <Stat k="Matched rows" v={fmtNum(scan.res.metrics.matched)} />
        </div>

        <div className="cs-groups">
          {scan.groups.map((g) => (
            <div
              key={g.i}
              className={`cs-group ${g.kept ? 'scanned' : 'pruned'}`}
              title={`group ${g.i}: ${predCol} ∈ [${formatValue(g.min)}, ${formatValue(g.max)}]  (${g.rows} rows) — ${
                g.kept ? 'scanned' : 'pruned'
              }`}
            >
              <span className="cs-group-i">#{g.i}</span>
              <span className="cs-group-range">
                {short(g.min)}‥{short(g.max)}
              </span>
            </div>
          ))}
        </div>

        <div className="cs-decode">
          <div className="cs-decode-row">
            <span>Cells a naive row-store scan reads</span>
            <div className="cs-decode-track">
              <div className="cs-decode-fill full" style={{ width: '100%' }} />
            </div>
            <span className="cs-decode-num">{fmtNum(scan.res.metrics.fullScanValues)}</span>
          </div>
          <div className="cs-decode-row">
            <span>Cells this column-store scan decodes</span>
            <div className="cs-decode-track">
              <div
                className="cs-decode-fill kept"
                style={{
                  width: `${(scan.res.metrics.valuesDecoded / Math.max(1, scan.res.metrics.fullScanValues)) * 100}%`,
                }}
              />
            </div>
            <span className="cs-decode-num accent">{fmtNum(scan.res.metrics.valuesDecoded)}</span>
          </div>
          <p className="cs-note">
            Column projection + group pruning + late materialization together cut decoding to{' '}
            <b>
              {((scan.res.metrics.valuesDecoded / Math.max(1, scan.res.metrics.fullScanValues)) * 100).toFixed(1)}%
            </b>{' '}
            of a full scan — and the answer is identical (proven against a brute-force filter in the self-tests).
          </p>
        </div>
      </div>
    </div>
  )
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="cs-stat">
      <span className="cs-stat-k">{k}</span>
      <span className={`cs-stat-v ${accent ? 'accent' : ''}`}>{v}</span>
    </div>
  )
}
