// The in-app verification suite. Runs the end-to-end assembler/decoder/executor tests and
// shows a green/red checklist — the project's own quality gate, visible to anyone.

import { useState } from 'react';
import { runSelfTests } from '../vm/selftest';
import type { TestResult } from '../vm/selftest';

interface Run {
  results: TestResult[];
  ms: number;
}

function execute(): Run {
  const t0 = performance.now();
  const results = runSelfTests();
  return { results, ms: Math.round(performance.now() - t0) };
}

export default function Tests() {
  // Tests run synchronously and are cheap (a few ms), so seed them in the state initialiser.
  const [run, setRun] = useState<Run>(execute);

  const runAll = () => setRun(execute());

  const { results, ms } = run;
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allGreen = passed === total;

  return (
    <div className="panel tests">
      <div className="panel-head">
        <h2>Verify</h2>
        <button onClick={runAll}>re-run</button>
      </div>
      <div className={`test-summary ${allGreen ? 'green' : 'red'}`}>
        {passed}/{total} passed · {ms} ms
      </div>
      <ul className="test-list">
        {results.map((r) => (
          <li key={r.name} className={r.passed ? 'pass' : 'fail'}>
            <span className="test-mark">{r.passed ? '✓' : '✗'}</span>
            <span className="test-name">{r.name}</span>
            {!r.passed && <span className="test-detail">{r.detail}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">
        Each test assembles a real program, runs it on the interpreter, and asserts on the
        output, registers, memory, or framebuffer.
      </p>
    </div>
  );
}
