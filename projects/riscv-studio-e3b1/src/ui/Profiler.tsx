// The Profiler tab.
//
// A trace-driven dynamic profile of the loaded program: where does the time actually go? It runs
// the program on a throwaway CPU with the retire-tracer attached (the same seam the timing models
// use — the functional core is never touched), then shows a flamegraph of the reconstructed call
// stack, a per-function self/total cost table, a per-instruction annotated listing with an
// execution heatmap and coverage, a category breakdown, and the data-memory working set. All
// weights can be measured by retired-instruction *hits* (exact) or by a *modelled issue-cost*
// (one cycle per op plus multi-cycle FU latency, the same latencies the pipeline model uses).

import { useMemo, useState } from 'react';
import type { AssembleResult } from '../vm/assembler';
import { profile, PROFILE_CAP } from '../prof/profile';
import type { FlameNode, Site, FuncStat } from '../prof/profile';
import { layoutFlame, flameColor, flameDepth } from '../prof/flamegraph';
import type { FlameMetric, FlameRect } from '../prof/flamegraph';

interface Props {
  assembly: AssembleResult | null;
  onReassemble: () => void;
}

function n(x: number): string {
  return x.toLocaleString();
}
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function hex(x: number): string {
  return `0x${(x >>> 0).toString(16).padStart(8, '0')}`;
}

const CATEGORY_COLOR: Record<string, string> = {
  alu: '#5ec2ff',
  load: '#7ee787',
  store: '#46d369',
  branch: '#ffb454',
  jump: '#ffcb6b',
  muldiv: '#c792ea',
  float: '#f78c6c',
  vector: '#82d8ff',
  system: '#ff6b6b',
  other: '#8a96ad',
};

export default function Profiler({ assembly, onReassemble }: Props) {
  const [cap, setCap] = useState(PROFILE_CAP);
  const [metric, setMetric] = useState<FlameMetric>('cost');
  const [focus, setFocus] = useState<FlameNode | null>(null);
  const [hover, setHover] = useState<{ rect: FlameRect; x: number; y: number } | null>(null);
  const [funcMode, setFuncMode] = useState<'self' | 'total'>('self');
  const [listing, setListing] = useState<'hot' | 'all' | 'uncovered'>('hot');

  const prof = useMemo(() => profile(assembly, { cap }), [assembly, cap]);

  // The flamegraph re-lays out when the metric or zoom focus changes.
  const flameRoot = focus ?? prof.flame;
  const rects = useMemo(() => (prof.ok ? layoutFlame(flameRoot, metric) : []), [prof, flameRoot, metric]);
  const depth = flameDepth(rects);

  const weightOfSite = (s: Site) => (metric === 'cost' ? s.cost : s.hits);
  const totalWeight = metric === 'cost' ? prof.totalCost : prof.totalHits;
  const maxSiteWeight = useMemo(() => {
    let m = 0;
    for (const s of prof.sites) m = Math.max(m, metric === 'cost' ? s.cost : s.hits);
    return m || 1;
  }, [prof, metric]);

  if (!assembly) {
    return (
      <div className="panel prof">
        <div className="panel-head">
          <h2>Profiler</h2>
        </div>
        <p className="muted prof-empty">Assemble a program first — press ⚙ Assemble or ▶ Run.</p>
      </div>
    );
  }

  if (!prof.ok) {
    return (
      <div className="panel prof">
        <div className="panel-head">
          <h2>Profiler</h2>
          <button onClick={onReassemble}>re-assemble</button>
        </div>
        <p className="muted prof-empty">{prof.message}</p>
      </div>
    );
  }

  const ROW_H = 21;
  const svgH = (depth + 1) * ROW_H;

  // functions sorted for the table by the chosen mode/metric
  const funcRows = [...prof.functions].sort((a, b) => funcWeight(b, funcMode, metric) - funcWeight(a, funcMode, metric));

  // annotated listing rows
  const listRows = buildListRows(assembly, prof, listing);

  return (
    <div className="panel prof">
      <div className="panel-head">
        <h2>Profiler</h2>
        <button onClick={onReassemble} title="Re-assemble the current editor buffer and re-profile">
          re-profile
        </button>
      </div>

      {/* config */}
      <div className="prof-config">
        <div className="prof-seg" role="group" aria-label="weight metric">
          <span className="perf-label">weight by</span>
          <button className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')} title="Modelled issue-cost: 1 cycle/op + multi-cycle FU latency">
            cost
          </button>
          <button className={metric === 'hits' ? 'on' : ''} onClick={() => setMetric('hits')} title="Retired-instruction count (exact)">
            hits
          </button>
        </div>
        <label className="prof-cap">
          trace cap
          <select value={cap} onChange={(e) => setCap(+e.target.value)}>
            {[20_000, 60_000, 100_000, 300_000, 1_000_000].map((v) => (
              <option key={v} value={v}>
                {v.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      </div>

      {prof.truncated && (
        <div className="perf-note">
          ⚠ trace truncated at the {n(prof.traced)}-instruction cap; the profile covers the captured prefix.
        </div>
      )}
      {!prof.halted && !prof.truncated && (
        <div className="perf-note">ⓘ the program did not halt cleanly; the captured trace is still profiled.</div>
      )}

      <div className="prof-body">
        {/* headline cards */}
        <div className="perf-cards">
          <Metric label="retired" value={n(prof.traced)} accent />
          <Metric label={metric === 'cost' ? 'modelled cost' : 'total hits'} value={n(totalWeight)} accent />
          <Metric label="coverage" value={pct(prof.coverage)} sub={`${n(prof.distinctPcs)} / ${n(prof.staticInstrs)} instrs`} />
          <Metric label="functions" value={n(prof.functions.length)} />
          <Metric label="call depth" value={n(prof.maxDepth)} />
          <Metric label="hottest" value={funcRows[0]?.name ?? '—'} sub={funcRows[0] ? pct(funcWeight(funcRows[0], 'self', metric) / (totalWeight || 1)) + ' self' : undefined} />
        </div>

        {/* category breakdown */}
        <section className="prof-section">
          <h3>Instruction mix</h3>
          <CategoryBar prof={prof} metric={metric} />
        </section>

        {/* flamegraph */}
        <section className="prof-section">
          <div className="prof-section-head">
            <h3>Flamegraph — reconstructed call stack</h3>
            <div className="prof-flame-controls">
              {focus && (
                <button onClick={() => setFocus(null)} className="prof-reset">
                  ⤺ reset zoom ({prof.flame.func})
                </button>
              )}
              <span className="muted small">click a frame to zoom · width ∝ inclusive {metric}</span>
            </div>
          </div>
          <div className="prof-flame-wrap">
            <svg
              className="prof-flame"
              viewBox={`0 0 1000 ${svgH}`}
              width="100%"
              height={svgH}
              preserveAspectRatio="none"
              onMouseLeave={() => setHover(null)}
            >
              {rects.map((r, i) => {
                const x = r.x0 * 1000;
                const w = Math.max(0.4, (r.x1 - r.x0) * 1000);
                const y = r.depth * ROW_H;
                const hot = r.fraction >= 0.12;
                const showText = w > 34;
                return (
                  <g
                    key={`${r.depth}-${i}-${r.func}`}
                    onClick={() => (r.node.children.length || r.depth > 0 ? setFocus(r.node) : undefined)}
                    onMouseMove={(e) => {
                      const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setHover({ rect: r, x: e.clientX - box.left, y: e.clientY - box.top });
                    }}
                    className="prof-frame"
                  >
                    <rect
                      x={x}
                      y={y + 0.5}
                      width={w}
                      height={ROW_H - 1}
                      fill={flameColor(r.colorIndex, hot)}
                      stroke="rgba(0,0,0,0.35)"
                      strokeWidth={0.5}
                    />
                    {showText && (
                      <text x={x + 3} y={y + ROW_H / 2 + 3.5} className="prof-frame-label" style={{ fontSize: 11 }}>
                        {clip(r.func, w)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {hover && (
              <div className="prof-tip" style={{ left: Math.min(hover.x + 12, 640), top: hover.y + 14 }}>
                <div className="prof-tip-fn">{hover.rect.func}</div>
                <div className="prof-tip-row">
                  <span>inclusive</span>
                  <b>
                    {n(metric === 'cost' ? hover.rect.totalCost : hover.rect.totalHits)} ({pct(hover.rect.fraction)})
                  </b>
                </div>
                <div className="prof-tip-row">
                  <span>self</span>
                  <b>{n(metric === 'cost' ? hover.rect.selfCost : hover.rect.selfHits)}</b>
                </div>
                <div className="prof-tip-row">
                  <span>entries</span>
                  <b>{n(hover.rect.node.entries)}</b>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* function table */}
        <section className="prof-section">
          <div className="prof-section-head">
            <h3>Functions</h3>
            <div className="prof-seg small" role="group" aria-label="sort functions">
              <span className="perf-label">rank by</span>
              <button className={funcMode === 'self' ? 'on' : ''} onClick={() => setFuncMode('self')}>
                self
              </button>
              <button className={funcMode === 'total' ? 'on' : ''} onClick={() => setFuncMode('total')}>
                total
              </button>
            </div>
          </div>
          <div className="prof-table-wrap">
            <table className="prof-table">
              <thead>
                <tr>
                  <th className="l">function</th>
                  <th>calls</th>
                  <th>self {metric}</th>
                  <th className="barcol">self %</th>
                  <th>total {metric}</th>
                  <th className="barcol">total %</th>
                </tr>
              </thead>
              <tbody>
                {funcRows.slice(0, 40).map((f) => {
                  const self = funcWeight(f, 'self', metric);
                  const total = funcWeight(f, 'total', metric);
                  return (
                    <tr key={f.name}>
                      <td className="l mono" title={hex(f.startPc)}>
                        {f.name}
                      </td>
                      <td>{n(f.calls)}</td>
                      <td>{n(self)}</td>
                      <td className="barcol">
                        <Bar frac={self / (totalWeight || 1)} color="var(--accent)" />
                      </td>
                      <td>{n(total)}</td>
                      <td className="barcol">
                        <Bar frac={total / (totalWeight || 1)} color="var(--accent-2)" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* annotated listing */}
        <section className="prof-section">
          <div className="prof-section-head">
            <h3>Annotated listing</h3>
            <div className="prof-seg small" role="group" aria-label="listing filter">
              <button className={listing === 'hot' ? 'on' : ''} onClick={() => setListing('hot')}>
                hottest
              </button>
              <button className={listing === 'all' ? 'on' : ''} onClick={() => setListing('all')}>
                all
              </button>
              <button className={listing === 'uncovered' ? 'on' : ''} onClick={() => setListing('uncovered')} title="Static instructions that never executed in this run">
                uncovered ({n(prof.uncovered.length)})
              </button>
            </div>
          </div>
          <div className="prof-listing">
            {listRows.length === 0 ? (
              <p className="muted small" style={{ padding: '0.5rem' }}>
                {listing === 'uncovered' ? 'Every instruction executed — 100% coverage. 🎉' : 'No instructions to show.'}
              </p>
            ) : (
              listRows.map((row) => {
                const w = row.site ? weightOfSite(row.site) : 0;
                const frac = w / maxSiteWeight;
                return (
                  <div key={row.addr} className={`prof-line${row.site ? '' : ' dead'}`}>
                    <span className="prof-line-heat" style={{ width: `${Math.round(frac * 100)}%`, background: heat(frac) }} />
                    <span className="prof-line-addr">{hex(row.addr)}</span>
                    <span className="prof-line-hits">{row.site ? n(weightOfSite(row.site)) : '·'}</span>
                    <span className="prof-line-src">{row.source}</span>
                    {row.site && row.site.isControl && (row.site.taken > 0 || row.site.notTaken > 0) && (
                      <span className="prof-line-tag">T {n(row.site.taken)} / N {n(row.site.notTaken)}</span>
                    )}
                    {!row.site && <span className="prof-line-tag dead">dead</span>}
                  </div>
                );
              })
            )}
          </div>
          <p className="muted small">
            heat bar ∝ {metric} at each site (relative to the hottest). {listing === 'hot' ? 'Showing the 60 hottest sites.' : listing === 'all' ? `All ${n(assembly.instrs.length)} static instructions.` : 'Instructions never reached in this run.'}
          </p>
        </section>

        {/* memory working set */}
        {prof.mem.distinct > 0 && (
          <section className="prof-section">
            <h3>Data working set</h3>
            <div className="perf-cards">
              <Metric label="reads" value={n(prof.mem.reads)} />
              <Metric label="writes" value={n(prof.mem.writes)} />
              <Metric label="distinct addrs" value={n(prof.mem.distinct)} />
              <Metric label="span" value={`${n(prof.mem.hi - prof.mem.lo + 1)} B`} sub={`${hex(prof.mem.lo)}…`} />
            </div>
            <MemHeat prof={prof} />
            <div className="prof-table-wrap">
              <table className="prof-table">
                <thead>
                  <tr>
                    <th className="l">hot address</th>
                    <th>accesses</th>
                    <th>reads</th>
                    <th>writes</th>
                    <th className="barcol">share</th>
                  </tr>
                </thead>
                <tbody>
                  {prof.mem.hot.slice(0, 12).map((m) => (
                    <tr key={m.addr}>
                      <td className="l mono">{hex(m.addr)}</td>
                      <td>{n(m.count)}</td>
                      <td>{n(m.reads)}</td>
                      <td>{n(m.writes)}</td>
                      <td className="barcol">
                        <Bar frac={m.count / (prof.mem.reads + prof.mem.writes || 1)} color="var(--warn)" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* call graph */}
        {prof.edges.length > 0 && (
          <section className="prof-section">
            <h3>Call graph</h3>
            <div className="prof-edges">
              {prof.edges.slice(0, 40).map((e) => (
                <span key={`${e.caller}->${e.callee}`} className="prof-edge">
                  <b>{e.caller}</b> → <b>{e.callee}</b>
                  <span className="prof-edge-n">×{n(e.count)}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        <p className="muted small prof-foot">
          The profiler is a pure function of the retired-instruction trace — the same opt-in tracer the timing
          models read. The functional interpreter is never touched, so results are byte-for-byte unchanged;
          only these measurements are new. “Cost” is a modelled issue-cost (1 cycle/op + multi-cycle FU latency),
          an intrinsic per-instruction weight — pairwise pipeline stalls and cache misses live in the Pipeline tab.
        </p>
      </div>
    </div>
  );
}

// --- helpers & sub-components -------------------------------------------------

function funcWeight(f: FuncStat, mode: 'self' | 'total', metric: FlameMetric): number {
  if (mode === 'self') return metric === 'cost' ? f.selfCost : f.selfHits;
  return metric === 'cost' ? f.totalCost : f.totalHits;
}

function clip(s: string, width: number): string {
  const max = Math.floor(width / 6.6);
  if (s.length <= max) return s;
  if (max <= 1) return '';
  return s.slice(0, max - 1) + '…';
}

/** A cool→hot gradient for the per-line/per-bucket heat. */
function heat(frac: number): string {
  const f = Math.max(0, Math.min(1, frac));
  // interpolate hue 210 (blue) → 12 (red) as it heats up
  const hue = 210 - f * 198;
  const light = 30 + f * 22;
  const alpha = 0.22 + f * 0.5;
  return `hsl(${hue} 85% ${light}% / ${alpha})`;
}

interface ListRow {
  addr: number;
  source: string;
  site: Site | null;
}

function buildListRows(assembly: AssembleResult, prof: ReturnType<typeof profile>, mode: 'hot' | 'all' | 'uncovered'): ListRow[] {
  const bySrc = new Map<number, string>();
  for (const ins of assembly.instrs) bySrc.set(ins.addr, ins.source.trim());
  if (mode === 'all') {
    return assembly.instrs.map((ins) => ({ addr: ins.addr, source: ins.source.trim(), site: prof.siteMap.get(ins.addr) ?? null }));
  }
  if (mode === 'uncovered') {
    return prof.uncovered.map((addr) => ({ addr, source: bySrc.get(addr) ?? '', site: null }));
  }
  // hottest: top 60 executed sites by cost
  return [...prof.sites]
    .sort((a, b) => b.cost - a.cost || b.hits - a.hits)
    .slice(0, 60)
    .map((s) => ({ addr: s.pc, source: bySrc.get(s.pc) ?? s.mnemonic, site: s }));
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`perf-card${accent ? ' accent' : ''}`}>
      <div className="perf-card-val prof-card-val">{value}</div>
      <div className="perf-card-lbl">{label}</div>
      {sub && <div className="perf-card-sub">{sub}</div>}
    </div>
  );
}

function Bar({ frac, color }: { frac: number; color: string }) {
  return (
    <div className="prof-bar">
      <span style={{ width: `${Math.max(1, Math.round(frac * 100))}%`, background: color }} />
      <em>{pct(frac)}</em>
    </div>
  );
}

function CategoryBar({ prof, metric }: { prof: ReturnType<typeof profile>; metric: FlameMetric }) {
  const total = metric === 'cost' ? prof.totalCost : prof.totalHits;
  const cats = prof.categories.filter((c) => (metric === 'cost' ? c.cost : c.hits) > 0);
  return (
    <div className="prof-catwrap">
      <div className="prof-cat">
        {cats.map((c) => {
          const w = (metric === 'cost' ? c.cost : c.hits) / (total || 1);
          return (
            <span
              key={c.name}
              className="prof-cat-seg"
              style={{ width: `${w * 100}%`, background: CATEGORY_COLOR[c.name] ?? '#8a96ad' }}
              title={`${c.name}: ${pct(w)}`}
            />
          );
        })}
      </div>
      <div className="prof-cat-legend">
        {cats.map((c) => {
          const w = (metric === 'cost' ? c.cost : c.hits) / (total || 1);
          return (
            <span key={c.name} className="prof-cat-key">
              <i style={{ background: CATEGORY_COLOR[c.name] ?? '#8a96ad' }} />
              {c.name} {pct(w)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MemHeat({ prof }: { prof: ReturnType<typeof profile> }) {
  const buckets = prof.mem.buckets;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="prof-memheat" title={`${prof.mem.bucketBytes} B per cell`}>
      {buckets.map((b) => (
        <span
          key={b.addr}
          className="prof-memcell"
          style={{ background: heat(b.count / max) }}
          title={`${hex(b.addr)} · ${n(b.count)} accesses (${n(b.reads)}r/${n(b.writes)}w)`}
        />
      ))}
    </div>
  );
}
