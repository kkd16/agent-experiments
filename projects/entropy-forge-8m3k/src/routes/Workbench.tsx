import { useRef, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { CODECS } from '../lib/codecs'
import { analyze } from '../lib/entropy'
import { bytesEqual, strToBytes } from '../lib/bits'
import { fmtBytes, seriesColor } from '../lib/format'

// Racing every codec includes the naive O(n² log n) BWT, so cap the raced payload
// to keep the button responsive; larger uploads are truncated with a clear note.
const CAP = 8192

interface Row {
  id: string
  name: string
  bytes: Uint8Array
  size: number
  ratio: number
  ok: boolean
  ms: number
}

export function Workbench() {
  const [data, setData] = useState<Uint8Array | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [label, setLabel] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const run = (input: Uint8Array, srcLabel: string) => {
    const trunc = input.length > CAP
    const payload = trunc ? input.subarray(0, CAP) : input
    setTruncated(trunc)
    setData(payload)
    setLabel(srcLabel)
    const out: Row[] = []
    for (const c of CODECS) {
      let size = 0
      let ok = false
      let ms = 0
      let enc: Uint8Array = new Uint8Array(0)
      try {
        const t0 = performance.now()
        enc = c.encode(payload)
        const dec = c.decode(enc)
        ms = performance.now() - t0
        ok = bytesEqual(dec, payload)
        size = enc.length
      } catch {
        // Leaves ok=false; a codec that throws simply shows as a failed round-trip.
      }
      out.push({
        id: c.id,
        name: c.name,
        bytes: enc,
        size,
        ratio: payload.length > 0 ? size / payload.length : 1,
        ok,
        ms,
      })
    }
    out.sort((a, b) => a.size - b.size)
    setRows(out)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer)
      run(buf, `${f.name} (${fmtBytes(f.size)})`)
    }
    reader.readAsArrayBuffer(f)
  }

  const download = (row: Row) => {
    try {
      const blob = new Blob([row.bytes.slice() as unknown as BlobPart], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `input.${row.id}.bin`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Sandbox / thumbnail context — downloads are simply unavailable there.
    }
  }

  const report = data && data.length > 0 ? analyze(data) : null
  const best = rows && rows.length > 0 ? rows[0] : null

  return (
    <div>
      <PageHeader
        kicker="Module 09 · bring your own bytes"
        title="Workbench — compress anything"
        lede={
          <>
            Paste text or drop a file and race <strong>every codec in the lab</strong> on your own
            bytes. Each result is <strong>verified by a full decode</strong> back to the original,
            timed, and downloadable as a real compressed blob. This is the same engine the Benchmark
            uses — now pointed at whatever you give it.
          </>
        }
      />

      <Panel title="Input">
        <textarea
          value={pasteText}
          rows={4}
          spellCheck={false}
          placeholder="Paste text here, then press Compress…"
          onChange={(e) => setPasteText(e.target.value)}
        />
        <div className="controls" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={() => run(strToBytes(pasteText), 'pasted text')}
            disabled={pasteText.length === 0}
          >
            Compress text
          </button>
          <span className="muted" style={{ fontSize: 13 }}>or</span>
          <button className="btn" onClick={() => fileRef.current?.click()}>Upload a file…</button>
          <input ref={fileRef} type="file" onChange={onFile} style={{ display: 'none' }} />
          <span className="tag">capped at {fmtBytes(CAP)} for the full race</span>
        </div>
      </Panel>

      {rows && data && (
        <>
          <div className="grid grid-4" style={{ marginTop: 16 }}>
            <Stat label="Input" value={data.length} unit="B" sub={truncated ? `${label} · truncated to cap` : label} />
            <Stat label="Order-0 entropy" value={report ? report.order0.toFixed(2) : '0'} unit="b/sym" sub={report ? `floor ≈ ${Math.ceil(report.idealBits / 8)} B` : undefined} />
            <Stat label="Best codec" value={best ? best.name.split(' ')[0] : '—'} accent sub={best ? `${(best.ratio * 100).toFixed(0)}% of original` : undefined} />
            <Stat label="Round-trips" value={rows.filter((r) => r.ok).length + '/' + rows.length} sub={rows.every((r) => r.ok) ? 'all verified ✓' : 'a codec failed'} />
          </div>

          <Panel title="Results" note="sorted smallest-first · every row decoded back to your exact bytes before it is shown">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Codec</th>
                    <th>Size</th>
                    <th>Ratio</th>
                    <th>bits/sym</th>
                    <th>Time</th>
                    <th>Round-trip</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id}>
                      <td style={{ textAlign: 'left' }}>
                        <span className="dot-swatch" style={{ background: seriesColor(i) }} /> {r.name}
                      </td>
                      <td className="num">{r.size} B</td>
                      <td className="num" style={{ color: i === 0 ? 'var(--green)' : 'var(--text)', fontWeight: i === 0 ? 700 : 400 }}>
                        {(r.ratio * 100).toFixed(1)}%
                      </td>
                      <td className="num">{data.length > 0 ? ((r.size * 8) / data.length).toFixed(2) : '0'}</td>
                      <td className="num">{r.ms.toFixed(1)} ms</td>
                      <td className="num">
                        <span className={`pill ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '✓ exact' : '✗ fail'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn small" onClick={() => download(r)} disabled={!r.ok}>download</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
