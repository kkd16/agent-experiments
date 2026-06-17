// The Pipeline & performance tab.
//
// It analyzes the loaded program with the trace-driven microarchitecture timing model and shows
// headline cycles/CPI, a stall breakdown, branch-prediction accuracy (with an all-predictors
// comparison), I/D cache statistics, and the textbook instruction × cycle pipeline diagram. All
// knobs (forwarding, predictor, resolve stage, FU latencies, cache geometry) re-run the model
// live. The functional interpreter is never touched — this is a pure analysis of its retired
// trace.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AssembleResult } from '../vm/assembler';
import { captureTrace, comparePredictors, defaultConfig } from '../perf/analyze';
import { simulate } from '../perf/pipeline';
import type { DiagramRow, PipelineConfig } from '../perf/pipeline';
import type { CacheConfig } from '../perf/cache';
import type { PredictorKind } from '../perf/predictor';

interface Props {
  assembly: AssembleResult | null;
  onReassemble: () => void;
}

const PREDICTOR_LABELS: Record<PredictorKind, string> = {
  'not-taken': 'Static not-taken',
  taken: 'Static taken',
  'one-bit': '1-bit',
  'two-bit': '2-bit bimodal',
  gshare: 'gshare',
};

const DIAGRAM_CYCLE_CAP = 180;
const STAGE_COLORS: Record<string, string> = {
  IF: 'st-if',
  ID: 'st-id',
  EX: 'st-ex',
  MEM: 'st-mem',
  WB: 'st-wb',
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function n(x: number): string {
  return x.toLocaleString();
}

function stageAt(r: DiagramRow, c: number): { stage: string; held: boolean } | null {
  const e = r.enter;
  if (c >= e.if && c < e.id) return { stage: 'IF', held: c > e.if };
  if (c >= e.id && c < e.ex) return { stage: 'ID', held: c > e.id };
  if (c >= e.ex && c < e.mem) return { stage: 'EX', held: c > e.ex };
  if (c >= e.mem && c < e.wb) return { stage: 'MEM', held: c > e.mem };
  if (c === e.wb) return { stage: 'WB', held: false };
  return null;
}

/** A compact cache geometry editor. */
function CacheControls({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CacheConfig | null;
  onChange: (c: CacheConfig | null) => void;
}) {
  const enabled = value !== null;
  const c = value ?? defaultConfig().dcache!;
  const set = (patch: Partial<CacheConfig>) => onChange({ ...c, ...patch });
  return (
    <div className="perf-cache">
      <label className="perf-cache-head">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? c : null)}
        />
        {label}
      </label>
      {enabled && (
        <div className="perf-cache-grid">
          <label>
            size
            <select value={c.sizeBytes} onChange={(e) => set({ sizeBytes: +e.target.value })}>
              {[256, 512, 1024, 2048, 4096, 8192, 16384].map((v) => (
                <option key={v} value={v}>
                  {v >= 1024 ? `${v / 1024} KiB` : `${v} B`}
                </option>
              ))}
            </select>
          </label>
          <label>
            block
            <select value={c.blockBytes} onChange={(e) => set({ blockBytes: +e.target.value })}>
              {[8, 16, 32, 64].map((v) => (
                <option key={v} value={v}>
                  {v} B
                </option>
              ))}
            </select>
          </label>
          <label>
            ways
            <select value={c.ways} onChange={(e) => set({ ways: +e.target.value })}>
              {[1, 2, 4, 8].map((v) => (
                <option key={v} value={v}>
                  {v === 1 ? 'direct' : `${v}-way`}
                </option>
              ))}
            </select>
          </label>
          <label>
            evict
            <select value={c.replace} onChange={(e) => set({ replace: e.target.value as CacheConfig['replace'] })}>
              <option value="lru">LRU</option>
              <option value="fifo">FIFO</option>
            </select>
          </label>
          <label>
            write
            <select value={c.writeBack ? 'wb' : 'wt'} onChange={(e) => set({ writeBack: e.target.value === 'wb' })}>
              <option value="wb">back/alloc</option>
              <option value="wt">through</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export default function Perf({ assembly, onReassemble }: Props) {
  const [config, setConfig] = useState<PipelineConfig>(defaultConfig);
  const set = (patch: Partial<PipelineConfig>) => setConfig((c) => ({ ...c, ...patch }));

  // Capture the retired trace once per assembled program (this runs the interpreter to
  // completion on a throwaway CPU). Re-runs only when the program identity changes.
  const captured = useMemo(() => {
    if (!assembly || !assembly.ok) return null;
    return captureTrace(assembly);
  }, [assembly]);

  // The timing model is a fast pure function of (trace, config) — recompute on any knob change.
  const result = useMemo(() => {
    if (!captured) return null;
    return simulate(captured.trace, config);
  }, [captured, config]);

  const comparison = useMemo(() => {
    if (!captured) return [];
    return comparePredictors(captured.trace, config.predictorEntries, config.ghistBits, config.btbSets);
  }, [captured, config.predictorEntries, config.ghistBits, config.btbSets]);

  const applyPreset = (preset: 'ideal' | 'scalar' | 'pipeline') => {
    const base = defaultConfig();
    if (preset === 'ideal') {
      set({
        ...base,
        forwarding: true,
        branchResolve: 'ID',
        predictor: 'gshare',
        mulCycles: 1,
        divCycles: 1,
        fpAddCycles: 1,
        fpMulCycles: 1,
        fpDivCycles: 1,
        icache: null,
        dcache: null,
      });
    } else if (preset === 'scalar') {
      set({ ...base, forwarding: false, branchResolve: 'EX', predictor: 'not-taken' });
    } else {
      set({ ...base });
    }
  };

  if (!assembly) {
    return (
      <div className="panel perf">
        <div className="panel-head">
          <h2>Pipeline &amp; performance</h2>
        </div>
        <p className="muted perf-empty">Load or assemble a program, then re-run the analysis.</p>
      </div>
    );
  }

  return (
    <div className="panel perf">
      <div className="panel-head">
        <h2>Pipeline &amp; performance</h2>
        <button onClick={onReassemble} title="Re-assemble the current source and re-analyze">
          ↻ re-run
        </button>
      </div>

      {/* ---- configuration ---- */}
      <div className="perf-config">
        <div className="perf-presets">
          <span className="perf-label">presets</span>
          <button onClick={() => applyPreset('ideal')}>Ideal core</button>
          <button onClick={() => applyPreset('pipeline')}>Default</button>
          <button onClick={() => applyPreset('scalar')}>No forwarding</button>
        </div>
        <div className="perf-knobs">
          <label className="perf-toggle">
            <input type="checkbox" checked={config.forwarding} onChange={(e) => set({ forwarding: e.target.checked })} />
            data forwarding
          </label>
          <label>
            resolve
            <select value={config.branchResolve} onChange={(e) => set({ branchResolve: e.target.value as 'ID' | 'EX' })}>
              <option value="ID">in ID (1-cyc)</option>
              <option value="EX">in EX (2-cyc)</option>
            </select>
          </label>
          <label>
            predictor
            <select value={config.predictor} onChange={(e) => set({ predictor: e.target.value as PredictorKind })}>
              {(Object.keys(PREDICTOR_LABELS) as PredictorKind[]).map((k) => (
                <option key={k} value={k}>
                  {PREDICTOR_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            BHT
            <select value={config.predictorEntries} onChange={(e) => set({ predictorEntries: +e.target.value })}>
              {[16, 64, 256, 1024, 4096].map((v) => (
                <option key={v} value={v}>
                  {v} entries
                </option>
              ))}
            </select>
          </label>
          <label>
            mul/div
            <select
              value={config.divCycles}
              onChange={(e) => {
                const div = +e.target.value;
                const mul = div <= 2 ? 1 : div <= 20 ? 3 : 6;
                set({ mulCycles: mul, divCycles: div });
              }}
            >
              <option value={2}>fast (1/2)</option>
              <option value={20}>typical (3/20)</option>
              <option value={40}>slow (6/40)</option>
            </select>
          </label>
          <label>
            miss pen.
            <select value={config.missPenalty} onChange={(e) => set({ missPenalty: +e.target.value })}>
              {[4, 10, 20, 50, 100].map((v) => (
                <option key={v} value={v}>
                  {v} cyc
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="perf-caches">
          <CacheControls label="I-cache" value={config.icache} onChange={(c) => set({ icache: c })} />
          <CacheControls label="D-cache" value={config.dcache} onChange={(c) => set({ dcache: c })} />
        </div>
      </div>

      {!captured || !result ? (
        <p className="muted perf-empty">
          {assembly.ok ? 'The program retired no instructions.' : 'Fix the assembler errors first.'}
        </p>
      ) : (
        <div className="perf-body">
          {captured.truncated && (
            <div className="perf-note">⚠ trace truncated at the {n(result.instructions)}-instruction cap; numbers cover the captured prefix.</div>
          )}
          {!captured.halted && !captured.truncated && (
            <div className="perf-note">ⓘ the program did not halt cleanly (ran off the end or errored); the captured trace is still analyzed.</div>
          )}

          {/* ---- headline metrics ---- */}
          <div className="perf-cards">
            <Metric label="instructions" value={n(result.instructions)} />
            <Metric label="cycles" value={n(result.cycles)} accent />
            <Metric label="CPI" value={result.cpi.toFixed(3)} accent />
            <Metric label="IPC" value={result.ipc.toFixed(3)} />
            <Metric
              label="branch acc."
              value={result.predictor.total ? pct(result.predictor.accuracy) : '—'}
              sub={`${n(result.predictor.misses)} miss / ${n(result.predictor.total)}`}
            />
            {result.icacheStats && (
              <Metric label="I$ miss" value={pct(result.icacheStats.missRate)} sub={`${n(result.icacheStats.misses)} / ${n(result.icacheStats.accesses)}`} />
            )}
            {result.dcacheStats && (
              <Metric label="D$ miss" value={pct(result.dcacheStats.missRate)} sub={`${n(result.dcacheStats.misses)} / ${n(result.dcacheStats.accesses)}`} />
            )}
          </div>

          {/* ---- stall breakdown ---- */}
          <StallBar result={result} />

          {/* ---- branch predictor comparison ---- */}
          {result.predictor.total > 0 && (
            <section className="perf-section">
              <h3>Branch prediction <span className="perf-sub">· {n(result.branches)} branches, {n(result.jumps)} jumps</span></h3>
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>predictor</th>
                    <th>accuracy</th>
                    <th>hits</th>
                    <th>misses</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((c) => (
                    <tr key={c.kind} className={c.kind === config.predictor ? 'on' : ''}>
                      <td>{PREDICTOR_LABELS[c.kind]}</td>
                      <td className="num">{pct(c.accuracy)}</td>
                      <td className="num">{n(c.hits)}</td>
                      <td className="num">{n(c.misses)}</td>
                      <td className="bar-cell">
                        <span className="acc-bar" style={{ width: `${c.accuracy * 100}%` }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(result.predictor.directionMisses > 0 || result.predictor.targetMisses > 0) && (
                <p className="muted small">
                  selected predictor mispredicts: {n(result.predictor.directionMisses)} direction, {n(result.predictor.targetMisses)} target (BTB).
                </p>
              )}
            </section>
          )}

          {/* ---- cache detail ---- */}
          {(result.icacheStats || result.dcacheStats) && (
            <section className="perf-section">
              <h3>Cache hierarchy</h3>
              <div className="perf-cache-stats">
                {result.icacheStats && <CacheCard title="I-cache" s={result.icacheStats} />}
                {result.dcacheStats && <CacheCard title="D-cache" s={result.dcacheStats} />}
              </div>
            </section>
          )}

          {/* ---- pipeline diagram ---- */}
          <section className="perf-section">
            <h3>
              Pipeline diagram <span className="perf-sub">· first {n(result.diagram.length)} instructions{result.diagramTruncated ? ' (of more)' : ''}</span>
            </h3>
            <Diagram rows={result.diagram} />
            <p className="muted small perf-legend">
              <Chip cls="st-if">IF</Chip><Chip cls="st-id">ID</Chip><Chip cls="st-ex">EX</Chip>
              <Chip cls="st-mem">MEM</Chip><Chip cls="st-wb">WB</Chip>
              <span className="held-key">▒ held (stall / multi-cycle)</span>
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`perf-card${accent ? ' accent' : ''}`}>
      <div className="perf-card-val">{value}</div>
      <div className="perf-card-lbl">{label}</div>
      {sub && <div className="perf-card-sub">{sub}</div>}
    </div>
  );
}

function Chip({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`stage-chip ${cls}`}>{children}</span>;
}

function CacheCard({ title, s }: { title: string; s: NonNullable<ReturnType<typeof simulate>['dcacheStats']> }) {
  return (
    <div className="perf-cache-card">
      <div className="perf-cache-title">{title}</div>
      <div className="perf-cache-rows">
        <span>accesses</span><span className="num">{n(s.accesses)}</span>
        <span>misses</span><span className="num">{n(s.misses)}</span>
        <span>miss rate</span><span className="num">{pct(s.missRate)}</span>
        <span>read miss</span><span className="num">{n(s.readMisses)}</span>
        <span>write miss</span><span className="num">{n(s.writeMisses)}</span>
        <span>writebacks</span><span className="num">{n(s.writebacks)}</span>
      </div>
    </div>
  );
}

function StallBar({ result }: { result: NonNullable<ReturnType<typeof simulate>> }) {
  const s = result.stalls;
  const segs: { key: string; label: string; v: number; cls: string }[] = [
    { key: 'data', label: 'data hazard', v: s.dataHazard, cls: 'sg-data' },
    { key: 'loaduse', label: 'load-use', v: s.loadUse, cls: 'sg-loaduse' },
    { key: 'control', label: 'control', v: s.control, cls: 'sg-control' },
    { key: 'icache', label: 'I$ miss', v: s.icache, cls: 'sg-icache' },
    { key: 'dcache', label: 'D$ miss', v: s.dcache, cls: 'sg-dcache' },
    { key: 'fu', label: 'FU latency', v: s.fuLatency, cls: 'sg-fu' },
    { key: 'struct', label: 'structural', v: s.structural, cls: 'sg-struct' },
  ];
  const useful = result.instructions; // ~1 cycle of useful work per instruction
  const total = Math.max(1, useful + segs.reduce((a, b) => a + b.v, 0));
  return (
    <section className="perf-section">
      <h3>Where the cycles go <span className="perf-sub">· categories can overlap when hazards stack</span></h3>
      <div className="stall-bar">
        <span className="stall-seg sg-useful" style={{ width: `${(useful / total) * 100}%` }} title={`useful work ≈ ${n(useful)} cyc`} />
        {segs.filter((g) => g.v > 0).map((g) => (
          <span key={g.key} className={`stall-seg ${g.cls}`} style={{ width: `${(g.v / total) * 100}%` }} title={`${g.label}: ${n(g.v)} cyc`} />
        ))}
      </div>
      <div className="stall-legend">
        <span className="stall-key"><i className="sg-useful" />useful ≈ {n(useful)}</span>
        {segs.filter((g) => g.v > 0).map((g) => (
          <span key={g.key} className="stall-key"><i className={g.cls} />{g.label} {n(g.v)}</span>
        ))}
      </div>
    </section>
  );
}

function Diagram({ rows }: { rows: DiagramRow[] }) {
  if (rows.length === 0) return null;
  const maxCycle = Math.min(DIAGRAM_CYCLE_CAP, rows.reduce((m, r) => Math.max(m, r.enter.wb), 0) + 1);
  const cycles = Array.from({ length: maxCycle }, (_, i) => i);
  return (
    <div className="diagram-scroll">
      <table className="diagram">
        <thead>
          <tr>
            <th className="dg-head">instr</th>
            {cycles.map((c) => (
              <th key={c} className="dg-cyc">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <th className="dg-instr" title={`pc=0x${(r.pc >>> 0).toString(16)}`}>
                <span className="dg-idx">{r.index}</span>
                <span className={`dg-mn${r.mispredicted ? ' mispred' : ''}`}>{r.mnemonic}</span>
              </th>
              {cycles.map((c) => {
                const cell = stageAt(r, c);
                if (!cell) return <td key={c} className="dg-cell" />;
                return (
                  <td key={c} className={`dg-cell ${STAGE_COLORS[cell.stage]}${cell.held ? ' held' : ''}`}>
                    {cell.held ? '' : cell.stage}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
