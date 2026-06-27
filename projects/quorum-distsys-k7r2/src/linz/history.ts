// The data model the linearizability checker reasons over.
//
// A *history* is the externally-observed record of a concurrent object: a set of
// operations, each with a real-time *invocation* and *response* instant, the
// process that issued it, the operation name + argument, and the value the
// object returned. Linearizability (Herlihy & Wing, 1990) asks: is there a
// single sequential order of these operations that (a) is legal for the object's
// sequential specification and (b) respects real time — if operation A finished
// before operation B started, A comes before B in the order?
//
// Nothing here knows about ABD, Raft or any protocol; a history is a plain value,
// so the very same checker certifies a hand-written textbook example, a randomly
// generated schedule, and a real ABD register run pulled out of the live kernel.

/** A value an operation can take as an argument or return as a result. */
export type Value = string | number | boolean | null;

/** An operation's argument: a single value, a tuple (e.g. CAS old→new), or none. */
export type Arg = Value | Value[] | undefined;

/** One operation invocation+response observed on a shared object. */
export interface Op {
  /** Stable identity within a history. */
  id: number;
  /** The process / client lane that issued it (for the per-process diagram). */
  proc: string;
  /** The call name, e.g. 'write', 'read', 'cas', 'enq', 'deq', 'inc'. */
  f: string;
  /** The argument, if any. */
  arg?: Arg;
  /**
   * The observed response. For void operations (write/enq/inc…) this is `null`.
   * For a *pending* operation (invoked but never observed to return) it is left
   * `undefined` and `ret` is `Infinity`.
   */
  res?: Value;
  /** Real-time invocation instant. */
  call: number;
  /** Real-time response instant; `Infinity` for a pending operation. */
  ret: number;
  /**
   * Optional object identity. A history over many independent objects (e.g. an
   * ABD store keyed x/y/z) partitions by this and each part is checked alone —
   * sound because linearizability is *compositional* (Herlihy & Wing's locality
   * theorem). Leave undefined for a single object.
   */
  obj?: string;
}

/** A complete history is one with no pending operations. */
export interface History {
  /** A human label for the source of this history. */
  label: string;
  ops: Op[];
}

/** An operation is pending iff it never returned. */
export function isPending(o: Op): boolean {
  return o.ret === Infinity || o.res === undefined;
}

/**
 * Real-time precedence: A ≺ B iff A's response happens at or before B's
 * invocation, i.e. they do not overlap and A is the earlier one. This is the
 * single partial order linearizability must respect.
 */
export function precedes(a: Op, b: Op): boolean {
  return a.ret <= b.call;
}

/** Structural equality on operation values (handles tuples like CAS args). */
export function eqValue(a: Arg | Value, b: Arg | Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

/** Group a history's operations by their object id (undefined ⇒ one group ''). */
export function partitionByObject(ops: Op[]): Map<string, Op[]> {
  const parts = new Map<string, Op[]>();
  for (const o of ops) {
    const k = o.obj ?? '';
    const cur = parts.get(k);
    if (cur) cur.push(o);
    else parts.set(k, [o]);
  }
  return parts;
}

/** Render an operation as `f(arg)→res` for diagrams and explanations. */
export function showOp(o: Op): string {
  const a = o.arg === undefined ? '' : Array.isArray(o.arg) ? o.arg.join('→') : String(o.arg);
  const head = a === '' ? `${o.f}()` : `${o.f}(${a})`;
  if (isPending(o)) return `${head} …`;
  const r = o.res === null ? '' : `→${o.res}`;
  return `${head}${r}`;
}
