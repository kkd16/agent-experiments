import { useState } from 'react';
import { motion } from 'framer-motion';
import { runTests, testSummary, type TestResult } from '../quantum/tests';

export default function TestsPanel() {
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => { setResults(runTests()); setBusy(false); }, 20);
  };

  const summary = results ? testSummary(results) : null;
  const groups = results ? [...new Set(results.map((r) => r.group))] : [];

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 16px', lineHeight: 1.6 }}>
        A live self-test battery that proves the engine is correct from first principles — Hermitian
        eigensolver, density-matrix channels, error-correcting codes, phase estimation, and the
        variational optimizers. Everything runs in your browser, no server.
      </p>
      <button onClick={run} disabled={busy} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#7c3aed,#0891b2)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
        {busy ? 'Running…' : '▶ Run all tests'}
      </button>

      {summary && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 16 }}>
          <div style={{
            display: 'inline-block', padding: '6px 14px', borderRadius: 8, marginBottom: 14,
            background: summary.passed === summary.total ? 'rgba(16,185,129,0.15)' : 'rgba(220,38,38,0.15)',
            border: `1px solid ${summary.passed === summary.total ? '#10b981' : '#dc2626'}`,
            color: summary.passed === summary.total ? '#34d399' : '#f87171', fontWeight: 800, fontSize: 14,
          }}>
            {summary.passed} / {summary.total} passing {summary.passed === summary.total ? '✓' : '✗'}
          </div>

          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{g}</div>
              {results!.filter((r) => r.group === g).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(30,58,95,0.3)' }}>
                  <span style={{ color: r.pass ? '#34d399' : '#f87171', fontWeight: 800, width: 16 }}>{r.pass ? '✓' : '✗'}</span>
                  <span style={{ fontSize: 12, color: '#cbd5e1', flex: 1 }}>{r.name}</span>
                  {r.detail && <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>{r.detail}</span>}
                </div>
              ))}
            </div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
