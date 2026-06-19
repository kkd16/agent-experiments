// The Pipeline & performance tab.
//
// It analyzes the loaded program with the trace-driven microarchitecture timing models and shows
// headline cycles/CPI/IPC, a stall (or bottleneck) breakdown, branch-prediction accuracy, cache
// statistics, and a per-instruction diagram. A mode toggle switches between two engines that read
// the *same* retired trace: the classic **5-stage in-order** pipeline and a from-scratch
// **out-of-order superscalar** core (Tomasulo dynamic scheduling + a reorder buffer + a load/store
// queue). All knobs re-run the selected model live. The functional interpreter is never touched —
// this is a pure analysis of its retired trace.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AssembleResult } from '../vm/assembler';
import { captureTrace, comparePredictors, defaultConfig, DEFAULT_ICACHE, DEFAULT_DCACHE } from '../perf/analyze';
import { simulate } from '../perf/pipeline';
import type { DiagramRow, PipelineConfig } from '../perf/pipeline';
import { simulateOoo, defaultOooConfig } from '../perf/ooo';
import type { OooConfig, OooResult, OooDiagramRow, FuClass } from '../perf/ooo';
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

/** The OoO engine is heavier than the in-order recurrence; cap its trace so knobs stay snappy. */
const OOO_TRACE_CAP = 80_000;

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
  const [mode, setMode] = useState<'inorder' | 'ooo'>('inorder');
  const [config, setConfig] = useState<PipelineConfig>(defaultConfig);
  const [ooo, setOoo] = useState<OooConfig>(() => defaultOooConfig(DEFAULT_ICACHE, DEFAULT_DCACHE));
  const set = (patch: Partial<PipelineConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const setO = (patch: Partial<OooConfig>) => setOoo((c) => ({ ...c, ...patch }));

  // Capture the retired trace once per assembled program (this runs the interpreter to
  // completion on a throwaway CPU). Re-runs only when the program identity changes.
  const captured = useMemo(() => {
    if (!assembly || !assembly.ok) return null;
    return captureTrace(assembly);
  }, [assembly]);

  // The in-order timing model is a fast pure function of (trace, config).
  const result = useMemo(() => {
    if (!captured) return null;
    return simulate(captured.trace, config);
  }, [captured, config]);

  const comparison = useMemo(() => {
    if (!captured) return [];
    return comparePredictors(captured.trace, config.predictorEntries, config.ghistBits, config.btbSets);
  }, [captured, config.predictorEntries, config.ghistBits, config.btbSets]);

  // The out-of-order model + an in-order baseline computed on the SAME (possibly capped) prefix,
  // so the reported speed-up is apples-to-apples.
  const oooSlice = useMemo(() => {
    if (!captured) return null;
    const trace = captured.trace.length > OOO_TRACE_CAP ? captured.trace.slice(0, OOO_TRACE_CAP) : captured.trace;
    return { trace, capped: captured.trace.length > OOO_TRACE_CAP };
  }, [captured]);

  const oooResult = useMemo(() => {
    if (!oooSlice) return null;
    return simulateOoo(oooSlice.trace, ooo);
  }, [oooSlice, ooo]);

  const oooBaseline = useMemo(() => {
    if (!oooSlice) return null;
    return simulate(oooSlice.trace, defaultConfig());
  }, [oooSlice]);

  const oooComparison = useMemo(() => {
    if (!oooSlice) return [];
    return comparePredictors(oooSlice.trace, ooo.predictorEntries, ooo.ghistBits, ooo.btbSets);
  }, [oooSlice, ooo.predictorEntries, ooo.ghistBits, ooo.btbSets]);

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

  const applyOooPreset = (w: 1 | 2 | 4 | 8) => {
    setOoo((c) => ({
      ...c,
      width: w,
      issueWidth: w,
      aluUnits: Math.max(2, w),
      fpAddUnits: Math.max(1, w >> 1),
      memUnits: Math.max(1, w >> 1),
      robSize: w <= 1 ? 16 : w <= 2 ? 32 : w <= 4 ? 64 : 128,
      iqSize: w <= 1 ? 8 : w <= 2 ? 16 : w <= 4 ? 32 : 64,
      lsqSize: w <= 1 ? 8 : w <= 2 ? 12 : w <= 4 ? 16 : 32,
    }));
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
        <div className="perf-modes" role="tablist" aria-label="timing model">
          <button className={mode === 'inorder' ? 'on' : ''} onClick={() => setMode('inorder')}>
            5-stage in-order
          </button>
          <button className={mode === 'ooo' ? 'on' : ''} onClick={() => setMode('ooo')}>
            Out-of-order superscalar
          </button>
        </div>
        <button onClick={onReassemble} title="Re-assemble the current source and re-analyze">
          ↻ re-run
        </button>
      </div>

      {mode === 'inorder' ? (
        <InorderView
          assembly={assembly}
          captured={captured}
          result={result}
          comparison={comparison}
          config={config}
          set={set}
          applyPreset={applyPreset}
        />
      ) : (
        <OooView
          assembly={assembly}
          captured={captured}
          capped={oooSlice?.capped ?? false}
          result={oooResult}
          baseline={oooBaseline}
          comparison={oooComparison}
          config={ooo}
          setO={setO}
          applyOooPreset={applyOooPreset}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ in-order view */

function InorderView({
  assembly,
  captured,
  result,
  comparison,
  config,
  set,
  applyPreset,
}: {
  assembly: AssembleResult;
  captured: ReturnType<typeof captureTrace> | null;
  result: ReturnType<typeof simulate> | null;
  comparison: ReturnType<typeof comparePredictors>;
  config: PipelineConfig;
  set: (patch: Partial<PipelineConfig>) => void;
  applyPreset: (p: 'ideal' | 'scalar' | 'pipeline') => void;
}) {
  return (
    <>
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
            <PredictorTable comparison={comparison} selected={config.predictor} branches={result.branches} jumps={result.jumps}>
              {(result.predictor.directionMisses > 0 || result.predictor.targetMisses > 0) && (
                <p className="muted small">
                  selected predictor mispredicts: {n(result.predictor.directionMisses)} direction, {n(result.predictor.targetMisses)} target (BTB).
                </p>
              )}
            </PredictorTable>
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
    </>
  );
}

/* ------------------------------------------------------------------ out-of-order view */

const FU_LABELS: Record<FuClass, string> = {
  alu: 'ALU',
  mul: 'integer mul',
  div: 'integer div',
  fpadd: 'FP add',
  fpmul: 'FP mul',
  fpdiv: 'FP div/sqrt',
  mem: 'load/store',
};

function OooView({
  assembly,
  captured,
  capped,
  result,
  baseline,
  comparison,
  config,
  setO,
  applyOooPreset,
}: {
  assembly: AssembleResult;
  captured: ReturnType<typeof captureTrace> | null;
  capped: boolean;
  result: OooResult | null;
  baseline: ReturnType<typeof simulate> | null;
  comparison: ReturnType<typeof comparePredictors>;
  config: OooConfig;
  setO: (patch: Partial<OooConfig>) => void;
  applyOooPreset: (w: 1 | 2 | 4 | 8) => void;
}) {
  const speedup = result && baseline && result.cycles > 0 ? baseline.cycles / result.cycles : 0;
  return (
    <>
      {/* ---- configuration ---- */}
      <div className="perf-config">
        <div className="perf-presets">
          <span className="perf-label">width</span>
          {([1, 2, 4, 8] as const).map((w) => (
            <button key={w} className={config.width === w ? 'on' : ''} onClick={() => applyOooPreset(w)}>
              {w}-wide
            </button>
          ))}
        </div>
        <div className="perf-knobs">
          <label>
            ROB
            <select value={config.robSize} onChange={(e) => setO({ robSize: +e.target.value })}>
              {[8, 16, 32, 64, 128, 256].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            RS / IQ
            <select value={config.iqSize} onChange={(e) => setO({ iqSize: +e.target.value })}>
              {[4, 8, 16, 32, 64].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            LSQ
            <select value={config.lsqSize} onChange={(e) => setO({ lsqSize: +e.target.value })}>
              {[4, 8, 16, 32].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            ALUs
            <select value={config.aluUnits} onChange={(e) => setO({ aluUnits: +e.target.value })}>
              {[1, 2, 3, 4, 6].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            mem ports
            <select value={config.memUnits} onChange={(e) => setO({ memUnits: +e.target.value })}>
              {[1, 2, 3, 4].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            memory
            <select value={config.memModel} onChange={(e) => setO({ memModel: e.target.value as OooConfig['memModel'] })}>
              <option value="disambiguate">disambiguate + forward</option>
              <option value="inorder">in-order memory</option>
            </select>
          </label>
          <label>
            predictor
            <select value={config.predictor} onChange={(e) => setO({ predictor: e.target.value as PredictorKind })}>
              {(Object.keys(PREDICTOR_LABELS) as PredictorKind[]).map((k) => (
                <option key={k} value={k}>{PREDICTOR_LABELS[k]}</option>
              ))}
            </select>
          </label>
          <label>
            mispred.
            <select value={config.mispredictPenalty} onChange={(e) => setO({ mispredictPenalty: +e.target.value })}>
              {[2, 4, 8, 12].map((v) => (
                <option key={v} value={v}>{v} cyc</option>
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
                setO({ mulCycles: mul, divCycles: div });
              }}
            >
              <option value={2}>fast (1/2)</option>
              <option value={20}>typical (3/20)</option>
              <option value={40}>slow (6/40)</option>
            </select>
          </label>
          <label>
            miss pen.
            <select value={config.missPenalty} onChange={(e) => setO({ missPenalty: +e.target.value })}>
              {[4, 10, 20, 50, 100].map((v) => (
                <option key={v} value={v}>{v} cyc</option>
              ))}
            </select>
          </label>
        </div>
        <div className="perf-caches">
          <CacheControls label="I-cache" value={config.icache} onChange={(c) => setO({ icache: c })} />
          <CacheControls label="D-cache" value={config.dcache} onChange={(c) => setO({ dcache: c })} />
        </div>
      </div>

      {!captured || !result || result.instructions === 0 ? (
        <p className="muted perf-empty">
          {assembly.ok ? 'The program retired no instructions.' : 'Fix the assembler errors first.'}
        </p>
      ) : (
        <div className="perf-body">
          {capped && (
            <div className="perf-note">ⓘ the out-of-order model analyzes the first {n(result.instructions)} retired instructions (it is heavier than the in-order recurrence); the in-order tab covers the full trace.</div>
          )}
          {result.bailed && (
            <div className="perf-note">⚠ the scheduler hit its safety cycle-cap; numbers are approximate.</div>
          )}

          {/* ---- headline metrics ---- */}
          <div className="perf-cards">
            <Metric label="instructions" value={n(result.instructions)} />
            <Metric label="cycles" value={n(result.cycles)} accent />
            <Metric label="IPC" value={result.ipc.toFixed(3)} accent sub={`CPI ${result.cpi.toFixed(3)}`} />
            <Metric
              label="speed-up"
              value={speedup ? `${speedup.toFixed(2)}×` : '—'}
              sub={baseline ? `vs in-order ${baseline.ipc.toFixed(2)} IPC` : undefined}
            />
            <Metric label="avg in flight" value={result.avgRobOccupancy.toFixed(1)} sub={`peak ${result.maxRobOccupancy}/${config.robSize}`} />
            <Metric
              label="branch acc."
              value={result.predictor.total ? pct(result.predictor.accuracy) : '—'}
              sub={`${n(result.predictor.misses)} miss / ${n(result.predictor.total)}`}
            />
            {result.dcacheStats && (
              <Metric label="D$ miss" value={pct(result.dcacheStats.missRate)} sub={`${n(result.dcacheStats.misses)} / ${n(result.dcacheStats.accesses)}`} />
            )}
          </div>

          {/* ---- ILP / scheduling stats ---- */}
          <section className="perf-section">
            <h3>Dynamic scheduling <span className="perf-sub">· what the window is doing</span></h3>
            <div className="ooo-stats">
              <Stat label="avg ROB occupancy" value={result.avgRobOccupancy.toFixed(1)} />
              <Stat label="peak occupancy" value={`${result.maxRobOccupancy} / ${config.robSize}`} />
              <Stat label="avg issue delay" value={`${result.avgIssueDelay.toFixed(2)} cyc`} />
              <Stat label="loads / stores" value={`${n(result.loads)} / ${n(result.stores)}`} />
              <Stat label="store→load forwards" value={n(result.storeForwards)} />
              <Stat label="memory-order stalls" value={`${n(result.memOrderStalls)} cyc`} />
            </div>
          </section>

          {/* ---- bottleneck (dispatch stall) breakdown ---- */}
          <BottleneckBar result={result} />

          {/* ---- functional-unit utilization ---- */}
          {result.fuUtil.length > 0 && (
            <section className="perf-section">
              <h3>Functional-unit utilization</h3>
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>unit</th>
                    <th>copies</th>
                    <th>ops</th>
                    <th>busy (unit·cyc)</th>
                    <th>utilization</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.fuUtil.map((u) => (
                    <tr key={u.cls}>
                      <td>{FU_LABELS[u.cls]}</td>
                      <td className="num">{u.units}</td>
                      <td className="num">{n(u.ops)}</td>
                      <td className="num">{n(u.busy)}</td>
                      <td className="num">{pct(u.utilization)}</td>
                      <td className="bar-cell">
                        <span className={`acc-bar fu-${u.cls}`} style={{ width: `${Math.min(100, u.utilization * 100)}%` }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* ---- branch predictor comparison ---- */}
          {result.predictor.total > 0 && (
            <PredictorTable comparison={comparison} selected={config.predictor} branches={result.branches} jumps={result.jumps} />
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

          {/* ---- instruction-lifetime (Gantt) diagram ---- */}
          <section className="perf-section">
            <h3>
              Instruction lifetime <span className="perf-sub">· first {n(result.diagram.length)} instructions{result.diagramTruncated ? ' (of more)' : ''}</span>
            </h3>
            <OooDiagram rows={result.diagram} />
            <p className="muted small perf-legend">
              <Chip cls="ph-fetch">F</Chip> fetch/decode
              <Chip cls="ph-rs">RS</Chip> reservation station
              <Chip cls="ph-ex">X</Chip> executing
              <Chip cls="ph-rob">R</Chip> ROB (done, awaiting commit)
              <Chip cls="ph-commit">C</Chip> commit
              <span className="held-key">⚡ mispredict · ⇄ store-forward · • cache miss</span>
            </p>
          </section>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ shared sub-components */

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`perf-card${accent ? ' accent' : ''}`}>
      <div className="perf-card-val">{value}</div>
      <div className="perf-card-lbl">{label}</div>
      {sub && <div className="perf-card-sub">{sub}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ooo-stat">
      <span className="ooo-stat-val">{value}</span>
      <span className="ooo-stat-lbl">{label}</span>
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

function PredictorTable({
  comparison,
  selected,
  branches,
  jumps,
  children,
}: {
  comparison: ReturnType<typeof comparePredictors>;
  selected: PredictorKind;
  branches: number;
  jumps: number;
  children?: ReactNode;
}) {
  return (
    <section className="perf-section">
      <h3>Branch prediction <span className="perf-sub">· {n(branches)} branches, {n(jumps)} jumps</span></h3>
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
            <tr key={c.kind} className={c.kind === selected ? 'on' : ''}>
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
      {children}
    </section>
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

function BottleneckBar({ result }: { result: OooResult }) {
  const b = result.bottleneck;
  const segs: { key: string; label: string; v: number; cls: string }[] = [
    { key: 'rob', label: 'ROB full', v: b.robFull, cls: 'sg-control' },
    { key: 'iq', label: 'RS full', v: b.iqFull, cls: 'sg-fu' },
    { key: 'lsq', label: 'LSQ full', v: b.lsqFull, cls: 'sg-dcache' },
    { key: 'front', label: 'front-end starved', v: b.frontEnd, cls: 'sg-icache' },
    { key: 'noissue', label: 'no ready op / unit busy', v: b.noIssue, cls: 'sg-data' },
  ];
  const sum = segs.reduce((a, g) => a + g.v, 0);
  const flowing = Math.max(0, result.cycles - sum);
  const total = Math.max(1, result.cycles);
  return (
    <section className="perf-section">
      <h3>Where dispatch stalls <span className="perf-sub">· cycles dispatch / issue lost, and why</span></h3>
      <div className="stall-bar">
        <span className="stall-seg sg-useful" style={{ width: `${(flowing / total) * 100}%` }} title={`flowing ≈ ${n(flowing)} cyc`} />
        {segs.filter((g) => g.v > 0).map((g) => (
          <span key={g.key} className={`stall-seg ${g.cls}`} style={{ width: `${(g.v / total) * 100}%` }} title={`${g.label}: ${n(g.v)} cyc`} />
        ))}
      </div>
      <div className="stall-legend">
        <span className="stall-key"><i className="sg-useful" />flowing ≈ {n(flowing)}</span>
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

/** One cell of the OoO instruction-lifetime diagram. */
function oooPhaseAt(r: OooDiagramRow, c: number): { ph: string; label: string } | null {
  if (c >= r.fetch && c < r.dispatch) return { ph: 'ph-fetch', label: c === r.fetch ? 'F' : '' };
  if (c >= r.dispatch && c < r.issue) return { ph: 'ph-rs', label: c === r.dispatch ? 'RS' : '' };
  if (c >= r.issue && c < r.complete) return { ph: `ph-ex fu-${r.fuClass}`, label: c === r.issue ? 'X' : '' };
  if (c >= r.complete && c < r.commit) return { ph: 'ph-rob', label: c === r.complete ? 'R' : '' };
  if (c === r.commit) return { ph: 'ph-commit', label: 'C' };
  return null;
}

function OooDiagram({ rows }: { rows: OooDiagramRow[] }) {
  if (rows.length === 0) return null;
  const maxCycle = Math.min(DIAGRAM_CYCLE_CAP, rows.reduce((m, r) => Math.max(m, r.commit), 0) + 1);
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
          {rows.map((r) => {
            const flags = `${r.forwarded ? ' ⇄' : ''}${r.dMiss || r.iMiss ? ' •' : ''}`;
            return (
              <tr key={r.index}>
                <th className="dg-instr" title={`pc=0x${(r.pc >>> 0).toString(16)} · ${FU_LABELS[r.fuClass]}`}>
                  <span className="dg-idx">{r.index}</span>
                  <span className={`dg-mn${r.mispredicted ? ' mispred' : ''}`}>{r.mnemonic}</span>
                  {flags && <span className="dg-flags">{flags}</span>}
                </th>
                {cycles.map((c) => {
                  const cell = oooPhaseAt(r, c);
                  if (!cell) return <td key={c} className="dg-cell" />;
                  return (
                    <td key={c} className={`dg-cell ${cell.ph}`}>
                      {cell.label}
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
