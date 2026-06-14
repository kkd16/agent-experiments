// React binding around the (mutable) Cpu. The CPU instance lives in React state (its identity
// never changes, so this is just a stable holder); UI re-renders are driven by bumping a
// `tick` counter after every mutation. This keeps the hot execution path free of React
// overhead while still letting the inspector reflect machine state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cpu } from '../vm/cpu';
import { assemble } from '../vm/assembler';
import type { AssembleResult } from '../vm/assembler';
import { STEPS_PER_FRAME, DEFAULT_MAX_STEPS } from '../vm/constants';

export interface VM {
  source: string;
  setSource: (s: string) => void;
  cpu: Cpu;
  assembly: AssembleResult | null;
  /** Bumps on every state change; components read it to stay in sync. */
  tick: number;
  running: boolean;
  /** Register values captured before the most recent step/run, for diff highlighting. */
  prevRegs: Int32Array;
  breakpointLines: ReadonlySet<number>;
  currentLine: number | null;
  /** How many instructions can be reverted with `stepBack()` (time-travel depth). */
  historyDepth: number;
  assembleOnly: () => AssembleResult;
  load: () => boolean;
  loadSource: (src: string) => void;
  step: () => void;
  stepBack: () => void;
  run: () => void;
  stop: () => void;
  reset: () => void;
  toggleBreakpoint: (line: number) => void;
  clearBreakpoints: () => void;
}

export function useVM(initialSource: string): VM {
  const [source, setSource] = useState(initialSource);
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [assembly, setAssembly] = useState<AssembleResult | null>(null);
  const [breakpointLines, setBreakpointLines] = useState<ReadonlySet<number>>(new Set());

  // The Cpu and the register snapshot are stable holders kept in state (never re-created),
  // so they can be read during render without tripping the refs-in-render rule.
  const [cpu] = useState(() => new Cpu());
  const [prevRegs, setPrevRegs] = useState<Int32Array>(() => new Int32Array(32));

  const loadedSourceRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const breakpointAddrsRef = useRef<ReadonlySet<number>>(new Set());

  const bump = useCallback(() => setTick((t) => t + 1), []);
  const snapshot = useCallback(() => setPrevRegs(cpu.regs.slice()), [cpu]);

  // Map breakpoint *lines* to *addresses* using the current assembly.
  const breakpointAddrs = useMemo(() => {
    const set = new Set<number>();
    if (assembly) {
      for (const line of breakpointLines) {
        const addr = assembly.lineToAddr.get(line);
        if (addr !== undefined) set.add(addr >>> 0);
      }
    }
    return set;
  }, [assembly, breakpointLines]);

  // Keep the run loop's view of breakpoints fresh without touching a ref during render.
  useEffect(() => {
    breakpointAddrsRef.current = breakpointAddrs;
  }, [breakpointAddrs]);

  const assembleOnly = useCallback((): AssembleResult => {
    const result = assemble(source);
    setAssembly(result);
    return result;
  }, [source]);

  const load = useCallback((): boolean => {
    const result = assemble(source);
    setAssembly(result);
    if (!result.ok) {
      loadedSourceRef.current = null;
      return false;
    }
    cpu.load(result);
    loadedSourceRef.current = source;
    snapshot();
    bump();
    return true;
  }, [source, cpu, snapshot, bump]);

  const cancelRun = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setRunning(false);
  }, []);

  /** Set the editor source and load it in one step (used by the example picker). */
  const loadSource = useCallback(
    (src: string) => {
      cancelRun();
      setSource(src);
      const result = assemble(src);
      setAssembly(result);
      if (result.ok) {
        cpu.load(result);
        loadedSourceRef.current = src;
        setPrevRegs(cpu.regs.slice());
      } else {
        loadedSourceRef.current = null;
      }
      bump();
    },
    [cpu, cancelRun, bump],
  );

  /** Ensure the CPU reflects the current source; reload if the text changed or it halted. */
  const ensureFresh = useCallback((): boolean => {
    if (loadedSourceRef.current !== source || cpu.isStopped()) {
      return load();
    }
    if (!assembly) setAssembly(assemble(source));
    return true;
  }, [source, cpu, load, assembly]);

  const step = useCallback(() => {
    if (!ensureFresh()) return;
    if (cpu.isStopped()) return;
    snapshot();
    cpu.step();
    bump();
  }, [ensureFresh, cpu, snapshot, bump]);

  /** Time-travel: revert exactly one executed instruction. */
  const stepBack = useCallback(() => {
    if (runningRef.current) return;
    if (cpu.historyDepth() === 0) return;
    snapshot();
    cpu.stepBack();
    bump();
  }, [cpu, snapshot, bump]);

  const stop = useCallback(() => {
    cancelRun();
    cpu.pause();
    bump();
  }, [cancelRun, cpu, bump]);

  const run = useCallback(() => {
    if (!ensureFresh()) return;
    if (cpu.isStopped()) return;
    snapshot();
    runningRef.current = true;
    setRunning(true);

    const frame = () => {
      if (!runningRef.current) return;
      cpu.run(STEPS_PER_FRAME, breakpointAddrsRef.current);
      bump();
      const done = cpu.isStopped() || cpu.status === 'paused' || cpu.cycles >= DEFAULT_MAX_STEPS;
      if (done) {
        runningRef.current = false;
        setRunning(false);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [ensureFresh, cpu, snapshot, bump]);

  const reset = useCallback(() => {
    cancelRun();
    load(); // reassemble + reload so edits take effect and state is clean
  }, [cancelRun, load]);

  const toggleBreakpoint = useCallback((line: number) => {
    setBreakpointLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }, []);

  const clearBreakpoints = useCallback(() => setBreakpointLines(new Set()), []);

  // Recomputed every render (cheap); a `tick` bump on each mutation re-renders this hook so
  // the highlighted line follows the pc as we step.
  const currentLine = assembly ? (assembly.addrToLine.get(cpu.pc >>> 0) ?? null) : null;

  // Recomputed each render; `tick` bumps on every mutation so this stays current.
  const historyDepth = cpu.historyDepth();

  return {
    source,
    setSource,
    cpu,
    assembly,
    tick,
    running,
    prevRegs,
    breakpointLines,
    currentLine,
    historyDepth,
    assembleOnly,
    load,
    loadSource,
    step,
    stepBack,
    run,
    stop,
    reset,
    toggleBreakpoint,
    clearBreakpoints,
  };
}
