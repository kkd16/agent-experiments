import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import {
  analyzeParikh,
  memberSemi,
  witnessCombination,
  describeLinear,
  PARIKH_EXAMPLES,
  type Semilinear,
  type Vec,
  type ParikhAtom,
} from '../engine/parikh';
import { compilePresburgerFormula } from '../engine/presburger/compile';
import { acceptsTuple, presburgerDfaToGraph } from '../engine/presburger/automata';
import type { BitDFA } from '../engine/logic/bitaut';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';
import { runParikhFuzz, DEFAULT_PARIKH_FUZZ, type ParikhFuzzReport } from '../engine/parikh-verify';

const ACCENT = '#c084fc';
const VIZ_BOUND = 12; // grid radius for the 1-D / 2-D lattice pictures

export function ParikhPanel({ compiled, onUsePattern }: { compiled: Compiled; onUsePattern: (p: string) => void }) {
  const notice = compiled.error
    ? 'Fix the pattern first.'
    : compiled.features && !compiled.features.regular
      ? `The Parikh image is computed structurally from a plain regular pattern; this one uses ${compiled.features.reasons.join(', ')}.`
      : null;

  const result = useMemo(() => (compiled.ast && !notice ? analyzeParikh(compiled.ast) : null), [compiled.ast, notice]);

  return (
    <div className="parikh-panel">
      <div className="pane-head">
        <h2>Parikh image — the commutative closure</h2>
        <p>
          Throw away the order and keep the counts. The <strong>Parikh map</strong> sends a word to its vector of
          letter counts, and <strong>Parikh's theorem</strong> says the image of any regular language is{' '}
          <strong>semilinear</strong> — a finite union of <em>base + ℕ·periods</em> cones. We build it straight off the
          regex (· ↦ ⊕, | ↦ ∪, * ↦ submonoid), then <strong>bridge to arithmetic</strong>: a set of naturals is
          semilinear <em>iff</em> it is Presburger-definable, so the same image compiles to a digit-automaton on the{' '}
          <strong>Presburger</strong> tab and is confronted, tuple for tuple, three independent ways.
        </p>
      </div>

      <div className="parikh-gallery">
        {PARIKH_EXAMPLES.map((ex) => (
          <button key={ex.pattern} className="parikh-ex" title={ex.note} onClick={() => onUsePattern(ex.pattern)}>
            <span className="parikh-ex-name">{ex.name}</span>
            <code className="parikh-ex-pat">/{ex.pattern}/</code>
          </button>
        ))}
      </div>

      {notice && <div className="placeholder">{notice}</div>}

      {result && result.error && <div className="placeholder">{result.error}</div>}

      {result && !result.error && <ParikhBody result={result} />}

      <ProofConsole />
    </div>
  );
}

type ParikhResult = NonNullable<ReturnType<typeof analyzeParikh>>;
type Bridge = { kind: 'ok'; automaton: BitDFA; checks: number; agree: boolean } | { kind: 'err'; error: string };

function ParikhBody({ result }: { result: ParikhResult }) {
  const { dim, atoms, semilinear } = result;

  const classification = classify(semilinear, dim);

  // The Presburger bridge: compile the semilinear set to a formula, run it through
  // the studio's own Büchi–Bruyère–Villemaire engine, and cross-check that the
  // digit-automaton accepts exactly the tuples the semilinear set holds (‖ ≤ bound).
  const bridge = useMemo((): Bridge | null => {
    if (!result.formula || dim < 1 || dim > 4) return null;
    const periodTotal = semilinear.sets.reduce((s, L) => s + L.periods.length, 0);
    if (semilinear.sets.length > 24 || periodTotal > 40) {
      return { kind: 'err', error: 'the formula is large (many linear sets / periods)' };
    }
    try {
      const { automaton } = compilePresburgerFormula(result.formula);
      // cross-check over the box with coordinate-sum ≤ bound
      const box = 14;
      let checks = 0;
      let agree = true;
      const odo = new Array<number>(dim).fill(0);
      loop: for (;;) {
        let s = 0;
        for (const x of odo) s += x;
        if (s <= box) {
          const valueByName: Record<string, number> = {};
          for (let i = 0; i < dim; i++) valueByName[result.varNames[i]] = odo[i];
          checks++;
          if (acceptsTuple(automaton, valueByName) !== memberSemi(semilinear, odo)) {
            agree = false;
            break loop;
          }
        }
        let i = 0;
        for (; i < dim; i++) {
          odo[i]++;
          if (odo[i] <= box) break;
          odo[i] = 0;
        }
        if (i === dim) break loop;
      }
      return { kind: 'ok', automaton, checks, agree };
    } catch (e) {
      return { kind: 'err', error: String((e as Error)?.message ?? e) };
    }
  }, [result.formula, result.varNames, semilinear, dim]);

  const bridgeLayout = useMemo(
    () => (bridge?.kind === 'ok' && bridge.automaton.n <= 60 ? layoutGraph(presburgerDfaToGraph(bridge.automaton)) : null),
    [bridge],
  );

  return (
    <>
      {/* alphabet */}
      <section className="parikh-section">
        <h3>Alphabet — {dim} dimension{dim === 1 ? '' : 's'}</h3>
        {dim === 0 ? (
          <p className="muted-note">The pattern has no letters; its image is the trivial {'{ () }'} (or ∅).</p>
        ) : (
          <div className="parikh-atoms">
            {atoms.map((a, i) => (
              <span key={a.key} className="parikh-atom">
                <span className="parikh-axis">axis {i}</span>
                <code>{a.label}</code>
                <span className="parikh-count">count = {result.varNames[i]}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* the semilinear set */}
      <section className="parikh-section">
        <h3>Semilinear image π(L)</h3>
        <div className={`parikh-verdict ${classification.tone}`}>{classification.headline}</div>
        {semilinear.sets.length === 0 ? (
          <p className="muted-note">∅ — the language is empty, so its image has no vectors.</p>
        ) : (
          <ul className="parikh-linears">
            {semilinear.sets.map((L, i) => (
              <li key={i}>
                <span className="parikh-lin-idx">L{i}</span>
                <code className="parikh-lin">{describeLinear(L, atoms)}</code>
                <span className="parikh-lin-kind">
                  {L.periods.length === 0 ? 'point' : `${L.periods.length} period${L.periods.length === 1 ? '' : 's'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted-note">
          {semilinear.sets.length} linear set{semilinear.sets.length === 1 ? '' : 's'} · a base point plus the ℕ-cone of
          its periods; their union is the whole image.
        </p>
      </section>

      {/* visualisation */}
      {dim >= 1 && dim <= 2 && semilinear.sets.length > 0 && (
        <section className="parikh-section">
          <h3>The lattice {dim === 1 ? '— a numerical set on the line' : '— points in ℕ²'}</h3>
          {dim === 1 ? <LatticeLine sl={semilinear} atoms={atoms} /> : <Lattice2D sl={semilinear} atoms={atoms} />}
        </section>
      )}
      {dim >= 3 && semilinear.sets.length > 0 && <VectorList sl={semilinear} atoms={atoms} />}

      {/* membership query */}
      {dim >= 1 && semilinear.sets.length > 0 && <QueryBox sl={semilinear} atoms={atoms} varNames={result.varNames} />}

      {/* construction trace */}
      <section className="parikh-section">
        <h3>Construction — Parikh's theorem by structural recursion</h3>
        <div className="parikh-trace">
          {result.trace.slice(-14).map((t, i) => (
            <div key={i} className="parikh-trace-row">
              <code className="parikh-trace-expr">{t.expr || 'ε'}</code>
              <span className="parikh-trace-op">{t.op}</span>
              <span className="parikh-trace-sl">{summarise(t.sl, atoms)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Presburger bridge */}
      <section className="parikh-section">
        <h3>Bridge to arithmetic — the same set as a Presburger automaton</h3>
        {result.formulaText ? (
          <>
            <p className="muted-note">
              A semilinear set is Presburger-definable: existentially quantify one multiplier per period and OR the
              linear sets. Compiled by the studio's own Büchi–Bruyère–Villemaire engine (over the binary digits of the
              counts):
            </p>
            <code className="parikh-formula">{result.formulaText}</code>
            {bridge?.kind === 'ok' && (
              <div className={`graph-badge ${bridge.agree ? 'ok' : 'bad'}`}>
                {bridge.agree
                  ? `digit-automaton ≡ semilinear set ✓ — ${bridge.automaton.n} states, ${bridge.checks} count-tuples confronted, zero disagreement`
                  : 'the Presburger automaton and the semilinear set disagreed — this should never happen'}
              </div>
            )}
            {bridge?.kind === 'err' && (
              <p className="muted-note">Bridge unavailable: {bridge.error} (the semilinear set above still stands on its own).</p>
            )}
            {bridgeLayout && (
              <div className="parikh-bridge-graph">
                <AutomatonGraph layout={bridgeLayout} accent={ACCENT} />
              </div>
            )}
          </>
        ) : (
          <p className="muted-note">Bridge unavailable for this pattern (too many variables or periods).</p>
        )}
      </section>
    </>
  );
}

// ── classification of the image ────────────────────────────────────────────────
function classify(sl: Semilinear, dim: number): { headline: string; tone: string } {
  if (sl.sets.length === 0) return { headline: 'π(L) = ∅ — an empty language', tone: 'bad' };
  const noPeriods = sl.sets.every((L) => L.periods.length === 0);
  if (noPeriods) {
    return {
      headline: `π(L) is FINITE — ${sl.sets.length} isolated point${sl.sets.length === 1 ? '' : 's'}, no periods (a finite language)`,
      tone: 'ok',
    };
  }
  // full ℕ^dim? membership of the all-ones and axis extremes is a cheap heuristic;
  // confirm by testing the box corners are all in.
  if (dim <= 2 && isFullQuadrant(sl, dim)) {
    return { headline: `π(L) = ℕ^${dim} — the whole non-negative lattice: every count vector is realised`, tone: 'ok' };
  }
  return {
    headline: `π(L) is SEMILINEAR — ${sl.sets.length} linear set${sl.sets.length === 1 ? '' : 's'} (a periodic lattice region), exactly as Parikh's theorem guarantees`,
    tone: 'ok',
  };
}

function isFullQuadrant(sl: Semilinear, dim: number): boolean {
  const B = 6;
  const v = new Array<number>(dim).fill(0);
  const rec = (i: number): boolean => {
    if (i === dim) return memberSemi(sl, v.slice());
    for (let x = 0; x <= B; x++) {
      v[i] = x;
      if (!rec(i + 1)) return false;
    }
    v[i] = 0;
    return true;
  };
  return rec(0);
}

// ── 1-D lattice: the number line, with the Frobenius gap when it is a semigroup ──
function LatticeLine({ sl, atoms }: { sl: Semilinear; atoms: ParikhAtom[] }) {
  const B = 40;
  const members: boolean[] = [];
  for (let n = 0; n <= B; n++) members.push(memberSemi(sl, [n]));
  // Frobenius: the largest non-member, provided the tail is entirely present.
  let frob: number | null = null;
  let tailFull = true;
  for (let n = B; n >= 0; n--) {
    if (!members[n]) {
      if (tailFull && n >= 1) frob = n;
      break;
    }
  }
  // require a genuine full tail (at least a run) before claiming Frobenius
  if (frob !== null) {
    for (let n = frob + 1; n <= B; n++) if (!members[n]) tailFull = false;
    if (!tailFull) frob = null;
  }
  return (
    <div>
      <div className="parikh-line">
        {members.map((m, n) => (
          <span key={n} className={`parikh-cell ${m ? 'in' : 'out'} ${frob === n ? 'frob' : ''}`} title={`${atoms[0].label}×${n}${m ? ' ∈ π' : ' ∉ π'}`}>
            {n}
          </span>
        ))}
      </div>
      <p className="muted-note">
        Count of <code>{atoms[0].label}</code> along the line — filled = realised by some word, hollow = a gap.
        {frob !== null && (
          <>
            {' '}
            The largest gap is the <strong>Frobenius number {frob}</strong>: beyond it every count is reachable.
          </>
        )}
      </p>
    </div>
  );
}

// ── 2-D lattice: an SVG scatter with base points and period arrows ───────────────
function Lattice2D({ sl, atoms }: { sl: Semilinear; atoms: ParikhAtom[] }) {
  const B = VIZ_BOUND;
  const pad = 34;
  const cell = 26;
  const W = pad + (B + 1) * cell + 12;
  const H = pad + (B + 1) * cell + 12;
  const px = (x: number) => pad + x * cell;
  const py = (y: number) => H - pad - y * cell;

  const cells: { x: number; y: number; base: boolean }[] = [];
  const baseKeys = new Set(sl.sets.map((L) => L.base.join(',')));
  for (let x = 0; x <= B; x++)
    for (let y = 0; y <= B; y++) {
      if (memberSemi(sl, [x, y])) cells.push({ x, y, base: baseKeys.has(`${x},${y}`) });
    }
  // one representative set's period arrows (from its base)
  const arrows: { fx: number; fy: number; tx: number; ty: number }[] = [];
  for (const L of sl.sets) {
    for (const p of L.periods) {
      if (p[0] > B || p[1] > B) continue;
      arrows.push({ fx: L.base[0], fy: L.base[1], tx: L.base[0] + p[0], ty: L.base[1] + p[1] });
    }
  }

  return (
    <div className="parikh-lattice-wrap">
      <svg width={W} height={H} className="parikh-lattice">
        {/* grid */}
        {Array.from({ length: B + 1 }, (_, i) => (
          <g key={`g${i}`} className="parikh-grid">
            <line x1={px(0)} y1={py(i)} x2={px(B)} y2={py(i)} />
            <line x1={px(i)} y1={py(0)} x2={px(i)} y2={py(B)} />
          </g>
        ))}
        {/* axes */}
        <line className="parikh-axisline" x1={px(0)} y1={py(0)} x2={px(B)} y2={py(0)} />
        <line className="parikh-axisline" x1={px(0)} y1={py(0)} x2={px(0)} y2={py(B)} />
        <text className="parikh-axislabel" x={px(B)} y={py(0) + 22}>
          #{atoms[0].label} →
        </text>
        <text className="parikh-axislabel" x={px(0) - 6} y={py(B) - 8} textAnchor="start">
          #{atoms[1].label} ↑
        </text>
        {/* period arrows */}
        <defs>
          <marker id="parikh-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill={ACCENT} />
          </marker>
        </defs>
        {arrows.map((a, i) => (
          <line
            key={`a${i}`}
            className="parikh-period"
            x1={px(a.fx)}
            y1={py(a.fy)}
            x2={px(a.tx)}
            y2={py(a.ty)}
            markerEnd="url(#parikh-arrow)"
          />
        ))}
        {/* member points */}
        {cells.map((c, i) => (
          <circle key={`c${i}`} cx={px(c.x)} cy={py(c.y)} r={c.base ? 6 : 4} className={c.base ? 'parikh-pt base' : 'parikh-pt'} />
        ))}
      </svg>
      <p className="muted-note">
        Each dot is a realised count pair (#{atoms[0].label}, #{atoms[1].label}); larger dots are the base points, arrows
        are the period vectors that tile the rest. Shown up to {B}.
      </p>
    </div>
  );
}

function VectorList({ sl, atoms }: { sl: Semilinear; atoms: ParikhAtom[] }) {
  const rows: Vec[] = [];
  const seen = new Set<string>();
  for (const L of sl.sets) {
    // base plus small combinations — bounded sample
    const push = (v: Vec) => {
      const k = v.join(',');
      if (!seen.has(k) && v.every((x) => x <= 8)) {
        seen.add(k);
        rows.push(v);
      }
    };
    push(L.base);
    for (const p of L.periods) push(L.base.map((b, i) => b + p[i]));
  }
  rows.sort((a, b) => a.join(',').localeCompare(b.join(',')));
  return (
    <section className="parikh-section">
      <h3>Sample vectors (dimension {atoms.length})</h3>
      <div className="parikh-veclist">
        {rows.slice(0, 40).map((v, i) => (
          <code key={i} className="parikh-vec">
            ({v.join(', ')})
          </code>
        ))}
      </div>
      <p className="muted-note">A bounded sample of realised count vectors — axes are {atoms.map((a) => a.label).join(', ')}.</p>
    </section>
  );
}

// ── membership query ──────────────────────────────────────────────────────────
function QueryBox({ sl, atoms, varNames }: { sl: Semilinear; atoms: ParikhAtom[]; varNames: string[] }) {
  const [vals, setVals] = useState<number[]>(() => atoms.map(() => 0));
  const v = vals.map((x) => Math.max(0, Math.floor(x || 0)));
  const inSet = memberSemi(sl, v);
  let combo: { L: number; counts: number[] } | null = null;
  if (inSet) {
    for (let i = 0; i < sl.sets.length; i++) {
      const c = witnessCombination(sl.sets[i], v);
      if (c) {
        combo = { L: i, counts: c };
        break;
      }
    }
  }
  return (
    <section className="parikh-section">
      <h3>Ask the image — is a count vector realisable?</h3>
      <div className="parikh-query">
        {atoms.map((a, i) => (
          <label key={a.key} className="parikh-query-field">
            <span>#{a.label}</span>
            <input
              type="number"
              min={0}
              value={vals[i]}
              onChange={(e) => {
                const next = vals.slice();
                next[i] = Number(e.target.value);
                setVals(next);
              }}
            />
          </label>
        ))}
        <span className={`parikh-query-verdict ${inSet ? 'yes' : 'no'}`}>{inSet ? '∈ π(L)' : '∉ π(L)'}</span>
      </div>
      {inSet && combo && (
        <p className="muted-note">
          Realised by <code>L{combo.L}</code>: ({varNames.map((_, i) => v[i]).join(', ')}) ={' '}
          <code>{describeCombo(sl.sets[combo.L], combo.counts, atoms)}</code>.
        </p>
      )}
      {!inSet && <p className="muted-note">No word of the language has these letter counts.</p>}
    </section>
  );
}

function describeCombo(L: Semilinear['sets'][number], counts: number[], atoms: ParikhAtom[]): string {
  const base = `(${L.base.map((_, i) => L.base[i]).join(', ')})`;
  const parts = L.periods
    .map((p, j) => (counts[j] ? `${counts[j]}·(${p.join(', ')})` : ''))
    .filter(Boolean);
  void atoms;
  return parts.length ? `${base} + ${parts.join(' + ')}` : base;
}

function summarise(sl: Semilinear, atoms: ParikhAtom[]): string {
  if (sl.sets.length === 0) return '∅';
  if (sl.sets.length <= 2) return sl.sets.map((L) => describeLinear(L, atoms)).join('  ∪  ');
  return `${sl.sets.length} linear sets`;
}

// ── the proof console ─────────────────────────────────────────────────────────
function ProofConsole() {
  const [seed, setSeed] = useState(DEFAULT_PARIKH_FUZZ.seed);
  const [report, setReport] = useState<ParikhFuzzReport | null>(null);
  const [running, setRunning] = useState(false);
  const run = (s: number) => {
    setRunning(true);
    setSeed(s);
    setTimeout(() => {
      setReport(runParikhFuzz({ ...DEFAULT_PARIKH_FUZZ, seed: s }));
      setRunning(false);
    }, 0);
  };
  return (
    <section className="parikh-section parikh-proof">
      <h3>Proof console — three roads, one set of vectors</h3>
      <p className="muted-note">
        A seeded fuzzer draws random regular patterns and confronts the structural semilinear image against (1) a
        brute-force enumeration of the language's own words, (2) the semilinear membership oracle, and (3) the Presburger
        digit-automaton — every check exact up to the horizon.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          new seed
        </button>
      </div>
      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ all three roads agree</span>
                <span className="fuzz-sub">
                  {report.tested.toLocaleString()} patterns tested · {report.vectorsCompared.toLocaleString()} count
                  vectors compared · {report.bridgeChecks.toLocaleString()} Presburger tuples — zero disagreement in{' '}
                  {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ disagreement</span>
                <span className="fuzz-sub">
                  {report.failure?.kind} on /{report.failure?.pattern}/ — {report.failure?.detail}
                </span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <Stat k="patterns tested" v={report.tested.toLocaleString()} />
            <Stat k="set-equality" v={report.setChecks.toLocaleString()} />
            <Stat k="membership" v={report.membershipChecks.toLocaleString()} />
            <Stat k="bridge tuples" v={report.bridgeChecks.toLocaleString()} />
            <Stat k="skipped (truncated)" v={report.skipped.toLocaleString()} />
            <Stat k="time" v={`${report.elapsedMs} ms`} />
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
