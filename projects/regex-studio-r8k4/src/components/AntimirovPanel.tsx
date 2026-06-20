import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import { fromAst } from '../engine/derivatives';
import {
  buildAntimirovDFA,
  buildAntimirovNFA,
  partialChain,
  pnfaToGraph,
  thompsonSize,
} from '../engine/antimirov';
import { minimizeDFA } from '../engine/minimize';
import { compareDFAs } from '../engine/equivalence';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#f472b6';

export function AntimirovPanel({ compiled, text }: { compiled: Compiled; text: string }) {
  const { ast, features } = compiled;

  const data = useMemo(() => {
    if (!ast || !features?.regular) return null;
    const root = fromAst(ast);
    const pnfa = buildAntimirovNFA(root);
    const thompson = thompsonSize(ast);
    // The third road, verified: determinise the equation automaton, minimise it,
    // and confirm it is the *same* canonical machine the Thompson pipeline reaches.
    let canonical: 'equal' | 'other' | 'na' = 'na';
    if (!pnfa.truncated && compiled.minDfa) {
      const min = minimizeDFA(buildAntimirovDFA(pnfa));
      canonical = compareDFAs(min, compiled.minDfa).relation === 'equal' ? 'equal' : 'other';
    }
    return { root, pnfa, thompson, canonical };
  }, [ast, features, compiled.minDfa]);

  const layout = useMemo(() => (data ? layoutGraph(pnfaToGraph(data.pnfa)) : null), [data]);
  const chain = useMemo(() => (data ? partialChain(data.root, text) : null), [data, text]);

  if (!ast || !features?.regular || !data || !layout) {
    return (
      <div className="placeholder">
        {compiled.error
          ? 'Fix the pattern first.'
          : 'Antimirov partial derivatives are defined for the regular subset — anchors, backreferences and lookaround route to the VM instead.'}
      </div>
    );
  }

  const { pnfa, thompson } = data;
  const shrink = thompson.states > 0 ? (1 - pnfa.states.length / thompson.states) * 100 : 0;

  return (
    <div className="deriv-panel">
      <div className="pane-head">
        <h2>Antimirov partial derivatives — a third road, straight to a tiny NFA</h2>
        <p>
          Brzozowski folds every alternative into <em>one</em> residual regex; Antimirov keeps them{' '}
          <em>apart</em>. The <strong>partial derivative</strong> <code>∂c(r)</code> is a <em>set</em> of regexes whose
          union is Brzozowski's derivative — and keeping the set unmerged makes the construction non-deterministic. Each
          distinct term becomes one NFA state, giving the <strong>equation automaton</strong>: ε-free, and provably no
          larger than the number of character classes in the pattern, plus one.
        </p>
      </div>

      <div className="deriv-roads">
        <div className="deriv-road">
          <span className="deriv-road-n">{thompson.states}</span>
          <span className="deriv-road-l">Thompson ε-NFA states</span>
          <span className="anti-sub">{thompson.epsilon} ε-edges</span>
        </div>
        <span className="deriv-arrow">vs</span>
        <div className="deriv-road accent">
          <span className="deriv-road-n">{pnfa.states.length}</span>
          <span className="deriv-road-l">equation-automaton states</span>
          <span className="anti-sub">0 ε-edges · ≤ {pnfa.letterBound} guaranteed</span>
        </div>
        {shrink > 0 && (
          <>
            <span className="deriv-arrow">→</span>
            <div className="deriv-road">
              <span className="deriv-road-n">−{Math.round(shrink)}%</span>
              <span className="deriv-road-l">states, no ε</span>
            </div>
          </>
        )}
      </div>
      <p className="muted-note deriv-note">
        Antimirov's theorem: the partial-derivative term set is finite and <strong>linear-size</strong> — at most one
        state per character occurrence. Thompson's construction, by contrast, spends two states and a handful of
        ε-transitions on every operator.
        {data.canonical === 'equal' && (
          <>
            {' '}
            And determinising <em>this</em> NFA, then minimising, lands on the exact same canonical machine the
            Thompson→subset→Moore pipeline reaches — <strong className="anti-ok">verified equal ✓</strong>. Three roads,
            one minimal automaton.
          </>
        )}
        {pnfa.truncated && ' (partial-derivative search hit its state cap on this pattern.)'}
      </p>

      <GraphCard layout={layout} pnfa={pnfa} />

      <h3 className="deriv-h3">Partial-derivative chain on the test text</h3>
      <p className="muted-note">
        Where the Brzozowski chain carries a single residual, the Antimirov chain carries the <em>set</em> of live
        terms — literally the NFA's active states as it reads the input. The string is accepted iff some live term is{' '}
        <em>nullable</em> when the input runs out. When every thread dies the set is empty <code>∅</code> and the match
        rejects.
      </p>
      <div className="deriv-chain">
        {chain!.steps.map((s, i) => (
          <div
            key={i}
            className={`deriv-step${s.dead ? ' dead' : ''}${i === chain!.steps.length - 1 ? ' last' : ''}`}
          >
            <div className="deriv-step-head">
              <span className="deriv-step-char">{s.char === null ? 'start' : s.char === ' ' ? '␣' : s.char}</span>
              {s.accept && <span className="deriv-badge nullable">accepting</span>}
              {s.dead && <span className="deriv-badge dead">dead ∅</span>}
            </div>
            {s.dead ? (
              <code className="deriv-expr">∅</code>
            ) : (
              <div className="anti-set">
                <span className="anti-brace">{'{'}</span>
                {s.terms.map((t, j) => (
                  <code key={j} className="anti-term">
                    {t === '' ? 'ε' : t}
                  </code>
                ))}
                <span className="anti-brace">{'}'}</span>
                <span className="anti-count">{s.terms.length} live</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={`deriv-final ${chain!.accepted ? 'ok' : 'no'}`}>
        {chain!.accepted
          ? 'accepted — a live term is nullable ✓'
          : 'rejected — no live term is nullable when the input ends'}
      </div>
    </div>
  );
}

function GraphCard({
  layout,
  pnfa,
}: {
  layout: ReturnType<typeof layoutGraph>;
  pnfa: ReturnType<typeof buildAntimirovNFA>;
}) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(toDot(pnfaToGraph(pnfa), 'equation_automaton'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const svg = toSvg(layout, { accent: ACCENT });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'equation-automaton.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* sandbox / download blocked — ignore */
    }
  };
  return (
    <div className="graph-pane">
      <div className="pane-head graph-head">
        <div>
          <h2>Equation automaton (Antimirov NFA)</h2>
          <p>
            Every state is a partial-derivative term; the start state is the whole pattern. Double-circled states are
            nullable (accepting). No ε-transitions — each edge consumes a character.
          </p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg} title="Download this automaton as a standalone SVG">
            download SVG
          </button>
          <button className="dot-btn" onClick={copyDot} title="Copy this automaton as Graphviz DOT">
            {copied ? 'copied ✓' : 'copy DOT'}
          </button>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent={ACCENT} />
    </div>
  );
}
