import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  gcd, modpow, multiplicativeOrder, convergents, recoverOrder,
  orderFindFull, idealOrderDistribution, shorFactor, shorRng,
  type ShorResult, type ShorStep,
} from '../quantum/shor';

const FACTOR_CHOICES = [15, 21, 33, 35, 39, 51, 55, 77, 91];
const SPECTRUM_CHOICES = [15, 21, 33, 35];

const STEP_COLOR: Record<ShorStep['kind'], string> = {
  info: '#64748b',
  attempt: '#a78bfa',
  success: '#34d399',
  fail: '#f87171',
  classical: '#67e8f9',
};

export default function ShorLab() {
  return (
    <div style={{ maxWidth: 780 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        <b style={{ color: '#a78bfa' }}>Shor's algorithm</b> — the result that put quantum computing on
        the map — factors an integer in polynomial time. Its engine is <b style={{ color: '#67e8f9' }}>quantum
        order-finding</b>: to factor <i>N</i>, pick a coprime base <code>a</code> and find the period{' '}
        <code>r</code> of <code>x ↦ a·x mod N</code> by phase-estimating the eigenphase{' '}
        <code>s/r</code> of the modular-multiplication unitary, then read <code>r</code> off a{' '}
        continued fraction. If <code>r</code> is even and <code>a^(r/2) ≢ −1</code>, then{' '}
        <code>gcd(a^(r/2) ± 1, N)</code> are real factors. Everything here is the genuine state-vector
        simulation — no shortcuts.
      </p>

      <FactorCard />
      <SpectrumCard />
    </div>
  );
}

// ─────────────────────────────── Factor a number ───────────────────────────────

function FactorCard() {
  const [N, setN] = useState(15);
  const [seed, setSeed] = useState(7);
  const [result, setResult] = useState<ShorResult | null>(null);

  const run = () => setResult(shorFactor(N, { rng: shorRng(seed), maxAttempts: 40 }));

  return (
    <Card title="Factor a number" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>N
          <select value={N} onChange={(e) => { setN(parseInt(e.target.value)); setResult(null); }} style={sel}>
            {FACTOR_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={lab}>seed
          <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
            style={{ ...sel, width: 64 }} />
        </label>
        <button onClick={run} style={btn}>▶ Run Shor</button>
      </div>

      {result && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '14px 0 16px',
          }}>
            {result.factors ? (
              <FactorTree N={result.N} p={result.factors[0]} q={result.factors[1]} />
            ) : (
              <span style={{ color: '#f87171', fontFamily: 'monospace', fontSize: 16 }}>
                {result.N} has no non-trivial factors (prime).
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="attempts" value={String(result.attempts)} />
            {result.method && <Stat label="order-finding" value={result.method} />}
            {result.a !== undefined && <Stat label="winning base a" value={String(result.a)} />}
            {result.order !== undefined && <Stat label="period r" value={String(result.order)} />}
            {result.measuredY !== undefined && result.t !== undefined &&
              <Stat label="measured" value={`${result.measuredY}/${1 << result.t}`} />}
          </div>

          <div style={{
            background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8,
            padding: '8px 12px', maxHeight: 220, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11,
          }}>
            {result.steps.map((s, i) => (
              <div key={i} style={{ color: STEP_COLOR[s.kind], lineHeight: 1.65 }}>
                <span style={{ color: '#334155', marginRight: 6 }}>{String(i + 1).padStart(2, '0')}</span>{s.text}
              </div>
            ))}
          </div>
        </motion.div>
      )}
      {!result && (
        <p style={{ color: '#475569', fontSize: 11, margin: '6px 0 0' }}>
          Press Run to factor N by quantum order-finding. Try a few seeds — each picks different random
          bases, so the number of attempts (and whether a lucky gcd short-circuits the quantum step) varies.
        </p>
      )}
    </Card>
  );
}

function FactorTree({ N, p, q }: { N: number; p: number; q: number }) {
  return (
    <svg width={220} height={104} style={{ overflow: 'visible' }}>
      <line x1={110} y1={30} x2={62} y2={74} stroke="#334155" strokeWidth={1.5} />
      <line x1={110} y1={30} x2={158} y2={74} stroke="#334155" strokeWidth={1.5} />
      <Node x={110} y={20} text={String(N)} color="#a78bfa" big />
      <Node x={62} y={84} text={String(p)} color="#34d399" />
      <Node x={158} y={84} text={String(q)} color="#34d399" />
    </svg>
  );
}

function Node({ x, y, text, color, big }: { x: number; y: number; text: string; color: string; big?: boolean }) {
  const r = big ? 19 : 16;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="rgba(2,6,23,0.9)" stroke={color} strokeWidth={1.5} />
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fill={color}
        fontFamily="monospace" fontSize={big ? 16 : 14} fontWeight={800}>{text}</text>
    </g>
  );
}

// ─────────────────────────────── Order-finding spectrum ───────────────────────────────

function SpectrumCard() {
  const [N, setN] = useState(15);
  const coprimes = useMemo(
    () => Array.from({ length: N - 2 }, (_, i) => i + 2).filter((a) => gcd(a, N) === 1),
    [N],
  );
  const [a, setA] = useState(7);
  const aEff = coprimes.includes(a) ? a : coprimes[0];

  const data = useMemo(() => {
    const n = Math.max(1, Math.ceil(Math.log2(N)));
    const t = 2 * n;
    const full = n + t <= 15; // genuine state vector only while it fits comfortably
    const dist = full ? orderFindFull(aEff, N).dist : idealOrderDistribution(aEff, N).dist;
    const r = multiplicativeOrder(aEff, N);
    // The most probable non-zero outcome and the order it implies.
    let bestY = 0, bestP = -1;
    for (let y = 1; y < dist.length; y++) if (dist[y] > bestP) { bestP = dist[y]; bestY = y; }
    const recovered = recoverOrder(bestY, t, aEff, N);
    const peaks = Array.from({ length: r }, (_, k) => Math.round((k * (1 << t)) / r));
    return { n, t, full, dist, r, bestY, recovered, peaks, M: 1 << t };
  }, [N, aEff]);

  return (
    <Card title="Order-finding spectrum" accent="#67e8f9">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={lab}>N
          <select value={N} onChange={(e) => { setN(parseInt(e.target.value)); }} style={sel}>
            {SPECTRUM_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={lab}>base a
          <select value={aEff} onChange={(e) => setA(parseInt(e.target.value))} style={sel}>
            {coprimes.map((c) => <option key={c} value={c}>{c}  (r={multiplicativeOrder(c, N)})</option>)}
          </select>
        </label>
        <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>
          {data.full ? `${data.n + data.t}-qubit state vector` : 'analytic comb'} · {data.t}-bit register
        </span>
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        The phase register measures <code>y</code> with probability peaking at{' '}
        <code style={{ color: '#67e8f9' }}>y ≈ k·2^t/r</code> — the spikes below sit exactly at the rationals{' '}
        <code>k/r</code>. Reading any spike and running it through a continued fraction recovers the period{' '}
        <code>r = {data.r}</code>.
      </p>

      <Spectrum dist={data.dist} peaks={data.peaks} bestY={data.bestY} M={data.M} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <Stat label="true order r" value={String(data.r)} />
        <Stat label="most-probable y" value={`${data.bestY}/${data.M}`} />
        <Stat label="phase y/2ᵗ" value={(data.bestY / data.M).toFixed(4)} />
        <Stat label="continued fraction → r" value={data.recovered === null ? '—' : String(data.recovered)}
          ok={data.recovered === data.r} />
      </div>

      <ConvergentTable y={data.bestY} M={data.M} a={aEff} N={N} r={data.r} />
    </Card>
  );
}

function Spectrum({ dist, peaks, bestY, M }: { dist: Float64Array; peaks: number[]; bestY: number; M: number }) {
  const W = 700, H = 150, padL = 6, padB = 18, padT = 8;
  const cw = W - padL, ch = H - padB - padT;
  const maxP = Math.max(...dist, 1e-9);
  const bw = Math.max(1, cw / M);
  const xOf = (y: number) => padL + (y / M) * cw;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {/* ideal s/r peak guides */}
      {peaks.map((py, i) => (
        <line key={i} x1={xOf(py)} y1={padT} x2={xOf(py)} y2={padT + ch}
          stroke="rgba(124,58,237,0.35)" strokeWidth={1} strokeDasharray="2 3" />
      ))}
      {/* probability bars */}
      {Array.from(dist).map((p, y) => {
        if (p < maxP * 1e-4) return null;
        const h = (p / maxP) * ch;
        return <rect key={y} x={xOf(y)} y={padT + ch - h} width={bw} height={h}
          fill={y === bestY ? '#34d399' : '#67e8f9'} opacity={y === bestY ? 1 : 0.8} />;
      })}
      {/* axis ticks at k/r */}
      {peaks.map((py, i) => (
        <text key={i} x={xOf(py)} y={H - 5} textAnchor="middle" fill="#475569" fontSize={9} fontFamily="monospace">
          {i}/{peaks.length}
        </text>
      ))}
      <line x1={padL} y1={padT + ch} x2={W} y2={padT + ch} stroke="#1e293b" strokeWidth={1} />
    </svg>
  );
}

function ConvergentTable({ y, M, a, N, r }: { y: number; M: number; a: number; N: number; r: number }) {
  const rows = useMemo(() => convergents(y, M).filter((c) => c.q > 0), [y, M]);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        Continued-fraction convergents of {y}/{M}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontFamily: 'monospace', fontSize: 11 }}>
        {rows.map((c, i) => {
          const isOrder = c.q < N && modpow(a, c.q, N) === 1;
          return (
            <span key={i} style={{
              padding: '3px 8px', borderRadius: 5,
              border: `1px solid ${isOrder ? 'rgba(52,211,153,0.5)' : '#1e293b'}`,
              background: isOrder ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.02)',
              color: isOrder ? '#34d399' : '#94a3b8',
            }}>
              {c.p}/{c.q}{isOrder ? '  ✓ a^q≡1' : ''}
            </span>
          );
        })}
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '6px 0 0' }}>
        The denominator of the convergent closest to the measured phase, with <code>a^q ≡ 1 (mod N)</code>,
        is the period <code>r = {r}</code>.
      </p>
    </div>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div style={{
      padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b',
      borderRadius: 7, minWidth: 70,
    }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: ok === undefined ? '#cbd5e1' : ok ? '#34d399' : '#f87171' }}>
        {value}{ok !== undefined && (ok ? ' ✓' : ' ✗')}
      </div>
    </div>
  );
}

function Card({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: accent }}>{title}</h3>
      {children}
    </div>
  );
}

const sel: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12 };
const lab: React.CSSProperties = { fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' };
const btn: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, background: 'linear-gradient(135deg, #7c3aed, #0891b2)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
