// React glue around the kernel: a play/pause/step/scrub controller with full
// time-travel, built as an external store read through useSyncExternalStore.
//
// Every mutation serializes the kernel into a bounded history ring, so the
// scrubber can restore any past instant exactly (the kernel is deterministic,
// so a restored state replays forward identically). Keeping the mutable engine
// in a plain store — rather than in React state — keeps renders clean and lets
// the animation loop run without churning component state.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Kernel } from '../sim/kernel';
import type { InvariantResult, NodeId, SimSnapshot } from '../sim/types';

const HISTORY_CAP = 1500;
const TIME_SCALE = 1; // real ms -> simulated ms (before the speed multiplier)

export interface SimView<S> {
  snapshot: SimSnapshot<S> | null;
  invariants: InvariantResult[];
  nodeOrder: NodeId[];
  playing: boolean;
  speed: number;
  cursor: number;
  historyLength: number;
  atHead: boolean;
}

class SimStore<S, Cmd> {
  private kernel: Kernel<S, Cmd>;
  private history: string[] = [];
  private cursor = 0;
  private playing = false;
  private speed = 1;
  private raf = 0;
  private lastTs: number | null = null;
  private listeners = new Set<() => void>();
  private view: SimView<S>;

  constructor(make: () => Kernel<S, Cmd>) {
    this.kernel = make();
    this.history = [this.kernel.serialize()];
    this.cursor = 0;
    this.view = this.computeView();
  }

  private computeView(): SimView<S> {
    const k = this.kernel;
    return {
      snapshot: k.snapshot(),
      invariants: k.protocol.invariants ? k.protocol.invariants(k.views()) : [],
      nodeOrder: [...k.nodeOrder],
      playing: this.playing,
      speed: this.speed,
      cursor: this.cursor,
      historyLength: this.history.length,
      atHead: this.cursor >= this.history.length - 1,
    };
  }

  private emit() {
    this.view = this.computeView();
    for (const l of this.listeners) l();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SimView<S> => this.view;

  rebuild(make: () => Kernel<S, Cmd>) {
    this.stopLoop();
    this.playing = false;
    this.kernel = make();
    this.history = [this.kernel.serialize()];
    this.cursor = 0;
    this.emit();
  }

  private ensureLive() {
    if (this.cursor !== this.history.length - 1) {
      this.kernel.restore(this.history[this.cursor]);
    }
  }

  private commit() {
    if (this.cursor < this.history.length - 1) this.history.length = this.cursor + 1;
    this.history.push(this.kernel.serialize());
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
    this.cursor = this.history.length - 1;
    this.emit();
  }

  act = (fn: (k: Kernel<S, Cmd>) => void) => {
    this.ensureLive();
    fn(this.kernel);
    this.commit();
  };

  setSpeed = (s: number) => {
    this.speed = s;
    this.emit();
  };

  private loop = (ts: number) => {
    if (!this.playing) return;
    if (this.lastTs === null) this.lastTs = ts;
    let dt = ts - this.lastTs;
    this.lastTs = ts;
    if (dt > 100) dt = 100;
    this.ensureLive();
    if (this.cursor < this.history.length - 1) this.history.length = this.cursor + 1;
    this.kernel.advance(dt * this.speed * TIME_SCALE);
    this.commit();
    this.raf = requestAnimationFrame(this.loop);
  };

  private startLoop() {
    if (this.raf) return;
    this.lastTs = null;
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  play = () => {
    if (this.playing) return;
    this.playing = true;
    this.startLoop();
    this.emit();
  };

  pause = () => {
    if (!this.playing) return;
    this.playing = false;
    this.stopLoop();
    this.emit();
  };

  toggle = () => (this.playing ? this.pause() : this.play());

  stepEvent = () => {
    this.pause();
    this.act((k) => k.stepOnce());
  };

  scrub = (index: number) => {
    this.pause();
    const i = Math.max(0, Math.min(index, this.history.length - 1));
    this.kernel.restore(this.history[i]);
    this.cursor = i;
    this.emit();
  };

  dispose() {
    this.stopLoop();
    this.listeners.clear();
  }
}

export interface SimController<S, Cmd> extends SimView<S> {
  setSpeed: (s: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stepEvent: () => void;
  reset: () => void;
  scrub: (index: number) => void;
  command: (target: NodeId, cmd: Cmd) => void;
  crash: (id: NodeId) => void;
  restart: (id: NodeId) => void;
  toggleLink: (a: NodeId, b: NodeId) => void;
  partition: (groups: NodeId[][]) => void;
  heal: () => void;
  act: (fn: (k: Kernel<S, Cmd>) => void) => void;
}

export function useSimulation<S, Cmd>(makeKernel: () => Kernel<S, Cmd>): SimController<S, Cmd> {
  const [store] = useState(() => new SimStore<S, Cmd>(makeKernel));

  // Rebuild when the kernel factory identity changes (seed / size / network).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return; // store already built with this factory in the constructor
    }
    store.rebuild(makeKernel);
  }, [makeKernel, store]);

  useEffect(() => () => store.dispose(), [store]);

  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return {
    ...view,
    setSpeed: store.setSpeed,
    play: store.play,
    pause: store.pause,
    toggle: store.toggle,
    stepEvent: store.stepEvent,
    reset: () => store.rebuild(makeKernel),
    scrub: store.scrub,
    command: (target, cmd) => store.act((k) => k.command(target, cmd)),
    crash: (id) => store.act((k) => k.crash(id)),
    restart: (id) => store.act((k) => k.restart(id)),
    toggleLink: (a, b) => store.act((k) => k.toggleLink(a, b)),
    partition: (groups) => store.act((k) => k.partition(groups)),
    heal: () => store.act((k) => k.healNetwork()),
    act: store.act,
  };
}
