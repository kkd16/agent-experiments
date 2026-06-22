import type { Challenge, DojoTest } from "./types";
import { compareValues } from "./equal";

/**
 * The Code Dojo judge.
 *
 * User code runs inside a Web Worker built from a Blob URL — no DOM, no access
 * to the page, and (critically) on a separate thread so a runaway loop can't
 * freeze the UI. The worker streams one message per test back, which lets us:
 *   1. attribute a verdict to each individual case, and
 *   2. keep a *rolling* timeout on the main thread — every result resets it, so
 *      a single infinite-looping case is terminated and reported as TLE while
 *      the cases that already returned keep their real verdicts.
 *
 * Building the worker from a Blob (instead of `new Worker(new URL(...))`) keeps
 * it dependency-free and avoids any bundler/base-path worker plumbing, so it
 * works unchanged under the relative GitHub-Pages subpath.
 */

export type CaseStatus = "pass" | "wrong" | "error" | "tle";

export interface CaseResult {
  index: number;
  name?: string;
  sample: boolean;
  status: CaseStatus;
  args: unknown[];
  expected: unknown;
  got?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
}

export interface RunOutcome {
  ok: boolean;
  compileError?: string;
  cases: CaseResult[];
  passed: number;
  total: number;
  totalMs: number;
}

// The worker program, kept as a string so it can be turned into a Blob URL.
// It evaluates the user's code, grabs the entry function, then runs each test
// in turn, capturing console output and timing, and posts a message per test.
// Exported so it can be exercised directly in tests against a fake `self`.
export const WORKER_SRC = `
function fmt(v){
  try {
    if (typeof v === 'string') return v;
    return JSON.stringify(v, function(_k, val){
      if (typeof val === 'number') {
        if (Number.isNaN(val)) return 'NaN';
        if (val === Infinity) return 'Infinity';
        if (val === -Infinity) return '-Infinity';
      }
      return val;
    });
  } catch (e) { return String(v); }
}
self.onmessage = function(e){
  var data = e.data || {};
  var code = data.code, entry = data.entry, tests = data.tests || [];
  var fn;
  try {
    var factory = new Function(code + "\\n;return (typeof " + entry + " === 'function') ? " + entry + " : undefined;");
    fn = factory();
  } catch (err) {
    self.postMessage({ type: 'compile-error', message: String((err && err.message) || err) });
    return;
  }
  if (typeof fn !== 'function') {
    self.postMessage({ type: 'compile-error', message: 'Could not find a function named "' + entry + '". Make sure it is defined and spelled correctly.' });
    return;
  }
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    var logs = [];
    var orig = console.log;
    console.log = function(){
      if (logs.length < 50) {
        var parts = [];
        for (var j = 0; j < arguments.length; j++) parts.push(fmt(arguments[j]));
        logs.push(parts.join(' '));
      }
    };
    var result, error = null, duration = 0;
    try {
      var args = JSON.parse(JSON.stringify(t.args));
      var start = (self.performance && performance.now) ? performance.now() : Date.now();
      result = fn.apply(null, args);
      var end = (self.performance && performance.now) ? performance.now() : Date.now();
      duration = end - start;
    } catch (err2) {
      error = String((err2 && err2.stack) || (err2 && err2.message) || err2);
    } finally {
      console.log = orig;
    }
    var payload = { type: 'result', index: i, error: error, logs: logs, durationMs: duration };
    if (error === null) {
      try { payload.result = result; }
      catch (e3) { payload.error = 'Result could not be serialised: ' + String(e3); }
    }
    self.postMessage(payload);
  }
  self.postMessage({ type: 'done' });
};
`;

function buildCase(test: DojoTest, index: number): CaseResult {
  return {
    index,
    name: test.name,
    sample: !!test.sample,
    status: "tle",
    args: test.args,
    expected: test.expected,
    logs: [],
    durationMs: 0,
    error: "Did not finish — time limit exceeded.",
  };
}

export function runTests(
  code: string,
  ch: Challenge,
  tests: DojoTest[],
  opts: { timeoutMs?: number } = {},
): Promise<RunOutcome> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const mode = ch.compare ?? "deep";

  return new Promise<RunOutcome>((resolve) => {
    const cases: CaseResult[] = tests.map(buildCase);
    const start = nowMs();
    let settled = false;
    let url = "";
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let received = 0;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
      }
      if (url) {
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
      }
    };

    const settle = (outcome: Partial<RunOutcome> & { compileError?: string } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      const passed = cases.filter((c) => c.status === "pass").length;
      resolve({
        ok: !outcome.compileError && passed === cases.length && cases.length > 0,
        compileError: outcome.compileError,
        cases,
        passed,
        total: cases.length,
        totalMs: Math.round((nowMs() - start) * 10) / 10,
      });
    };

    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        // The next test we were waiting on is the culprit; the rest never ran.
        settle();
      }, timeoutMs);
    };

    try {
      const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
      url = URL.createObjectURL(blob);
      worker = new Worker(url);
    } catch (e) {
      settle({ compileError: "The in-browser sandbox is unavailable in this context: " + String(e) });
      return;
    }

    worker.onerror = (ev) => {
      settle({ compileError: ev.message || "The sandbox crashed while running your code." });
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "compile-error") {
        settle({ compileError: String(msg.message) });
        return;
      }
      if (msg.type === "done") {
        settle();
        return;
      }
      if (msg.type === "result") {
        const i = msg.index as number;
        const c = cases[i];
        if (c) {
          c.logs = Array.isArray(msg.logs) ? msg.logs : [];
          c.durationMs = Math.round((msg.durationMs ?? 0) * 100) / 100;
          if (msg.error) {
            c.status = "error";
            c.error = String(msg.error);
          } else {
            c.got = msg.result;
            c.error = undefined;
            c.status = compareValues(msg.result, c.expected, mode) ? "pass" : "wrong";
          }
        }
        received += 1;
        if (received >= cases.length) {
          settle();
        } else {
          armTimer();
        }
      }
    };

    armTimer();
    worker.postMessage({ code, entry: ch.entry, tests });
  });
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
