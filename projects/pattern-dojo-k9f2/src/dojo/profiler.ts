import type { Challenge } from "./types";
import type { ScalingRecipe } from "./scaling";

/**
 * The Code Dojo complexity profiler.
 *
 * Where the judge (`runner.ts`) checks *correctness*, the profiler measures
 * *efficiency*: it runs the user's function over a geometric ladder of input
 * sizes and times each, so the resulting (n, time) curve can be fit to a growth
 * class (see `complexity.ts`). A correct-but-quadratic solution to an O(n)
 * problem passes the judge yet stands out instantly here.
 *
 * Everything runs inside a Blob Web Worker — same sandboxing rationale as the
 * judge (separate thread, no DOM, a runaway loop can't freeze the page). The
 * worker assembles, in order: the shared generator `PREAMBLE`, the challenge's
 * `gen` source, the user's `code`, and a measurement driver.
 *
 * Robust timing under a coarse, security-clamped `performance.now()` is the
 * crux. Each size is measured by *batch timing*: the function is called K times
 * in a tight loop and the elapsed time divided by K, with K auto-grown until a
 * batch comfortably exceeds the clock's resolution. The minimum per-call time
 * across several batches is kept (noise only ever *adds* time). Inputs are
 * regenerated fresh per size; problems whose idiomatic solution rewrites its
 * input in place get a fresh deep copy for every call.
 */

/**
 * Shared, dependency-free generator helpers, prepended before each challenge's
 * `gen` source. A seeded PRNG (mulberry32) makes every profile reproducible.
 * Kept as a string so it ships into the worker; also reused by the Node
 * validation harness so what's tested is exactly what runs.
 */
export const PREAMBLE = `
var __s = 1;
function __seed(x){ __s = (x >>> 0) || 1; }
function rnd(){
  __s |= 0; __s = (__s + 0x6D2B79F5) | 0;
  var t = Math.imul(__s ^ (__s >>> 15), 1 | __s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function ri(lo, hi){ return lo + Math.floor(rnd() * (hi - lo + 1)); }
function arr(n, f){ var a = new Array(n); for (var i=0;i<n;i++) a[i] = f(i); return a; }
function shuffle(a){ for (var i=a.length-1;i>0;i--){ var j=Math.floor(rnd()*(i+1)); var t=a[i]; a[i]=a[j]; a[j]=t; } return a; }
function lower(n){ var s=''; for (var i=0;i<n;i++) s += String.fromCharCode(97 + Math.floor(rnd()*26)); return s; }
function baltree(lo, hi){ if (lo > hi) return null; var mid = (lo + hi) >> 1; return { val: mid, left: baltree(lo, mid-1), right: baltree(mid+1, hi) }; }
`;

/**
 * The measurement driver, kept as a string for the Blob worker. The exact body
 * (sans `self`/`postMessage`) is also exercised in Node, so the calibration and
 * batch-timing logic is tested directly.
 */
export const PROFILER_SRC = `
function __now(){ return (self.performance && performance.now) ? performance.now() : Date.now(); }
function __copy(v){
  try { if (typeof structuredClone === 'function') return structuredClone(v); } catch (e) {}
  return JSON.parse(JSON.stringify(v));
}
self.onmessage = function(e){
  var d = e.data || {};
  var fn;
  try {
    var f1 = new Function(d.code + "\\n;return (typeof " + d.entry + " === 'function') ? " + d.entry + " : undefined;");
    fn = f1();
  } catch (err) {
    self.postMessage({ type: 'compile-error', message: String((err && err.message) || err) });
    return;
  }
  if (typeof fn !== 'function') {
    self.postMessage({ type: 'compile-error', message: 'Could not find a function named "' + d.entry + '".' });
    return;
  }
  var api;
  try {
    var f2 = new Function(d.preamble + "\\n" + d.gen + "\\nreturn { gen: genInput, seed: __seed };");
    api = f2();
  } catch (err2) {
    self.postMessage({ type: 'compile-error', message: 'profiler input generator failed: ' + String((err2 && err2.message) || err2) });
    return;
  }

  var mutates = !!d.mutates;
  var minBatch = d.minBatchMs || 4;
  var reps = d.reps || 4;
  var kmax = d.kmax || 65536;
  var capMs = d.perCallCapMs || 80;
  var budgetMs = d.budgetMs || 4500;
  var seedBase = (d.seedBase >>> 0) || 0x1234567;

  function timeBatch(base, K){
    var t0, t1, i;
    if (mutates) {
      var inputs = new Array(K);
      for (i = 0; i < K; i++) inputs[i] = __copy(base);
      t0 = __now();
      for (i = 0; i < K; i++) fn.apply(null, inputs[i]);
      t1 = __now();
    } else {
      t0 = __now();
      for (i = 0; i < K; i++) fn.apply(null, base);
      t1 = __now();
    }
    return t1 - t0;
  }

  var started = __now();
  var measurements = [];
  var stopped = null;

  for (var si = 0; si < d.sizes.length; si++) {
    if (__now() - started > budgetMs) { stopped = 'budget'; break; }
    var n = d.sizes[si];
    api.seed(seedBase ^ n);
    var base;
    try { base = api.gen(n); }
    catch (ge) { self.postMessage({ type: 'error', message: 'could not build an input of size ' + n + ': ' + String((ge && ge.message) || ge) }); return; }

    try {
      fn.apply(null, mutates ? __copy(base) : base);
      fn.apply(null, mutates ? __copy(base) : base);
    } catch (we) {
      self.postMessage({ type: 'error', n: n, message: 'your code threw at n=' + n + ': ' + String((we && we.message) || we) });
      return;
    }

    var K = 1, batchMs = 0;
    try {
      while (true) {
        batchMs = timeBatch(base, K);
        if (batchMs >= minBatch || K >= kmax) break;
        var factor = batchMs > 0 ? (minBatch / batchMs) : 2;
        var nextK = Math.min(kmax, Math.max(K * 2, Math.ceil(K * Math.min(8, Math.max(2, factor)))));
        if (nextK <= K) break;
        K = nextK;
      }
      var best = batchMs / K;
      for (var r = 1; r < reps; r++) {
        if (__now() - started > budgetMs) break;
        var pc = timeBatch(base, K) / K;
        if (pc < best) best = pc;
      }
    } catch (ce) {
      self.postMessage({ type: 'error', n: n, message: 'your code threw at n=' + n + ': ' + String((ce && ce.message) || ce) });
      return;
    }

    measurements.push({ n: n, perCall: best, k: K });
    self.postMessage({ type: 'progress', n: n, perCall: best, k: K, done: measurements.length, total: d.sizes.length });

    if (best > capMs) { stopped = 'slow'; break; }
  }

  self.postMessage({ type: 'done', measurements: measurements, stopped: stopped });
};
`;

export interface ProfilePoint {
  n: number;
  /** representative per-call time, milliseconds */
  perCall: number;
  /** batch size used to time this point */
  k: number;
}

export type ProfileStatus = "ok" | "compile-error" | "runtime-error" | "unsupported";

export interface ProfileOutcome {
  status: ProfileStatus;
  compileError?: string;
  runtimeError?: string;
  /** why measurement stopped before exhausting the size ladder, if it did */
  stopped?: "budget" | "slow" | "timeout" | null;
  points: ProfilePoint[];
}

export interface ProfileOpts {
  minBatchMs?: number;
  reps?: number;
  budgetMs?: number;
  perCallCapMs?: number;
  /** rolling per-size watchdog; a size that never reports is treated as a hang */
  sizeTimeoutMs?: number;
  seedBase?: number;
  onProgress?: (p: ProfilePoint & { done: number; total: number }) => void;
}

/** Run the profiler for one challenge + scaling recipe against the user's code. */
export function profile(
  code: string,
  ch: Challenge,
  recipe: ScalingRecipe,
  opts: ProfileOpts = {},
): Promise<ProfileOutcome> {
  const sizeTimeoutMs = opts.sizeTimeoutMs ?? 15000;

  return new Promise<ProfileOutcome>((resolve) => {
    const points: ProfilePoint[] = [];
    let settled = false;
    let url = "";
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (worker) {
        try {
          worker.terminate();
        } catch {
          /* noop */
        }
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* noop */
        }
      }
    };

    const settle = (outcome: ProfileOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        settle({ status: "ok", stopped: "timeout", points });
      }, sizeTimeoutMs);
    };

    try {
      const blob = new Blob([PROFILER_SRC], { type: "application/javascript" });
      url = URL.createObjectURL(blob);
      worker = new Worker(url);
    } catch (e) {
      settle({ status: "unsupported", compileError: "The in-browser sandbox is unavailable here: " + String(e), points });
      return;
    }

    worker.onerror = (ev) => {
      settle({ status: "runtime-error", runtimeError: ev.message || "The sandbox crashed while profiling.", points });
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "compile-error") {
        settle({ status: "compile-error", compileError: String(msg.message), points });
        return;
      }
      if (msg.type === "error") {
        settle({ status: "runtime-error", runtimeError: String(msg.message), points });
        return;
      }
      if (msg.type === "progress") {
        const p: ProfilePoint = { n: msg.n, perCall: msg.perCall, k: msg.k };
        points.push(p);
        opts.onProgress?.({ ...p, done: msg.done, total: msg.total });
        armTimer();
        return;
      }
      if (msg.type === "done") {
        settle({ status: "ok", stopped: msg.stopped ?? null, points });
        return;
      }
    };

    armTimer();
    worker.postMessage({
      code,
      entry: ch.entry,
      gen: recipe.gen,
      preamble: PREAMBLE,
      sizes: recipe.sizes,
      mutates: !!recipe.mutates,
      minBatchMs: opts.minBatchMs,
      reps: opts.reps,
      budgetMs: opts.budgetMs,
      perCallCapMs: opts.perCallCapMs,
      seedBase: opts.seedBase ?? 0x1234567,
    });
  });
}
