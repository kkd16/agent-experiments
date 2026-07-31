import { useCallback, useEffect, useRef, useState } from 'react';
import { EXPERIMENTS, type ExperimentResult } from '../sim/experiments';
import type { VerifyResponse } from '../sim/verify.worker';

type Status = 'idle' | 'running' | 'done' | 'error';
interface Row {
  status: Status;
  result?: ExperimentResult;
  error?: string;
  ms?: number;
}

const initialRows = (): Record<string, Row> =>
  Object.fromEntries(EXPERIMENTS.map((e) => [e.id, { status: 'idle' as Status }]));

export function VerifyView() {
  const [rows, setRows] = useState<Record<string, Row>>(initialRows);
  const [running, setRunning] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  const getWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current;
    try {
      workerRef.current = new Worker(new URL('../sim/verify.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      return null;
    }
    return workerRef.current;
  }, []);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const runOne = (w: Worker, id: string) =>
    new Promise<void>((resolve) => {
      const t0 = performance.now();
      const handler = (e: MessageEvent<VerifyResponse>) => {
        if (e.data.id !== id) return;
        w.removeEventListener('message', handler);
        setRows((r) => ({
          ...r,
          [id]: e.data.result
            ? { status: 'done', result: e.data.result, ms: performance.now() - t0 }
            : { status: 'error', error: e.data.error },
        }));
        resolve();
      };
      w.addEventListener('message', handler);
      setRows((r) => ({ ...r, [id]: { status: 'running' } }));
      w.postMessage({ id });
    });

  const runAll = useCallback(async () => {
    setRunning(true);
    setRows(initialRows());
    const w = getWorker();
    if (w) {
      for (const e of EXPERIMENTS) await runOne(w, e.id);
    } else {
      // Fallback: run on the main thread (yields between experiments so the
      // "running" state paints first).
      for (const e of EXPERIMENTS) {
        setRows((r) => ({ ...r, [e.id]: { status: 'running' } }));
        await new Promise((res) => setTimeout(res, 16));
        const t0 = performance.now();
        const result = e.run();
        setRows((r) => ({ ...r, [e.id]: { status: 'done', result, ms: performance.now() - t0 } }));
      }
    }
    setRunning(false);
  }, [getWorker]);

  const done = EXPERIMENTS.filter((e) => rows[e.id]?.status === 'done');
  const passed = done.filter((e) => rows[e.id].result?.pass).length;
  const allDone = done.length === EXPERIMENTS.length;

  return (
    <div className="verify">
      <div className="verify__head">
        <div>
          <h2>Measurement lab</h2>
          <p>
            Every experiment runs the real FDTD solver and compares a measured observable to a{' '}
            <em>closed-form</em> result from electromagnetic theory. Numbers, not pictures — this is
            how you know the engine actually solves Maxwell&rsquo;s equations.
          </p>
        </div>
        <div className="verify__actions">
          <button className="btn btn--primary" onClick={runAll} disabled={running}>
            {running ? 'Running…' : allDone ? '↻ Re-run all' : '► Run all experiments'}
          </button>
          {allDone && (
            <div className={'verify__score ' + (passed === EXPERIMENTS.length ? 'is-pass' : 'is-fail')}>
              {passed}/{EXPERIMENTS.length} passed
            </div>
          )}
        </div>
      </div>

      <div className="verify__grid">
        {EXPERIMENTS.map((e) => (
          <ExperimentCard key={e.id} title={e.title} row={rows[e.id]} />
        ))}
      </div>
    </div>
  );
}

function ExperimentCard({ title, row }: { title: string; row: Row }) {
  const r = row?.result;
  const statusClass =
    row?.status === 'done' ? (r?.pass ? 'is-pass' : 'is-fail') : row?.status ?? 'idle';
  return (
    <section className={'exp-card ' + statusClass}>
      <header className="exp-card__head">
        <span className="exp-card__badge" aria-hidden>
          {row?.status === 'running'
            ? '…'
            : row?.status === 'done'
              ? r?.pass
                ? '✓'
                : '✕'
              : row?.status === 'error'
                ? '!'
                : '·'}
        </span>
        <h3>{r?.title ?? title}</h3>
      </header>
      {row?.status === 'idle' && <p className="exp-card__idle">Not yet run.</p>}
      {row?.status === 'running' && <p className="exp-card__idle">Running the solver…</p>}
      {row?.status === 'error' && <p className="exp-card__idle">Error: {row.error}</p>}
      {r && (
        <>
          <p className="exp-card__summary">{r.summary}</p>
          <div className="exp-card__metrics">
            {r.metrics.map((m) => (
              <div key={m.label} className="metric">
                <span className="metric__k">{m.label}</span>
                <span className="metric__v">{m.value}</span>
              </div>
            ))}
          </div>
          {r.series && <MiniChart result={r} />}
          <div className="exp-card__foot">
            <span>
              measured <b>{fmt(r.measured)}</b> vs theory <b>{fmt(r.theory)}</b> {r.unit}
            </span>
            {row.ms != null && <span className="exp-card__ms">{(row.ms / 1000).toFixed(1)}s</span>}
          </div>
        </>
      )}
    </section>
  );
}

function fmt(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e5) return v.toExponential(2);
  return v.toPrecision(4);
}

function MiniChart({ result }: { result: ExperimentResult }) {
  const s = result.series!;
  const W = 300;
  const H = 120;
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  const xs = s.map((d) => d.x);
  const ys = s.flatMap((d) => [d.measured, d.theory]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.08 || 1;
  const x = (v: number) =>
    pad.l + ((v - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const y = (v: number) =>
    H - pad.b - ((v - (yMin - yPad)) / (yMax - yMin + 2 * yPad || 1)) * (H - pad.t - pad.b);
  const path = (key: 'measured' | 'theory') =>
    s.map((d, i) => `${i ? 'L' : 'M'}${x(d.x).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  return (
    <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} role="img">
      <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className="mc-axis" />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} className="mc-axis" />
      <path d={path('theory')} className="mc-theory" />
      <path d={path('measured')} className="mc-measured" />
      {s.map((d, i) => (
        <circle key={i} cx={x(d.x)} cy={y(d.measured)} r={2.4} className="mc-dot" />
      ))}
      {result.seriesLabel && (
        <>
          <text x={(W + pad.l) / 2} y={H - 4} className="mc-label" textAnchor="middle">
            {result.seriesLabel.x}
          </text>
          <text
            x={10}
            y={H / 2}
            className="mc-label"
            textAnchor="middle"
            transform={`rotate(-90 10 ${H / 2})`}
          >
            {result.seriesLabel.y}
          </text>
        </>
      )}
      <g className="mc-legend" transform={`translate(${W - 96}, ${pad.t + 6})`}>
        <line x1="0" y1="0" x2="16" y2="0" className="mc-measured" />
        <text x="20" y="3.5" className="mc-label">measured</text>
        <line x1="0" y1="12" x2="16" y2="12" className="mc-theory" />
        <text x="20" y="15.5" className="mc-label">theory</text>
      </g>
    </svg>
  );
}
