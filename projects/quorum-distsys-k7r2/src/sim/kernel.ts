// The simulation kernel: a deterministic discrete-event engine that any
// Protocol can run on. It owns virtual time, the event queue, per-node timers,
// crash/restart, the network, the event log and metrics — and can serialize its
// entire state so the UI can scrub a run backwards and forwards in time.
import { Rng } from './prng';
import { PriorityQueue } from './pqueue';
import { Network, DEFAULT_NETWORK, type NetworkConfig } from './network';
import type {
  NodeId,
  Message,
  LogEntry,
  Protocol,
  NodeContext,
  NodeRuntime,
  NodeView,
  SimEvent,
  SimSnapshot,
  SimMetrics,
} from './types';

export interface KernelOptions<S, Cmd> {
  seed: number;
  protocol: Protocol<S, Cmd>;
  nodeIds: NodeId[];
  network?: NetworkConfig;
  /** Cap on retained event-log lines (oldest are dropped). */
  logLimit?: number;
}

const DEFAULT_LOG_LIMIT = 2000;

export class Kernel<S, Cmd = unknown> {
  readonly protocol: Protocol<S, Cmd>;
  readonly nodeOrder: NodeId[];
  rng: Rng;
  network: Network;
  time = 0;
  step = 0;

  private seq = 0;
  private msgId = 0;
  private timerGen = 0;
  private queue = new PriorityQueue<SimEvent>();
  private nodes = new Map<NodeId, NodeRuntime<S>>();
  private logBuf: LogEntry[] = [];
  private readonly logLimit: number;
  metrics: SimMetrics = {
    messagesSent: 0,
    messagesDelivered: 0,
    messagesDropped: 0,
    timersFired: 0,
    steps: 0,
  };

  constructor(opts: KernelOptions<S, Cmd>) {
    this.protocol = opts.protocol;
    this.nodeOrder = [...opts.nodeIds];
    this.rng = new Rng(opts.seed);
    this.network = new Network(opts.network ?? DEFAULT_NETWORK);
    this.logLimit = opts.logLimit ?? DEFAULT_LOG_LIMIT;

    for (const id of this.nodeOrder) {
      const rt: NodeRuntime<S> = { id, state: undefined as unknown as S, up: true, timers: {} };
      this.nodes.set(id, rt);
    }
    // Initialize each node (handlers may arm timers / send during init).
    for (const id of this.nodeOrder) {
      const rt = this.nodes.get(id)!;
      const ctx = this.makeContext(rt);
      rt.state = this.protocol.init(ctx);
    }
  }

  // ---- context handed to protocol handlers -------------------------------

  private makeContext(rt: NodeRuntime<S>): NodeContext {
    const self = rt.id;
    const peers = this.nodeOrder.filter((n) => n !== self);
    return {
      self,
      peers,
      all: this.nodeOrder,
      now: this.time,
      rng: this.rng,
      send: (to, type, payload) => this.enqueueSend(rt, to, type, payload),
      broadcast: (type, make) => {
        for (const p of peers) this.enqueueSend(rt, p, type, make(p));
      },
      setTimer: (name, delay) => {
        const gen = ++this.timerGen;
        rt.timers[name] = { fireAt: this.time + delay, gen };
        this.queue.push({ kind: 'timer', time: this.time + delay, seq: this.seq++, node: self, name, gen });
      },
      clearTimer: (name) => {
        delete rt.timers[name];
      },
      log: (kind, text) => this.pushLog(self, kind, text),
    };
  }

  private enqueueSend(from: NodeRuntime<S>, to: NodeId, type: string, payload: unknown): void {
    this.metrics.messagesSent++;
    const lat = this.network.latency(from.id, to, this.rng);
    if (lat === null) {
      this.metrics.messagesDropped++;
      this.pushLog(from.id, 'drop', `${type} ⇸ ${to} (lost)`);
      return;
    }
    const msg: Message = {
      id: this.msgId++,
      from: from.id,
      to,
      type,
      payload,
      sentAt: this.time,
      deliverAt: this.time + lat,
    };
    this.queue.push({ kind: 'deliver', time: msg.deliverAt, seq: this.seq++, message: msg });
    this.pushLog(from.id, 'send', `${type} → ${to}`);
  }

  private pushLog(node: NodeId, kind: string, text: string): void {
    this.logBuf.push({ time: this.time, seq: this.seq++, node, kind, text });
    if (this.logBuf.length > this.logLimit) this.logBuf.splice(0, this.logBuf.length - this.logLimit);
  }

  // ---- driving the simulation -------------------------------------------

  /** Process the single earliest event. Returns false when the queue is idle. */
  stepOnce(): boolean {
    const ev = this.queue.pop();
    if (!ev) return false;
    this.time = ev.time;
    this.step++;
    this.metrics.steps++;

    if (ev.kind === 'deliver') {
      const node = this.nodes.get(ev.message.to);
      if (!node || !node.up) {
        this.metrics.messagesDropped++;
        return true; // delivered to a crashed node -> lost
      }
      this.metrics.messagesDelivered++;
      const ctx = this.makeContext(node);
      this.protocol.onMessage(ctx, node.state, ev.message);
    } else {
      const node = this.nodes.get(ev.node);
      if (!node || !node.up) return true;
      const t = node.timers[ev.name];
      if (!t || t.gen !== ev.gen) return true; // stale (re-armed or cleared)
      delete node.timers[ev.name]; // one-shot; handler re-arms if it wants periodicity
      this.metrics.timersFired++;
      const ctx = this.makeContext(node);
      this.protocol.onTimer(ctx, node.state, ev.name);
    }
    return true;
  }

  /** Advance virtual time by `dt` ms, firing every event that comes due. */
  advance(dt: number): void {
    const target = this.time + dt;
    let guard = 0;
    while (this.queue.size > 0) {
      const next = this.queue.peek()!;
      if (next.time > target) break;
      this.stepOnce();
      if (++guard > 200000) break; // runaway protection
    }
    if (target > this.time) this.time = target;
  }

  /** Whether any events remain (used to detect a quiesced cluster). */
  get hasPending(): boolean {
    return this.queue.size > 0;
  }

  // ---- external inputs ---------------------------------------------------

  command(target: NodeId, cmd: Cmd): boolean {
    const node = this.nodes.get(target);
    if (!node || !node.up || !this.protocol.onCommand) return false;
    const ctx = this.makeContext(node);
    this.protocol.onCommand(ctx, node.state, cmd);
    return true;
  }

  crash(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node || !node.up) return;
    node.up = false;
    node.timers = {}; // volatile timers are lost on crash
    this.pushLog(id, 'crash', `${id} crashed`);
  }

  restart(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node || node.up) return;
    node.up = true;
    this.pushLog(id, 'crash', `${id} restarted`);
    if (this.protocol.onRestart) {
      const ctx = this.makeContext(node);
      this.protocol.onRestart(ctx, node.state);
    }
  }

  isUp(id: NodeId): boolean {
    return this.nodes.get(id)?.up ?? false;
  }

  // ---- network controls --------------------------------------------------

  toggleLink(a: NodeId, b: NodeId): void {
    this.network.toggle(a, b);
    this.pushLog(a, 'info', `link ${a}↔${b} ${this.network.connected(a, b) ? 'healed' : 'cut'}`);
  }

  partition(groups: NodeId[][]): void {
    this.network.partition(groups);
    this.pushLog(this.nodeOrder[0], 'info', `partition ${groups.map((g) => g.join('')).join(' | ')}`);
  }

  healNetwork(): void {
    this.network.healAll();
    this.pushLog(this.nodeOrder[0], 'info', 'network healed');
  }

  // ---- introspection -----------------------------------------------------

  views(): NodeView<S>[] {
    return this.nodeOrder.map((id) => {
      const n = this.nodes.get(id)!;
      return { id, up: n.up, state: n.state };
    });
  }

  inFlight(): Message[] {
    return this.queue
      .toSortedArray()
      .filter((e): e is Extract<SimEvent, { kind: 'deliver' }> => e.kind === 'deliver')
      .map((e) => e.message);
  }

  snapshot(): SimSnapshot<S> {
    return {
      time: this.time,
      step: this.step,
      nodes: this.nodeOrder.map((id) => structuredClone(this.nodes.get(id)!)),
      inFlight: this.inFlight().map((m) => structuredClone(m)),
      log: this.logBuf.slice(),
      blockedLinks: [...this.network.blocked],
      metrics: { ...this.metrics },
    };
  }

  // ---- full serialization for time travel --------------------------------

  serialize(): string {
    return JSON.stringify({
      time: this.time,
      step: this.step,
      seq: this.seq,
      msgId: this.msgId,
      timerGen: this.timerGen,
      rng: this.rng.save(),
      nodes: this.nodeOrder.map((id) => this.nodes.get(id)!),
      queue: this.queue.toSortedArray(),
      log: this.logBuf,
      metrics: this.metrics,
      blocked: [...this.network.blocked],
      config: this.network.config,
    });
  }

  restore(serialized: string): void {
    const s = JSON.parse(serialized);
    this.time = s.time;
    this.step = s.step;
    this.seq = s.seq;
    this.msgId = s.msgId;
    this.timerGen = s.timerGen;
    this.rng.restore(s.rng);
    this.nodes.clear();
    for (const n of s.nodes as NodeRuntime<S>[]) this.nodes.set(n.id, n);
    this.queue.clear();
    for (const e of s.queue as SimEvent[]) this.queue.push(e);
    this.logBuf = s.log;
    this.metrics = s.metrics;
    this.network = new Network(s.config, s.blocked);
  }
}
