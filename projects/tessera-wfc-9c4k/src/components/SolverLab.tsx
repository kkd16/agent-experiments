import { useCallback, useState } from 'react';
import { benchToCsv, type BenchRow, type BenchStrategy } from '../wfc/bench';
import type { Controller } from '../wfc/controller';
import { CELL_HEURISTICS, HEURISTIC_LABEL, type CellHeuristic } from '../wfc/heuristics';

/**
 * Solver Lab — the empirical companion to the Proof Lab. It races the four cell-selection
 * heuristics against each other on the *current* tileset and grid (same seeds for each, so it's a
 * fair fight) and tabulates what each one actually costs: how often it solves, and the mean
 * search effort (backtracks, peak depth, propagation eliminations) when it does. The point is to
 * make WFC's normally-invisible search policy legible — you can *see* that MRV barely backtracks
 * while scanline thrashes, on the very instance you're looking at.
 */

type Props = {
  controller: Controller;
  activeHeuristic: CellHeuristic;
  size: number;
};

const SEED_OPTIONS = [6, 12, 24];

// Compare the four observation heuristics, each with the default weighted tile policy.
const STRATEGIES: BenchStrategy[] = CELL_HEURISTICS.map((h) => ({ heuristic: h, tilePolicy: 'weighted' }));

function num(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export default function SolverLab({ controller, activeHeuristic, size }: Props) {
  const [rows, setRows] = useState<BenchRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [seeds, setSeeds] = useState(12);
  const [ms, setMs] = useState(0);
  const [copied, setCopied] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    setCopied(false);
    // defer so the button can paint its "running" state before the synchronous benchmark blocks
    setTimeout(() => {
      const t0 = performance.now();
      const r = controller.benchmark(STRATEGIES, seeds);
      setMs(Math.round(performance.now() - t0));
      setRows(r);
      setRunning(false);
    }, 16);
  }, [controller, seeds]);

  const copyCsv = useCallback(() => {
    if (!rows) return;
    navigator.clipboard
      .writeText(benchToCsv(rows))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — no-op */
      });
  }, [rows]);

  // Normalise the backtrack bars to the worst performer so the chart is self-scaling.
  const maxBacktracks = rows ? Math.max(1, ...rows.map((r) => r.meanBacktracks)) : 1;
  // Lower search effort is better; flag the winner among strategies that actually solved.
  const best = rows
    ? rows
        .filter((r) => r.solved > 0)
        .reduce<BenchRow | null>((b, r) => (b === null || r.meanBacktracks < b.meanBacktracks ? r : b), null)
    : null;

  return (
    <section className="panel solverlab">
      <header className="panel-head">
        <h2>Solver Lab</h2>
        {rows && <span className="badge badge-running">{seeds}×4 runs</span>}
      </header>
      <p className="blurb">
        Race the four observation heuristics on the current set at {size}×{size}, each over the same
        seeds. Lower backtracks / peak depth = a smarter search. The empirical side of the Proof Lab.
      </p>

      <div className="field">
        <span className="field-label">seeds per heuristic</span>
        <div className="segmented">
          {SEED_OPTIONS.map((s) => (
            <button key={s} className={`seg ${s === seeds ? 'active' : ''}`} onClick={() => setSeeds(s)} type="button">
              {s}
            </button>
          ))}
        </div>
      </div>

      <button className="btn btn-wide" onClick={run} disabled={running} type="button">
        {running ? 'Benchmarking…' : rows ? 'Re-run benchmark' : 'Run benchmark'}
      </button>

      {rows && (
        <>
          <p className="proof-time">
            {ms} ms · winner (fewest backtracks): <strong>{best ? HEURISTIC_LABEL[best.heuristic] : '—'}</strong>
          </p>
          <div className="bench">
            <div className="bench-row bench-head">
              <span>heuristic</span>
              <span>solved</span>
              <span>steps</span>
              <span>backtracks</span>
              <span>depth</span>
            </div>
            {rows.map((r) => {
              const isBest = best !== null && r.heuristic === best.heuristic;
              const isActive = r.heuristic === activeHeuristic;
              const w = `${Math.round((r.meanBacktracks / maxBacktracks) * 100)}%`;
              return (
                <div key={r.heuristic} className={`bench-row ${isBest ? 'win' : ''} ${isActive ? 'active' : ''}`}>
                  <span className="bench-name">
                    {HEURISTIC_LABEL[r.heuristic]}
                    {isActive && <em> ◂ live</em>}
                  </span>
                  <span>{Math.round(r.successRate * 100)}%</span>
                  <span>{r.solved > 0 ? num(r.meanSteps) : '—'}</span>
                  <span className="bench-bar-cell">
                    <span className="bench-bar" style={{ width: w }} />
                    <span className="bench-bar-val">{r.solved > 0 ? num(r.meanBacktracks) : '—'}</span>
                  </span>
                  <span>{r.solved > 0 ? num(r.meanPeakDepth) : '—'}</span>
                </div>
              );
            })}
          </div>
          <button className="btn btn-wide btn-ghost" onClick={copyCsv} type="button">
            {copied ? 'Copied ✓' : 'Copy CSV'}
          </button>
        </>
      )}
    </section>
  );
}
