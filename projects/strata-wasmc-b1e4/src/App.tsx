import { useEffect, useMemo, useState } from 'react';
import './App.css';
import Editor from './ui/Editor';
import CfgView from './ui/CfgView';
import { AstPanel, DebugPanel, HexPanel, IrPanel, LoopsPanel, OptPanel, RunPanel, TokensPanel, VerifyPanel, WasmVmPanel, WatPanel } from './ui/Panels';
import { compile } from './compiler/pipeline';
import type { OptLevel } from './compiler/opt/optimize';
import { EXAMPLES } from './examples';

const STAGES = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'ast', label: 'AST' },
  { id: 'ir', label: 'SSA IR' },
  { id: 'opt', label: 'Optimizer' },
  { id: 'loops', label: 'Loops' },
  { id: 'cfg', label: 'CFG' },
  { id: 'wat', label: 'WASM' },
  { id: 'hex', label: 'Bytes' },
  { id: 'run', label: 'Run' },
  { id: 'debug', label: 'Debug' },
  { id: 'vm', label: 'WASM VM' },
  { id: 'verify', label: 'Verify' },
] as const;
type StageId = (typeof STAGES)[number]['id'];

function stageFromHash(): StageId {
  const h = window.location.hash.replace(/^#\/?/, '');
  return (STAGES.find((s) => s.id === h)?.id ?? 'cfg') as StageId;
}

export default function App() {
  const [source, setSource] = useState(EXAMPLES[0].source);
  const [level, setLevel] = useState<OptLevel>(1);
  const [stage, setStage] = useState<StageId>(stageFromHash);
  const [fnIdx, setFnIdx] = useState(0);
  const [exampleId, setExampleId] = useState(EXAMPLES[0].id);
  const [debugLine, setDebugLine] = useState<number | undefined>(undefined);
  const [vmLine, setVmLine] = useState<number | undefined>(undefined);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
  const toggleBreakpoint = (line: number) =>
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  useEffect(() => {
    const onHash = () => setStage(stageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (s: StageId) => {
    window.history.replaceState(null, '', `#/${s}`);
    setStage(s);
  };

  const comp = useMemo(() => compile(source, level, true), [source, level]);
  const funcs = comp.optimized?.funcs ?? [];
  const safeFnIdx = Math.min(fnIdx, Math.max(0, funcs.length - 1));

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (ex) {
      setSource(ex.source);
      setExampleId(id);
      setFnIdx(0);
    }
  };

  const m = comp.metrics;
  const showFnSelect = (stage === 'ir' || stage === 'cfg' || stage === 'loops') && funcs.length > 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⟢</span>
          <div>
            <div className="title">Strata</div>
            <div className="subtitle">an optimizing compiler to WebAssembly — in your browser</div>
          </div>
        </div>
        <div className="metrics">
          <Metric label="tokens" value={m?.tokens ?? '—'} />
          <Metric label="SSA insts" value={m?.ssaInsts ?? '—'} />
          <Metric label={`O${level} insts`} value={m?.optInsts ?? '—'} />
          <Metric label="reduction" value={m ? `${m.reductionPct}%` : '—'} accent />
          <Metric label="wasm" value={m ? `${m.wasmBytes} B` : '—'} />
          <Metric label="locals" value={m?.wasmLocals ?? '—'} />
          <Metric label="stack-folded" value={m?.stackFolded ?? '—'} accent />
          <Metric label="compile" value={m ? `${m.compileMs.toFixed(1)} ms` : '—'} />
        </div>
      </header>

      <div className="workspace">
        <section className="left">
          <div className="left-toolbar">
            <select value={exampleId} onChange={(e) => loadExample(e.target.value)} className="select">
              {EXAMPLES.map((e) => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </select>
            <div className="opt-seg">
              {([0, 1, 2, 3] as OptLevel[]).map((l) => (
                <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)} title={`optimization level ${l}`}>
                  -O{l}
                </button>
              ))}
            </div>
          </div>
          <div className="example-blurb">{EXAMPLES.find((e) => e.id === exampleId)?.blurb}</div>
          <Editor
            value={source}
            onChange={setSource}
            errorLine={comp.ok ? undefined : comp.error?.line}
            activeLine={stage === 'debug' ? debugLine : stage === 'vm' ? vmLine : undefined}
            breakpoints={stage === 'vm' ? breakpoints : undefined}
            onToggleBreakpoint={stage === 'vm' ? toggleBreakpoint : undefined}
          />
          {!comp.ok && comp.error && (
            <div className="error-bar">
              <b>{comp.error.phase} error</b> at {comp.error.line}:{comp.error.col} — {comp.error.message}
            </div>
          )}
        </section>

        <section className="right">
          <nav className="tabs">
            {STAGES.map((s) => (
              <button key={s.id} className={stage === s.id ? 'tab on' : 'tab'} onClick={() => go(s.id)}>
                {s.label}
              </button>
            ))}
            {showFnSelect && (
              <select className="select fn-select" value={safeFnIdx} onChange={(e) => setFnIdx(Number(e.target.value))}>
                {funcs.map((f, i) => (
                  <option key={i} value={i}>{f.name}()</option>
                ))}
              </select>
            )}
          </nav>
          <div className="panel">
            {stage === 'tokens' && <TokensPanel comp={comp} />}
            {stage === 'ast' && <AstPanel comp={comp} />}
            {stage === 'ir' && <IrPanel comp={comp} fnIdx={safeFnIdx} />}
            {stage === 'opt' && <OptPanel comp={comp} />}
            {stage === 'loops' && <LoopsPanel comp={comp} fnIdx={safeFnIdx} />}
            {stage === 'cfg' &&
              (funcs[safeFnIdx] ? <CfgView fn={funcs[safeFnIdx]} /> : <div className="panel-scroll dim note">no function</div>)}
            {stage === 'wat' && <WatPanel comp={comp} />}
            {stage === 'hex' && <HexPanel comp={comp} />}
            {stage === 'run' && <RunPanel comp={comp} />}
            {stage === 'debug' && <DebugPanel key={`${level}:${source}`} comp={comp} onActiveLine={setDebugLine} />}
            {stage === 'vm' && (
              <WasmVmPanel
                key={`${level}:${source}`}
                comp={comp}
                onActiveLine={setVmLine}
                breakpoints={breakpoints}
                onToggleBreakpoint={toggleBreakpoint}
              />
            )}
            {stage === 'verify' && <VerifyPanel />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={'metric' + (accent ? ' metric-accent' : '')}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
