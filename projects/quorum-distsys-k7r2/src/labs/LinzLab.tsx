// The Linearizability Lab — a from-scratch linearizability checker you can watch
// decide. Feed it a hand-built textbook history, a randomly generated one, or a
// *real* ABD register run pulled live off the kernel; it renders the operations
// as a real-time space-time diagram and runs the Wing & Gong search to either
// certify the history with a concrete witness order or convict it with the
// operation that went back in time.
import { useMemo, useState } from 'react';
import {
  curatedHistories,
  genLinearizable,
  genAdversarial,
  type Curated,
} from '../linz/histories';
import { checkTimed, type LinzResult } from '../linz/checker';
import { SPECS, specById, type Spec } from '../linz/specs';
import { runAbdHistory } from '../linz/fromprotocol';
import { isPending, showOp, type History } from '../linz/history';

type Mode = 'curated' | 'random' | 'abd';

const MUTATORS = new Set(['write', 'cas', 'enq', 'push', 'inc', 'dec', 'add', 'remove', 'lock', 'unlock']);
const MUT_COLOR = '#7c9cff';
const OBS_COLOR = '#73e08a';
const BAD_COLOR = '#ff5d6c';

const CURATED = curatedHistories();

export function LinzLab() {
  const [mode, setMode] = useState<Mode>('curated');

  // curated selection
  const [curId, setCurId] = useState(CURATED[0].id);
  // random
  const [randSpec, setRandSpec] = useState('register');
  const [randSeed, setRandSeed] = useState(1);
  const [randN, setRandN] = useState(8);
  const [randKind, setRandKind] = useState<'lz' | 'adv'>('lz');
  // abd
  const [abdSeed, setAbdSeed] = useState(1);
  const [abdReplicas, setAbdReplicas] = useState(5);
  const [abdOps, setAbdOps] = useState(14);
  const [abdLoss, setAbdLoss] = useState(0);

  const curated: Curated = useMemo(() => CURATED.find((c) => c.id === curId) ?? CURATED[0], [curId]);

  const { history, spec } = useMemo((): { history: History; spec: Spec<unknown> } => {
    if (mode === 'curated') return { history: curated.history, spec: specById(curated.spec) };
    if (mode === 'random') {
      const sp = specById(randSpec);
      if (randKind === 'adv') {
        const a = genAdversarial(randSpec, randSeed, randN, 3);
        if (a) return { history: a.history, spec: sp };
        // Fall back to a linearizable one if no breaking corruption was found.
        return { history: genLinearizable(randSpec, randSeed, randN, 3, 3), spec: sp };
      }
      return { history: genLinearizable(randSpec, randSeed, randN, 3, 3), spec: sp };
    }
    return {
      history: runAbdHistory({ seed: abdSeed, replicas: abdReplicas, ops: abdOps, keys: ['x', 'y', 'z'], dropRate: abdLoss }),
      spec: specById('register'),
    };
  }, [mode, curated, randSpec, randSeed, randN, randKind, abdReplicas, abdOps, abdSeed, abdLoss]);

  const { result, elapsed } = useMemo(() => {
    const { result: r, elapsedMs } = checkTimed(history, spec);
    return { result: r, elapsed: elapsedMs };
  }, [history, spec]);

  const blameSet = useMemo(() => new Set(result.blame), [result.blame]);

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Linearizability · a checker you can watch decide</h2>
        <p>
          <b>Linearizability</b> is the gold-standard correctness condition for a concurrent object: every
          operation must appear to take effect <em>instantaneously at some single instant between its call and
          its return</em>, and the resulting sequential order must be legal for the object. Deciding it is{' '}
          <b>NP-complete</b> — yet a real checker stays fast by pruning to real-time-respecting orders and
          memoizing dead ends (the <b>Wing &amp; Gong</b> algorithm), and by checking each object independently
          (Herlihy &amp; Wing's <b>locality</b> theorem). This one is built from scratch, works for any
          sequential spec, and — when a history passes — hands back a concrete <b>witness order</b> you can
          re-check by hand; when it fails, it names the operation that <b>went back in time</b>.
        </p>
      </div>

      <div className="cluster-toolbar">
        <div className="ctl-group">
          <label>Source</label>
          <button className={`btn tiny ${mode === 'curated' ? 'on' : ''}`} onClick={() => setMode('curated')}>Textbook</button>
          <button className={`btn tiny ${mode === 'random' ? 'on' : ''}`} onClick={() => setMode('random')}>Random</button>
          <button className={`btn tiny ${mode === 'abd' ? 'on' : ''}`} onClick={() => setMode('abd')}>Live ABD run</button>
        </div>
      </div>

      {mode === 'curated' && (
        <div className="cluster-toolbar linz-curated">
          <div className="ctl-group" style={{ flexWrap: 'wrap' }}>
            <label>History</label>
            {CURATED.map((c) => (
              <button
                key={c.id}
                className={`btn tiny ${curId === c.id ? 'on' : ''}`}
                title={c.note}
                onClick={() => setCurId(c.id)}
              >
                {c.expected ? '✓' : '✕'} {c.label.replace(/^[^·]+· /, '')}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'random' && (
        <div className="cluster-toolbar">
          <div className="ctl-group">
            <label>Object</label>
            {SPECS.map((s) => (
              <button key={s.id} className={`btn tiny ${randSpec === s.id ? 'on' : ''}`} title={s.blurb} onClick={() => setRandSpec(s.id)}>
                {s.name.split(' ')[0]}
              </button>
            ))}
          </div>
          <div className="ctl-group">
            <label>Kind</label>
            <button className={`btn tiny ${randKind === 'lz' ? 'on' : ''}`} onClick={() => setRandKind('lz')}>linearizable</button>
            <button className={`btn tiny ${randKind === 'adv' ? 'on' : ''}`} onClick={() => setRandKind('adv')}>adversarial</button>
          </div>
          <div className="ctl-group">
            <label>Ops {randN}</label>
            <input type="range" min={3} max={14} value={randN} onChange={(e) => setRandN(Number(e.target.value))} />
          </div>
          <div className="ctl-group">
            <label>Seed</label>
            <button className="btn tiny" onClick={() => setRandSeed((s) => Math.max(1, s - 1))}>−</button>
            <code className="linz-seed">{randSeed}</code>
            <button className="btn tiny" onClick={() => setRandSeed((s) => s + 1)}>+</button>
          </div>
        </div>
      )}

      {mode === 'abd' && (
        <div className="cluster-toolbar">
          <div className="ctl-group">
            <label>Replicas</label>
            {[3, 5, 7].map((c) => (
              <button key={c} className={`btn tiny ${abdReplicas === c ? 'on' : ''}`} onClick={() => setAbdReplicas(c)}>{c}</button>
            ))}
          </div>
          <div className="ctl-group">
            <label>Ops {abdOps}</label>
            <input type="range" min={6} max={26} value={abdOps} onChange={(e) => setAbdOps(Number(e.target.value))} />
          </div>
          <div className="ctl-group">
            <label>Loss</label>
            {[0, 0.1, 0.25].map((l) => (
              <button key={l} className={`btn tiny ${abdLoss === l ? 'on' : ''}`} onClick={() => setAbdLoss(l)}>{Math.round(l * 100)}%</button>
            ))}
          </div>
          <div className="ctl-group">
            <label>Seed</label>
            <button className="btn tiny" onClick={() => setAbdSeed((s) => Math.max(1, s - 1))}>−</button>
            <code className="linz-seed">{abdSeed}</code>
            <button className="btn tiny" onClick={() => setAbdSeed((s) => s + 1)}>+</button>
          </div>
        </div>
      )}

      <div className="lab-grid">
        <div className="lab-main">
          <div className="linz-source-line">
            <span className="muted">checking</span> <b>{history.label}</b>{' '}
            <span className="muted">against the</span> <b>{spec.name}</b> <span className="muted">spec · {history.ops.length} ops</span>
          </div>
          {mode === 'curated' && <div className="linz-note">{curated.note}</div>}

          <SpaceTime history={history} spec={spec} blame={blameSet} />

          <Verdict result={result} elapsed={elapsed} spec={spec} history={history} />
        </div>

        <div className="lab-side">
          <SearchStatsPanel result={result} elapsed={elapsed} />

          <div className="lab-aux">
            <div className="panel-head"><span>What the checker does</span></div>
            <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)', lineHeight: 1.5 }}>
              It searches for a total order of the operations that is (1) <b>legal</b> for the sequential object
              and (2) <b>respects real time</b> — if A returned before B was called, A precedes B. It only ever
              tries an operation whose real-time predecessors are already placed, and it never re-expands a
              (remaining-ops, state) pair it has already refuted. That collapses the {history.ops.length}-operation
              search from up to {factorialish(history.ops.length)} interleavings to the{' '}
              <b>{result.stats.statesExplored.toLocaleString()}</b> states it actually touched.
            </div>
          </div>

          {mode === 'abd' && (
            <div className="lab-aux">
              <div className="panel-head"><span>Why this matters</span></div>
              <div className="lab-aux-body" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--tx-dim)', lineHeight: 1.5 }}>
                The ABD lab proves its register linearizable with Lamport's tag conditions — a shortcut only a
                register affords. Here a <b>general</b> checker, which knows nothing about tags, certifies the same
                real run. Two independent proofs agreeing is the strongest evidence both are right. Tamper with a
                read (flip a value) and this checker catches what the tag test, reading only tags, could miss.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Rough magnitude of n! for the explanatory blurb (kept compact).
function factorialish(n: number): string {
  if (n <= 1) return '1';
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  if (f < 1e6) return f.toLocaleString();
  const exp = Math.floor(Math.log10(f));
  return `~10^${exp}`;
}

// ---------------------------------------------------------------------------
// The space-time diagram: one lane per process, a bar per operation's
// [call, ret] interval, coloured by mutator/observer and outlined red if blamed.
// ---------------------------------------------------------------------------
function SpaceTime({ history, spec, blame }: { history: History; spec: Spec<unknown>; blame: Set<number> }) {
  const ops = history.ops;
  const procs = useMemo(() => Array.from(new Set(ops.map((o) => o.proc))).sort(), [ops]);
  const objs = useMemo(() => Array.from(new Set(ops.map((o) => o.obj ?? ''))).sort(), [ops]);
  const mutFs = useMemo(() => {
    const s = new Set<string>(MUTATORS);
    for (const sig of spec.ops) if (sig.kind === 'mutator') s.add(sig.f);
    return s;
  }, [spec]);

  const width = 760;
  const laneH = 46;
  const top = 14;
  const ml = 52;
  const mr = 16;
  const H = top * 2 + Math.max(1, procs.length) * laneH;

  const finiteRets = ops.map((o) => (isPending(o) ? o.call + 30 : o.ret));
  const minT = Math.min(0, ...ops.map((o) => o.call));
  const maxT = Math.max(minT + 1, ...finiteRets);
  const x = (t: number) => ml + ((t - minT) / (maxT - minT)) * (width - ml - mr);
  const laneY = (proc: string) => top + procs.indexOf(proc) * laneH + laneH / 2;
  const label = (op: (typeof ops)[number]) => (objs.length > 1 ? `${op.obj}:` : '') + showOp(op);

  // Stagger labels into two rows per lane so back-to-back operations don't
  // overprint each other (a busy coordinator issues many ops on one lane).
  const labelRow = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of procs) {
      const lane = ops.filter((o) => o.proc === p).sort((a, b) => a.call - b.call);
      const rowEnd = [-Infinity, -Infinity];
      for (const o of lane) {
        const x1 = Math.max(x(o.call) + 26, x(isPending(o) ? o.call + 30 : o.ret));
        const cx = (x(o.call) + x1) / 2;
        const w = label(o).length * 6.0;
        const left = cx - w / 2;
        const row = left < rowEnd[0] + 4 ? 1 : 0;
        m.set(o.id, row);
        rowEnd[row] = cx + w / 2;
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, procs, objs]);

  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>Space-time history</span>
        <span className="muted">each bar = one operation’s real-time span · ▮ call &nbsp; ▯ return</span>
      </div>
      <div className="depgraph-scroll">
        <svg width={width} height={H} className="depgraph-svg" role="img">
          {procs.map((p, i) => (
            <g key={p}>
              <line x1={ml} y1={top + i * laneH + laneH / 2} x2={width - mr} y2={top + i * laneH + laneH / 2} stroke="rgba(120,130,150,0.16)" />
              <text x={10} y={top + i * laneH + laneH / 2 + 4} fill="var(--tx-dim)" fontSize={12} fontFamily="ui-monospace, monospace" fontWeight={700}>{p}</text>
            </g>
          ))}
          {ops.map((o) => {
            const y = laneY(o.proc);
            const x0 = x(o.call);
            const x1 = Math.max(x0 + 26, x(isPending(o) ? o.call + 30 : o.ret));
            const isMut = mutFs.has(o.f);
            const blamed = blame.has(o.id);
            const color = blamed ? BAD_COLOR : isMut ? MUT_COLOR : OBS_COLOR;
            return (
              <g key={o.id}>
                <line x1={x0} y1={y} x2={x1} y2={y} stroke={color} strokeWidth={blamed ? 3.5 : 2.5} opacity={blamed ? 1 : 0.85} />
                <rect x={x0 - 1.5} y={y - 6} width={3} height={12} fill={color} />
                <rect x={x1 - 1.5} y={y - 6} width={3} height={12} fill="none" stroke={color} strokeWidth={1.5} />
                <text x={(x0 + x1) / 2} y={y - (labelRow.get(o.id) === 1 ? 22 : 10)} textAnchor="middle" fontSize={10.5} fontFamily="ui-monospace, monospace" fill={blamed ? BAD_COLOR : 'var(--tx)'} fontWeight={blamed ? 700 : 500}>
                  {label(o)}
                </text>
                <title>{`${o.proc}: ${showOp(o)}  [${o.call}, ${isPending(o) ? '∞' : o.ret}]${blamed ? '  ← blamed' : ''}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="depgraph-foot muted">
        <span style={{ color: MUT_COLOR }}>▬ mutator</span> &nbsp; <span style={{ color: OBS_COLOR }}>▬ observer</span>
        {blame.size > 0 && <> &nbsp; <span style={{ color: BAD_COLOR }}>▬ blamed (remove it ⇒ linearizable)</span></>}
        {objs.length > 1 && <> &nbsp;·&nbsp; {objs.length} independent objects, checked separately by locality</>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict + witness / counterexample.
// ---------------------------------------------------------------------------
function Verdict({ result, spec, history }: { result: LinzResult; elapsed: number; spec: Spec<unknown>; history: History }) {
  if (result.timedOut) {
    return (
      <div className="linz-verdict warn">
        <div className="linz-verdict-head">⏳ Search budget exhausted</div>
        <div className="linz-verdict-body">This history is too large to decide within the node budget. Try fewer operations.</div>
      </div>
    );
  }

  if (result.linearizable) {
    return (
      <div className="linz-verdict ok">
        <div className="linz-verdict-head">✅ Linearizable</div>
        <div className="linz-verdict-body">
          A legal sequential order exists that respects real time. Witness{result.parts.length > 1 ? 'es' : ''} below — apply each operation in order to the model and every response matches.
        </div>
        {result.parts.map((p) => (
          <div key={p.obj} className="linz-witness">
            {result.parts.length > 1 && <div className="linz-witness-obj">object “{p.obj}”</div>}
            <table className="linz-table">
              <thead><tr><th>#</th><th>op</th><th>state</th><th>→</th></tr></thead>
              <tbody>
                {p.witness?.map((s, i) => (
                  <tr key={i}>
                    <td className="linz-step">{i + 1}</td>
                    <td className="linz-op"><span className="linz-proc">{s.op.proc}</span> {showOp(s.op)}</td>
                    <td className="linz-state">{s.before}</td>
                    <td className="linz-state-after">{s.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    );
  }

  const blamed = history.ops.filter((o) => result.blame.includes(o.id));
  return (
    <div className="linz-verdict bad">
      <div className="linz-verdict-head">❌ Not linearizable</div>
      <div className="linz-verdict-body">
        No ordering of these operations is both legal for the <b>{spec.name}</b> and consistent with real time —
        some operation observed a value that no valid history allows.
      </div>
      {blamed.length > 0 ? (
        <div className="linz-blame">
          <div className="linz-blame-head">Counterexample — removing {blamed.length === 1 ? 'this operation' : 'any one of these'} makes the rest linearizable:</div>
          <ul>
            {blamed.map((o) => (
              <li key={o.id}><span className="linz-proc">{o.proc}</span> <code>{showOp(o)}</code> <span className="muted">[{o.call}, {isPending(o) ? '∞' : o.ret}]</span></li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="linz-blame"><div className="linz-blame-head muted">No single operation explains the violation — it arises from the combination.</div></div>
      )}
    </div>
  );
}

function SearchStatsPanel({ result, elapsed }: { result: LinzResult; elapsed: number }) {
  const s = result.stats;
  const rows: [string, string][] = [
    ['operations', String(s.ops)],
    ['objects (locality split)', String(result.parts.length)],
    ['search nodes', s.statesExplored.toLocaleString()],
    ['memo prunes', s.memoHits.toLocaleString()],
    ['ops applied', s.candidatesTried.toLocaleString()],
    ['max depth', String(s.maxDepth)],
    ['decided in', `${elapsed < 1 ? '<1' : elapsed.toFixed(1)} ms`],
  ];
  return (
    <div className="lab-aux">
      <div className="panel-head">
        <span>Search</span>
        <span className={result.linearizable ? 'leader-pill has' : 'leader-pill'}>{result.timedOut ? 'budget hit' : result.linearizable ? 'linearizable' : 'violation'}</span>
      </div>
      <div className="lab-aux-body">
        {rows.map(([k, v]) => (
          <div key={k} className="replica-row"><span className="replica-id">{k}</span><code className="replica-val">{v}</code></div>
        ))}
      </div>
    </div>
  );
}
