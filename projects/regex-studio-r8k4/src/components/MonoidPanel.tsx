import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import {
  buildSyntacticMonoid,
  greenRelations,
  monoidProperties,
  wordLabel,
  type SyntacticMonoid,
  type GreenStructure,
  type MonoidProperties,
} from '../engine/monoid';
import { varietyLadder, stateMapOf, type VarietyLadder } from '../engine/variety';
import { runMonoidFuzz, type MonoidFuzzReport } from '../engine/monoid-verify';

interface Built {
  m: SyntacticMonoid;
  green: GreenStructure | null;
  props: MonoidProperties | null;
  ladder: VarietyLadder | null;
}

// The shortest-word representative of an H-class (the egg-box cell).
function repOf(members: number[], m: SyntacticMonoid): number {
  let best = members[0];
  for (const e of members) {
    const a = m.elements[e].word;
    const b = m.elements[best].word;
    if (a.length < b.length || (a.length === b.length && a.join() < b.join())) best = e;
  }
  return best;
}

export function MonoidPanel({ compiled }: { compiled: Compiled }) {
  const { ast, features } = compiled;

  const built = useMemo<Built | null>(() => {
    if (!compiled.minDfa || !features?.regular) return null;
    const m = buildSyntacticMonoid(compiled.minDfa);
    if (m.truncated) return { m, green: null, props: null, ladder: null };
    const green = greenRelations(m);
    const props = green ? monoidProperties(m, green) : null;
    const ladder = green && props ? varietyLadder(m, green, props) : null;
    return { m, green, props, ladder };
  }, [compiled.minDfa, features]);

  const [showCayley, setShowCayley] = useState(false);
  const [fuzz, setFuzz] = useState<MonoidFuzzReport | null>(null);
  const [fuzzing, setFuzzing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  if (!ast || !features?.regular || !built) {
    return (
      <div className="placeholder">
        {compiled.error
          ? 'Fix the pattern first.'
          : 'The syntactic monoid is defined for the regular subset — anchors, backreferences and lookaround route to the VM, which has no finite monoid.'}
      </div>
    );
  }

  const { m, green, props, ladder } = built;

  if (!green || !props || !ladder) {
    return (
      <div className="placeholder">
        This language's syntactic monoid has more than {m.cap.toLocaleString()} elements — too large to enumerate the
        full algebra in the browser. Try a smaller pattern.
      </div>
    );
  }

  const runFuzz = () => {
    setFuzzing(true);
    setTimeout(() => {
      setFuzz(runMonoidFuzz((Math.random() * 1e9) >>> 0, 2500));
      setFuzzing(false);
    }, 10);
  };

  const idElem = m.elements[m.identity];
  const labels = m.complete.atomLabels;

  return (
    <div className="deriv-panel mon-panel">
      <div className="pane-head">
        <h2>The syntactic monoid — the algebra behind the language</h2>
        <p>
          Every regular language <code>L</code> has a canonical finite monoid <code>M(L)</code>: the{' '}
          <strong>transition monoid of the minimal complete DFA</strong>, where each element is a state-to-state map
          some input word induces, and the product is "read one word, then the next". Read the language's deepest
          properties straight off this algebra — <strong>Schützenberger's theorem</strong> says <code>L</code> is{' '}
          <em>star-free</em> exactly when <code>M(L)</code> is <em>aperiodic</em> (has no non-trivial group).
        </p>
      </div>

      {/* ── headline verdict ───────────────────────────────────────────── */}
      <div className={`mon-verdict ${props.aperiodic ? 'ok' : 'no'}`}>
        {props.aperiodic ? (
          <>
            <span className="mon-verdict-tag">★ star-free</span>
            <span className="mon-verdict-text">
              <code>M(L)</code> is <strong>aperiodic</strong> — so by Schützenberger this language is{' '}
              <strong>star-free</strong>, by McNaughton–Papert it is <strong>first-order (FO[&lt;]) definable</strong>{' '}
              and expressible in <strong>LTL</strong>, and its minimal DFA is <strong>counter-free</strong>. It can be
              described with union, concatenation and <em>complement</em> alone — no Kleene star needed.
            </span>
          </>
        ) : (
          <>
            <span className="mon-verdict-tag">not star-free</span>
            <span className="mon-verdict-text">
              <code>M(L)</code> contains a <strong>non-trivial group</strong> of order{' '}
              <strong>{props.countingModulus}</strong>, so the language does genuine <strong>modular counting</strong>{' '}
              (mod {props.countingModulus}) — it is <strong>not</strong> star-free, <strong>not</strong> first-order
              definable, and its minimal DFA has a <strong>counter</strong> (a cycle of length{' '}
              {props.counterPeriod}
              {props.counterWord && props.counterWord.length > 0 && (
                <> on the word <code>{wordLabel(props.counterWord, labels)}</code></>
              )}
              ).
            </span>
          </>
        )}
      </div>

      {/* ── three-way cross-check of aperiodicity ──────────────────────── */}
      <div className="mon-xcheck">
        <span className="mon-xcheck-label">aperiodic, decided three independent ways:</span>
        <span className={`mon-pill ${props.aperiodicByHClasses ? 'on' : 'off'}`}>
          every H-class is a singleton {props.aperiodicByHClasses ? '✓' : '✗'}
        </span>
        <span className={`mon-pill ${props.aperiodicByPowers ? 'on' : 'off'}`}>
          group-free (mⁿ = mⁿ⁺¹) {props.aperiodicByPowers ? '✓' : '✗'}
        </span>
        <span className={`mon-pill ${props.counterFree ? 'on' : 'off'}`}>
          DFA counter-free {props.counterFree ? '✓' : '✗'}
        </span>
        <span className={`mon-agree ${props.crossCheckOk ? 'ok' : 'bad'}`}>
          {props.crossCheckOk ? 'all three agree ✓' : 'DISAGREE — bug!'}
        </span>
      </div>

      {/* ── monoid summary ─────────────────────────────────────────────── */}
      <div className="mon-summary">
        <Metric label="order |M|" value={String(m.size)} accent />
        <Metric label="idempotents" value={String(m.idempotents.length)} />
        <Metric label="generators" value={String(new Set(m.generators).size)} />
        <Metric label="J / D-classes" value={String(green.dClasses.length)} />
        <Metric label="counting modulus" value={String(props.countingModulus)} accent={props.countingModulus > 1} />
        <Metric label="identity (ε)" value={wordLabel(idElem.word, labels)} />
        {m.zero >= 0 && <Metric label="zero" value={wordLabel(m.elements[m.zero].word, labels)} />}
      </div>

      {/* ── the variety ladder ─────────────────────────────────────────── */}
      <h3 className="deriv-h3">The variety ladder — where this language sits</h3>
      <p className="muted-note">
        By <strong>Eilenberg's variety theorem</strong>, each class of finite monoids corresponds to a class of
        regular languages. These classes <em>nest</em>, and <code>M(L)</code>'s structure decides exactly how deep{' '}
        <code>L</code> sits. Shaded rings are classes <code>L</code> belongs to; the{' '}
        <span className="vl-here-key">★ marked</span> ring is the <strong>tightest</strong> one we can prove.
      </p>
      <VarietyLadderView ladder={ladder} />

      {/* ── the syntactic group, named ─────────────────────────────────── */}
      {ladder.group && (
        <div className="grp-card">
          <div className="grp-head">
            <span className="grp-badge">⟳ syntactic group</span>
            <span className="grp-name">{ladder.group.name}</span>
            <span className="grp-tags">
              order {ladder.group.order} · {ladder.group.abelian ? 'abelian' : 'non-abelian'} · exponent{' '}
              {ladder.group.exponent}
              {ladder.group.cyclic ? ' · cyclic' : ''}
            </span>
          </div>
          <p className="grp-meaning">
            The counting modulus finally has a name: <code>M(L)</code>'s non-trivial group is{' '}
            <strong>{ladder.group.name}</strong> — {ladder.group.meaning}{' '}
            {ladder.group.invariantFactors && ladder.group.invariantFactors.length > 1 && (
              <>
                Its abelian <strong>invariant-factor decomposition</strong> is{' '}
                <code>{ladder.group.invariantFactors.map((d) => `ℤ/${d}`).join(' × ')}</code> (each factor divides the
                next), recovered from the element-order spectrum by primary decomposition.
              </>
            )}
          </p>
          <div className="grp-spectrum">
            <span className="grp-spectrum-l">element orders:</span>
            {ladder.group.orderSpectrum.map((o) => (
              <span key={o.order} className="grp-ord">
                <strong>{o.count}</strong>×<span className="grp-ord-k">ord {o.order}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── secondary structural badges ────────────────────────────────── */}
      <div className="mon-badges">
        <Badge on={props.rTrivial} title="Every R-class is a singleton — a 'partially ordered' / R-trivial language.">
          R-trivial
        </Badge>
        <Badge on={props.lTrivial} title="Every L-class is a singleton.">
          L-trivial
        </Badge>
        <Badge on={props.commutative} title="x·y = y·x for all elements — order of letters never matters to membership.">
          commutative
        </Badge>
        <Badge on={props.band} title="Every element is idempotent (M is a band).">
          idempotent (band)
        </Badge>
        <Badge on={props.group} title="One idempotent (the identity) ⇒ M is a group ⇒ L is a group language (the DFA is a permutation automaton).">
          group language
        </Badge>
      </div>

      {/* ── the egg-box diagram ────────────────────────────────────────── */}
      <h3 className="deriv-h3">Green's relations — the egg-box diagram</h3>
      <p className="muted-note">
        The elements partition into <strong>D-classes</strong> (here = J-classes, since <code>M</code> is finite),
        drawn as boxes ordered top-down by rank. Inside each box, <strong>rows are R-classes</strong> (same right
        ideal), <strong>columns are L-classes</strong> (same left ideal), and each cell is an{' '}
        <strong>H-class</strong> = R ∩ L. A <span className="egg-idem">★ starred, shaded</span> cell contains an
        idempotent — and a cell with more than one element is a <strong>group</strong> (the source of any
        counting). Each cell shows a shortest word reaching that element.
      </p>
      <div className="egg-stack">
        {green.dClasses.map((d) => (
          <div key={d.id} className={`egg-box${d.regular ? ' regular' : ''}`}>
            <div className="egg-head">
              <span className="egg-title">
                D-class {d.id} · rank {d.rank}
              </span>
              <span className="egg-meta">
                {d.members.length} elem{d.members.length === 1 ? '' : 's'} · {d.rows.length}×{d.cols.length}
                {d.regular ? ` · group order ${d.groupOrder}` : ' · null (no idempotent)'}
                {d.members.includes(m.identity) ? ' · contains ε' : ''}
                {m.zero >= 0 && d.members.includes(m.zero) ? ' · the zero' : ''}
              </span>
            </div>
            <table className="egg-grid">
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r}>
                    {d.cols.map((l) => {
                      const hIdx = d.cell.get(`${r},${l}`);
                      if (hIdx === undefined) return <td key={l} className="egg-cell empty" />;
                      const members = green.hClasses[hIdx];
                      const rep = repOf(members, m);
                      const isIdem = members.some((e) => m.elements[e].idempotent);
                      const isGroup = members.length > 1;
                      return (
                        <td
                          key={l}
                          className={`egg-cell${isIdem ? ' egg-idem' : ''}${isGroup ? ' egg-group' : ''}${
                            selected !== null && members.includes(selected) ? ' egg-sel' : ''
                          }`}
                          onClick={() => setSelected(rep)}
                          title={
                            members.map((e) => wordLabel(m.elements[e].word, labels)).join('  ·  ') +
                            (isIdem ? '  (idempotent)' : '') +
                            (isGroup ? `  group of order ${members.length}` : '') +
                            '  — click to see its state-map'
                          }
                        >
                          <code className="egg-word">{wordLabel(m.elements[rep].word, labels)}</code>
                          {isIdem && <span className="egg-star">★</span>}
                          {isGroup && <span className="egg-size">×{members.length}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* ── an element IS a transformation: the egg-box ↔ DFA bridge ────── */}
      <h3 className="deriv-h3">An element <em>is</em> a transformation of the states</h3>
      <p className="muted-note">
        Every monoid element is the state-map some word induces on the <strong>complete minimal DFA</strong> — that is
        literally how <code>M(L)</code> was built. Click any egg-box cell above (or any Cayley entry below) to light up
        the map <code>s ↦ δ(s, w)</code> it realises: which states are <span className="sm-key fix">fixed</span>, the{' '}
        <span className="sm-key img">image</span> (its rank), and any non-trivial{' '}
        <span className="sm-key cyc">cycle</span> — a cycle longer than one is exactly a <strong>counter</strong>, the
        thing a group element does and an aperiodic one never can.
      </p>
      <StateMapView m={m} selected={selected} labels={labels} onClear={() => setSelected(null)} />

      {/* ── Cayley table ───────────────────────────────────────────────── */}
      <h3 className="deriv-h3">
        Multiplication (Cayley) table{' '}
        {m.size <= 64 && (
          <button className="mini-btn" onClick={() => setShowCayley((v) => !v)}>
            {showCayley ? 'hide' : 'show'}
          </button>
        )}
      </h3>
      {m.size > 64 ? (
        <p className="muted-note">The table has {m.size}² entries — too large to draw; the egg-box above is the readable view.</p>
      ) : showCayley && m.mult ? (
        <div className="cayley-wrap">
          <table className="cayley">
            <thead>
              <tr>
                <th className="cayley-corner">·</th>
                {m.elements.map((e) => (
                  <th key={e.id} title={`element ${e.id}`}>
                    {wordLabel(e.word, labels)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.elements.map((row) => (
                <tr key={row.id}>
                  <th title={`element ${row.id}`}>{wordLabel(row.word, labels)}</th>
                  {m.elements.map((col) => {
                    const prod = m.mult![row.id * m.size + col.id];
                    return (
                      <td
                        key={col.id}
                        className={`cayley-cell d${green.dClassOf[prod] % 6}${prod === selected ? ' cayley-sel' : ''}`}
                        onClick={() => setSelected(prod)}
                        title={`${wordLabel(m.elements[row.id].word, labels)} · ${wordLabel(
                          m.elements[col.id].word,
                          labels,
                        )} = ${wordLabel(m.elements[prod].word, labels)} — click for its state-map`}
                      >
                        {wordLabel(m.elements[prod].word, labels)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted-note">A {m.size}×{m.size} grid; each cell <code>i·j</code> is the word you reach by reading i's word then j's, coloured by D-class.</p>
      )}

      {/* ── in-app cross-check ─────────────────────────────────────────── */}
      <h3 className="deriv-h3">Verify the construction</h3>
      <p className="muted-note">
        Draw thousands of random regular patterns, build each one's syntactic monoid, and confirm the three roads to
        "aperiodic" agree and Green's relations stay structurally sound (H = R ∩ L, full egg-boxes, J-trivial ⇒
        aperiodic). Session 9 adds the ladder's own invariants: <strong>J-trivial ⇒ DA ⇒ aperiodic</strong>, every DA
        failure exhibits a genuine regular non-idempotent witness, and each named group's order matches its counting
        modulus while its abelian invariant factors multiply to the order, form a divisibility chain and reproduce the
        element-order spectrum. Any disagreement would be a bug — there should be none.
      </p>
      <div className="mon-fuzz">
        <button className="fuzz-run" onClick={runFuzz} disabled={fuzzing}>
          {fuzzing ? 'running…' : 'run cross-check'}
        </button>
        {fuzz && (
          <div className={`mon-fuzz-out ${fuzz.disagreements === 0 ? 'ok' : 'bad'}`}>
            <strong>{fuzz.checks.toLocaleString()}</strong> invariant checks over{' '}
            <strong>{fuzz.analyzed.toLocaleString()}</strong> monoids · {fuzz.aperiodic.toLocaleString()} star-free ·{' '}
            {fuzz.inDA.toLocaleString()} in DA · {fuzz.withGroups.toLocaleString()} with a group (
            {fuzz.named.toLocaleString()} named) ·{' '}
            {fuzz.disagreements === 0 ? (
              <span className="anti-ok">0 disagreements ✓</span>
            ) : (
              <span className="mon-fail">{fuzz.disagreements} disagreements — {fuzz.firstFailure}</span>
            )}{' '}
            <span className="mon-dim">({fuzz.ms} ms, seed {fuzz.seed})</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`mon-metric${accent ? ' accent' : ''}`}>
      <span className="mon-metric-v">{value}</span>
      <span className="mon-metric-l">{label}</span>
    </div>
  );
}

function Badge({ on, title, children }: { on: boolean; title: string; children: React.ReactNode }) {
  return (
    <span className={`mon-badge ${on ? 'on' : 'off'}`} title={title}>
      <span className="mon-badge-mark">{on ? '✓' : '·'}</span>
      {children}
    </span>
  );
}

// The inclusion ladder, drawn as nested rings (most general outermost). Rings L
// belongs to are shaded; the tightest provable one carries the ★ "you are here".
function VarietyLadderView({ ladder }: { ladder: VarietyLadder }) {
  // levels come most-specific → most-general; nest from the outside in.
  const outerToInner = [...ladder.levels].reverse();
  const render = (i: number): React.ReactNode => {
    if (i >= outerToInner.length) return null;
    const lvl = outerToInner[i];
    const here = lvl.id === ladder.tightestId;
    return (
      <div className={`vl-level${lvl.member ? ' member' : ' nonmember'}${here ? ' here' : ''}`}>
        <div className="vl-row">
          <span className="vl-mark">{lvl.member ? (here ? '★' : '✓') : '·'}</span>
          <span className="vl-name">{lvl.name}</span>
          <span className="vl-algebra" title="the condition decided on M(L)">
            {lvl.algebra}
          </span>
        </div>
        <div className="vl-meaning">{lvl.meaning}</div>
        <div className="vl-theorem">{lvl.theorem}</div>
        {render(i + 1)}
      </div>
    );
  };
  return (
    <div className="vl-ladder">
      {render(0)}
      {ladder.isGroupLanguage && (
        <div className="vl-group-note">
          ⟳ Off the aperiodic spine entirely: <code>M(L)</code> is a <strong>group</strong>, so <code>L</code> is a{' '}
          <strong>group language</strong> — the minimal DFA is a permutation automaton and membership is pure modular
          counting (definable only with modular quantifiers, never in plain FO[&lt;]).
        </div>
      )}
    </div>
  );
}

// What the selected monoid element does to the complete DFA's states.
function StateMapView({
  m,
  selected,
  labels,
  onClear,
}: {
  m: SyntacticMonoid;
  selected: number | null;
  labels: string[];
  onClear: () => void;
}) {
  if (selected === null) {
    return <div className="sm-empty">Click an egg-box cell or a Cayley entry to inspect the state-map it induces.</div>;
  }
  const view = stateMapOf(m, selected);
  const comp = m.complete;
  const inCycle = new Set<number>();
  view.cycles.forEach((c) => c.forEach((s) => inCycle.add(s)));
  const stateLabel = (s: number) => {
    if (s === comp.sink) return '∅';
    return String(s);
  };
  return (
    <div className="sm-box">
      <div className="sm-head">
        <span className="sm-word">
          element <code>{wordLabel(view.word, labels)}</code>
        </span>
        <span className="sm-stat">rank {view.rank}</span>
        {view.idempotent && <span className="sm-stat idem">idempotent (e·e = e)</span>}
        <span className={`sm-stat ${view.period > 1 ? 'counter' : 'nocounter'}`}>
          {view.period > 1 ? `counter of period ${view.period}` : 'no counter (aperiodic transform)'}
        </span>
        <button className="mini-btn" onClick={onClear}>
          clear
        </button>
      </div>
      <div className="sm-grid">
        {view.map.map((e) => {
          const fromAccept = comp.accept[e.from];
          const toAccept = comp.accept[e.to];
          return (
            <div
              key={e.from}
              className={`sm-edge${e.fixed ? ' fixed' : ''}${inCycle.has(e.from) ? ' cyc' : ''}`}
              title={inCycle.has(e.from) ? 'on a non-trivial cycle (a counter)' : e.fixed ? 'fixed point' : ''}
            >
              <span className={`sm-state${fromAccept ? ' acc' : ''}${e.from === comp.start ? ' start' : ''}`}>
                {stateLabel(e.from)}
              </span>
              <span className="sm-arrow">→</span>
              <span className={`sm-state${toAccept ? ' acc' : ''}${e.to === comp.start ? ' start' : ''}`}>
                {stateLabel(e.to)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="sm-legend">
        <span className="sm-state acc demo">n</span> accepting state ·{' '}
        <span className="sm-state start demo">n</span> start · <code>∅</code> the dead sink ·{' '}
        the <span className="sm-key img">image</span> has {view.rank} state{view.rank === 1 ? '' : 's'}
        {view.cycles.length > 0 && (
          <>
            {' '}· cycle{view.cycles.length === 1 ? '' : 's'}:{' '}
            {view.cycles.map((c, i) => (
              <code key={i} className="sm-cycle">
                ({c.map(stateLabel).join(' → ')} → {stateLabel(c[0])})
              </code>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
