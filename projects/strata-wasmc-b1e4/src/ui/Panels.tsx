import { useEffect, useRef, useState } from 'react';
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
import { analyzeLoops } from '../compiler/loopAnalysis';
import type { LoopFact } from '../compiler/loopAnalysis';
import { EXAMPLES, TEST_PROGRAMS } from '../examples';
import { TESTS } from '../compiler/tests';
import { decodeModule } from '../wasm/decode';
import { WasmVM } from '../wasm/vm';
import type { VMState } from '../wasm/vm';

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
        copy-propagation → sparse conditional constant propagation → devirtualization →
        {comp.level >= 2 ? ' full loop unrolling (induction-variable + trip-count analysis) →' : ''}
        {' '}if-conversion → strength reduction (incl. division-by-constant) → <b>SROA</b>
        (escape analysis + scalar replacement of aggregates: a non-escaping record is promoted out
        of memory into SSA values via dominance-frontier phi insertion) → memory optimization
        (alias-based store→load forwarding, redundant-load &amp; dead-store elimination, with distinct
        allocations proven disjoint) →
        {comp.level >= 2 ? ' global value numbering (CSE) →' : ''}
        {comp.level >= 2 ? ' operator strength reduction on induction variables (loop `i*stride` → a running add) →' : ''} algebraic simplification →
        {comp.level >= 2 ? ' loop-invariant code motion →' : ''} dead-code elimination → CFG
        simplification (block coalescing), iterated to a fixed point
        {comp.level >= 2 ? ', then partial loop unrolling (unroll-by-K + remainder loop, for the runtime- and large-trip loops full unrolling declines) and a cleanup round' : ''}
        {comp.level >= 2 ? ', then CFG cleanup + dead-function elimination' : ''}.
        The backend then <b>stackifies</b> — folding single-use pure values onto the wasm operand
        stack so they never need a local. {snaps.length > 0 && 'Click a pass to see exactly what it rewrote.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Loops

export function LoopsPanel({ comp, fnIdx }: { comp: Compilation; fnIdx: number }) {
  if (!comp.ssa || !comp.optimized) return <Empty />;
  const ssaFn = comp.ssa.funcs[fnIdx];
  const optFn = comp.optimized.funcs[fnIdx];
  if (!ssaFn) return <div className="panel-scroll dim note">no function</div>;
  const before = analyzeLoops(ssaFn);
  const after = optFn ? analyzeLoops(optFn) : [];
  const stat = comp.optLog?.find((s) => s.name === 'partial-unroll');
  const strided = after.filter((l) => l.kind === 'strided-main').length;

  return (
    <div className="panel-scroll loops-panel">
      <div className="loops-summary">
        <span className="loops-stat"><b>{before.length}</b> loop{before.length === 1 ? '' : 's'} in SSA</span>
        <span className="loops-arrow">→</span>
        <span className="loops-stat"><b>{after.length}</b> after -O{comp.level}</span>
        {comp.level >= 2 && (
          <span className="loops-stat dim">
            full-unrolled {Math.max(0, before.length - after.length + strided)} · partial-strided {strided}
            {stat ? ` (pass ×${stat.changed})` : ''}
          </span>
        )}
      </div>

      <LoopTable title={`SSA IR — ${ssaFn.name}()`} facts={before} />
      {optFn && <LoopTable title={`Optimized (-O${comp.level}) — ${optFn.name}()`} facts={after} />}

      <div className="loops-legend">
        <b>What you're seeing.</b> A <i>counted</i> loop is a header phi
        {' '}<code>i = [init, i ± c]</code> tested against a loop-invariant bound — the shape both
        unrollers recognise. When the trip count is a small constant, <b>full unrolling</b> peels the
        loop away entirely (it vanishes from the optimized column). When the bound is a
        <i> runtime</i> value or too large, <b>partial unrolling</b> (-O2+) prepends a
        {' '}<i>strided main loop</i> — its exit test is an exact, overflow-blind
        {' '}<code>K more iterations?</code> guard — and reuses the original loop untouched as the
        {' '}<i>remainder</i>. So a single runtime <code>for</code> becomes a strided-main loop plus a
        counted remainder here.
      </div>
    </div>
  );
}

function LoopTable({ title, facts }: { title: string; facts: LoopFact[] }) {
  return (
    <div className="loop-block">
      <div className="loop-block-title mono">{title}</div>
      {facts.length === 0 ? (
        <div className="dim note">no loops</div>
      ) : (
        <table className="loop-table">
          <thead>
            <tr>
              <th>header</th><th>depth</th><th>kind</th><th>induction</th><th>bound</th><th>trip</th><th>blocks</th><th>insts</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.header} className={f.kind === 'strided-main' ? 'loop-strided' : f.kind === 'counted' ? 'loop-counted' : ''}>
                <td className="mono">b{f.header}{f.depth > 1 ? <span className="dim"> ⟂b{f.parent}</span> : null}</td>
                <td className="num">{f.depth}</td>
                <td><span className={'loop-pill loop-pill-' + f.kind}>{f.kind}</span></td>
                <td className="mono">{f.iv ? <>{f.iv} <span className="dim">{f.init !== undefined ? `= ${f.init}` : ''} {f.step ?? ''}</span></> : <span className="dim">—</span>}</td>
                <td className="mono">{f.pred ?? <span className="dim">—</span>}</td>
                <td className="num">{f.trip !== undefined ? f.trip : <span className="dim">runtime</span>}</td>
                <td className="num">{f.bodyBlocks}</td>
                <td className="num">{f.bodyInsts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

// ---------------------------------------------------------------- WASM VM (time-travel)

// The from-scratch WebAssembly VM, driven interactively. It decodes the very
// bytes the backend emitted and single-steps them on a hand-written stack
// machine, exposing the operand stack, locals, globals, linear memory and call
// stack as the real bytecode executes. Time-travel (step back) is implemented by
// re-running from the start to the previous instruction — the machine is
// deterministic, so the replay is exact.
const VM_RUN_CAP = 2_000_000;

function buildVM(comp: Compilation): { mod: ReturnType<typeof decodeModule>; vm: WasmVM } | null {
  if (!comp.ok || !comp.bytes) return null;
  try {
    const mod = decodeModule(comp.bytes);
    return { mod, vm: new WasmVM(mod) };
  } catch {
    return null;
  }
}

export function WasmVmPanel({ comp }: { comp: Compilation }) {
  const [st, setSt] = useState<{ built: ReturnType<typeof buildVM>; snap: VMState | null }>(() => {
    const built = buildVM(comp);
    return { built, snap: built ? built.vm.state() : null };
  });
  const { built, snap } = st;
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Keep the executing instruction in view as we step.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [snap]);

  const refresh = (b: ReturnType<typeof buildVM>) => setSt({ built: b, snap: b ? b.vm.state() : null });
  const rebuildTo = (target: number) => {
    if (!built) return;
    const vm = new WasmVM(built.mod);
    let n = 0;
    while (vm.steps < target && !vm.halted && n++ < VM_RUN_CAP) vm.step();
    refresh({ mod: built.mod, vm });
  };
  const step = (k = 1) => {
    if (!built) return;
    for (let i = 0; i < k && !built.vm.halted; i++) built.vm.step();
    refresh(built);
  };
  const run = () => {
    if (!built) return;
    built.vm.runToEnd(VM_RUN_CAP);
    refresh(built);
  };
  const restart = () => refresh(buildVM(comp));
  const stepBack = () => snap && rebuildTo(Math.max(0, snap.steps - 1));

  if (!snap) {
    return (
      <div className="panel-scroll run-panel">
        <p className="dim note">The program doesn’t compile yet — fix it on the left to run it on the from-scratch VM.</p>
      </div>
    );
  }

  const cur = snap.frames[snap.frames.length - 1];
  return (
    <div className="panel-scroll run-panel">
      <div className="run-controls">
        <button className="primary" onClick={() => step(1)} disabled={snap.halted}>▸ step</button>
        <button onClick={() => step(10)} disabled={snap.halted}>▸▸ 10×</button>
        <button onClick={stepBack} disabled={snap.steps === 0}>◂ back</button>
        <button onClick={run} disabled={snap.halted}>⏩ run</button>
        <button onClick={restart}>↺ restart</button>
        <span className="dim">
          {snap.steps} instr{snap.steps === 1 ? '' : 's'}
          {snap.halted ? ' · halted' : cur ? ` · ${cur.funcName}() pc ${cur.pc}` : ''}
        </span>
        {snap.halted && snap.result !== undefined && <span className="badge ok">main() → {snap.result}</span>}
        {snap.trap && <span className="badge bad">trap: {snap.trap}</span>}
      </div>
      <p className="dim note vm-blurb">
        This is the project’s own <b>from-scratch WebAssembly virtual machine</b> — it decodes the bytes on the
        Bytes tab and executes them one instruction at a time. The same engine cross-checks every Verify run, so
        V8, the reference interpreter and this VM are proven to agree.
      </p>

      <div className="vm-grid">
        <div className="vm-disasm">
          <div className="col-head">{cur ? `${cur.funcName}() — disassembly` : 'disassembly'}</div>
          <div className="vm-listing">
            {cur ? cur.lines.map((ln, i) => (
              <div
                key={i}
                ref={i === cur.pc ? activeRef : null}
                className={'vm-line' + (i === cur.pc ? ' vm-line-cur' : '')}
              >
                <span className="vm-pc">{i.toString().padStart(3, ' ')}</span>
                <span className="vm-code">{ln}</span>
              </div>
            )) : <div className="dim note">no active frame</div>}
          </div>
        </div>

        <div className="vm-side">
          <div className="vm-box">
            <div className="col-head">Operand stack {cur && <span className="dim">(top first)</span>}</div>
            {cur && cur.stack.length > 0 ? (
              <table className="dbg-vars">
                <tbody>
                  {cur.stack.slice().reverse().map((slot, i) => (
                    <tr key={i}>
                      <td className="dim dbg-vty">{i === 0 ? '↑ top' : ''}</td>
                      <td className="dim dbg-vty">{slot.ty}</td>
                      <td className="mono dbg-vval">{slot.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="dim dbg-novars">empty</div>}
          </div>

          <div className="vm-box">
            <div className="col-head">Locals</div>
            {cur && cur.locals.length > 0 ? (
              <table className="dbg-vars">
                <tbody>
                  {cur.locals.map((slot, i) => (
                    <tr key={i}>
                      <td className="mono dbg-vname">{i}</td>
                      <td className="dim dbg-vty">{slot.ty}</td>
                      <td className="mono dbg-vval">{slot.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="dim dbg-novars">none</div>}
          </div>

          <div className="vm-box">
            <div className="col-head">Call stack</div>
            <div className="vm-callstack">
              {snap.frames.slice().reverse().map((fr, i) => (
                <div key={i} className={'vm-csframe' + (i === 0 ? ' vm-csframe-cur' : '')}>
                  <span className="mono">{fr.funcName}()</span> <span className="dim">pc {fr.pc}</span>
                </div>
              ))}
            </div>
          </div>

          {snap.globals.length > 0 && (
            <div className="vm-box">
              <div className="col-head">Globals</div>
              <table className="dbg-vars">
                <tbody>
                  {snap.globals.map((slot, i) => (
                    <tr key={i}>
                      <td className="mono dbg-vname">{i}</td>
                      <td className="dim dbg-vty">{slot.ty}</td>
                      <td className="mono dbg-vval">{slot.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="vm-grid vm-grid-low">
        <div className="vm-box">
          <div className="col-head">Linear memory {snap.memUsed > 0 && <span className="dim">({snap.memUsed} B used)</span>}</div>
          <pre className="code-pre hex-pre vm-mem">{memDump(snap.memory, snap.memUsed)}</pre>
        </div>
        <div className="vm-box">
          <div className="col-head">Output</div>
          <pre className="code-pre out-pre">{snap.output.join('\n') || '(no output yet)'}</pre>
        </div>
      </div>
    </div>
  );
}

function memDump(mem: Uint8Array, used: number): string {
  if (used === 0) return '(memory is empty)';
  const limit = Math.min(used, 512);
  const rows: string[] = [];
  for (let i = 0; i < limit; i += 16) {
    const slice = mem.subarray(i, Math.min(i + 16, limit));
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    rows.push(`${i.toString(16).padStart(5, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (used > limit) rows.push(`…  (${used - limit} more bytes)`);
  return rows.join('\n');
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
        (wrapping arithmetic, signed div/rem, shifts, floats &amp; ∞, casts, inlining, LICM, <b>loop unrolling</b>
        (counted/nested/reverse-step/<code>long</code> IVs, plus the loops that must <em>not</em> unroll),
        <b>operator strength reduction</b> (an induction-variable <code>i*r</code>/<code>i&lt;&lt;k</code> reduced to a
        running add — basic/decrementing/multi-candidate/<code>long</code>/array-addressing/wraparound cases), globals, ternary,
        compound assignment, the full <b>string runtime</b>: literals, concat, equality, indexing, str()/char()…,
        the <b>transcendental math library</b> (exp/ln/sin/cos/pow/…, a shared Strata kernel), the <b>f32</b>
        single-precision type, <b>128-bit SIMD vectors</b> (int4/float4/long2/double2 — elementwise arithmetic,
        lanes, hsum, compare→mask + vselect, int↔float convert, all lowering to wasm <code>v128</code> ops),
        <b>SROA</b> (escape analysis promoting non-escaping records out of memory —
        local, branch-merged, loop-carried, aliased, mixed-width and escape-boundary cases), and
        <b>memory optimization</b> (store→load forwarding, redundant-load &amp;
        dead/silent-store elimination — with the aliasing, call-barrier and branch-merge cases that must stay conservative))
        — is compiled at -O0…-O3 and run by <b>three independent engines</b>: the host’s <code>WebAssembly</code> (V8),
        the tree-walking reference interpreter, and the project’s <b>own from-scratch WebAssembly VM</b> (which decodes
        and executes the assembled bytes on a hand-written stack machine). A ✓ means all three printed the
        <em>exact</em> same output — a far stronger proof than two engines agreeing that each optimization, and the
        string runtime (itself written in Strata and compiled the same way), is sound.
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
