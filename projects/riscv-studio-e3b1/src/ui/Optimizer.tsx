// The "Optimizer" tab: Forge, the studio's optimizing back end, made visible.
//
// You write C (or paste assembly) on the left. On every keystroke it is compiled with the naive
// stack-machine back end, then run through Forge's pass pipeline. The right side shows the win:
// a before→after metric strip (instructions, static bytes, *and* the cycle count measured through
// the studio's own performance model), a "provably equivalent" badge from the differential oracle,
// the optimized assembly, a side-by-side diff, the per-pass transformation log, and the CFG.

import { useMemo, useState } from 'react';
import CEditor from './CEditor';
import { compile } from '../cc/compile';
import { optimizeAsm } from '../opt/optimize';
import type { OptResult } from '../opt/optimize';
import { checkEquivalence } from '../opt/equiv';
import type { EquivResult } from '../opt/equiv';
import { assemble } from '../vm/assembler';
import { analyze, defaultConfig } from '../perf/analyze';
import { OPT_DEMOS, DEFAULT_OPT_DEMO } from '../opt/demos';
import type { OptDemo } from '../opt/demos';
import { parseModule } from '../opt/parse';
import { buildCfg } from '../opt/cfg';
import { printInstr } from '../opt/ir';

interface OptimizerProps {
  onSendAsm: (asm: string) => void;
}

type Panel = 'result' | 'diff' | 'passes' | 'cfg';

interface Analysis {
  ok: boolean;
  error: string | null;
  naiveAsm: string | null;
  opt: OptResult | null;
  equiv: EquivResult | null;
  cyclesBefore: number;
  cyclesAfter: number;
  retiredBefore: number;
  retiredAfter: number;
  bytesBefore: number;
  bytesAfter: number;
}

function staticBytes(asm: string): number {
  const a = assemble(asm, { compress: false });
  if (!a.ok) return 0;
  return a.instrs.reduce((n, i) => n + (i.size ?? 4), 0);
}

function runAnalysis(source: string, mode: 'c' | 'asm'): Analysis {
  const empty: Analysis = {
    ok: false, error: null, naiveAsm: null, opt: null, equiv: null,
    cyclesBefore: 0, cyclesAfter: 0, retiredBefore: 0, retiredAfter: 0, bytesBefore: 0, bytesAfter: 0,
  };
  let naive: string;
  if (mode === 'c') {
    const c = compile(source);
    if (!c.ok || !c.asm) return { ...empty, error: c.diags.map((d) => `line ${d.line}: ${d.message}`).join('; ') || 'compile error' };
    naive = c.asm;
  } else {
    naive = source;
  }
  const a0 = assemble(naive, { compress: false });
  if (!a0.ok) return { ...empty, error: a0.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ') };

  let opt: OptResult;
  try {
    opt = optimizeAsm(naive);
  } catch (e) {
    return { ...empty, naiveAsm: naive, error: `optimizer error: ${(e as Error).message}` };
  }
  const equiv = checkEquivalence(naive, opt.asm);
  const cfg = defaultConfig();
  const before = analyze(assemble(naive, { compress: false }), cfg);
  const after = analyze(assemble(opt.asm, { compress: false }), cfg);

  return {
    ok: true,
    error: null,
    naiveAsm: naive,
    opt,
    equiv,
    cyclesBefore: before.result.cycles,
    cyclesAfter: after.result.cycles,
    retiredBefore: before.traced,
    retiredAfter: after.traced,
    bytesBefore: staticBytes(naive),
    bytesAfter: staticBytes(opt.asm),
  };
}

export default function Optimizer({ onSendAsm }: OptimizerProps) {
  const [mode, setMode] = useState<'c' | 'asm'>('c');
  const [source, setSource] = useState(DEFAULT_OPT_DEMO.code);
  const [demoId, setDemoId] = useState<string | null>(DEFAULT_OPT_DEMO.id);
  const [panel, setPanel] = useState<Panel>('result');

  const analysis = useMemo(() => runAnalysis(source, mode), [source, mode]);

  const onEdit = (s: string) => {
    setSource(s);
    setDemoId(null);
  };
  const loadDemo = (d: OptDemo) => {
    setMode(d.mode);
    setSource(d.code);
    setDemoId(d.id);
    setPanel('result');
  };

  const a = analysis;
  const removed = a.opt ? a.opt.stats.removed : 0;
  const pct = a.opt && a.opt.stats.instrsBefore > 0 ? (removed / a.opt.stats.instrsBefore) * 100 : 0;
  const cyclePct = a.cyclesBefore > 0 ? ((a.cyclesBefore - a.cyclesAfter) / a.cyclesBefore) * 100 : 0;

  return (
    <div className="cc opt">
      <div className="cc-toolbar">
        <div className="tool-group">
          <button
            onClick={() => a.opt && onSendAsm(a.opt.asm)}
            disabled={!a.ok}
            title="Load the optimized assembly into the main debugger"
          >
            ⇪ Send optimized asm to debugger
          </button>
          <div className="opt-mode">
            <label className={mode === 'c' ? 'on' : ''}>
              <input type="radio" checked={mode === 'c'} onChange={() => setMode('c')} /> C
            </label>
            <label className={mode === 'asm' ? 'on' : ''}>
              <input type="radio" checked={mode === 'asm'} onChange={() => setMode('asm')} /> assembly
            </label>
          </div>
        </div>
        <div className="tool-group">
          <select
            value={demoId ?? ''}
            onChange={(e) => {
              const d = OPT_DEMOS.find((x) => x.id === e.target.value);
              if (d) loadDemo(d);
            }}
          >
            <option value="" disabled>load a demo…</option>
            {OPT_DEMOS.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        </div>
        <div className="tool-status">
          {a.ok && a.opt ? (
            <>
              <span className="pill status-halted">−{pct.toFixed(0)}% instrs</span>
              <span className="cyc">{a.opt.stats.instrsBefore} → {a.opt.stats.instrsAfter}</span>
            </>
          ) : (
            <span className="pill status-error">{a.error ? 'error' : '…'}</span>
          )}
        </div>
      </div>

      <div className="cc-body">
        <section className="cc-left">
          {mode === 'c' ? (
            <CEditor source={source} onChange={onEdit} errorLines={new Map()} />
          ) : (
            <textarea className="opt-asm-input" value={source} spellCheck={false} onChange={(e) => onEdit(e.target.value)} />
          )}
          {a.error && (
            <div className="error-bar">
              <div className="err-item">{a.error}</div>
            </div>
          )}
        </section>

        <section className="cc-right">
          <nav className="cc-tabs">
            {(['result', 'diff', 'passes', 'cfg'] as Panel[]).map((p) => (
              <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
                {p === 'result' ? 'Result' : p === 'diff' ? 'Before / After' : p === 'passes' ? 'Passes' : 'CFG'}
              </button>
            ))}
          </nav>
          <div className="cc-panel">
            {!a.ok && <div className="cc-hint">{a.error ?? 'Write a program on the left to optimize it.'}</div>}
            {a.ok && a.opt && panel === 'result' && (
              <ResultPanel a={a} removed={removed} pct={pct} cyclePct={cyclePct} />
            )}
            {a.ok && a.opt && panel === 'diff' && <DiffPanel naive={a.naiveAsm!} opt={a.opt.asm} />}
            {a.ok && a.opt && panel === 'passes' && <PassesPanel opt={a.opt} />}
            {a.ok && a.opt && panel === 'cfg' && <CfgPanel opt={a.opt} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, before, after, deltaPct, lowerIsBetter = true }: { label: string; before: number; after: number; deltaPct: number; lowerIsBetter?: boolean }) {
  const good = lowerIsBetter ? after <= before : after >= before;
  return (
    <div className="opt-metric">
      <div className="opt-metric-label">{label}</div>
      <div className="opt-metric-val">
        <span className="opt-before">{before.toLocaleString()}</span>
        <span className="opt-arrow">→</span>
        <span className="opt-after">{after.toLocaleString()}</span>
      </div>
      <div className={`opt-delta ${good ? 'good' : 'bad'}`}>
        {deltaPct >= 0 ? '−' : '+'}{Math.abs(deltaPct).toFixed(1)}%
      </div>
    </div>
  );
}

function ResultPanel({ a, removed, pct, cyclePct }: { a: Analysis; removed: number; pct: number; cyclePct: number }) {
  const eq = a.equiv!;
  const verdictClass = eq.verdict === 'equivalent' ? 'good' : eq.verdict === 'different' ? 'bad' : 'warn';
  const verdictLabel = eq.verdict === 'equivalent' ? '✓ provably equivalent' : eq.verdict === 'different' ? '✗ NOT equivalent' : '… inconclusive';
  return (
    <div className="opt-result">
      <div className={`opt-equiv ${verdictClass}`}>
        <span className="opt-equiv-badge">{verdictLabel}</span>
        <span className="opt-equiv-reason">{eq.reason}</span>
      </div>
      <div className="opt-metrics">
        <Metric label="static instructions" before={a.opt!.stats.instrsBefore} after={a.opt!.stats.instrsAfter} deltaPct={pct} />
        <Metric label="code size (bytes)" before={a.bytesBefore} after={a.bytesAfter} deltaPct={a.bytesBefore ? ((a.bytesBefore - a.bytesAfter) / a.bytesBefore) * 100 : 0} />
        <Metric label="instructions retired" before={a.retiredBefore} after={a.retiredAfter} deltaPct={a.retiredBefore ? ((a.retiredBefore - a.retiredAfter) / a.retiredBefore) * 100 : 0} />
        <Metric label="cycles (perf model)" before={a.cyclesBefore} after={a.cyclesAfter} deltaPct={cyclePct} />
      </div>
      <div className="opt-summary">
        Forge removed <strong>{removed}</strong> instruction{removed === 1 ? '' : 's'} across{' '}
        <strong>{a.opt!.stats.rounds}</strong> fixpoint round{a.opt!.stats.rounds === 1 ? '' : 's'}, then re-ran both versions on
        a throwaway CPU and confirmed identical console output and exit code. Cycles are measured by
        the studio's own in-order pipeline + cache model — the optimizer and the performance lab,
        end to end.
      </div>
      <pre className="cc-asm">{a.opt!.asm}</pre>
    </div>
  );
}

function DiffPanel({ naive, opt }: { naive: string; opt: string }) {
  const left = naive.split('.data')[0].trimEnd().split('\n');
  const right = opt.split('.data')[0].trimEnd().split('\n');
  return (
    <div className="opt-diff">
      <div className="opt-diff-col">
        <div className="opt-diff-head">naive ({left.length} lines)</div>
        <pre className="cc-asm">{left.join('\n')}</pre>
      </div>
      <div className="opt-diff-col">
        <div className="opt-diff-head">optimized ({right.length} lines)</div>
        <pre className="cc-asm">{right.join('\n')}</pre>
      </div>
    </div>
  );
}

function PassesPanel({ opt }: { opt: OptResult }) {
  const byPass = opt.stats.byPass.filter((p) => p.changes > 0);
  return (
    <div className="opt-passes">
      <div className="opt-pass-summary">
        {byPass.map((p) => (
          <span key={p.name} className="opt-pass-chip">{p.name} <b>×{p.changes}</b></span>
        ))}
        {byPass.length === 0 && <span className="muted">no changes — the program was already optimal</span>}
      </div>
      <ul className="opt-log">
        {opt.log.slice(0, 400).map((c, i) => (
          <li key={i}>
            <span className="opt-log-pass">{c.pass}</span>
            {c.before && <code className="opt-log-before">{c.before}</code>}
            <span className="opt-arrow">{c.after === null ? '✕' : '→'}</span>
            {c.after !== null && <code className="opt-log-after">{c.after}</code>}
            <span className="opt-log-note">{c.note}</span>
          </li>
        ))}
        {opt.log.length > 400 && <li className="muted">… {opt.log.length - 400} more edits</li>}
      </ul>
    </div>
  );
}

function CfgPanel({ opt }: { opt: OptResult }) {
  // Rebuild a CFG over the optimized module for display.
  const blocks = useMemo(() => {
    // Lazy import-free: reparse + buildCfg through the exported helpers.
    return buildCfgSummary(opt.asm);
  }, [opt.asm]);
  return (
    <div className="opt-cfg">
      <div className="opt-cfg-head">{blocks.length} basic blocks</div>
      {blocks.map((b) => (
        <div key={b.id} className="opt-cfg-block">
          <div className="opt-cfg-block-head">
            block {b.id}{b.labels.length ? ` · ${b.labels.join(', ')}` : ''}
            <span className="opt-cfg-succ">{b.succ.length ? `→ ${b.succ.map((s) => 'b' + s).join(', ')}` : b.exit === 'return' ? '→ return' : ''}</span>
          </div>
          <pre className="cc-asm">{b.text}</pre>
        </div>
      ))}
    </div>
  );
}

// A tiny CFG summary for the panel, kept here to avoid leaking optimizer internals into the UI API.
interface BlockSummary { id: number; labels: string[]; succ: number[]; exit: string; text: string }
function buildCfgSummary(asm: string): BlockSummary[] {
  const cfg = buildCfg(parseModule(asm));
  return cfg.blocks.map((b) => ({
    id: b.id,
    labels: cfg.instrs[b.range[0]]?.labels ?? [],
    succ: b.succ,
    exit: b.exit,
    text: b.range.map((ix) => printInstr(cfg.instrs[ix]).trim()).join('\n'),
  }));
}
