import { useMemo, useState } from 'react';
import { analyzeFeatures } from '../engine/ast';
import { parseExtended } from '../engine/parser';
import { buildEregDFA, derivativeChainE, fromAstE, type EReg, type EregDFA } from '../engine/ereg';
import { minimizeDFA } from '../engine/minimize';
import type { DFA } from '../engine/dfa';
import { analyzeLanguage, type LanguageInfo } from '../engine/language';
import { verifyExtended, fuzzExtended, type FuzzResult, type Law } from '../engine/ereg-verify';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#2dd4bf';

type BuiltState =
  | { kind: 'none' }
  | { kind: 'unsupported'; reasons: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; d: EReg; dfa: EregDFA; min: DFA; lang: LanguageInfo };

interface ExtExample {
  name: string;
  pattern: string;
  note: string;
}

const EXT_EXAMPLES: ExtExample[] = [
  {
    name: 'Password — lookahead as a true intersection',
    pattern: '.*[0-9].*&.*[a-z].*&.{6,}',
    note: 'The classic (?=.*\\d)(?=.*[a-z]).{6,} lookahead rule, re-expressed as a real regular INTERSECTION — and now it has a finite DFA the lookahead version can never have.',
  },
  {
    name: 'No "abc" substring (complement)',
    pattern: '~(.*abc.*)',
    note: 'Everything that does NOT contain "abc". Complement is impossible for an NFA — derivatives build it directly.',
  },
  {
    name: 'Identifiers minus keywords (difference)',
    pattern: '[a-z]+-(if|else|for|while)',
    note: 'A − B = A ∩ ¬B. Lowercase identifiers, but not the reserved words. The minimal DFA fuses the keyword trie into the letter loop.',
  },
  {
    name: 'Even a’s AND even b’s',
    pattern: 'b*(ab*ab*)*&a*(ba*ba*)*',
    note: 'The textbook intersection: “an even number of a’s” ∩ “an even number of b’s”. Two simple languages meet in the four-state product DFA — and the minimiser finds exactly those four states.',
  },
  {
    name: 'Contains "ab" but not "ba"',
    pattern: '.*ab.*&~(.*ba.*)',
    note: 'A positive substring requirement intersected with a forbidden one — trivial with &/~, painful without.',
  },
  {
    name: 'Binary ÷3 AND even (ends in 0)',
    pattern: '(0|1(01*0)*1)+&(0|1)*0',
    note: 'Two independent languages — “divisible by three” and “even” — intersected into “divisible by six”, each road already in the studio.',
  },
  {
    name: 'De Morgan, by construction',
    pattern: '~(ab|cd)',
    note: 'Complement of a union. Compare the proof badges: ~(A|B) is verified equal to ~A & ~B.',
  },
];

export function ExtendedPanel({
  pattern,
  onPatternChange,
  text,
}: {
  pattern: string;
  onPatternChange: (s: string) => void;
  text: string;
}) {
  const parsed = useMemo(() => parseExtended(pattern), [pattern]);

  const built = useMemo<BuiltState>(() => {
    if (!parsed.ast) return { kind: 'none' };
    const feats = analyzeFeatures(parsed.ast);
    // The Boolean engine spans the regular core plus & ~ − only.
    if (feats.anchors || feats.boundaries || feats.backrefs || feats.lookaround) {
      return { kind: 'unsupported', reasons: feats.reasons.filter((r) => !r.includes('intersection')) };
    }
    try {
      const d = fromAstE(parsed.ast);
      const dfa = buildEregDFA(d);
      const min = minimizeDFA(dfa);
      const lang = analyzeLanguage(min, { maxLen: 8, examples: 6 });
      return { kind: 'ok', d, dfa, min, lang };
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }, [parsed.ast]);

  const ok = built.kind === 'ok' ? built : null;
  const laws = useMemo<Law[]>(() => (parsed.ast && ok ? verifyExtended(parsed.ast) : []), [parsed.ast, ok]);
  const layout = useMemo(() => (ok ? layoutGraph(dfaToGraph(ok.dfa)) : null), [ok]);
  const chain = useMemo(() => (ok ? derivativeChainE(ok.d, text) : null), [ok, text]);

  const [fuzz, setFuzz] = useState<FuzzResult | null>(null);
  const [fuzzing, setFuzzing] = useState(false);
  const runFuzz = () => {
    setFuzzing(true);
    // Let the button paint "running…" before the synchronous sweep.
    setTimeout(() => {
      const r = fuzzExtended({ seed: (Date.now() & 0xffff) | 1, patterns: 700, strings: 32 });
      setFuzz(r);
      setFuzzing(false);
    }, 16);
  };

  return (
    <div className="deriv-panel ext-panel">
      <div className="pane-head">
        <h2>Extended regex — the Boolean closure, via derivatives</h2>
        <p>
          The studio reaches an automaton four ways, but every road so far speaks the same core algebra: union,
          concatenation, star. This is the <strong>fifth road</strong>, and the first to leave it — the full{' '}
          <strong>Boolean closure</strong> of the regular languages: intersection <code>A&amp;B</code>, complement{' '}
          <code>~A</code>, and difference <code>A−B</code>. Thompson, Glushkov and Antimirov can’t build these (there is
          no ε-NFA fragment for them) — but <strong>Brzozowski derivatives extend to them for free</strong>:{' '}
          <code>∂c(A&amp;B)=∂cA&amp;∂cB</code>, <code>∂c(~A)=~(∂cA)</code>. So derivatives are the one road that builds an
          intersection or a complement <em>directly</em>.
        </p>
      </div>

      <div className="ext-legend">
        <span>
          <code>A|B</code> union
        </span>
        <span>
          <code>A&amp;B</code> intersection
        </span>
        <span>
          <code>~A</code> complement
        </span>
        <span>
          <code>A−B</code> difference
        </span>
        <span className="ext-legend-note">
          precedence: <code>|</code> &lt; <code>&amp; −</code> &lt; concat &lt; <code>~</code> &lt; <code>*</code>. Use{' '}
          <code>\&amp;</code> <code>\~</code> <code>\-</code> for the literals.
        </span>
      </div>

      <div className={`pattern-box ext-input${parsed.error ? ' has-error' : ''}`}>
        <span className="slash">/</span>
        <input
          className="pattern-input"
          value={pattern}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onPatternChange(e.target.value)}
          placeholder="e.g. .*a.*&~(.*bb.*)"
        />
        <span className="slash">/</span>
      </div>
      {parsed.error && (
        <div className="parse-error ext-err">
          <span className="err-msg">
            {parsed.error.message} (at index {parsed.error.index})
          </span>
        </div>
      )}

      <div className="ext-examples">
        {EXT_EXAMPLES.map((ex) => (
          <button key={ex.name} className="ext-example" title={ex.note} onClick={() => onPatternChange(ex.pattern)}>
            <span className="ext-example-name">{ex.name}</span>
            <code className="ext-example-pat">/{ex.pattern}/</code>
          </button>
        ))}
      </div>

      {!parsed.error && built.kind === 'unsupported' && (
        <div className="placeholder">
          The Boolean engine spans the regular core plus <code>&amp; ~ −</code>. This pattern also uses{' '}
          {built.reasons.join(', ')}, which the derivative method doesn’t model — drop those to explore it here.
        </div>
      )}

      {!parsed.error && built.kind === 'error' && <div className="placeholder">Couldn’t build: {built.message}</div>}

      {ok && layout && (
        <>
          <div className="deriv-roads ext-roads">
            <div className="deriv-road">
              <span className="deriv-road-n">{ok.dfa.states.length}</span>
              <span className="deriv-road-l">Boolean-derivative DFA</span>
            </div>
            <span className="deriv-arrow">→</span>
            <div className="deriv-road accent">
              <span className="deriv-road-n">{ok.min.states.length}</span>
              <span className="deriv-road-l">minimises to</span>
            </div>
            <span className="deriv-arrow">·</span>
            <div className="deriv-road">
              <span className="deriv-road-n">{ok.lang.empty ? '∅' : ok.lang.finite ? ok.lang.totalIfFinite!.toString() : '∞'}</span>
              <span className="deriv-road-l">{ok.lang.empty ? 'empty language' : ok.lang.finite ? 'strings (finite)' : 'strings (infinite)'}</span>
            </div>
          </div>
          {ok.dfa.complete && (
            <p className="muted-note ext-note">
              A complement is present, so the DFA is <strong>complete</strong>: a “Σ∖…” edge sends every other character to
              a live state, exactly what makes <code>~A</code> accept the symbols <code>A</code> never mentions.
              {ok.dfa.truncated && ' (search hit its state cap on this pattern.)'}
            </p>
          )}

          <ProofGrid laws={laws} />

          <GraphCard layout={layout} dfa={ok.dfa} />

          <h3 className="deriv-h3">Boolean-derivative chain on the test text</h3>
          <p className="muted-note">
            The very same engine — but now residuals can carry <code>&amp;</code> and <code>~</code>. Accept iff the final
            residual is nullable. <code>nullable(A&amp;B)=∧</code>, <code>nullable(~A)=¬</code>.
          </p>
          <div className="deriv-chain">
            {chain!.steps.map((s, i) => (
              <div key={i} className={`deriv-step${s.dead ? ' dead' : ''}${i === chain!.steps.length - 1 ? ' last' : ''}`}>
                <div className="deriv-step-head">
                  <span className="deriv-step-char">{s.char === null ? 'start' : s.char === ' ' ? '␣' : s.char}</span>
                  {s.nullable && <span className="deriv-badge nullable">nullable</span>}
                  {s.dead && <span className="deriv-badge dead">dead ∅</span>}
                </div>
                <code className="deriv-expr">{s.expr}</code>
              </div>
            ))}
          </div>
          <div className={`deriv-final ${chain!.accepted ? 'ok' : 'no'}`}>
            {chain!.accepted ? 'accepted — final residual is nullable ✓' : 'rejected — final residual is not nullable'}
          </div>

          {ok.lang.examples.length > 0 && (
            <div className="ext-members">
              <h3 className="deriv-h3">A few members</h3>
              <p className="muted-note">
                Shortest: <code>{ok.lang.shortest ? ok.lang.shortest.display : '—'}</code>
                {!ok.lang.examplesExact && ' · representatives (each class shown by one character)'}
              </p>
              <div className="ext-member-list">
                {ok.lang.examples.map((m, i) => (
                  <code key={i} className="ext-member">
                    {m === '' ? 'ε' : m}
                  </code>
                ))}
              </div>
            </div>
          )}

          <div className="ext-fuzz">
            <div className="ext-fuzz-head">
              <h3 className="deriv-h3">Differential cross-check</h3>
              <button className="dot-btn" onClick={runFuzz} disabled={fuzzing}>
                {fuzzing ? 'running…' : 'run cross-check'}
              </button>
            </div>
            <p className="muted-note">
              A seeded generator builds random <code>&amp;</code>/<code>~</code> expressions and races{' '}
              <strong>three independent engines</strong> — the streaming derivative, the derivative DFA, and the{' '}
              <code>ends</code> span oracle (membership defined straight from the algebra, no derivatives) — over thousands
              of strings.
            </p>
            {fuzz && (
              <div className={`ext-fuzz-result ${fuzz.disagreements === 0 ? 'ok' : 'bad'}`}>
                {fuzz.disagreements === 0 ? (
                  <>
                    <strong>{fuzz.checks.toLocaleString()}</strong> membership checks across{' '}
                    <strong>{fuzz.patterns}</strong> random Boolean expressions × {fuzz.strings} strings —{' '}
                    <strong>all three engines agree</strong>, zero disagreements ✓ ({Math.round(fuzz.ms)} ms
                    {fuzz.skipped ? `, ${fuzz.skipped} over-cap skipped` : ''}).
                  </>
                ) : (
                  <>
                    {fuzz.disagreements} disagreement(s)! e.g. <code>{fuzz.counterexample?.pattern}</code> on “
                    {fuzz.counterexample?.input}”: oracle={String(fuzz.counterexample?.oracle)} stream=
                    {String(fuzz.counterexample?.streaming)} dfa={String(fuzz.counterexample?.dfa)}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProofGrid({ laws }: { laws: Law[] }) {
  if (laws.length === 0) return null;
  return (
    <div className="ext-proofs">
      {laws.map((l) => (
        <div key={l.name} className={`ext-proof ${l.ok === null ? 'na' : l.ok ? 'ok' : 'bad'}`} title={l.detail}>
          <span className="ext-proof-mark">{l.ok === null ? '–' : l.ok ? '✓' : '✗'}</span>
          <span className="ext-proof-body">
            <span className="ext-proof-name">{l.name}</span>
            <code className="ext-proof-formula">{l.formula}</code>
          </span>
        </div>
      ))}
    </div>
  );
}

function GraphCard({ layout, dfa }: { layout: ReturnType<typeof layoutGraph>; dfa: EregDFA }) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(toDot(dfaToGraph(dfa), 'boolean_derivative_DFA'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent: ACCENT })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'boolean-derivative-dfa.svg';
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
          <h2>Boolean-derivative DFA</h2>
          <p>Each state is a residual that may carry &amp; and ~ — the start state is the whole extended pattern.</p>
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
