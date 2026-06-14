// The "Compiler" tab: a self-contained C IDE. You write C on the left; on every keystroke it
// is compiled to RV32IM (lex → parse → type-check → codegen) and the result is shown on the
// right — generated assembly, the token stream, the AST, diagnostics, and a one-click Run
// that assembles the output and executes it on the studio's own CPU. "Open in Assembler"
// hands the generated asm to the main debugger so you can single-step the compiled code.

import { useMemo, useState } from 'react';
import CEditor from './CEditor';
import { compile } from '../cc/compile';
import { dumpProgram } from '../cc/astdump';
import { C_EXAMPLES, DEFAULT_C_EXAMPLE } from '../cc/examples';
import type { CExample } from '../cc/examples';
import { CC_TESTS, runCase } from '../cc/cc-tests';
import { assemble } from '../vm/assembler';
import { Cpu } from '../vm/cpu';

interface CCStudioProps {
  onSendAsm: (asm: string) => void;
}

type Panel = 'asm' | 'run' | 'tokens' | 'ast' | 'verify';

interface RunState {
  output: string;
  status: string;
  cycles: number;
  error: string | null;
}

export default function CCStudio({ onSendAsm }: CCStudioProps) {
  const [source, setSource] = useState(DEFAULT_C_EXAMPLE.code);
  const [panel, setPanel] = useState<Panel>('run');
  const [exampleId, setExampleId] = useState<string | null>(DEFAULT_C_EXAMPLE.id);
  const [run, setRun] = useState<RunState | null>(null);

  const result = useMemo(() => compile(source), [source]);

  const errorLines = useMemo(() => {
    const m = new Map<number, string>();
    for (const d of result.diags) if (!m.has(d.line)) m.set(d.line, d.message);
    return m;
  }, [result]);

  const onEdit = (s: string) => {
    setSource(s);
    setExampleId(null);
    setRun(null);
  };

  const loadExample = (ex: CExample) => {
    setSource(ex.code);
    setExampleId(ex.id);
    setRun(null);
    setPanel('run');
  };

  const doRun = () => {
    if (!result.ok || result.asm === null) {
      setPanel('run');
      setRun({ output: '', status: 'compile error', cycles: 0, error: 'fix the diagnostics first' });
      return;
    }
    const a = assemble(result.asm);
    if (!a.ok) {
      setRun({ output: '', status: 'assembler error', cycles: 0, error: a.errors.map((e) => `L${e.line} ${e.message}`).join('; ') });
      setPanel('run');
      return;
    }
    const cpu = new Cpu();
    cpu.load(a);
    cpu.run(60_000_000);
    setRun({
      output: cpu.output,
      status: cpu.status,
      cycles: cpu.cycles,
      error: cpu.status === 'error' ? cpu.error : null,
    });
    setPanel('run');
  };

  const asmLineCount = result.asm ? result.asm.trimEnd().split('\n').length : 0;

  return (
    <div className="cc">
      <div className="cc-toolbar">
        <div className="tool-group">
          <button className="run" onClick={doRun} disabled={!result.ok}>
            ▶ Compile &amp; Run
          </button>
          <button onClick={() => result.asm && onSendAsm(result.asm)} disabled={!result.ok} title="Load the generated assembly into the main debugger">
            ⇪ Open in Assembler
          </button>
        </div>
        <div className="tool-group">
          <select
            value={exampleId ?? ''}
            onChange={(e) => {
              const ex = C_EXAMPLES.find((x) => x.id === e.target.value);
              if (ex) loadExample(ex);
            }}
          >
            <option value="" disabled>
              load a C example…
            </option>
            {C_EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title}
              </option>
            ))}
          </select>
        </div>
        <div className="tool-status">
          <span className={`pill ${result.ok ? 'status-halted' : 'status-error'}`}>
            {result.ok ? 'compiled' : `${result.diags.length} error${result.diags.length === 1 ? '' : 's'}`}
          </span>
          {result.ok && <span className="cyc">{asmLineCount} asm lines</span>}
        </div>
      </div>

      <div className="cc-body">
        <section className="cc-left">
          <CEditor source={source} onChange={onEdit} errorLines={errorLines} />
          {!result.ok && (
            <div className="error-bar">
              {result.diags.slice(0, 8).map((d, i) => (
                <div key={i} className="err-item">
                  <span className="err-line">line {d.line}</span> <span className="muted">[{d.where}]</span> {d.message}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="cc-right">
          <nav className="cc-tabs">
            {(['run', 'asm', 'tokens', 'ast', 'verify'] as Panel[]).map((p) => (
              <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
                {p === 'run' ? 'Run' : p === 'asm' ? 'Assembly' : p === 'tokens' ? 'Tokens' : p === 'ast' ? 'AST' : 'C Verify'}
              </button>
            ))}
          </nav>
          <div className="cc-panel">
            {panel === 'run' && <RunPanel run={run} />}
            {panel === 'asm' && <AsmPanel asm={result.asm} />}
            {panel === 'tokens' && <TokensPanel result={result} />}
            {panel === 'ast' && <AstPanel result={result} />}
            {panel === 'verify' && <VerifyPanel />}
          </div>
        </section>
      </div>
    </div>
  );
}

function RunPanel({ run }: { run: RunState | null }) {
  if (!run) {
    return (
      <div className="cc-hint">
        Press <strong>Compile &amp; Run</strong> to assemble the generated RV32IM and execute it on the studio's CPU.
        The program's <code>printf</code>/<code>putchar</code> output appears here.
      </div>
    );
  }
  return (
    <div className="cc-run">
      <div className="cc-run-meta">
        <span className={`pill status-${run.status}`}>{run.status}</span>
        <span className="cyc">{run.cycles.toLocaleString()} cycles</span>
      </div>
      {run.error && <div className="cc-run-error">{run.error}</div>}
      <pre className="cc-console">{run.output || '(no output)'}</pre>
    </div>
  );
}

function AsmPanel({ asm }: { asm: string | null }) {
  if (!asm) return <div className="cc-hint">No assembly — fix the compiler diagnostics on the left.</div>;
  return <pre className="cc-asm">{asm}</pre>;
}

function TokensPanel({ result }: { result: ReturnType<typeof compile> }) {
  const toks = result.tokens.filter((t) => t.kind !== 'eof');
  return (
    <div className="cc-tokens">
      {toks.map((t, i) => (
        <span key={i} className={`cc-tok cc-tok-${t.kind}`} title={`line ${t.line}`}>
          {t.kind === 'str' ? JSON.stringify(t.str) : t.value}
        </span>
      ))}
    </div>
  );
}

function AstPanel({ result }: { result: ReturnType<typeof compile> }) {
  if (!result.ast) return <div className="cc-hint">No AST — the source didn't parse.</div>;
  return <pre className="cc-asm">{dumpProgram(result.ast)}</pre>;
}

function VerifyPanel() {
  const [results, setResults] = useState<{ name: string; passed: boolean; detail: string }[] | null>(null);
  const [running, setRunning] = useState(false);

  const go = () => {
    setRunning(true);
    // Defer so the button shows its busy state before the (synchronous) battery runs.
    setTimeout(() => {
      setResults(CC_TESTS.map((c) => runCase(c)));
      setRunning(false);
    }, 0);
  };

  const passed = results ? results.filter((r) => r.passed).length : 0;

  return (
    <div className="cc-verify">
      <div className="cc-verify-head">
        <button className="run" onClick={go} disabled={running}>
          {running ? 'running…' : `Run ${CC_TESTS.length} C tests`}
        </button>
        {results && (
          <span className={`pill ${passed === results.length ? 'status-halted' : 'status-error'}`}>
            {passed}/{results.length} passed
          </span>
        )}
        <span className="muted">each: compile → assemble → run → check stdout</span>
      </div>
      {results && (
        <ul className="cc-verify-list">
          {results.map((r, i) => (
            <li key={i} className={r.passed ? 'ok' : 'bad'}>
              <span className="mark">{r.passed ? '✓' : '✗'}</span>
              <span className="name">{r.name}</span>
              {!r.passed && <span className="detail">{r.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
