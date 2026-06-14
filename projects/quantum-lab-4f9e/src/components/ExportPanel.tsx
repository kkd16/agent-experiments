import { useMemo, useState } from 'react';
import type { GateOp } from '../quantum/QuantumState';
import { circuitMetrics } from '../quantum/metrics';
import { toQASM } from '../quantum/qasm';
import { toJSON, download, encodeToHash, type CircuitDoc } from '../quantum/serialize';

interface Props {
  numQubits: number;
  ops: GateOp[];
  name?: string;
}

export default function ExportPanel({ numQubits, ops, name }: Props) {
  const [view, setView] = useState<'metrics' | 'qasm' | 'json'>('metrics');
  const [copied, setCopied] = useState('');

  const metrics = useMemo(() => circuitMetrics(numQubits, ops), [numQubits, ops]);
  const qasm = useMemo(() => toQASM(numQubits, ops), [numQubits, ops]);
  const doc: CircuitDoc = useMemo(() => ({ v: 1, numQubits, ops, name }), [numQubits, ops, name]);
  const json = useMemo(() => toJSON(doc), [doc]);

  const copy = (text: string, what: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(''), 1200);
    } catch { /* sandboxed */ }
  };
  const share = () => {
    try {
      const hash = encodeToHash(doc);
      const url = `${location.origin}${location.pathname}#c=${hash}`;
      copy(url, 'link');
    } catch { /* sandboxed */ }
  };

  return (
    <div style={{ marginTop: 16, background: 'rgba(14,22,41,0.5)', border: '1px solid rgba(30,58,95,0.4)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(30,58,95,0.4)' }}>
        {(['metrics', 'qasm', 'json'] as const).map((t) => (
          <button key={t} onClick={() => setView(t)} style={{
            flex: 1, padding: '7px 8px', border: 'none', background: view === t ? 'rgba(124,58,237,0.12)' : 'transparent',
            color: view === t ? '#a78bfa' : '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>{t === 'qasm' ? 'OpenQASM' : t}</button>
        ))}
      </div>

      <div style={{ padding: 12 }}>
        {view === 'metrics' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 10 }}>
              <MiniStat label="Gates" value={metrics.gateCount} />
              <MiniStat label="Depth" value={metrics.depth} />
              <MiniStat label="2-qubit" value={metrics.twoQubitGates} />
            </div>
            <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Gate histogram</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {metrics.perType.map((t) => (
                <span key={t.name} style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 7px', borderRadius: 4, background: 'rgba(124,58,237,0.12)', color: '#a78bfa' }}>
                  {t.name}×{t.count}
                </span>
              ))}
              {metrics.perType.length === 0 && <span style={{ fontSize: 11, color: '#475569' }}>empty circuit</span>}
            </div>
          </div>
        )}
        {view === 'qasm' && (
          <CodeBlock text={qasm} onCopy={() => copy(qasm, 'qasm')} copied={copied === 'qasm'} onDownload={() => download('circuit.qasm', qasm)} downloadLabel=".qasm" />
        )}
        {view === 'json' && (
          <CodeBlock text={json} onCopy={() => copy(json, 'json')} copied={copied === 'json'} onDownload={() => download('circuit.json', json)} downloadLabel=".json" extra={<button onClick={share} style={smallBtn}>{copied === 'link' ? 'copied!' : '🔗 share link'}</button>} />
        )}
      </div>
    </div>
  );
}

function CodeBlock({ text, onCopy, copied, onDownload, downloadLabel, extra }: { text: string; onCopy: () => void; copied: boolean; onDownload: () => void; downloadLabel: string; extra?: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button onClick={onCopy} style={smallBtn}>{copied ? 'copied!' : '⧉ copy'}</button>
        <button onClick={onDownload} style={smallBtn}>↓ {downloadLabel}</button>
        {extra}
      </div>
      <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', background: '#020617', borderRadius: 6, padding: 10, fontSize: 10.5, lineHeight: 1.5, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>{text}</pre>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#67e8f9', fontFamily: 'monospace' }}>{value}</div>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

const smallBtn: React.CSSProperties = { fontSize: 10, padding: '3px 9px', borderRadius: 5, border: '1px solid #334155', background: 'rgba(255,255,255,0.03)', color: '#94a3b8', cursor: 'pointer' };
