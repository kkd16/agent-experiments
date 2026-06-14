import { useMemo, useRef, useEffect } from 'react';
import type { GateOp } from '../quantum/QuantumState';
import { simulateDensity } from '../quantum/DensityMatrix';
import { CHANNEL_INFO, isNoiseActive, type ChannelType, type NoiseModel } from '../quantum/noise';
import BlochSphere from './BlochSphere';

interface Props {
  numQubits: number;
  ops: GateOp[];
  noise: NoiseModel;
  onNoiseChange: (n: NoiseModel) => void;
}

const CHANNELS: ChannelType[] = ['depolarizing', 'amplitude-damping', 'phase-damping', 'bit-flip', 'phase-flip'];
const MAX_DENSITY_QUBITS = 6;

// Map a complex phase angle to a hue color (used for the ρ heatmap).
function phaseColor(re: number, im: number, mag: number, maxMag: number): string {
  const hue = ((Math.atan2(im, re) * 180) / Math.PI + 360) % 360;
  const light = 8 + 52 * Math.min(1, mag / (maxMag || 1));
  return `hsl(${hue}, 85%, ${light}%)`;
}

export default function DensityLab({ numQubits, ops, noise, onNoiseChange }: Props) {
  const tooBig = numQubits > MAX_DENSITY_QUBITS;
  const dm = useMemo(() => (tooBig ? null : simulateDensity(numQubits, ops, noise)), [numQubits, ops, noise, tooBig]);

  const stats = useMemo(() => {
    if (!dm) return null;
    return {
      purity: dm.purity(),
      entropy: dm.vonNeumannEntropy(),
      spectrum: dm.spectrum(),
      probs: dm.probabilities(),
      trace: dm.trace(),
    };
  }, [dm]);

  const setChannel = (type: ChannelType, strength: number) => {
    const channels = noise.channels.filter((c) => c.type !== type);
    if (strength > 0) channels.push({ type, strength });
    onNoiseChange({ ...noise, channels });
  };
  const strengthOf = (type: ChannelType) => noise.channels.find((c) => c.type === type)?.strength ?? 0;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dm) return;
    const size = dm.rho.length;
    const px = Math.max(2, Math.floor(220 / size));
    canvas.width = size * px;
    canvas.height = size * px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let maxMag = 1e-9;
    for (const row of dm.rho) for (const z of row) maxMag = Math.max(maxMag, z.abs());
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const z = dm.rho[i][j];
        const mag = z.abs();
        ctx.fillStyle = mag < 1e-6 ? '#0a0f1e' : phaseColor(z.re, z.im, mag, maxMag);
        ctx.fillRect(j * px, i * px, px, px);
      }
    }
  }, [dm]);

  const active = isNoiseActive(noise);

  return (
    <div>
      <p style={{ color: '#475569', fontSize: 11, margin: '4px 0 12px' }}>
        Open-system simulation. Noise channels turn the pure state into a <b>density matrix</b> ρ
        evolved as ρ → Σ KρK†. Watch purity drop and the Bloch vectors retract inward.
      </p>

      {/* Noise channel sliders */}
      <div style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Noise model (per gate)</span>
          {active && (
            <button onClick={() => onNoiseChange({ ...noise, channels: [] })} style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>reset</button>
          )}
        </div>
        {CHANNELS.map((ch) => (
          <div key={ch} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 34px', gap: 8, alignItems: 'center', marginBottom: 5 }}>
            <span title={CHANNEL_INFO[ch].blurb} style={{ fontSize: 10, color: '#cbd5e1', cursor: 'help' }}>{CHANNEL_INFO[ch].label}</span>
            <input type="range" min={0} max={1} step={0.01} value={strengthOf(ch)} onChange={(e) => setChannel(ch, parseFloat(e.target.value))} style={{ accentColor: '#dc2626', width: '100%' }} />
            <span style={{ fontSize: 9, color: '#f87171', fontFamily: 'monospace', textAlign: 'right' }}>{strengthOf(ch).toFixed(2)}</span>
          </div>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10, color: '#94a3b8' }}>
          <input type="checkbox" checked={noise.scope === 'all'} onChange={(e) => onNoiseChange({ ...noise, scope: e.target.checked ? 'all' : 'touched' })} style={{ accentColor: '#dc2626' }} />
          apply to every qubit each step (idle decoherence)
        </label>
      </div>

      {tooBig ? (
        <div style={{ padding: 16, color: '#64748b', fontSize: 12, textAlign: 'center', border: '1px dashed #334155', borderRadius: 8 }}>
          Density-matrix simulation is shown for ≤ {MAX_DENSITY_QUBITS} qubits (ρ is 2ⁿ×2ⁿ). This circuit uses {numQubits}.
        </div>
      ) : stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            <Stat label="Purity Tr(ρ²)" value={stats.purity.toFixed(4)} hint={stats.purity > 0.999 ? 'pure' : 'mixed'} good={stats.purity > 0.999} />
            <Stat label="Entropy S(ρ)" value={`${stats.entropy.toFixed(3)} bits`} hint={stats.entropy < 1e-3 ? 'pure' : 'mixed'} good={stats.entropy < 1e-3} />
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div>
              <SectionLabel>Density matrix |ρ| (phase = hue)</SectionLabel>
              <canvas ref={canvasRef} style={{ imageRendering: 'pixelated', border: '1px solid #1e293b', borderRadius: 6, width: 220, height: 220, background: '#0a0f1e' }} />
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <SectionLabel>Eigenvalue spectrum of ρ</SectionLabel>
              {stats.spectrum.filter((v) => v > 1e-4).slice(0, 8).map((v, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 44px', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                  <div style={{ height: 8, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${v * 100}%`, background: 'linear-gradient(90deg,#7c3aed,#0891b2)', borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', textAlign: 'right' }}>{v.toFixed(4)}</span>
                </div>
              ))}
              <div style={{ fontSize: 9, color: '#334155', marginTop: 6 }}>
                A pure state has one eigenvalue = 1; a mixture spreads probability across several.
              </div>
            </div>
          </div>

          <SectionLabel style={{ marginTop: 16 }}>Reduced Bloch spheres {active ? '(noisy)' : '(ideal)'}</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {Array.from({ length: numQubits }, (_, q) => {
              const bv = dm!.blochVector(q);
              const r = Math.hypot(bv[0], bv[1], bv[2]);
              return (
                <div key={q} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <BlochSphere blochVector={bv} qubitIndex={q} />
                  <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>r={r.toFixed(2)} {r < 0.95 ? '(mixed)' : '(pure)'}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, good }: { label: string; value: string; hint: string; good: boolean }) {
  return (
    <div style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: good ? '#67e8f9' : '#f0abfc', fontFamily: 'monospace' }}>{value}</div>
      <div style={{ fontSize: 9, color: good ? '#0891b2' : '#a21caf' }}>{hint}</div>
    </div>
  );
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, ...style }}>{children}</div>;
}
