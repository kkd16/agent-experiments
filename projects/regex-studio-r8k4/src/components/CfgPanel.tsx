import { useMemo, useState } from 'react';
import {
  compileCfg,
  membership,
  grammarText,
  rhsText,
  treeYield,
  rootTrees,
  findAmbiguity,
  enumerateWords,
  buildPda,
  pdaRun,
  analyzeLL1,
  parseLL1,
  END,
  CFG_EXAMPLES,
  type ParseTree,
  type Ll1Analysis,
} from '../engine/cfg';
import { runCfgFuzz, DEFAULT_CFG_FUZZ, type CfgFuzzReport } from '../engine/cfg/verify';

export function CfgPanel({
  source,
  onSourceChange,
  query,
  onQueryChange,
}: {
  source: string;
  onSourceChange: (s: string) => void;
  query: string;
  onQueryChange: (s: string) => void;
}) {
  const compiled = useMemo(() => compileCfg(source), [source]);
  const g = compiled.grammar;
  const cnf = compiled.cnf;

  const mem = useMemo(() => {
    if (!g || !cnf) return null;
    try {
      return membership(g, cnf.grammar, query);
    } catch {
      return null;
    }
  }, [g, cnf, query]);

  const pda = useMemo(() => (g ? buildPda(g) : null), [g]);
  const pdaRunResult = useMemo(() => {
    if (!g) return null;
    try {
      return pdaRun(g, query, { maxConfigs: 120000 });
    } catch {
      return null;
    }
  }, [g, query]);

  // does the *queried* string itself have ≥2 parse trees?
  const queryTrees = useMemo(() => (g ? rootTrees(g, query) : []), [g, query]);

  const enumeration = useMemo(() => {
    if (!g) return null;
    const src = compiled.trimmed ?? g;
    return enumerateWords(src, 8, 40);
  }, [g, compiled.trimmed]);

  const ambiguity = useMemo(() => (g ? findAmbiguity(g, 7) : null), [g]);

  const ll1 = useMemo(() => (g ? analyzeLL1(g) : null), [g]);
  const ll1Parse = useMemo(() => (g && ll1 && ll1.isLL1 ? parseLL1(g, ll1, query) : null), [g, ll1, query]);

  return (
    <div className="logic-panel deriv-panel cfg-panel">
      <div className="pane-head">
        <h2>Context-Free — beyond the regular fence</h2>
        <p>
          Every other tab lives <em>inside</em> the regular languages. This one steps out. Write a{' '}
          <strong>context-free grammar</strong> and the whole Chomsky-hierarchy machinery unfolds: three independent
          recognizers (<strong>CYK</strong> on the Chomsky-normal-form grammar, an <strong>Earley</strong> chart on the
          raw one, and a brute-force derivation oracle) that must agree, the <strong>CNF</strong> transform watched
          step by step, the grammar compiled to a <strong>pushdown automaton</strong> whose stack you can single-step,
          and the language read for emptiness, finiteness, and <strong>ambiguity</strong>. The headline:{' '}
          <code>S → a S b | ε</code> is <code>{'{ aⁿbⁿ }'}</code>, the canonical non-regular language.
        </p>
      </div>

      <div className="cfg-io">
        <div className="cfg-io-col">
          <label className="field-label" htmlFor="cfg-src">
            grammar
          </label>
          <textarea
            id="cfg-src"
            className={`cfg-grammar${compiled.error ? ' has-error' : ''}`}
            value={source}
            spellCheck={false}
            autoComplete="off"
            rows={Math.min(10, Math.max(4, source.split('\n').length + 1))}
            onChange={(e) => onSourceChange(e.target.value)}
          />
          <p className="muted-note cfg-syntax">
            One nonterminal per line. Uppercase-led tokens (<code>S</code>, <code>A'</code>, <code>T0</code>) are
            nonterminals; any other single character is a terminal. <code>-&gt;</code>, <code>→</code> or{' '}
            <code>::=</code> for the arrow, <code>|</code> for alternatives, <code>ε</code> / <code>epsilon</code> /
            empty for the empty string. <code>#</code> or <code>//</code> start a comment.
          </p>
        </div>
        <div className="cfg-io-col cfg-io-query">
          <label className="field-label" htmlFor="cfg-query">
            test string
          </label>
          <input
            id="cfg-query"
            className="pattern-input cfg-query-input"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="a string to parse"
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {mem && (
            <div className={`cfg-verdict ${mem.cyk.accepted ? 'yes' : 'no'}`}>
              <span className="cfg-verdict-big">
                {query === '' ? 'ε' : `“${query}”`} {mem.cyk.accepted ? 'is in the language' : 'is not in the language'}
              </span>
              <div className="cfg-recognizers">
                <RecoBadge label="CYK (CNF)" ok={mem.cyk.accepted} />
                <RecoBadge label="Earley (raw)" ok={mem.earley.accepted} />
                <RecoBadge label="oracle" ok={mem.oracleAccepts} />
                <RecoBadge label="PDA" ok={mem.pda.accepted} bounded={mem.pda.bounded} />
              </div>
              <div className={`graph-badge ${mem.agree ? 'ok' : 'bad'} cfg-agree`}>
                {mem.agree ? 'all three recognizers agree ✓' : 'DISAGREEMENT — a bug'}
              </div>
            </div>
          )}
        </div>
      </div>

      {compiled.error && (
        <div className="parse-error logic-err">
          <span className="err-msg">
            {compiled.error.message} (line {compiled.error.line})
          </span>
        </div>
      )}

      {/* gallery */}
      <div className="cfg-gallery">
        {CFG_EXAMPLES.map((ex) => (
          <button
            key={ex.name}
            className="example cfg-example"
            title={ex.note}
            onClick={() => {
              onSourceChange(ex.source);
              onQueryChange(ex.sample);
            }}
          >
            <span className="ex-name">{ex.name}</span>
            <code className="ex-pat">{ex.source.split('\n')[0]}</code>
          </button>
        ))}
      </div>

      {g && (
        <>
          {/* structural analysis */}
          <div className="cfg-analysis">
            <span className="lang-badge">
              start <code>{g.start}</code>
            </span>
            <span className="lang-badge">
              N = {'{'}
              {g.nonterminals.join(', ')}
              {'}'}
            </span>
            <span className="lang-badge">
              Σ = {'{'}
              {g.terminals.join(', ') || '∅'}
              {'}'}
            </span>
            {compiled.finiteness && (
              <span className={`lang-badge ${compiled.finiteness.empty ? 'bad' : 'good'}`}>
                {compiled.finiteness.empty ? 'L = ∅ (empty)' : compiled.finiteness.finite ? 'finite language' : 'infinite language'}
              </span>
            )}
            {!compiled.finiteness?.empty && compiled.finiteness && !compiled.finiteness.finite && compiled.finiteness.recursiveWitness && (
              <span className="lang-badge" title="a self-embedding nonterminal — it can pump arbitrarily long words">
                recursive: <code>{compiled.finiteness.recursiveWitness}</code>
              </span>
            )}
            {compiled.nullable.length > 0 && (
              <span className="lang-badge" title="nonterminals that can derive ε">
                nullable: {compiled.nullable.join(' ')}
              </span>
            )}
            {compiled.useless.length > 0 && (
              <span className="lang-badge warn" title="non-generating or unreachable — removed by trimming">
                useless: {compiled.useless.join(' ')}
              </span>
            )}
          </div>

          {/* the queried string's parse trees + ambiguity */}
          {mem && mem.earley.accepted && (
            <>
              <h3 className="lang-h3">Parse of {query === '' ? 'ε' : `“${query}”`}</h3>
              {queryTrees.length >= 2 ? (
                <>
                  <div className="graph-badge warn cfg-amb-note">
                    This string is <strong>ambiguous</strong> in this grammar — it has (at least) two distinct parse
                    trees. Both are shown.
                  </div>
                  <div className="cfg-trees">
                    <TreeView tree={queryTrees[0]} caption="tree 1" />
                    <TreeView tree={queryTrees[1]} caption="tree 2" />
                  </div>
                </>
              ) : (
                <div className="cfg-trees">
                  {mem.earley.tree && <TreeView tree={mem.earley.tree} caption="Earley — over the original grammar" />}
                  {mem.cyk.tree && <TreeView tree={mem.cyk.tree} caption="CYK — over the CNF grammar (binary)" />}
                </div>
              )}
            </>
          )}

          {/* CYK table */}
          {mem && query.length > 0 && mem.cyk.cells.length > 0 && (
            <CykTable cells={mem.cyk.cells} word={query} start={cnf ? cnf.grammar.start : g.start} />
          )}

          {/* CNF transform */}
          {cnf && (
            <>
              <h3 className="lang-h3">Chomsky Normal Form — START · TERM · BIN · DEL · UNIT</h3>
              <p className="muted-note">
                Five language-preserving steps normalise every production to <code>A → B C</code> or <code>A → a</code>{' '}
                (plus <code>{cnf.epsilon ? 'S₀ → ε' : 'no ε'}</code>). CYK needs exactly this shape; that the language
                never moves is a fuzzer invariant.
              </p>
              <div className="logic-trace cfg-cnf-trace">
                {cnf.trace.map((s, i) => (
                  <div key={i} className="logic-trace-row">
                    <code className="logic-op">{s.step}</code>
                    <span className="logic-trace-detail">{s.detail}</span>
                    <span className="logic-trace-size">
                      {s.rules} rules · {s.nonterminals} N
                    </span>
                  </div>
                ))}
              </div>
              <details className="cfg-details">
                <summary>the CNF grammar ({cnf.grammar.rules.length} rules)</summary>
                <pre className="cfg-grammar-pre">{grammarText(cnf.grammar)}</pre>
              </details>
            </>
          )}

          {/* Earley chart */}
          {mem && (
            <>
              <h3 className="lang-h3">Earley chart — the general parser, no normalization</h3>
              <p className="muted-note">
                {mem.earley.itemCount} items across {mem.earley.chart.length} state sets. Set <code>k</code> holds every
                dotted rule <code>A → α•β (j)</code> consistent with the first <code>k</code> characters, started at
                position <code>j</code>. Acceptance = a completed <code>⟪start⟫ → {g.start}•</code> spanning the whole
                input.
              </p>
              <EarleyChart chart={mem.earley.chart} word={query} />
            </>
          )}

          {/* PDA */}
          {pda && (
            <>
              <h3 className="lang-h3">Pushdown automaton — the grammar as a stack machine</h3>
              <p className="muted-note">
                The top-down, single-state PDA: <code>(q, ε, A) → (q, γ)</code> expands a nonterminal, and{' '}
                <code>(q, a, a) → (q, ε)</code> pops a terminal that matches the input. Acceptance is by{' '}
                <strong>empty stack</strong> — and an accepting run is exactly a leftmost derivation.
              </p>
              <div className="cfg-pda-cols">
                <div className="cfg-pda-table">
                  <div className="cfg-pda-sub">expand moves</div>
                  {pda.expand.map((m, i) => (
                    <div key={i} className="cfg-pda-move">
                      <code>(q, ε, {m.A})</code> → <code>(q, {rhsText(m.rhs)})</code>
                    </div>
                  ))}
                  <div className="cfg-pda-sub">match moves</div>
                  {pda.match.map((a) => (
                    <div key={a} className="cfg-pda-move">
                      <code>(q, {a}, {a})</code> → <code>(q, ε)</code>
                    </div>
                  ))}
                </div>
                <PdaRunView run={pdaRunResult} word={query} start={g.start} />
              </div>
            </>
          )}

          {/* LL(1) predictive parsing */}
          {ll1 && g.terminals.length > 0 && (
            <>
              <h3 className="lang-h3">LL(1) — predictive, table-driven parsing</h3>
              <p className="muted-note">
                A fourth parser, but a <em>committing</em> one: it picks a single production from the{' '}
                <strong>(nonterminal, one-token lookahead)</strong> cell and never backtracks. That's only possible
                when the <strong>FIRST</strong>/<strong>FOLLOW</strong> table has no cell with two productions — and
                building it shows exactly what breaks it.
              </p>
              <div className="cfg-analysis">
                <span className={`lang-badge ${ll1.isLL1 ? 'good' : 'bad'}`}>
                  {ll1.isLL1 ? 'LL(1) ✓ — conflict-free table' : `not LL(1) — ${ll1.conflicts.length} conflict cell${ll1.conflicts.length === 1 ? '' : 's'}`}
                </span>
                {ll1.leftRecursive && (
                  <span className="lang-badge warn" title="left recursion always breaks LL(1)">
                    left-recursive
                  </span>
                )}
              </div>

              <FirstFollowTable g={g} ll1={ll1} />

              {!ll1.isLL1 && ll1.conflicts.length > 0 && (
                <div className="cfg-ll1-conflicts">
                  <div className="cfg-lang-label">conflicts</div>
                  {ll1.conflicts.map((c, i) => (
                    <div key={i} className="cfg-ll1-conflict">
                      cell <code>[{c.A}, {c.terminal === END ? '$' : c.terminal}]</code> wants{' '}
                      {c.rules.map((ri) => (
                        <code key={ri} className="cfg-ll1-rule">
                          {g.rules[ri].lhs} → {rhsText(g.rules[ri].rhs)}
                        </code>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              <Ll1Table g={g} ll1={ll1} />

              {ll1.isLL1 && ll1Parse && (
                <>
                  <div className="cfg-lang-label" style={{ marginTop: 12 }}>
                    predictive parse of {query === '' ? 'ε' : `“${query}”`} — {ll1Parse.accepted ? 'accepted ✓' : 'rejected'}
                    {ll1Parse.error && !ll1Parse.accepted ? ` (${ll1Parse.error})` : ''}
                  </div>
                  <div className="cfg-ll1-trace-scroll">
                    <table className="cfg-ll1-trace">
                      <thead>
                        <tr>
                          <th>stack (top ▸)</th>
                          <th>input</th>
                          <th>action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ll1Parse.steps.map((s, i) => (
                          <tr key={i}>
                            <td><code>{s.stack.join(' ') || '—'}</code></td>
                            <td>
                              <code>
                                <span className="cfg-consumed">{query.slice(0, s.pos)}</span>
                                <span className="cfg-remaining">{query.slice(s.pos) || '$'}</span>
                              </code>
                            </td>
                            <td className="cfg-ll1-act">{s.action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {/* language card */}
          <h3 className="lang-h3">The language</h3>
          <div className="cfg-lang-card">
            {enumeration && (
              <div className="cfg-lang-words">
                <div className="cfg-lang-label">shortest words (≤ 8)</div>
                {enumeration.words.length === 0 ? (
                  <span className="muted-note">— none (empty language)</span>
                ) : (
                  <div className="cfg-words">
                    {enumeration.words.map((w) => (
                      <code
                        key={w || 'ε'}
                        className={`cfg-word${w === query ? ' active' : ''}`}
                        onClick={() => onQueryChange(w)}
                        title="use as the test string"
                      >
                        {w === '' ? 'ε' : w}
                      </code>
                    ))}
                    {enumeration.truncated && <span className="cfg-word more">…</span>}
                  </div>
                )}
              </div>
            )}
            {ambiguity && (
              <div className="cfg-lang-amb">
                <div className="cfg-lang-label">ambiguity</div>
                {ambiguity.witness ? (
                  <div className="cfg-amb-found">
                    <span className="graph-badge warn">
                      ambiguous — “{ambiguity.witness.word}” has two distinct parse trees
                    </span>
                    <button className="fuzz-run secondary" onClick={() => onQueryChange(ambiguity.witness!.word)}>
                      show it
                    </button>
                  </div>
                ) : (
                  <span className="muted-note">
                    no ambiguity witness up to length 7{ambiguity.bounded ? ' (search was bounded)' : ''}. Ambiguity is
                    only semi-decidable, so this is “none found”, not a proof of unambiguity.
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <CrossCheck />
    </div>
  );
}

function FirstFollowTable({ g, ll1 }: { g: ReturnType<typeof compileCfg>['grammar']; ll1: Ll1Analysis }) {
  if (!g) return null;
  const fmt = (set: Set<string> | undefined) =>
    set && set.size ? [...set].map((x) => (x === END ? '$' : x)).join(' ') : '∅';
  return (
    <div className="cfg-ff-scroll">
      <table className="cfg-ff">
        <thead>
          <tr>
            <th>A</th>
            <th>FIRST(A)</th>
            <th>FOLLOW(A)</th>
          </tr>
        </thead>
        <tbody>
          {g.nonterminals.map((A) => (
            <tr key={A}>
              <td><code className="cfg-ff-nt">{A}</code></td>
              <td>
                <code>{fmt(ll1.first.get(A))}</code>
                {ll1.nullable.has(A) && <span className="cfg-ff-null"> · ε</span>}
              </td>
              <td><code>{fmt(ll1.follow.get(A))}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ll1Table({ g, ll1 }: { g: ReturnType<typeof compileCfg>['grammar']; ll1: Ll1Analysis }) {
  if (!g) return null;
  const cols = ll1.terminals;
  return (
    <div className="cfg-ll1-scroll">
      <table className="cfg-ll1">
        <thead>
          <tr>
            <th />
            {cols.map((a) => (
              <th key={a}>{a === END ? '$' : a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.nonterminals.map((A) => {
            const row = ll1.table.get(A);
            return (
              <tr key={A}>
                <th className="cfg-ll1-rowh">{A}</th>
                {cols.map((a) => {
                  const rules = row?.get(a) ?? [];
                  const conflict = rules.length > 1;
                  return (
                    <td key={a} className={`cfg-ll1-cell${rules.length ? ' filled' : ''}${conflict ? ' conflict' : ''}`}>
                      {rules.map((ri) => (
                        <div key={ri} className="cfg-ll1-prod">
                          {A} → {rhsText(g.rules[ri].rhs)}
                        </div>
                      ))}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecoBadge({ label, ok, bounded }: { label: string; ok: boolean; bounded?: boolean }) {
  return (
    <span className={`cfg-reco ${bounded ? 'bounded' : ok ? 'acc' : 'rej'}`} title={bounded ? 'search bounded — inconclusive' : ''}>
      {label} {bounded ? '?' : ok ? '✓' : '✗'}
    </span>
  );
}

// ---- parse-tree rendering ----

interface TNode {
  x: number;
  y: number;
  label: string;
  terminal: boolean;
}

function layoutTree(root: ParseTree): { nodes: TNode[]; edges: { x1: number; y1: number; x2: number; y2: number }[]; width: number; height: number } {
  const XGAP = 42;
  const YGAP = 56;
  const nodes: TNode[] = [];
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let leafX = 0;

  const place = (t: ParseTree, depth: number): TNode => {
    const y = depth * YGAP + 24;
    const label = t.terminal ? t.label : t.label;
    let x: number;
    if (t.terminal || t.children.length === 0) {
      x = leafX * XGAP + 24;
      leafX++;
    } else {
      const kids = t.children.map((c) => place(c, depth + 1));
      x = (kids[0].x + kids[kids.length - 1].x) / 2;
      for (const k of kids) edges.push({ x1: x, y1: y, x2: k.x, y2: k.y });
    }
    const n: TNode = { x, y, label: t.children.length === 0 && !t.terminal ? 'ε' : label, terminal: t.terminal };
    nodes.push(n);
    return n;
  };
  place(root, 0);
  const width = Math.max(leafX, 1) * XGAP + 24;
  const maxDepth = Math.max(...nodes.map((n) => n.y)) + 40;
  return { nodes, edges, width, height: maxDepth };
}

function TreeView({ tree, caption }: { tree: ParseTree; caption: string }) {
  const layout = useMemo(() => layoutTree(tree), [tree]);
  return (
    <div className="cfg-tree">
      <div className="cfg-tree-cap">{caption}</div>
      <div className="cfg-tree-scroll">
        <svg width={layout.width} height={layout.height} className="cfg-tree-svg">
          {layout.edges.map((e, i) => (
            <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="var(--edge)" strokeWidth={1.3} />
          ))}
          {layout.nodes.map((n, i) => (
            <g key={i}>
              <circle cx={n.x} cy={n.y} r={n.terminal ? 11 : 13} className={n.terminal ? 'cfg-tnode term' : 'cfg-tnode nt'} />
              <text x={n.x} y={n.y} className="cfg-tlabel" textAnchor="middle" dominantBaseline="central">
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="cfg-tree-yield">
        yield: <code>{treeYield(tree) === '' ? 'ε' : treeYield(tree)}</code>
      </div>
    </div>
  );
}

// ---- CYK table ----

function CykTable({ cells, word, start }: { cells: string[][][]; word: string; start: string }) {
  const n = word.length;
  // build a triangular grid: row = length (n..1), col = start index
  return (
    <>
      <h3 className="lang-h3">CYK table — the triangular dynamic program</h3>
      <p className="muted-note">
        Cell <code>(i, ℓ)</code> holds the nonterminals deriving the substring of length <code>ℓ</code> starting at{' '}
        <code>i</code>, filled bottom-up. The top cell spanning the whole string contains{' '}
        <code>{start}</code> exactly when the word is accepted.
      </p>
      <div className="cfg-cyk-scroll">
        <table className="cfg-cyk">
          <tbody>
            {Array.from({ length: n }, (_, r) => {
              const len = n - r; // rows from length n at top down to 1
              return (
                <tr key={len}>
                  <th className="cfg-cyk-len">ℓ={len}</th>
                  {Array.from({ length: n - len + 1 }, (_, i) => {
                    const set = cells[i][len - 1];
                    const has = set.includes(start) && len === n;
                    return (
                      <td key={i} className={`cfg-cyk-cell${set.length ? ' filled' : ''}${has ? ' accept' : ''}`} colSpan={1}>
                        {set.length ? set.join(' ') : '·'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr>
              <th className="cfg-cyk-len" />
              {[...word].map((c, i) => (
                <td key={i} className="cfg-cyk-char">
                  {c}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Earley chart ----

function EarleyChart({ chart, word }: { chart: string[][]; word: string }) {
  const chars = [...word];
  return (
    <div className="cfg-earley-scroll">
      <div className="cfg-earley">
        {chart.map((items, k) => (
          <div key={k} className="cfg-earley-set">
            <div className="cfg-earley-head">
              S{k}
              {k > 0 && <span className="cfg-earley-ch"> ·{chars[k - 1]}</span>}
            </div>
            <div className="cfg-earley-items">
              {items.length === 0 ? (
                <span className="muted-note">∅</span>
              ) : (
                items.map((it, i) => (
                  <code key={i} className="cfg-earley-item">
                    {it}
                  </code>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- PDA run animation ----

function PdaRunView({ run, word, start }: { run: ReturnType<typeof pdaRun> | null; word: string; start: string }) {
  const [step, setStep] = useState(0);
  const steps = run?.steps ?? [];
  const idx = Math.min(step, steps.length);

  if (!run) return <div className="cfg-pda-run placeholder">—</div>;
  if (!run.accepted) {
    return (
      <div className="cfg-pda-run">
        <div className="cfg-pda-sub">accepting run</div>
        <div className="muted-note">
          {run.bounded ? 'no accepting run found within the search bound.' : 'the PDA rejects this string (no accepting computation).'}
        </div>
      </div>
    );
  }

  const pos = idx === 0 ? 0 : steps[idx - 1].pos;
  const stack = idx === 0 ? [{ kind: 'N' as const, name: start }] : steps[idx - 1].stack;
  const action = idx === 0 ? 'initial: push the start symbol' : steps[idx - 1].action;
  const remaining = word.slice(pos);
  return (
    <div className="cfg-pda-run">
      <div className="cfg-pda-sub">
        accepting run — step {idx} / {steps.length}
      </div>
      <div className="cfg-pda-config">
        <div className="cfg-pda-input">
          <span className="cfg-pda-lbl">input</span>
          <code>
            <span className="cfg-consumed">{word.slice(0, pos)}</span>
            <span className="cfg-remaining">{remaining || '⊣'}</span>
          </code>
        </div>
        <div className="cfg-pda-stack">
          <span className="cfg-pda-lbl">stack</span>
          <div className="cfg-stack-cells">
            {stack.length === 0 ? (
              <span className="cfg-stack-empty">empty ✓</span>
            ) : (
              [...stack].reverse().map((s, i) => (
                <span key={i} className={`cfg-stack-cell ${s.kind === 'N' ? 'nt' : 'term'}`}>
                  {s.name}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="cfg-pda-action">{action}</div>
      <div className="cfg-pda-ctrl">
        <button className="fuzz-run secondary" disabled={idx === 0} onClick={() => setStep(idx - 1)}>
          ◀ prev
        </button>
        <button className="fuzz-run secondary" disabled={idx >= steps.length} onClick={() => setStep(idx + 1)}>
          next ▶
        </button>
        <button className="fuzz-run secondary" onClick={() => setStep(0)}>
          reset
        </button>
        <button className="fuzz-run secondary" onClick={() => setStep(steps.length)}>
          end
        </button>
      </div>
    </div>
  );
}

// ---- cross-check console ----

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_CFG_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_CFG_FUZZ.trials);
  const [report, setReport] = useState<CfgFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runCfgFuzz({ seed: nextSeed, trials, maxLen: DEFAULT_CFG_FUZZ.maxLen }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the whole pillar</h3>
      <p className="muted-note">
        A seeded fuzzer draws random grammars and confronts them five ways: <strong>CYK ≡ Earley ≡ oracle</strong> on
        every string up to a length horizon; <strong>CNF preserves the language</strong>; <strong>useless-symbol
        removal preserves the language</strong>; <strong>the PDA agrees with the oracle</strong> wherever its bounded
        search is conclusive; and every <strong>LL(1) grammar's predictive parser accepts exactly the
        language</strong>. Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>grammars</span>
          <input
            type="number"
            min={10}
            max={400}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(400, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          new seed
        </button>
      </div>

      {!report && !running && (
        <div className="placeholder">
          Press <strong>run</strong> to draw hundreds of random grammars and verify all three recognizers and every
          transform against each other.
        </div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every grammar checks out</span>
                <span className="fuzz-sub">
                  {report.trials} grammars — {report.stringChecks.toLocaleString()} recognizer-agreement checks,{' '}
                  {report.cnfChecks.toLocaleString()} CNF-preservation, {report.trimChecks.toLocaleString()} trim,{' '}
                  {report.pdaChecks.toLocaleString()} PDA, and {report.ll1Checks.toLocaleString()} LL(1) checks, all
                  agree. {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A recognizer or transform disagreed with the ground truth — see below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="grammars" v={String(report.trials)} />
            <St k="recognizers" v={report.stringChecks.toLocaleString()} />
            <St k="CNF" v={report.cnfChecks.toLocaleString()} />
            <St k="trim" v={report.trimChecks.toLocaleString()} />
            <St k="PDA" v={report.pdaChecks.toLocaleString()} />
            <St k="LL(1)" v={report.ll1Checks.toLocaleString()} />
            <St k="time" v={`${report.elapsedMs.toFixed(0)} ms`} />
          </div>
          {report.failure && (
            <div className="fuzz-counter">
              <h3>Counterexample</h3>
              <pre className="cfg-grammar-pre">{report.failure.grammar}</pre>
              <span className="learn-fail-reason">{report.failure.detail}</span>
            </div>
          )}
        </>
      )}
    </>
  );
}

function St({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
