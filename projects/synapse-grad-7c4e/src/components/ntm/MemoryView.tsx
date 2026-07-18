import { useMemo } from 'react';
import type { NTM } from '../../engine/ntm';
import type { NtmSample } from '../../engine/ntmtasks';
import Heatmap from './Heatmap';

interface Props {
  model: NTM;
  probe: NtmSample;
  tick: number;
}

// The signature NTM figure: the read/write head weightings as they sweep across memory
// locations over time, beside the final memory matrix. On a solved copy you can watch the write
// head march down the addresses during the input phase and the read head retrace the exact same
// path during the output phase — the machine has learned to use memory as a tape.
export default function MemoryView({ model, probe, tick }: Props) {
  const trace = useMemo(() => {
    model.forward(probe.inputs, true);
    return model.lastTrace;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, probe, tick]);

  if (!trace) return null;
  const { N, M, T } = trace;

  // Build a [N × T] matrix for a head's weighting series (row = location, col = timestep).
  const headMatrix = (series: Float64Array[]): Float64Array => {
    const m = new Float64Array(N * T);
    for (let t = 0; t < series.length; t++) {
      for (let i = 0; i < N; i++) m[i * T + t] = series[t][i];
    }
    return m;
  };

  const colLabels = Array.from({ length: T }, (_, t) => (t % 2 === 0 ? String(t) : ''));
  const rowLabels = Array.from({ length: N }, (_, i) => (i % 4 === 0 ? String(i) : ''));

  const memFinal = trace.memoryFinal;
  let memMax = 1e-6;
  for (let i = 0; i < memFinal.length; i++) memMax = Math.max(memMax, Math.abs(memFinal[i]));

  const cell = T > 26 ? 7 : 9;

  return (
    <div className="card">
      <div className="card-title">
        Memory &amp; head addressing <span className="muted small">· the probe sequence, live</span>
      </div>
      <div className="ntm-mem-grid">
        {trace.writeWeights.map((series, h) => (
          <div key={`w${h}`} className="ntm-mem-block">
            <div className="ntm-mem-label">
              <span className="dot write" /> write head {trace.writeWeights.length > 1 ? h : ''} — location × time
            </div>
            <Heatmap data={headMatrix(series)} rows={N} cols={T} cell={cell} palette="focus" vmax={1} rowLabels={rowLabels} colLabels={colLabels} />
          </div>
        ))}
        {trace.readWeights.map((series, h) => (
          <div key={`r${h}`} className="ntm-mem-block">
            <div className="ntm-mem-label">
              <span className="dot read" /> read head {trace.readWeights.length > 1 ? h : ''} — location × time
            </div>
            <Heatmap data={headMatrix(series)} rows={N} cols={T} cell={cell} palette="focus" vmax={1} rowLabels={rowLabels} colLabels={colLabels} />
          </div>
        ))}
        <div className="ntm-mem-block">
          <div className="ntm-mem-label">
            <span className="dot mem" /> memory M<sub>t=end</sub> — {N}×{M}
          </div>
          <Heatmap data={memFinal} rows={N} cols={M} cell={cell} palette="signed" vmax={memMax} rowLabels={rowLabels} />
        </div>
      </div>
      <p className="muted small chart-foot">
        Bright = focused there. On a trained copy the write head walks the tape as the sequence
        arrives, then the read head walks the same addresses back — content lookup, an interpolated
        shift, and sharpening, all differentiable.
      </p>
    </div>
  );
}
