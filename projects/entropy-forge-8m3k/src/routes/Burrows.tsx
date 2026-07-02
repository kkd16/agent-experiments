import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { bwtEncode, mtfEncode, rleEncode } from '../lib/bwt'
import { arithEncode, Order0Adaptive } from '../lib/arithmetic'
import { analyze } from '../lib/entropy'
import { strToBytes, bytesToStr } from '../lib/bits'
import { byteGlyph, fmtNum } from '../lib/format'

// Build the sorted rotation matrix for display (only for short inputs).
function rotationMatrix(data: Uint8Array) {
  const n = data.length
  const idx = Array.from({ length: n }, (_, i) => i)
  idx.sort((a, b) => {
    for (let k = 0; k < n; k++) {
      const ca = data[(a + k) % n]
      const cb = data[(b + k) % n]
      if (ca !== cb) return ca - cb
    }
    return a - b
  })
  return idx.map((start) => {
    const row: number[] = []
    for (let k = 0; k < n; k++) row.push(data[(start + k) % n])
    return { start, row }
  })
}

export function Burrows() {
  const [text, setText] = useState('banana_bandana_bandanna')
  const data = useMemo(() => strToBytes(text), [text])
  const bwt = useMemo(() => bwtEncode(data), [data])
  const mtf = useMemo(() => mtfEncode(bwt.transformed), [bwt])
  const rle = useMemo(() => rleEncode(mtf), [mtf])
  const arith = useMemo(() => arithEncode(rle, () => new Order0Adaptive(256)), [rle])
  const matrix = useMemo(() => (data.length <= 40 ? rotationMatrix(data) : null), [data])

  const before = useMemo(() => analyze(data).order0, [data])
  const afterBwt = useMemo(() => analyze(bwt.transformed).order0, [bwt])
  const afterMtf = useMemo(() => analyze(mtf).order0, [mtf])

  const origBits = data.length * 8
  const finalBits = arith.encodedBits + 32 /* primary index + lengths ≈ header */
  const ratio = origBits > 0 ? finalBits / origBits : 1

  return (
    <div>
      <PageHeader
        kicker="Module 05 · Transform coding"
        title="Burrows–Wheeler"
        lede={
          <>
            The BWT is not a compressor — it is a <em>reversible permutation</em> that sorts every
            rotation of the input and keeps the last column. That column clusters like-symbols into
            runs, which move-to-front and RLE then flatten, and an entropy coder finishes. This is
            the bzip2 pipeline, and its inverse is the famous piece of magic.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={2} maxNote="short inputs show the rotation matrix" />
      </Panel>

      <div className="grid grid-4">
        <Stat label="Order-0 entropy: input" value={fmtNum(before)} unit="b/sym" />
        <Stat label="after BWT" value={fmtNum(afterBwt)} unit="b/sym" sub="same symbols, reordered" />
        <Stat label="after MTF" value={fmtNum(afterMtf)} unit="b/sym" accent sub="runs → small numbers" />
        <Stat label="Pipeline ratio" value={`${(ratio * 100).toFixed(0)}%`} sub={`${Math.ceil(finalBits / 8)} B out`} />
      </div>

      {matrix && (
        <Panel title="Sorted rotation matrix" note="All cyclic rotations, sorted. The BWT is the last column (highlighted); the primary index marks the original.">
          <div style={{ overflowX: 'auto' }}>
            <table className="data" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              <tbody>
                {matrix.map((m, i) => (
                  <tr key={i} style={{ background: i === bwt.primaryIndex ? 'color-mix(in srgb, var(--teal) 12%, transparent)' : undefined }}>
                    <td className="num" style={{ color: 'var(--text-dim)' }}>{i}</td>
                    {m.row.map((b, j) => (
                      <td
                        key={j}
                        style={{
                          padding: '4px 6px',
                          textAlign: 'center',
                          color: j === m.row.length - 1 ? 'var(--amber)' : 'var(--text-mid)',
                          fontWeight: j === m.row.length - 1 ? 700 : 400,
                        }}
                      >
                        {byteGlyph(b)}
                      </td>
                    ))}
                    {i === bwt.primaryIndex && <td style={{ color: 'var(--teal)', textAlign: 'left' }}>← primary</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="The pipeline, stage by stage" note="Each stage is exactly invertible; decode runs them in reverse.">
        <PipeStage label="1 · BWT output (last column)" bytes={bwt.transformed} note={`primary index ${bwt.primaryIndex}`} />
        <PipeStage label="2 · Move-to-front ranks" bytes={mtf} note="clustered runs become repeated small numbers (lots of 0s)" numbers />
        <PipeStage label="3 · Run-length encoded" bytes={rle} note={`${rle.length} bytes after collapsing runs`} numbers />
        <div className="stat" style={{ marginTop: 8 }}>
          <div className="stat-label">4 · Arithmetic coded</div>
          <div className="stat-value" style={{ fontSize: 18 }}>
            {arith.encodedBits} <span className="unit">bits ({Math.ceil(arith.encodedBits / 8)} B)</span>
          </div>
        </div>
      </Panel>

      <Panel title="The inverse is the magic">
        <div className="prose" style={{ fontSize: 14 }}>
          <p>
            From the single last column <code>L</code> and one index, the whole input is rebuilt with
            no rotations stored. The trick: sorting <code>L</code> gives the first column <code>F</code>,
            and the <strong>LF-mapping</strong> — the i-th occurrence of a symbol in <code>L</code>{' '}
            corresponds to the i-th occurrence in <code>F</code> — lets you walk the original order one
            symbol at a time. Round-tripped here to{' '}
            <code>“{bytesToStr(bwt.transformed).length > 0 ? text.slice(0, 40) : ''}{text.length > 40 ? '…' : ''}”</code>{' '}
            and verified on the Self-test page across every corpus and edge case.
          </p>
        </div>
      </Panel>
    </div>
  )
}

function PipeStage({ label, bytes, note, numbers }: { label: string; bytes: Uint8Array; note?: string; numbers?: boolean }) {
  const show = Array.from(bytes.slice(0, 160))
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <div className="stat-label">{label}</div>
        {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
      </div>
      <div className="byte-grid">
        {show.map((b, i) => (
          <span key={i} className="byte-cell" style={{ color: numbers && b === 0 ? 'var(--text-dim)' : undefined }}>
            {numbers ? b : byteGlyph(b)}
          </span>
        ))}
        {bytes.length > 160 && <span className="byte-cell muted">+{bytes.length - 160}</span>}
      </div>
    </div>
  )
}
