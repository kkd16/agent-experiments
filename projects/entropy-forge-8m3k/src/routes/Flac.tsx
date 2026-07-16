import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { HBarChart, ColumnChart } from '../components/charts'
import { seriesColor, fmtBytes } from '../lib/format'
import { SIGNALS, encodeWav, decodeWav, waveformBins } from '../lib/audio'
import { flacEncodeAnalyzed, flacDecode, type Pcm, type SubframeKind } from '../lib/flac'
import { gzipEncode } from '../lib/gzip'
import { bestRiceK, zigzag } from '../lib/intcodes'

// ---------------------------------------------------------------------------
// A hand-drawn waveform (min/max envelope per pixel column). Kept dependency-
// free like every other visual in the lab.
// ---------------------------------------------------------------------------

function Waveform({
  channel,
  color = 'var(--teal)',
  height = 90,
  peak,
}: {
  channel: Int32Array
  color?: string
  height?: number
  peak?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const w = cv.width
    const h = cv.height
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    // resolve CSS var to a concrete colour
    const probe = getComputedStyle(cv).getPropertyValue('color') || '#4fd1c5'
    ctx.strokeStyle = probe.trim() || '#4fd1c5'
    const bins = waveformBins(channel, w)
    let mx = peak ?? 1
    if (peak === undefined) for (const b of bins) mx = Math.max(mx, Math.abs(b.min), Math.abs(b.max))
    const mid = h / 2
    const scale = (h / 2 - 2) / mx
    // zero line
    ctx.strokeStyle = 'rgba(148,163,184,0.25)'
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke()
    ctx.strokeStyle = probe.trim() || '#4fd1c5'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0; x < bins.length; x++) {
      const yTop = mid - bins[x].max * scale
      const yBot = mid - bins[x].min * scale
      ctx.moveTo(x + 0.5, yTop)
      ctx.lineTo(x + 0.5, yBot)
    }
    ctx.stroke()
  }, [channel, peak])
  return (
    <canvas
      ref={ref}
      width={640}
      height={height}
      style={{ width: '100%', height, color, display: 'block', background: 'var(--panel-2)', borderRadius: 8 }}
    />
  )
}

const KIND_COLOR: Record<SubframeKind, string> = {
  constant: 'var(--text-dim)',
  verbatim: 'var(--amber)',
  fixed: 'var(--blue)',
  lpc: 'var(--teal)',
}

/** Interleaved little-endian int16 PCM bytes — what a naive .raw would store,
 *  and what we feed gzip so the comparison is header-free and fair. */
function pcmBytes(pcm: Pcm): Uint8Array {
  const n = pcm.samples[0].length
  const ch = pcm.channels
  const out = new Uint8Array(n * ch * 2)
  const dv = new DataView(out.buffer)
  let o = 0
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = pcm.samples[c][i]
      if (v < -32768) v = -32768; else if (v > 32767) v = 32767
      dv.setInt16(o, v, true); o += 2
    }
  }
  return out
}

function bitsPerSampleRice(values: Int32Array): number {
  if (values.length === 0) return 0
  const zz = new Int32Array(values.length)
  for (let i = 0; i < values.length; i++) zz[i] = zigzag(values[i])
  return bestRiceK(zz).bits / values.length
}

export function Flac() {
  const [signalId, setSignalId] = useState('chord')
  const [seconds, setSeconds] = useState(0.9)
  const [maxLpcOrder, setMaxLpcOrder] = useState(8)
  const [blockSize, setBlockSize] = useState(4096)
  const [uploaded, setUploaded] = useState<{ name: string; pcm: Pcm } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const [playing, setPlaying] = useState(false)

  const SAMPLE_RATE = 22050

  const pcm = useMemo<Pcm>(() => {
    if (uploaded) return uploaded.pcm
    const spec = SIGNALS.find((s) => s.id === signalId) ?? SIGNALS[0]
    return spec.gen(SAMPLE_RATE, seconds)
  }, [signalId, seconds, uploaded])

  const analysis = useMemo(() => flacEncodeAnalyzed(pcm, { blockSize, maxLpcOrder }), [pcm, blockSize, maxLpcOrder])

  const roundTrip = useMemo(() => {
    try {
      const dec = flacDecode(analysis.bytes)
      if (dec.channels !== pcm.channels) return false
      for (let c = 0; c < pcm.channels; c++) {
        const a = pcm.samples[c], b = dec.samples[c]
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
      }
      return true
    } catch {
      return false
    }
  }, [analysis, pcm])

  const raw = useMemo(() => pcmBytes(pcm), [pcm])
  const gzipSize = useMemo(() => {
    try { return gzipEncode(raw).length } catch { return raw.length }
  }, [raw])
  const wavSize = 44 + raw.length

  const n = pcm.samples[0].length
  const flacSize = analysis.bytes.length
  const flacBps = n > 0 ? (flacSize * 8) / (n * pcm.channels) : 0
  const ratio = raw.length > 0 ? flacSize / raw.length : 0

  const sizeBars = [
    { label: 'raw PCM (.raw)', value: raw.length, color: 'var(--text-dim)' },
    { label: 'WAV (.wav)', value: wavSize, color: seriesColor(4) },
    { label: 'gzip(PCM)', value: gzipSize, color: 'var(--amber)' },
    { label: 'FLAC (.flac)', value: flacSize, color: 'var(--teal)' },
  ]

  // aggregate subframe method usage
  const methodCounts = useMemo(() => {
    const counts: Record<SubframeKind, number> = { constant: 0, verbatim: 0, fixed: 0, lpc: 0 }
    for (const f of analysis.frames) for (const s of f.subframes) counts[s.kind]++
    return counts
  }, [analysis])

  // frame-0, channel-0 subframe — the one we open up for the residual story
  const sub0 = analysis.frames[0]?.subframes[0]
  const origBps = useMemo(() => {
    const f0 = analysis.frames[0]
    if (!f0) return 0
    const seg = pcm.samples[0].subarray(0, f0.blockSize)
    return bitsPerSampleRice(Int32Array.from(seg))
  }, [analysis, pcm])
  const resBps = useMemo(() => (sub0?.residual ? bitsPerSampleRice(sub0.residual.subarray(sub0.order)) : 0), [sub0])

  const perFrameBytes = useMemo(
    () => analysis.frames.map((f, i) => ({ label: `${i}`, value: f.bytes })),
    [analysis],
  )

  // ---- WebAudio playback ----
  const stop = () => {
    try { sourceRef.current?.stop() } catch { /* already stopped */ }
    sourceRef.current = null
    setPlaying(false)
  }
  const play = () => {
    try {
      stop()
      let ctx = audioCtxRef.current
      if (!ctx) { ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); audioCtxRef.current = ctx }
      const buf = ctx.createBuffer(pcm.channels, n, pcm.sampleRate)
      for (let c = 0; c < pcm.channels; c++) {
        const ch = buf.getChannelData(c)
        const src = pcm.samples[c]
        for (let i = 0; i < n; i++) ch[i] = Math.max(-1, Math.min(1, src[i] / 32768))
      }
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.connect(ctx.destination)
      node.onended = () => setPlaying(false)
      node.start()
      sourceRef.current = node
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }
  useEffect(() => stop, []) // stop on unmount

  const download = (bytes: Uint8Array, name: string) => {
    try {
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch { /* sandboxed */ }
  }

  const onUpload = async (file: File) => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const p = decodeWav(buf)
      // clamp very long uploads so the encoder stays snappy (~5s @ its rate)
      const maxN = p.sampleRate * 5
      if (p.samples[0].length > maxN) {
        p.samples = p.samples.map((s) => Int32Array.from(s.subarray(0, maxN)))
      }
      setUploaded({ name: file.name, pcm: p })
    } catch {
      setUploaded(null)
    }
  }

  const spec = SIGNALS.find((s) => s.id === signalId)

  return (
    <div className="prose">
      <PageHeader
        kicker="The real thing · lossless audio"
        title="FLAC — lossless audio by linear prediction"
        lede={
          <>
            A new modality. Text is symbolic and images are spatial; audio is a <strong>time series</strong>,
            and the idea that compresses it is the one PNG's scanline filters only hinted at, pushed all the
            way: <strong>linear prediction</strong>. A sample is very nearly a linear combination of the ones
            just before it, so subtract off that prediction and you're left with a small, white-ish{' '}
            <strong>residual</strong> — and a residual shaped like a two-sided geometric is exactly what a{' '}
            <strong>Rice code</strong> spends the fewest bits on. That is FLAC (and ALAC, Shorten, WavPack),
            and it is why they beat gzip on audio by a mile: gzip has no model of "the next sample continues
            the last few". Everything here is integer and exactly invertible — a real{' '}
            <span className="mono">fLaC</span> stream with STREAMINFO, framed subframes, UTF-8 frame numbers
            and per-frame CRC-8/CRC-16.
          </>
        }
      />

      <Panel title="Source" note="Pick a procedural signal or drop in a .wav. Each is chosen to make a different predictor win.">
        <div className="chip-row" style={{ marginBottom: 12 }}>
          {SIGNALS.map((s) => (
            <button
              key={s.id}
              className={`chip${!uploaded && signalId === s.id ? ' active' : ''}`}
              onClick={() => { setUploaded(null); setSignalId(s.id) }}
              title={s.note}
            >
              {s.name}
            </button>
          ))}
          <button className={`chip${uploaded ? ' active' : ''}`} onClick={() => fileRef.current?.click()}>
            {uploaded ? `▲ ${uploaded.name}` : '＋ upload .wav'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f) }}
          />
        </div>

        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
          {!uploaded && (
            <label className="field" style={{ minWidth: 200 }}>duration = {seconds.toFixed(1)} s
              <input type="range" min={0.3} max={1.6} step={0.1} value={seconds} onChange={(e) => setSeconds(+e.target.value)} />
            </label>
          )}
          <label className="field" style={{ minWidth: 220 }}>max LPC order = {maxLpcOrder} {maxLpcOrder === 0 ? '(fixed predictors only)' : ''}
            <input type="range" min={0} max={16} value={maxLpcOrder} onChange={(e) => setMaxLpcOrder(+e.target.value)} />
          </label>
          <label className="field" style={{ minWidth: 140 }}>block size
            <select value={blockSize} onChange={(e) => setBlockSize(+e.target.value)}>
              <option value={1024}>1024</option>
              <option value={2048}>2048</option>
              <option value={4096}>4096</option>
            </select>
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" onClick={playing ? stop : play}>{playing ? '■ stop' : '▶ play'}</button>
            <button className="btn small" onClick={() => download(analysis.bytes, `${uploaded?.name ?? signalId}.flac`)}>↓ .flac</button>
            <button className="btn small" onClick={() => download(encodeWav(pcm), `${uploaded?.name ?? signalId}.wav`)}>↓ .wav</button>
          </div>
        </div>

        <Waveform channel={pcm.samples[0]} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {spec && !uploaded ? spec.note : 'uploaded audio'} · {pcm.channels === 2 ? 'stereo' : 'mono'} · {n.toLocaleString()} samples @ {pcm.sampleRate.toLocaleString()} Hz · {pcm.bitsPerSample}-bit
        </div>
      </Panel>

      <div className="grid-4" style={{ marginBottom: 4 }}>
        <Stat label="FLAC size" value={fmtBytes(flacSize)} accent sub={`${(ratio * 100).toFixed(1)}% of raw`} />
        <Stat label="bit rate" value={flacBps.toFixed(2)} unit="b/sample" sub={`raw is ${pcm.bitsPerSample}.0`} />
        <Stat label="vs gzip" value={gzipSize > 0 ? `${(gzipSize / flacSize).toFixed(2)}×` : '—'} sub="gzip has no audio model" />
        <Stat label="round-trip" value={roundTrip ? '✓ bit-exact' : '✗ FAIL'} sub="decode == original PCM" />
      </div>

      <Panel title="Size race" note="FLAC vs the naive stores and vs gzip. gzip finds byte repetition; FLAC models the signal — a categorical difference on audio.">
        <HBarChart bars={sizeBars} unit="" valueFmt={(v) => fmtBytes(v)} height={34} />
      </Panel>

      <div className="grid-2">
        <Panel
          title="Prediction shrinks entropy"
          note="Frame 0, channel 0: the raw samples span the full range; the residual after linear prediction is a thin band around zero — and that is the whole game."
        >
          {sub0?.residual ? (
            <>
              <div className="stat-label" style={{ marginBottom: 4 }}>original samples</div>
              <Waveform channel={Int32Array.from(pcm.samples[0].subarray(0, analysis.frames[0].blockSize))} color="var(--text-mid)" height={72} />
              <div className="stat-label" style={{ margin: '10px 0 4px' }}>residual (what actually gets coded)</div>
              <Waveform channel={sub0.residual.subarray(sub0.order)} color="var(--teal)" height={72} />
              <div className="grid-2" style={{ marginTop: 12 }}>
                <Stat label="samples cost" value={origBps.toFixed(2)} unit="b/samp" sub="best Rice on raw" />
                <Stat label="residual cost" value={resBps.toFixed(2)} unit="b/samp" sub={`${origBps > 0 ? (100 * (1 - resBps / origBps)).toFixed(0) : 0}% smaller`} accent />
              </div>
            </>
          ) : (
            <div className="muted">Frame 0 chose a {sub0?.kind} subframe (no residual to show — the signal is constant or was stored verbatim).</div>
          )}
        </Panel>

        <Panel title="What each frame chose" note="Per subframe: CONSTANT / VERBATIM / a fixed polynomial predictor / a quantised-coefficient LPC predictor — whichever coded smallest.">
          <div className="grid-4" style={{ marginBottom: 12 }}>
            {(['lpc', 'fixed', 'constant', 'verbatim'] as SubframeKind[]).map((k) => (
              <Stat key={k} label={k} value={methodCounts[k]} sub="subframes" />
            ))}
          </div>
          <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr><th>frame</th><th>stereo</th><th>ch0</th><th>ch1</th><th style={{ textAlign: 'right' }}>bytes</th></tr>
              </thead>
              <tbody>
                {analysis.frames.slice(0, 40).map((f) => (
                  <tr key={f.index}>
                    <td className="mono num">{f.index}</td>
                    <td>{f.stereo}</td>
                    {[0, 1].map((c) => {
                      const s = f.subframes[c]
                      return (
                        <td key={c} className="mono" style={{ color: s ? KIND_COLOR[s.kind] : undefined }}>
                          {s ? `${s.kind}${s.order ? `·${s.order}` : ''}` : '—'}
                        </td>
                      )
                    })}
                    <td className="mono num" style={{ textAlign: 'right' }}>{f.bytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Partitioned Rice parameters" note="The block's residual is split into 2^p partitions, each free to pick its own Rice k — a transient and the silence after it want very different codes.">
          {sub0 && sub0.riceParams.length > 0 ? (
            <>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                {sub0.riceParams.map((k, i) => (
                  <div key={i} title={`partition ${i}: k=${k === 15 || k === 31 ? 'escape' : k}`}
                    style={{
                      flex: '1 1 20px', minWidth: 20, height: 34, borderRadius: 5,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--mono)', fontSize: 11, color: '#0a0d13',
                      background: `color-mix(in srgb, var(--teal) ${Math.min(100, 20 + (k === 15 || k === 31 ? 100 : k) * 8)}%, var(--panel-2))`,
                    }}>
                    {k === 15 || k === 31 ? 'esc' : k}
                  </div>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {sub0.riceParams.length} partitions (order {sub0.partitionOrder}). Each cell is one partition's Rice k — brighter = larger k = a noisier stretch.
              </div>
            </>
          ) : (
            <div className="muted">No partitioned residual in frame 0 (constant/verbatim subframe).</div>
          )}
        </Panel>

        <Panel title={sub0?.kind === 'lpc' ? `LPC predictor (order ${sub0.order})` : 'Predictor'} note="For an LPC subframe: the quantised integer coefficients and the shift. The decoder replays pred = (Σ cⱼ·x[i−1−j]) ≫ shift exactly, so it reconstructs bit-for-bit.">
          {sub0?.kind === 'lpc' && sub0.coefs ? (
            <>
              <div className="mono" style={{ fontSize: 12, lineHeight: 1.7, wordBreak: 'break-word' }}>
                <div className="muted">shift = {sub0.shift} · precision {sub0.coefs.length ? 15 : 0}-bit</div>
                [{sub0.coefs.join(', ')}]
              </div>
              <div style={{ marginTop: 10 }}>
                <ColumnChart cols={sub0.coefs.map((c, i) => ({ label: `${i}`, value: c }))} height={80} color="var(--teal)" />
              </div>
            </>
          ) : sub0?.kind === 'fixed' ? (
            <div className="muted">Frame 0 chose a fixed order-{sub0.order} predictor — one of the closed-form finite-difference filters (0..4), no coefficients to transmit.</div>
          ) : (
            <div className="muted">Frame 0 chose a {sub0?.kind ?? '—'} subframe.</div>
          )}
        </Panel>
      </div>

      <Panel title="Per-frame size" note="Bytes per frame across the file. Onsets and noisy passages cost more; steady tones and silence collapse.">
        <ColumnChart cols={perFrameBytes} height={120} color="var(--blue)" />
      </Panel>

      <Panel title="The pipeline, end to end">
        <ol className="prose-list">
          <li><strong>Inter-channel decorrelation</strong> — stereo is recoded as mid/side or left/side (whichever is smaller this frame), because a song's two channels are nearly the same signal.</li>
          <li><strong>Predictor selection</strong> — each channel's block tries CONSTANT, VERBATIM, the five fixed polynomial predictors, and an LPC predictor whose coefficients come from Levinson–Durbin on the windowed autocorrelation, then quantised to 15-bit integers. Smallest wins.</li>
          <li><strong>Partitioned Rice coding</strong> — the residual is split into 2^p partitions, each with its own optimal Rice parameter (or an escape to raw bits for incompressible stretches).</li>
          <li><strong>The bitstream</strong> — a real <span className="mono">fLaC</span> marker + STREAMINFO, then frames with the 14-bit sync code, UTF-8-coded frame numbers, and CRC-8/CRC-16 integrity.</li>
        </ol>
        <p className="muted" style={{ fontSize: 13 }}>
          Because every predictor is integer and its coefficients are stored, the decoder replays the identical
          arithmetic — a correct model is automatically a correct codec, the same invariant PPM and context
          mixing rely on. The <strong>{roundTrip ? '✓ bit-exact' : 'round-trip'}</strong> badge above is that
          proof, live, on whatever you're looking at.
        </p>
      </Panel>
    </div>
  )
}
