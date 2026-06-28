import { useState } from "react";
import type { ReactNode } from "react";
import type { Challenge } from "../dojo/types";
import { profile } from "../dojo/profiler";
import type { ProfileOutcome } from "../dojo/profiler";
import { classify, compareToTarget, modelOf } from "../dojo/complexity";
import type { Classification, TargetComparison } from "../dojo/complexity";
import { scalingFor } from "../dojo/scaling";
import ComplexityChart from "./ComplexityChart";

/**
 * The Code Dojo complexity profiler panel.
 *
 * Runs the editor's current solution over a ladder of input sizes (in the
 * sandbox worker), classifies the resulting timing curve, and reports the
 * measured Big-O against the problem's optimal class — so an accepted but
 * quadratic answer to an O(n) problem is exposed instead of passing silently.
 */

const STOP_NOTE: Record<string, string> = {
  budget: "Stopped at the time budget — the largest sizes were skipped, but the trend is already clear.",
  slow: "Stopped once a single call got slow — that's the curve steepening, which is exactly the signal.",
  timeout: "A size took too long to return (a likely infinite loop or runaway growth); results up to there are shown.",
};

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="cx-stat" title={hint}>
      <div className="cx-stat-val">{value}</div>
      <div className="cx-stat-label">{label}</div>
    </div>
  );
}

export default function ComplexityProfiler({ ch, code, color }: { ch: Challenge; code: string; color?: string }) {
  const recipe = scalingFor(ch.id);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; n: number } | null>(null);
  const [outcome, setOutcome] = useState<ProfileOutcome | null>(null);
  const [cls, setCls] = useState<Classification | null>(null);
  const [cmp, setCmp] = useState<TargetComparison | null>(null);

  if (!recipe) {
    return (
      <div className="cx-panel">
        <div className="cx-panel-head">
          <h3>Complexity profiler</h3>
        </div>
        <p className="muted small">
          Empirical profiling isn't wired up for this problem yet — its input doesn't have a single
          size to scale. Try it on an array, string, grid or graph problem.
        </p>
      </div>
    );
  }

  const run = async () => {
    if (running) return;
    setRunning(true);
    setOutcome(null);
    setCls(null);
    setCmp(null);
    setProgress({ done: 0, total: recipe.sizes.length, n: 0 });
    const res = await profile(code, ch, recipe, {
      onProgress: (p) => setProgress({ done: p.done, total: p.total, n: p.n }),
    });
    setOutcome(res);
    if (res.status === "ok" && res.points.length >= 4) {
      const samples = res.points.map((p) => ({ n: p.n, t: p.perCall }));
      const c = classify(samples);
      setCls(c);
      setCmp(compareToTarget(c.best?.id ?? null, recipe.targetClass));
    }
    setRunning(false);
    setProgress(null);
  };

  const targetModel = modelOf(recipe.targetClass);
  const measured = cls?.best ? modelOf(cls.best.id) : null;
  const tooFew = outcome?.status === "ok" && outcome.points.length < 4;

  return (
    <div className="cx-panel">
      <div className="cx-panel-head">
        <h3>Complexity profiler</h3>
        <button className="btn ghost sm" onClick={run} disabled={running}>
          {running ? "Profiling…" : outcome ? "Re-profile" : "📈 Profile complexity"}
        </button>
      </div>

      {!outcome && !running && (
        <p className="muted small">
          Times your solution across input sizes from {recipe.sizes[0].toLocaleString()} up to{" "}
          {recipe.sizes[recipe.sizes.length - 1].toLocaleString()} ({recipe.sizeLabel}) and estimates
          its Big-O — then checks it against this problem's optimal of <code>{targetModel.label}</code>.
          Profile a working solution for a meaningful result.
        </p>
      )}

      {running && progress && (
        <div className="cx-progress">
          <div className="cx-progress-bar">
            <div className="cx-progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="muted small">
            Timing {recipe.sizeLabel} = {progress.n.toLocaleString()} … ({progress.done}/{progress.total})
          </p>
        </div>
      )}

      {outcome?.status === "compile-error" && (
        <div className="compile-error">
          <strong>Couldn't run your code</strong>
          <code>{outcome.compileError}</code>
        </div>
      )}
      {outcome?.status === "runtime-error" && (
        <div className="compile-error">
          <strong>Your code threw while profiling</strong>
          <code>{outcome.runtimeError}</code>
        </div>
      )}
      {outcome?.status === "unsupported" && (
        <p className="muted small">{outcome.compileError}</p>
      )}
      {tooFew && (
        <p className="muted small">
          Only {outcome!.points.length} size(s) completed — not enough to estimate a growth rate.
          Make sure your function returns a value and doesn't loop forever.
        </p>
      )}

      {!running && cls && cmp && measured && (
        <div className="cx-results">
          <div className={`cx-verdict ${cmp.verdict}`}>
            <div className="cx-verdict-head">{cmp.headline}</div>
            <div className="cx-verdict-detail">{cmp.detail}</div>
          </div>

          <div className="cx-stats">
            <Stat label="measured" value={<span className="cx-big" style={{ color }}>{measured.label}</span>}
              hint="The growth class your timings best match." />
            <Stat label="optimal" value={<span className="cx-big">{targetModel.label}</span>}
              hint="The best known complexity for this problem." />
            <Stat label="exponent" value={`n^${cls.slope.toFixed(2)}`}
              hint="Empirical power-law exponent (robust log–log slope): ~1 linear, ~2 quadratic." />
            <Stat label="fit R²" value={cls.best!.r2.toFixed(3)}
              hint="How tightly the measurements track the chosen curve (1.0 is perfect)." />
            <Stat label="points" value={cls.points} hint="Distinct input sizes timed." />
          </div>

          {cls.second && cls.margin < 0.02 && cls.second.id !== cls.best!.id && (
            <p className="muted small cx-alt">
              The data is also close to <code>{modelOf(cls.second.id).label}</code> — at this range the two are
              hard to separate by timing alone.
            </p>
          )}

          {recipe.note && <p className="muted small cx-note">{recipe.note}</p>}
          {outcome?.stopped && STOP_NOTE[outcome.stopped] && (
            <p className="muted small cx-note">{STOP_NOTE[outcome.stopped]}</p>
          )}

          <ComplexityChart points={outcome!.points} fit={cls.best} sizeLabel={recipe.sizeLabel} color={color} />

          <details className="cx-table-wrap">
            <summary>Raw measurements</summary>
            <table className="cx-table">
              <thead>
                <tr><th>{recipe.sizeLabel}</th><th>per call</th><th>batch ×</th></tr>
              </thead>
              <tbody>
                {outcome!.points.map((p, i) => (
                  <tr key={i}>
                    <td>{p.n.toLocaleString()}</td>
                    <td>{p.perCall < 1 ? (p.perCall * 1000).toFixed(2) + " µs" : p.perCall.toFixed(3) + " ms"}</td>
                    <td>{p.k.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
