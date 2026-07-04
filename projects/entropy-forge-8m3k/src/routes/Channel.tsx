import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { LineChart } from '../components/charts'
import {
  RNG,
  binaryEntropy,
  bscCapacity,
  becCapacity,
  bsc,
  bec,
  awgn,
  ERASURE,
  bytesToBits,
} from '../lib/channel'
import { strToBytes } from '../lib/bits'

type Kind = 'bsc' | 'bec' | 'awgn'

const SAMPLE = 'SHANNON'

export function Channel() {
  const [kind, setKind] = useState<Kind>('bsc')
  const [noise, setNoise] = useState(0.1)
  const [seed, setSeed] = useState(1)

  const bits = useMemo(() => bytesToBits(strToBytes(SAMPLE)).slice(0, 120), [])

  const sim = useMemo(() => {
    const rng = new RNG(0x1234 + seed * 2654435761)
    if (kind === 'bsc') {
      const r = bsc(bits, noise, rng)
      return { out: r.out, changed: new Set(r.flipped), erased: new Set<number>() }
    }
    if (kind === 'bec') {
      const r = bec(bits, noise, rng)
      return { out: r.out, changed: new Set<number>(), erased: new Set(r.erased) }
    }
    // AWGN: report hard decisions, mark flips
    const r = awgn(bits, Math.pow(10, noise), rng) // noise slider = Eb/N0 dB here
    return { out: r.hard, changed: new Set(r.flipped), erased: new Set<number>() }
  }, [bits, kind, noise, seed])

  const nErr = kind === 'bec' ? sim.erased.size : sim.changed.size
  const capacity = useMemo(() => {
    if (kind === 'bsc') return bscCapacity(noise)
    if (kind === 'bec') return becCapacity(noise)
    return null
  }, [kind, noise])

  // Capacity curves.
  const bscCurve = useMemo(() => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 100; i++) pts.push([i / 200, bscCapacity(i / 200)])
    return pts
  }, [])
  const becCurve = useMemo(() => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 100; i++) pts.push([i / 100, becCapacity(i / 100)])
    return pts
  }, [])
  const hCurve = useMemo(() => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 100; i++) pts.push([i / 100, binaryEntropy(i / 100)])
    return pts
  }, [])

  const noiseLabel = kind === 'awgn' ? 'Eb/N₀ (dB)' : kind === 'bec' ? 'erasure ε' : 'crossover p'
  const noiseMin = kind === 'awgn' ? -2 : 0
  const noiseMax = kind === 'awgn' ? 10 : 0.5
  const noiseStep = kind === 'awgn' ? 0.5 : 0.01

  return (
    <div>
      <PageHeader
        kicker="Channel coding · Shannon's other theorem"
        title="The Noisy Channel"
        lede={
          <>
            Everything else in this lab serves Shannon's <b>source coding</b> theorem — entropy is the
            floor, and every codec chases it by <b>removing</b> redundancy. This pillar is the dual: the{' '}
            <b>noisy-channel coding</b> theorem. To send bits reliably over a channel that corrupts
            them, you <b>add</b> redundancy back — structured and minimal — so the receiver can
            reconstruct the message <b>exactly</b>. Shannon's stunning result: as long as the code rate
            R stays below the channel <b>capacity</b> C, the error probability can be driven to{' '}
            <b>zero</b>. The codes here are concrete constructions living under that ceiling.
          </>
        }
      />

      <Panel
        title="Try a channel"
        note="Push a bit stream through a noisy channel and watch what arrives. The Binary Symmetric Channel flips bits; the Binary Erasure Channel drops them to '?'; the AWGN channel adds Gaussian noise to a ±1 signal and slices the sign."
      >
        <div className="row" style={{ gap: 18, marginBottom: 14 }}>
          <div className="chip-row">
            {(['bsc', 'bec', 'awgn'] as Kind[]).map((k) => (
              <button
                key={k}
                className={`chip${kind === k ? ' active' : ''}`}
                onClick={() => {
                  setKind(k)
                  setNoise(k === 'awgn' ? 4 : 0.1)
                }}
              >
                {k === 'bsc' ? 'BSC (flip)' : k === 'bec' ? 'BEC (erase)' : 'AWGN (analog)'}
              </button>
            ))}
          </div>
          <label className="field" style={{ minWidth: 220 }}>
            {noiseLabel}: <b style={{ color: 'var(--text)' }}>{kind === 'awgn' ? noise.toFixed(1) : noise.toFixed(2)}</b>
            <input type="range" min={noiseMin} max={noiseMax} step={noiseStep} value={noise} onChange={(e) => setNoise(+e.target.value)} />
          </label>
          <button className="btn" onClick={() => setSeed((s) => s + 1)}>
            Re-roll noise
          </button>
        </div>

        <div className="grid grid-4" style={{ marginBottom: 14 }}>
          <Stat label="Bits sent" value={bits.length} />
          <Stat label={kind === 'bec' ? 'Erased' : 'Corrupted'} value={nErr} accent sub={`${((nErr / bits.length) * 100).toFixed(1)}% of stream`} />
          <Stat
            label="Capacity C"
            value={capacity === null ? '—' : capacity.toFixed(3)}
            unit={capacity === null ? '' : 'bits'}
            sub={kind === 'awgn' ? 'analog channel' : 'max reliable rate'}
          />
          <Stat label="Uncoded" value="rate 1.0" sub={capacity !== null && capacity < 1 ? 'above C ⇒ errors inevitable' : ''} />
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.1 }}>
          {sim.out.map((b, i) => {
            const flipped = sim.changed.has(i)
            const erased = sim.erased.has(i)
            const bg = erased ? 'var(--amber)' : flipped ? 'var(--red)' : 'var(--panel-2)'
            const col = erased || flipped ? '#0a0d13' : 'var(--text-mid)'
            return (
              <span
                key={i}
                title={erased ? 'erased' : flipped ? 'flipped by the channel' : 'received intact'}
                style={{ width: 15, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, background: bg, color: col, border: '1px solid var(--border)' }}
              >
                {b === ERASURE ? '?' : b}
              </span>
            )
          })}
        </div>
      </Panel>

      <div className="grid grid-2" style={{ gap: 16 }}>
        <Panel
          title="Capacity of the Binary Symmetric Channel"
          note="C = 1 − H(p). At p=0 the channel is perfect (C=1). At p=½ it is useless (C=0): the output is independent of the input. The binary entropy H(p) is exactly the information the noise destroys."
        >
          <LineChart
            series={[
              { label: 'C = 1 − H(p)', color: 'var(--teal)', points: bscCurve },
              { label: 'H(p) lost', color: 'var(--red)', points: hCurve.map(([x, y]) => [x / 2, y]) },
            ]}
            xDomain={[0, 0.5]}
            yDomain={[0, 1]}
            xLabel="crossover probability p"
            yLabel="bits / use"
            markers={kind === 'bsc' ? [{ x: noise, label: `p=${noise.toFixed(2)}` }] : []}
            xFmt={(v) => v.toFixed(2)}
          />
        </Panel>
        <Panel
          title="Capacity of the Binary Erasure Channel"
          note="C = 1 − ε. Erasures are the easy case — you know exactly which bits are missing, so a fraction ε of the throughput is simply lost. This is why erasure-correcting is 'twice as cheap' as error-correcting."
        >
          <LineChart
            series={[{ label: 'C = 1 − ε', color: 'var(--blue)', points: becCurve }]}
            xDomain={[0, 1]}
            yDomain={[0, 1]}
            xLabel="erasure probability ε"
            yLabel="bits / use"
            markers={kind === 'bec' ? [{ x: noise, label: `ε=${noise.toFixed(2)}` }] : []}
            xFmt={(v) => v.toFixed(1)}
          />
        </Panel>
      </div>

      <Panel title="The two theorems, side by side">
        <div className="grid grid-2" style={{ gap: 16 }}>
          <div className="prose" style={{ fontSize: 14 }}>
            <p style={{ marginTop: 0 }}>
              <strong style={{ color: 'var(--teal)' }}>Source coding (the rest of this lab).</strong> A
              source with entropy H bits/symbol cannot be compressed below H without loss. Codecs{' '}
              <em>remove</em> redundancy to approach that floor. Success = <em>smallest</em> output.
            </p>
            <p>
              <strong style={{ color: 'var(--violet)' }}>Channel coding (this pillar).</strong> A channel
              with capacity C bits/use can carry any rate R &lt; C with vanishing error. Codes <em>add</em>{' '}
              structured redundancy to climb toward that ceiling. Success = <em>correct</em> output.
            </p>
            <p style={{ marginBottom: 0 }}>
              Compose them and you get a real communication system: compress to the entropy floor, then
              re-expand by exactly 1/R to survive the noise — the <b>separation theorem</b> says doing the
              two independently is (asymptotically) optimal. The Channel Lab page runs that full pipeline.
            </p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Code</th>
                  <th style={{ textAlign: 'left' }}>Idea</th>
                  <th>Corrects</th>
                  <th style={{ textAlign: 'left' }}>Used in</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={{ textAlign: 'left' }}>Hamming(7,4)</td><td style={{ textAlign: 'left' }}>syndrome = error position</td><td>1 bit / block</td><td style={{ textAlign: 'left' }}>ECC RAM</td></tr>
                <tr><td style={{ textAlign: 'left' }}>Reed–Solomon</td><td style={{ textAlign: 'left' }}>roots over GF(256)</td><td>t bytes / block</td><td style={{ textAlign: 'left' }}>QR, CD, DVD, Voyager</td></tr>
                <tr><td style={{ textAlign: 'left' }}>Convolutional</td><td style={{ textAlign: 'left' }}>trellis + Viterbi</td><td>spread errors</td><td style={{ textAlign: 'left' }}>GSM, Wi-Fi, deep space</td></tr>
                <tr><td style={{ textAlign: 'left' }}>LDPC</td><td style={{ textAlign: 'left' }}>belief propagation</td><td>near-capacity</td><td style={{ textAlign: 'left' }}>5G, Wi-Fi 6, DVB-S2</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </div>
  )
}
