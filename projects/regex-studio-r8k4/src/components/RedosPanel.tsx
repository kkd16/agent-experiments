import { useMemo, useState } from 'react';
import type { RegexNode, AstFeatures } from '../engine/ast';
import { analyzeRedos, type RedosReport } from '../engine/redos';

interface Props {
  ast: RegexNode | null;
  groupCount: number;
  features: AstFeatures | null;
  notice: string | null;
  onUseAttack: (text: string) => void;
}

const STATUS_META: Record<RedosReport['status'], { label: string; cls: string; blurb: string }> = {
  exponential: { label: 'EXPONENTIAL — vulnerable', cls: 'redos-exp', blurb: 'Catastrophic backtracking. A short input can hang the matcher.' },
  polynomial: { label: 'POLYNOMIAL — risky', cls: 'redos-poly', blurb: 'Super-linear backtracking. Long inputs degrade badly.' },
  safe: { label: 'SAFE — linear', cls: 'redos-safe', blurb: 'No exploitable ambiguity. Matching time stays linear.' },
  unknown: { label: 'UNDECIDED', cls: 'redos-unknown', blurb: 'Out of scope for static automaton analysis.' },
};

export function RedosPanel({ ast, groupCount, features, notice, onUseAttack }: Props) {
  const report = useMemo<RedosReport | null>(() => {
    if (!ast || !features) return null;
    return analyzeRedos(ast, groupCount, features);
  }, [ast, groupCount, features]);

  if (!ast || !features) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to analyse it.'}</div>;
  }
  if (!report) return <div className="placeholder">Analysing…</div>;

  const meta = STATUS_META[report.status];

  return (
    <div className="redos-panel">
      <div className={`redos-head ${meta.cls}`}>
        <div className="redos-verdict">{meta.label}</div>
        <div className="redos-blurb">{meta.blurb}</div>
      </div>

      <p className="redos-reason">{report.reason}</p>

      {report.pump && report.exploitable && report.attackExample && (
        <AttackBlock report={report} onUseAttack={onUseAttack} />
      )}

      {report.empirical && report.empirical.length > 0 && <GrowthChart report={report} />}

      <div className="redos-explainer">
        <h4>How this verdict was reached</h4>
        <ol>
          <li>
            Build the pattern’s ε-NFA and form the <strong>squared automaton</strong> N×N, then find a strongly-connected
            component that touches both the diagonal <code>(q,q)</code> and an off-diagonal node — proof that some state
            reaches itself by <em>two distinct paths</em> over one word (the pump).
          </li>
          <li>
            Synthesise <code>prefix · pump<sup>k</sup> · suffix</code>, probing the real engine for a suffix that forces
            the match to <em>fail</em> (failure is what makes a backtracker explore every split).
          </li>
          <li>
            <strong>Measure</strong> the actual backtracking VM at growing <code>k</code>. The verdict is read off the
            curve — never the structural guess alone — so a flagged-but-benign loop is correctly reported safe.
          </li>
        </ol>
      </div>
    </div>
  );
}

function AttackBlock({ report, onUseAttack }: { report: RedosReport; onUseAttack: (t: string) => void }) {
  const [copied, setCopied] = useState(false);
  const k0 = 6;
  const attack = report.attackExample!;
  const copy = () => {
    try {
      navigator.clipboard?.writeText(attack);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* sandbox: ignore */
    }
  };
  const show = (s: string | undefined) => (s ? visualise(s) : '');
  return (
    <div className="attack-block">
      <div className="attack-title">
        <span>Synthesised attack string</span>
        <span className="attack-formula">
          prefix · pump<sup>k</sup> · suffix
        </span>
      </div>
      <div className="attack-poc">
        {report.prefix ? <span className="poc-prefix" title="prefix: drives the NFA to the ambiguous loop">{show(report.prefix)}</span> : null}
        <span className="poc-pump" title={`pump: the ambiguous loop word, repeated k=${k0}×`}>
          ({show(report.pump)})<sup>{k0}</sup>
        </span>
        <span className="poc-suffix" title="suffix: forces the match to fail, triggering backtracking">{show(report.suffix)}</span>
      </div>
      <div className="attack-actions">
        <button className="dot-btn" onClick={() => onUseAttack(attack)} title="Load this string into the Run panel and watch the VM step counter">
          ▶ run it in the matcher
        </button>
        <button className="dot-btn" onClick={copy}>
          {copied ? 'copied ✓' : 'copy attack'}
        </button>
      </div>
    </div>
  );
}

function GrowthChart({ report }: { report: RedosReport }) {
  const data = report.empirical!;
  const maxLog = Math.max(...data.map((d) => Math.log10(Math.max(d.steps, 1))), 1);
  return (
    <div className="growth-chart">
      <div className="growth-title">
        Measured backtracking steps vs pump count{' '}
        {report.status === 'exponential' && report.ratio ? (
          <span className="growth-tag exp">×{report.ratio.toFixed(2)} per pump → exponential</span>
        ) : report.status === 'polynomial' && report.degree ? (
          <span className="growth-tag poly">slope ≈ {report.degree} → n^{report.degree}</span>
        ) : (
          <span className="growth-tag safe">flat → linear</span>
        )}
      </div>
      <table className="growth-table">
        <thead>
          <tr>
            <th>k</th>
            <th>length</th>
            <th>steps</th>
            <th className="growth-bar-col">growth (log scale)</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.k} className={d.aborted ? 'growth-abort' : ''}>
              <td>{d.k}</td>
              <td>{d.length}</td>
              <td className="growth-steps">{d.aborted ? '≥ limit' : d.steps.toLocaleString()}</td>
              <td className="growth-bar-col">
                <span
                  className={`growth-bar ${report.status}`}
                  style={{ width: `${(Math.log10(Math.max(d.steps, 1)) / maxLog) * 100}%` }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted-note">
        Pump count grows arithmetically, so the input length grows linearly. Exponential cost then shows a constant
        multiplier per row (a straight line on this log scale); polynomial cost bends; linear cost is nearly flat.
      </p>
    </div>
  );
}

// Make whitespace / control chars in synthesised strings visible.
function visualise(s: string): string {
  return Array.from(s)
    .map((ch) => (ch === '\n' ? '⏎' : ch === '\t' ? '⇥' : ch === ' ' ? '␣' : ch))
    .join('');
}
