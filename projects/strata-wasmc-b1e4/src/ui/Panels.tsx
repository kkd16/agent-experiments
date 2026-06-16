import { useEffect, useState } from 'react';
import type { Compilation } from '../compiler/pipeline';
import type { Block, Expr, FnDecl, Program, Stmt } from '../compiler/ast';
import { tyName } from '../compiler/ast';
import { dumpFunc } from '../compiler/irdump';
import { interpret } from '../compiler/interp';
import { Debugger } from '../compiler/debug';
import type { DebugState } from '../compiler/debug';
import { runWasm } from '../compiler/runner';
import { verifyAll } from '../compiler/verify';
import type { VerifyResult } from '../compiler/verify';
import type { OptLevel } from '../compiler/opt/optimize';
import { EXAMPLES, TEST_PROGRAMS } from '../examples';
import { TESTS } from '../compiler/tests';

// ---------------------------------------------------------------- Tokens

export function TokensPanel({ comp }: { comp: Compilation }) {
  return (
    <div className="panel-scroll">
      <table className="tok-table">
        <thead>
          <tr><th>#</th><th>type</th><th>text</th><th>line:col</th></tr>
        </thead>
        <tbody>
          {comp.tokens.map((t, i) => (
            <tr key={i}>
              <td className="dim">{i}</td>
              <td className="t-kw">{t.type}</td>
              <td className="mono">{t.type === 'eof' ? '⟂' : t.text}</td>
              <td className="dim">{t.span.line}:{t.span.col}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- AST

function exprStr(e: Expr): string {
  switch (e.node) {
    case 'int': return String(e.value);
    case 'long': return `${e.value}L`;
    case 'float': return String(e.value);
    case 'bool': return String(e.value);
    case 'string': return JSON.stringify(e.value);
    case 'ident': return e.name;
    case 'unary': return `${e.op}${exprStr(e.operand)}`;
    case 'binary': return `(${exprStr(e.left)} ${e.op} ${exprStr(e.right)})`;
    case 'call': return `${e.callee}(${e.args.map(exprStr).join(', ')})`;
    case 'callptr': return `${exprStr(e.target)}(${e.args.map(exprStr).join(', ')})`;
    case 'index': return `${exprStr(e.target)}[${exprStr(e.index)}]`;
    case 'member': return `${exprStr(e.target)}.${e.field}`;
    case 'null': return 'null';
    case 'ternary': return `(${exprStr(e.cond)} ? ${exprStr(e.then)} : ${exprStr(e.otherwise)})`;
  }
}

function stmtLines(s: Stmt, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const ty = (e: Expr) => (e.ty ? ` :${tyName(e.ty)}` : '');
  switch (s.node) {
    case 'let': out.push(`${pad}let ${s.name} = ${exprStr(s.init)}${ty(s.init)}`); break;
    case 'assign': out.push(`${pad}${s.name} = ${exprStr(s.value)}`); break;
    case 'index-assign': out.push(`${pad}${exprStr(s.target)}[${exprStr(s.index)}] = ${exprStr(s.value)}`); break;
    case 'member-assign': out.push(`${pad}${exprStr(s.target)}.${s.field} = ${exprStr(s.value)}`); break;
    case 'expr': out.push(`${pad}expr ${exprStr(s.expr)}`); break;
    case 'return': out.push(`${pad}return ${s.value ? exprStr(s.value) : ''}`); break;
    case 'break': out.push(`${pad}break`); break;
    case 'continue': out.push(`${pad}continue`); break;
    case 'if':
      out.push(`${pad}if ${exprStr(s.cond)}`);
      blockLines(s.then, depth + 1, out);
      if (s.otherwise) { out.push(`${pad}else`); blockLines(s.otherwise, depth + 1, out); }
      break;
    case 'while':
      out.push(`${pad}while ${exprStr(s.cond)}`);
      blockLines(s.body, depth + 1, out);
      break;
    case 'for':
      out.push(`${pad}for (${s.init ? 'init; ' : ''}${s.cond ? exprStr(s.cond) : 'true'}; ${s.update ? 'update' : ''})`);
      if (s.init) stmtLines(s.init, depth + 1, out);
      blockLines(s.body, depth + 1, out);
      if (s.update) stmtLines(s.update, depth + 1, out);
      break;
    case 'block': blockLines(s.block, depth + 1, out); break;
  }
}
function blockLines(b: Block, depth: number, out: string[]): void {
  for (const s of b.stmts) stmtLines(s, depth, out);
}
function astLines(prog: Program): string {
  const out: string[] = [];
  for (const d of prog.decls) {
    if (d.kind === 'fn') {
      const f = d as FnDecl;
      out.push(`fn ${f.name}(${f.params.map((p) => `${p.name}: ${tyName(p.ty)}`).join(', ')}) -> ${tyName(f.retTy)}`);
      blockLines(f.body, 1, out);
    } else if (d.kind === 'struct') {
      out.push(`struct ${d.name}`);
      for (const fld of d.fields) out.push(`  ${fld.name}: ${tyName(fld.ty)}`);
    } else {
      out.push(`global ${d.name} = ${exprStr(d.init)}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function AstPanel({ comp }: { comp: Compilation }) {
  if (!comp.program) return <Empty />;
  return <pre className="panel-scroll code-pre">{astLines(comp.program)}</pre>;
}

// ---------------------------------------------------------------- IR (SSA)

export function IrPanel({ comp, fnIdx }: { comp: Compilation; fnIdx: number }) {
  const [showOpt, setShowOpt] = useState(true);
  const mod = showOpt ? comp.optimized : comp.ssa;
  if (!mod) return <Empty />;
  const fn = mod.funcs[Math.min(fnIdx, mod.funcs.length - 1)];
  return (
    <div className="panel-scroll">
      <div className="seg">
        <button className={!showOpt ? 'on' : ''} onClick={() => setShowOpt(false)}>unoptimized</button>
        <button className={showOpt ? 'on' : ''} onClick={() => setShowOpt(true)}>optimized (O{comp.level})</button>
      </div>
      <pre className="code-pre ir-pre">{fn ? dumpFunc(fn) : '(no function)'}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- Optimizer

type DiffLine = { t: ' ' | '+' | '-'; s: string };
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i++; }
    else { out.push({ t: '+', s: B[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

export function OptPanel({ comp }: { comp: Compilation }) {
  const [sel, setSel] = useState<number | null>(null);
  if (!comp.metrics || !comp.optLog) return <Empty />;
  const { ssaInsts, optInsts, reductionPct } = comp.metrics;
  const max = Math.max(ssaInsts, 1);
  const snaps = comp.optSnapshots ?? [];
  const preLog = comp.preLog ?? [];

  const diff = sel !== null && snaps[sel] !== undefined && snaps[sel + 1] !== undefined
    ? lineDiff(snaps[sel], snaps[sel + 1])
    : null;
  const changedLines = diff ? diff.filter((d) => d.t !== ' ').length : 0;

  return (
    <div className="panel-scroll opt-panel">
      <div className="opt-bars">
        <div className="opt-bar-row">
          <span className="opt-label">SSA in</span>
          <div className="bar"><div className="bar-fill bar-a" style={{ width: '100%' }}>{ssaInsts}</div></div>
        </div>
        <div className="opt-bar-row">
          <span className="opt-label">after O{comp.level}</span>
          <div className="bar"><div className="bar-fill bar-b" style={{ width: `${(optInsts / max) * 100}%` }}>{optInsts}</div></div>
        </div>
        <div className="opt-reduction">{reductionPct}% fewer IR instructions</div>
      </div>

      {preLog.length > 0 && (
        <div className="prelog">
          <span className="prelog-label">pre-SSA:</span>
          {preLog.map((p, i) => (
            <span key={i} className="prelog-pill">{p.name} <b>×{p.changed}</b></span>
          ))}
        </div>
      )}

      {comp.level === 0 ? (
        <p className="dim note">Optimizations are disabled at -O0. Switch to -O1/-O2/-O3 to run the pass pipeline.</p>
      ) : (
        <>
          <table className="pass-table">
            <thead><tr><th>SSA pass</th><th>changes</th><th></th></tr></thead>
            <tbody>
              {comp.optLog.map((p, i) => (
                <tr
                  key={i}
                  className={(p.changed > 0 ? '' : 'dim') + (sel === i ? ' pass-sel' : '') + (snaps.length ? ' pass-click' : '')}
                  onClick={() => snaps.length && setSel(sel === i ? null : i)}
                >
                  <td className="mono">{p.name}</td>
                  <td className="num">{p.changed}</td>
                  <td className="dim diff-hint">{snaps.length ? (sel === i ? '▾ diff' : '▸ diff') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {diff && (
            <div className="ir-diff">
              <div className="ir-diff-head">
                IR change from <b>{comp.optLog[sel!].name}</b> — {changedLines === 0 ? 'no instructions changed' : `${changedLines} line(s) changed`}
              </div>
              <pre className="code-pre diff-pre">
                {diff.map((d, i) => (
                  <div key={i} className={d.t === '+' ? 'diff-add' : d.t === '-' ? 'diff-del' : 'diff-ctx'}>
                    {d.t}
                    {d.s ? ' ' + d.s : ''}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </>
      )}
      <div className="pass-legend">
        <b>Pipeline:</b>{comp.level >= 2 ? ' tail-call → loop → function inlining (pre-SSA) → ' : ' '}
        copy-propagation → sparse conditional constant propagation → strength reduction →
        {comp.level >= 2 ? ' global value numbering (CSE) →' : ''} algebraic simplification →
        {comp.level >= 2 ? ' loop-invariant code motion →' : ''} dead-code elimination,
        iterated to a fixed point{comp.level >= 2 ? ', then CFG cleanup + dead-function elimination' : ''}.
        The backend then <b>stackifies</b> — folding single-use pure values onto the wasm operand
        stack so they never need a local. {snaps.length > 0 && 'Click a pass to see exactly what it rewrote.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- WAT

export function WatPanel({ comp }: { comp: Compilation }) {
  if (!comp.wat) return <Empty />;
  return <pre className="panel-scroll code-pre wat-pre">{comp.wat}</pre>;
}

// ---------------------------------------------------------------- Hex + sections

const SECTION_NAMES: Record<number, string> = {
  0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory',
  6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data',
};
function decodeU32(bytes: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0, p = off;
  for (;;) {
    const b = bytes[p++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, p];
}
function walkSections(bytes: Uint8Array): { id: number; name: string; size: number; offset: number }[] {
  const out: { id: number; name: string; size: number; offset: number }[] = [];
  let p = 8; // skip magic + version
  while (p < bytes.length) {
    const id = bytes[p++];
    const [size, np] = decodeU32(bytes, p);
    out.push({ id, name: SECTION_NAMES[id] ?? `#${id}`, size, offset: np });
    p = np + size;
  }
  return out;
}

export function HexPanel({ comp }: { comp: Compilation }) {
  if (!comp.bytes) return <Empty />;
  const bytes = comp.bytes;
  const sections = walkSections(bytes);
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    rows.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  const download = () => {
    // Copy into a fresh ArrayBuffer-backed view so the Blob types cleanly.
    const buf = new Uint8Array(bytes.length);
    buf.set(bytes);
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/wasm' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'strata.wasm';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel-scroll">
      <div className="section-list">
        {sections.map((s, i) => (
          <span key={i} className="section-pill">
            <b>{s.name}</b> {s.size}B
          </span>
        ))}
        <span className="section-pill total">total {bytes.length}B</span>
        <button className="dl-wasm" onClick={download} title="download the assembled module">⤓ strata.wasm</button>
      </div>
      <pre className="code-pre hex-pre">{rows.join('\n')}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- Run

export function RunPanel({ comp }: { comp: Compilation }) {
  const [out, setOut] = useState<{ wasm: string[]; ref: string[]; match: boolean; err?: string; ms: number; ret?: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!comp.bytes || !comp.program) return;
    setBusy(true);
    const t0 = performance.now();
    const r = await runWasm(comp.bytes);
    const ref = interpret(comp.program);
    const match = JSON.stringify(r.output) === JSON.stringify(ref.output) && (r.error ?? '') === (ref.error ?? '');
    setOut({ wasm: r.output, ref: ref.output, match, err: r.error, ms: performance.now() - t0, ret: r.result });
    setBusy(false);
  };

  return (
    <div className="panel-scroll run-panel">
      <div className="run-controls">
        <button className="primary" onClick={run} disabled={busy || !comp.ok}>
          {busy ? 'running…' : '▶ run main()'}
        </button>
        {out && (
          <span className={'badge ' + (out.match ? 'ok' : 'bad')}>
            {out.match ? '✓ wasm output matches reference interpreter' : '✗ MISMATCH vs interpreter'}
          </span>
        )}
        {out && <span className="dim">{out.ms.toFixed(2)} ms{out.ret !== undefined ? ` · returned ${out.ret}` : ''}</span>}
      </div>
      {out && (
        <div className="run-cols">
          <div>
            <div className="col-head">WebAssembly stdout</div>
            <pre className="code-pre out-pre">{out.wasm.join('\n') || '(no output)'}{out.err ? `\n⚠ trap: ${out.err}` : ''}</pre>
          </div>
          <div>
            <div className="col-head">Reference interpreter</div>
            <pre className="code-pre out-pre">{out.ref.join('\n') || '(no output)'}</pre>
          </div>
        </div>
      )}
      {!out && <p className="dim note">Runs the compiled WebAssembly in your browser and diff-checks it against the independent tree-walking interpreter.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Debugger

// The parent remounts this panel (via `key`) whenever the program text changes,
// so the debugger is built once per program in a lazy `useState` initializer —
// no refs read during render, no reset effect.
export function DebugPanel({ comp, onActiveLine }: { comp: Compilation; onActiveLine?: (line: number | undefined) => void }) {
  const [st, setSt] = useState<{ dbg: Debugger | null; snap: DebugState | null }>(() => {
    const d = comp.ok && comp.program ? new Debugger(comp.program) : null;
    return { dbg: d, snap: d ? d.state() : null };
  });
  const { dbg, snap } = st;

  // Drive the editor's current-line highlight, and clear it on unmount.
  useEffect(() => {
    onActiveLine?.(snap && !snap.done && snap.line > 0 ? snap.line : undefined);
  }, [snap, onActiveLine]);
  useEffect(() => () => onActiveLine?.(undefined), [onActiveLine]);

  const reset = () => {
    if (comp.ok && comp.program) {
      const d = new Debugger(comp.program);
      setSt({ dbg: d, snap: d.state() });
    }
  };
  const step = () => {
    if (dbg) { dbg.step(); setSt({ dbg, snap: dbg.state() }); }
  };
  const run = () => {
    if (dbg) { dbg.runToEnd(); setSt({ dbg, snap: dbg.state() }); }
  };

  if (!snap) {
    return (
      <div className="panel-scroll run-panel">
        <p className="dim note">The program doesn’t compile yet — fix it on the left to start debugging.</p>
      </div>
    );
  }

  const current = snap.stack[snap.stack.length - 1];
  return (
    <div className="panel-scroll run-panel">
      <div className="run-controls">
        <button className="primary" onClick={step} disabled={snap.done}>▸ step</button>
        <button onClick={run} disabled={snap.done}>⏩ run to end</button>
        <button onClick={reset}>↺ restart</button>
        <span className="dim">
          {snap.steps} step{snap.steps === 1 ? '' : 's'}
          {snap.done ? ' · finished' : current ? ` · ${current.fn}() @ line ${snap.line}` : ''}
        </span>
        {snap.done && snap.result !== undefined && <span className="badge ok">main() → {snap.result}</span>}
        {snap.error && <span className="badge bad">trap: {snap.error}</span>}
      </div>

      <div className="dbg-cols">
        <div className="dbg-col">
          <div className="col-head">Call stack &amp; locals</div>
          {snap.stack.length === 0 && <p className="dim note">not running</p>}
          {snap.stack
            .slice()
            .reverse()
            .map((fr, i) => (
              <div key={i} className={'dbg-frame' + (i === 0 ? ' dbg-frame-cur' : '')}>
                <div className="dbg-frame-head">
                  <span className="mono">{fr.fn}()</span> <span className="dim">line {fr.line}</span>
                </div>
                {fr.vars.length === 0 ? (
                  <div className="dim dbg-novars">no locals yet</div>
                ) : (
                  <table className="dbg-vars">
                    <tbody>
                      {fr.vars.map((v) => (
                        <tr key={v.name}>
                          <td className="mono dbg-vname">{v.name}</td>
                          <td className="dim dbg-vty">{v.ty}</td>
                          <td className="mono dbg-vval">{v.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          {snap.globals.length > 0 && (
            <div className="dbg-frame">
              <div className="dbg-frame-head"><span className="dim">globals</span></div>
              <table className="dbg-vars">
                <tbody>
                  {snap.globals.map((v) => (
                    <tr key={v.name}>
                      <td className="mono dbg-vname">{v.name}</td>
                      <td className="dim dbg-vty">{v.ty}</td>
                      <td className="mono dbg-vval">{v.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="dbg-col">
          <div className="col-head">Output</div>
          <pre className="code-pre out-pre">{snap.output.join('\n') || '(no output yet)'}</pre>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Verify suite

export function VerifyPanel() {
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [busy, setBusy] = useState(false);
  const levels: OptLevel[] = [0, 1, 2, 3];
  // The example gallery plus the adversarial battery, each run at every level.
  const battery = TESTS.map((t) => ({ name: t.name, source: t.source }));
  const programs = [...TEST_PROGRAMS, ...battery];

  const run = async () => {
    setBusy(true);
    setResults([]);
    const acc: VerifyResult[] = [];
    await verifyAll(programs, levels, (r) => {
      acc.push(r);
      setResults([...acc]);
    });
    setBusy(false);
  };

  const pass = results.filter((r) => r.pass).length;
  const total = programs.length * levels.length;
  const titleOf = (id: string) => EXAMPLES.find((e) => e.id === id)?.title ?? id;

  const renderRows = (list: { name: string }[]) =>
    list.map((p) => (
      <tr key={p.name}>
        <td className="mono">{titleOf(p.name)}</td>
        {levels.map((lvl) => {
          const r = results.find((x) => x.name === p.name && x.level === lvl);
          return (
            <td key={lvl} className="cell-center">
              {r ? <span className={r.pass ? 'tick' : 'cross'} title={r.detail}>{r.pass ? '✓' : '✗'}</span> : '·'}
            </td>
          );
        })}
      </tr>
    ));

  return (
    <div className="panel-scroll verify-panel">
      <div className="run-controls">
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? 'verifying…' : `▶ run ${total} differential tests`}
        </button>
        {results.length > 0 && (
          <span className={'badge ' + (pass === results.length ? 'ok' : 'bad')}>
            {pass}/{results.length} pass
          </span>
        )}
      </div>
      <p className="dim note">
        Every program — the {TEST_PROGRAMS.length} examples plus a {battery.length}-program adversarial battery
        (wrapping arithmetic, signed div/rem, shifts, floats &amp; ∞, casts, inlining, LICM, globals, ternary,
        compound assignment, the full <b>string runtime</b>: literals, concat, equality, indexing, str()/char()…,
        the <b>transcendental math library</b> (exp/ln/sin/cos/pow/…, a shared Strata kernel) and the <b>f32</b>
        single-precision type)
        — is compiled at -O0…-O3, executed as WebAssembly, and its output compared to the reference interpreter.
        Identical output at every level is the proof that each optimization — and the string runtime, which is itself
        written in Strata and compiled the same way — is sound.
      </p>
      {results.length > 0 && (
        <table className="verify-table">
          <thead><tr><th>program</th><th>O0</th><th>O1</th><th>O2</th><th>O3</th></tr></thead>
          <tbody>
            <tr className="verify-group"><td colSpan={5}>examples</td></tr>
            {renderRows(TEST_PROGRAMS)}
            <tr className="verify-group"><td colSpan={5}>adversarial battery</td></tr>
            {renderRows(battery)}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ----------------------------------------------------------------

function Empty() {
  return <div className="panel-scroll dim note">Fix the errors in your program to see this stage.</div>;
}
