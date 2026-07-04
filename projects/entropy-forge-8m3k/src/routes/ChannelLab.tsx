import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { InputPanel } from '../components/InputPanel'
import { strToBytes, bytesToStr, bytesEqual } from '../lib/bits'
import { gzipEncode, gzipDecode } from '../lib/gzip'
import { rsEncode, rsDecode, RsError } from '../lib/reedSolomon'
import { RNG } from '../lib/channel'

const RS_N = 255
const RS_K = 223 // RS(255,223): 32 parity bytes, corrects 16 byte errors per block — the CCSDS deep-space code.

interface Pipeline {
  original: Uint8Array
  gz: Uint8Array
  transmitted: Uint8Array
  received: Uint8Array
  blocks: number
  corruptedBytes: number
  blockRepairs: { block: number; errors: number; ok: boolean }[]
  recoveredGz: Uint8Array | null
  recoveredText: string | null
  gunzipOk: boolean
  finalMatch: boolean
  // Control: what happens to the *unprotected* gzip under the same corruption.
  unprotectedGunzipOk: boolean
  unprotectedMatch: boolean
}

function runPipeline(text: string, byteErrRate: number, burst: boolean, seed: number): Pipeline {
  const original = strToBytes(text)
  const gz = gzipEncode(original, { filename: 'msg.txt' })
  // Chunk gzip bytes into RS_K blocks (pad last with zeros; gz length is known to the receiver).
  const blocks = Math.max(1, Math.ceil(gz.length / RS_K))
  const codewords: number[][] = []
  for (let b = 0; b < blocks; b++) {
    const chunk: number[] = []
    for (let i = 0; i < RS_K; i++) {
      const idx = b * RS_K + i
      chunk.push(idx < gz.length ? gz[idx] : 0)
    }
    codewords.push(rsEncode(chunk, RS_N - RS_K))
  }
  const transmitted = new Uint8Array(blocks * RS_N)
  codewords.forEach((cw, b) => transmitted.set(cw, b * RS_N))

  // Channel: corrupt bytes. In burst mode, cluster errors so each block gets a
  // contiguous smear (RS's home turf); otherwise scatter them.
  const rng = new RNG(0x9a1c + seed * 2654435761)
  const received = transmitted.slice()
  let corruptedBytes = 0
  if (burst) {
    // Per block, place one burst of up to ~byteErrRate·N contiguous bytes.
    const burstLen = Math.min(16, Math.max(1, Math.round(byteErrRate * RS_N)))
    for (let b = 0; b < blocks; b++) {
      const start = b * RS_N + Math.floor(rng.float() * (RS_N - burstLen))
      for (let i = 0; i < burstLen; i++) {
        const idx = start + i
        let v = Math.floor(rng.float() * 256)
        if (v === received[idx]) v ^= 0x5a
        received[idx] = v
        corruptedBytes++
      }
    }
  } else {
    for (let i = 0; i < received.length; i++) {
      if (rng.float() < byteErrRate) {
        let v = Math.floor(rng.float() * 256)
        if (v === received[i]) v ^= 0x5a
        received[i] = v
        corruptedBytes++
      }
    }
  }

  // Receive: RS-decode each block.
  const blockRepairs: Pipeline['blockRepairs'] = []
  const recoveredBytes: number[] = []
  let allBlocksOk = true
  for (let b = 0; b < blocks; b++) {
    const cw = Array.from(received.subarray(b * RS_N, b * RS_N + RS_N))
    try {
      const dec = rsDecode(cw, RS_N - RS_K)
      blockRepairs.push({ block: b, errors: dec.errorPositions.length, ok: true })
      recoveredBytes.push(...dec.message)
    } catch (e) {
      void (e as RsError)
      allBlocksOk = false
      blockRepairs.push({ block: b, errors: -1, ok: false })
      // Fall back to the raw (corrupted) message bytes so downstream still runs.
      recoveredBytes.push(...cw.slice(0, RS_K))
    }
  }
  const recoveredGzBytes = Uint8Array.from(recoveredBytes.slice(0, gz.length))

  let recoveredGz: Uint8Array | null = recoveredGzBytes
  let recoveredText: string | null = null
  let gunzipOk = false
  let finalMatch = false
  try {
    const dec = gzipDecode(recoveredGz)
    gunzipOk = dec.crcOk && dec.sizeOk
    recoveredText = bytesToStr(dec.data)
    finalMatch = bytesEqual(dec.data, original)
  } catch {
    recoveredGz = allBlocksOk ? recoveredGzBytes : null
  }

  // Control: corrupt the *unprotected* gzip with the same byte-error rate.
  const rng2 = new RNG(0x9a1c + seed * 2654435761)
  const rawGz = gz.slice()
  for (let i = 0; i < rawGz.length; i++) {
    if (rng2.float() < byteErrRate) {
      let v = Math.floor(rng2.float() * 256)
      if (v === rawGz[i]) v ^= 0x5a
      rawGz[i] = v
    }
  }
  let unprotectedGunzipOk = false
  let unprotectedMatch = false
  try {
    const dec = gzipDecode(rawGz)
    unprotectedGunzipOk = dec.crcOk && dec.sizeOk
    unprotectedMatch = bytesEqual(dec.data, original)
  } catch {
    /* gunzip threw on the corrupted stream — both flags keep their initial false value */
  }

  return {
    original,
    gz,
    transmitted,
    received,
    blocks,
    corruptedBytes,
    blockRepairs,
    recoveredGz,
    recoveredText,
    gunzipOk,
    finalMatch,
    unprotectedGunzipOk,
    unprotectedMatch,
  }
}

export function ChannelLab() {
  const [text, setText] = useState(
    'The two halves of Shannon meet here: source coding squeezes this message to its entropy floor with gzip, then channel coding wraps it in Reed-Solomon parity so it survives a noisy, bursty link — and comes back byte-for-byte. Compress to remove redundancy; re-expand by exactly 1/R to beat the noise. That is the separation theorem, running end to end.',
  )
  const [errRate, setErrRate] = useState(0.02)
  const [burst, setBurst] = useState(true)
  const [seed, setSeed] = useState(1)

  const pipe = useMemo(() => runPipeline(text, errRate, burst, seed), [text, errRate, burst, seed])

  const overhead = pipe.transmitted.length / Math.max(1, pipe.gz.length)
  const totalRatio = pipe.transmitted.length / Math.max(1, pipe.original.length)
  const repairedBlocks = pipe.blockRepairs.filter((r) => r.ok && r.errors > 0).length
  const failedBlocks = pipe.blockRepairs.filter((r) => !r.ok).length

  return (
    <div>
      <PageHeader
        kicker="Channel coding · the two theorems cooperating"
        title="Channel Lab — end to end"
        lede={
          <>
            The capstone: a real communication system in miniature. Take text, <b>gzip</b> it (source
            coding — remove redundancy), wrap the compressed bytes in <b>Reed–Solomon(255,223)</b> parity
            (channel coding — add structured redundancy), fire it through a <b>bursty channel</b>, then{' '}
            <b>RS-decode</b> and <b>gunzip</b> back. When the corruption stays within budget it returns{' '}
            <b>byte-for-byte</b> — while the same noise on the <em>unprotected</em> gzip destroys it. This is
            Shannon's <b>separation theorem</b> made runnable.
          </>
        }
      />

      <InputPanel value={text} onChange={setText} rows={4} label="Message to transmit" maxNote="gzipped, then RS-protected" />

      <Panel
        title="The channel"
        right={
          <div className="row">
            <button className={`chip${burst ? ' active' : ''}`} onClick={() => setBurst((b) => !b)}>{burst ? 'burst errors' : 'scattered errors'}</button>
            <button className="btn" onClick={() => setSeed((s) => s + 1)}>Re-roll noise</button>
          </div>
        }
      >
        <label className="field" style={{ maxWidth: 380, marginTop: 4 }}>
          byte-error rate: <b style={{ color: 'var(--text)' }}>{(errRate * 100).toFixed(1)}%</b>
          <input type="range" min={0} max={0.08} step={0.002} value={errRate} onChange={(e) => setErrRate(+e.target.value)} />
        </label>
      </Panel>

      <Panel title="The pipeline">
        <div className="pipeline-flow" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
          <Stage label="1 · Original" value={`${pipe.original.length} B`} sub="the message" color="var(--text-mid)" />
          <Arrow />
          <Stage label="2 · gzip" value={`${pipe.gz.length} B`} sub={`${((1 - pipe.gz.length / Math.max(1, pipe.original.length)) * 100).toFixed(0)}% smaller`} color="var(--blue)" />
          <Arrow />
          <Stage label="3 · RS(255,223)" value={`${pipe.transmitted.length} B`} sub={`${pipe.blocks} block${pipe.blocks === 1 ? '' : 's'} · +${((overhead - 1) * 100).toFixed(0)}%`} color="var(--violet)" />
          <Arrow />
          <Stage label="4 · Channel" value={`${pipe.corruptedBytes} B hit`} sub={burst ? 'burst noise' : 'scattered noise'} color="var(--red)" />
          <Arrow />
          <Stage label="5 · RS decode" value={`${repairedBlocks} repaired`} sub={failedBlocks ? `${failedBlocks} over budget` : 'all within t'} color={failedBlocks ? 'var(--amber)' : 'var(--green)'} />
          <Arrow />
          <Stage label="6 · gunzip" value={pipe.finalMatch ? 'exact ✓' : pipe.gunzipOk ? 'wrong' : 'failed'} sub={pipe.finalMatch ? 'byte-for-byte' : 'corrupted'} color={pipe.finalMatch ? 'var(--teal)' : 'var(--red)'} />
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="With Reed–Solomon protection"
          note="Each 255-byte block corrects up to 16 corrupted bytes. Stay within that per-block budget and the recovered message is identical to the original."
        >
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            <Stat label="Blocks repaired" value={repairedBlocks} sub={`of ${pipe.blocks}`} />
            <Stat label="Over budget" value={failedBlocks} sub="uncorrectable blocks" />
            <Stat label="Recovered" value={pipe.finalMatch ? 'exact ✓' : 'no ✗'} accent={pipe.finalMatch} sub={pipe.gunzipOk ? 'gzip CRC ok' : 'gzip failed'} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {pipe.blockRepairs.map((r) => (
              <span
                key={r.block}
                title={r.ok ? `block ${r.block}: ${r.errors} error${r.errors === 1 ? '' : 's'} corrected` : `block ${r.block}: over budget`}
                style={{
                  width: 18, height: 18, borderRadius: 3, fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)',
                  background: !r.ok ? 'var(--red)' : r.errors > 0 ? 'var(--green)' : 'var(--panel-hi)',
                  color: !r.ok ? '#0a0d13' : r.errors > 0 ? '#0a0d13' : 'var(--text-dim)',
                }}
              >
                {r.ok ? r.errors : '✗'}
              </span>
            ))}
          </div>
          <div className="prose" style={{ fontSize: 12.5, marginTop: 10, color: 'var(--text-dim)' }}>
            Each square is a block; the number is how many byte errors RS silently fixed in it.
          </div>
        </Panel>

        <Panel
          title="Without protection (control)"
          note="The same corruption applied to the raw gzip stream — no parity to fall back on. Compressed data is maximally fragile: a single flipped byte usually cascades through the entropy coder into garbage or an outright decode failure."
        >
          <div className="grid grid-2" style={{ marginBottom: 12 }}>
            <Stat label="gunzip" value={pipe.unprotectedGunzipOk ? 'ok' : 'failed'} sub={pipe.unprotectedGunzipOk ? 'CRC passed' : 'CRC / format error'} />
            <Stat label="Recovered" value={pipe.unprotectedMatch ? 'exact' : 'destroyed ✗'} accent={!pipe.unprotectedMatch} sub={pipe.corruptedBytes ? 'same noise, no ECC' : 'no noise'} />
          </div>
          <div className="prose" style={{ fontSize: 13 }}>
            <p style={{ margin: 0 }}>
              This is the whole point of the pillar: <b>entropy coding and channel coding are opposites
              that need each other</b>. Compression makes data small <em>and</em> brittle; error-correction
              makes it robust again. Do both, in that order, and you get a channel that is both efficient
              and reliable.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Recovered message">
        <div
          style={{
            fontFamily: 'var(--mono)', fontSize: 13, background: 'var(--panel-2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 12, minHeight: 40, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            color: pipe.finalMatch ? 'var(--text)' : 'var(--text-dim)',
          }}
        >
          {pipe.finalMatch ? pipe.recoveredText : pipe.gunzipOk ? pipe.recoveredText : '⚠ decode failed — corruption exceeded the code budget on at least one block'}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Stat label="Total expansion" value={totalRatio.toFixed(2)} unit="×" sub="vs original" />
          <Stat label="Code rate R" value={(RS_K / RS_N).toFixed(3)} sub="RS(255,223)" />
          <Stat label="Protection cost" value={`+${((overhead - 1) * 100).toFixed(1)}%`} sub="parity over gzip" />
        </div>
      </Panel>
    </div>
  )
}

function Stage({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: 'var(--panel-2)', border: `1px solid var(--border)`, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 600, color, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function Arrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-dim)', fontSize: 18 }} aria-hidden>
      →
    </div>
  )
}
