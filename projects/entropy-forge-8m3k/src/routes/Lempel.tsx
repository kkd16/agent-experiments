import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { lz77Encode, LZ77_PARAMS } from '../lib/lz77'
import { lzwEncode } from '../lib/lzw'
import { strToBytes } from '../lib/bits'
import { byteGlyph } from '../lib/format'

function Lz77View({ data }: { data: Uint8Array }) {
  const result = useMemo(() => lz77Encode(data), [data])
  const origBits = data.length * 8
  const ratio = origBits > 0 ? result.encodedBits / origBits : 1

  // Render the source per *byte* (positions are byte indices, so indexing the
  // UTF-16 string would misalign on multi-byte characters), colouring each by
  // whether it was a literal or copied from a back-reference.
  const spans = useMemo(() => {
    const out: { char: string; match: boolean; token: number; dist?: number; len?: number }[] = []
    result.tokens.forEach((t, ti) => {
      if (t.kind === 'lit') {
        out.push({ char: byteGlyph(t.byte), match: false, token: ti })
      } else {
        for (let k = 0; k < t.length; k++) {
          out.push({ char: byteGlyph(data[t.pos + k]), match: true, token: ti, dist: t.distance, len: t.length })
        }
      }
    })
    return out
  }, [result, data])

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Tokens" value={result.tokens.length} sub={`${result.literals} lit · ${result.matches} match`} />
        <Stat label="Encoded" value={result.encodedBits} unit="bits" accent sub={`${Math.ceil(result.encodedBits / 8)} bytes`} />
        <Stat label="Ratio" value={`${(ratio * 100).toFixed(0)}%`} />
        <Stat label="Window" value={LZ77_PARAMS.WINDOW} unit="B" sub={`match ${LZ77_PARAMS.MIN_MATCH}–${LZ77_PARAMS.MAX_MATCH}`} />
      </div>
      <Panel title="Parse map" note="Teal = literal byte · amber = copied from a back-reference. Hover a match for its (distance, length).">
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.9, wordBreak: 'break-all' }}>
          {spans.map((s, i) => (
            <span
              key={i}
              title={s.match ? `copy ${s.len} bytes from ${s.dist} back` : 'literal'}
              style={{
                background: s.match ? 'color-mix(in srgb, var(--amber) 22%, transparent)' : 'color-mix(in srgb, var(--teal) 14%, transparent)',
                borderBottom: s.match ? '2px solid var(--amber)' : '2px solid transparent',
                padding: '1px 0',
                whiteSpace: 'pre',
              }}
            >
              {s.char}
            </span>
          ))}
        </div>
      </Panel>
      <Panel title="Token stream" note="LZSS: one flag bit per token distinguishes a literal from a (distance, length) match.">
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Value</th>
                <th>Bits</th>
              </tr>
            </thead>
            <tbody>
              {result.tokens.slice(0, 120).map((t, i) => (
                <tr key={i}>
                  <td className="num">{i}</td>
                  <td style={{ textAlign: 'left', color: t.kind === 'match' ? 'var(--amber)' : 'var(--teal)' }}>
                    {t.kind === 'match' ? 'match' : 'literal'}
                  </td>
                  <td className="mono">
                    {t.kind === 'match' ? `⟨dist ${t.distance}, len ${t.length}⟩` : `'${byteGlyph(t.byte)}'`}
                  </td>
                  <td className="num">{t.kind === 'match' ? 1 + LZ77_PARAMS.WINDOW_BITS + LZ77_PARAMS.LENGTH_BITS : 9}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

function LzwView({ data }: { data: Uint8Array }) {
  const result = useMemo(() => lzwEncode(data), [data])
  const origBits = data.length * 8
  const ratio = origBits > 0 ? result.encodedBits / origBits : 1
  // Reconstruct the dictionary strings as codes are emitted, to show the table grow.
  const rows = useMemo(() => {
    const dict: string[] = []
    for (let i = 0; i < 256; i++) dict.push(byteGlyph(i))
    let next = 256
    let width = 9
    const emitted: { code: number; text: string; width: number; added?: string; addedCode?: number }[] = []
    // Re-run a light encode purely to narrate (mirrors lzwEncode's structure).
    const s = Array.from(data, (b) => String.fromCharCode(b))
    const strDict = new Map<string, number>()
    for (let i = 0; i < 256; i++) strDict.set(String.fromCharCode(i), i)
    if (s.length > 0) {
      let cur = s[0]
      for (let i = 1; i < s.length; i++) {
        const combined = cur + s[i]
        if (strDict.has(combined)) {
          cur = combined
        } else {
          const code = strDict.get(cur)!
          const addedCode = next < 1 << 16 ? next : undefined
          emitted.push({ code, text: dict[code] ?? cur, width, added: combined, addedCode })
          if (next < 1 << 16) {
            strDict.set(combined, next)
            dict[next] = displayStr(combined)
            next++
            if (next === 1 << width && width < 16) width++
          }
          cur = s[i]
        }
      }
      const code = strDict.get(cur)!
      emitted.push({ code, text: dict[code] ?? cur, width })
    }
    return emitted
  }, [data])

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Codes emitted" value={result.codes.length} />
        <Stat label="Dictionary size" value={result.dictSize} sub="entries built" />
        <Stat label="Encoded" value={result.encodedBits} unit="bits" accent sub={`${Math.ceil(result.encodedBits / 8)} bytes`} />
        <Stat label="Ratio" value={`${(ratio * 100).toFixed(0)}%`} />
      </div>
      <Panel title="Code stream & dictionary growth" note="Codes start at 9 bits and widen as the self-built dictionary fills — nothing about the table is transmitted.">
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Step</th>
                <th>Code</th>
                <th>Emits</th>
                <th>Width</th>
                <th>New entry</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 140).map((r, i) => (
                <tr key={i}>
                  <td className="num">{i}</td>
                  <td className="num" style={{ color: 'var(--teal)' }}>{r.code}</td>
                  <td className="mono" style={{ textAlign: 'left' }}>{r.text}</td>
                  <td className="num">{r.width}</td>
                  <td className="mono" style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
                    {r.added && r.addedCode !== undefined
                      ? `#${r.addedCode} → “${r.added.length > 10 ? displayStr(r.added.slice(0, 10)) + '…' : displayStr(r.added)}”`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

function displayStr(s: string): string {
  return Array.from(s, (ch) => byteGlyph(ch.charCodeAt(0))).join('')
}

export function Lempel() {
  const [text, setText] = useState('TOBEORNOTTOBEORTOBEORNOT — and to be, or not, to be, that is the question')
  const [tab, setTab] = useState<'lz77' | 'lzw'>('lz77')
  const data = useMemo(() => strToBytes(text), [text])

  return (
    <div>
      <PageHeader
        kicker="Module 04 · Dictionary coding"
        title="Lempel–Ziv"
        lede={
          <>
            Where entropy coders squeeze the symbol distribution, Lempel–Ziv attacks{' '}
            <em>repetition</em>. LZ77 emits back-references into a sliding window of recent bytes;
            LZW builds a dictionary of growing byte-strings on the fly. Together they are the
            workhorses behind gzip, PNG, GIF and ZIP.
          </>
        }
      />

      <Panel title="Input">
        <InputPanel value={text} onChange={setText} rows={3} />
        <div className="chip-row" style={{ marginTop: 12 }}>
          <button className={`chip${tab === 'lz77' ? ' active' : ''}`} onClick={() => setTab('lz77')}>
            LZ77 / LZSS
          </button>
          <button className={`chip${tab === 'lzw' ? ' active' : ''}`} onClick={() => setTab('lzw')}>
            LZW
          </button>
        </div>
      </Panel>

      {tab === 'lz77' ? <Lz77View data={data} /> : <LzwView data={data} />}

      <Panel title={tab === 'lz77' ? 'How LZ77 works' : 'How LZW works'}>
        <div className="prose" style={{ fontSize: 14 }}>
          {tab === 'lz77' ? (
            <p>
              At each position the encoder searches the previous {LZ77_PARAMS.WINDOW} bytes for the
              longest match to the upcoming bytes. A match of {LZ77_PARAMS.MIN_MATCH}+ bytes is
              emitted as a (distance, length) pair; otherwise a single literal is emitted. The LZSS
              refinement uses one flag bit to tell the two apart, so isolated bytes cost only a bit
              of overhead. DEFLATE-lite (see Benchmark) then entropy-codes this token stream.
            </p>
          ) : (
            <p>
              LZW seeds a 256-entry dictionary with every single byte, then repeatedly finds the
              longest current input string already in the dictionary, emits its code, and adds that
              string-plus-next-byte as a new entry. Decoder and encoder build the identical table
              from the code stream alone. Codes start at 9 bits and widen as the table grows — and
              the notorious KwKwK case (a code referring to the entry being defined this very step)
              is handled explicitly in the decoder.
            </p>
          )}
        </div>
      </Panel>
    </div>
  )
}
