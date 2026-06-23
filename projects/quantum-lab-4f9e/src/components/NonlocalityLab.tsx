import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  type BellName, BELL_LABELS, bellState, chshValue, chshWinProb, optimizeCHSH,
  chshSweep, tsirelsonCeiling, OPTIMAL_CHSH, TSIRELSON_BOUND,
  CHSH_GAME_CLASSICAL, CHSH_GAME_QUANTUM,
  merminExpectations, ghzClassicalMax, ghzGameTable, ghzQuantumWin,
  magicSquareAlgebra, magicClassicalMax, magicQuantumWin, magicCellLabel, MAGIC_CLASSICAL,
  merminTable,
} from '../quantum/nonlocality';

export default function NonlocalityLab() {
  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        Quantum mechanics is not just a faster way to compute — it describes a world that is{' '}
        <b style={{ color: '#a78bfa' }}>non-classical</b>. Entangled particles produce correlations that{' '}
        <i>no local-hidden-variable theory can reproduce</i> (Bell's theorem), and in some cooperative
        games quantum players win <b style={{ color: '#34d399' }}>with certainty</b> where the best
        classical players provably cannot — <b style={{ color: '#34d399' }}>quantum pseudo-telepathy</b>.
        Everything below runs on the exact state-vector engine; every headline number is proven to
        machine precision in the Tests tab.
      </p>

      <CHSHCard />
      <GHZCard />
      <MagicSquareCard />
      <MerminCard />
    </div>
  );
}

// ─────────────────────────────── Mermin–Klyshko ───────────────────────────────

function MerminCard() {
  const rows = useMemo(() => merminTable(10), []);
  const maxRatio = rows[rows.length - 1].ratio;
  return (
    <Card title="Mermin–Klyshko — nonlocality that grows exponentially with size" accent="#f472b6">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        CHSH is the two-party case. Its n-party generalisation — the Mermin polynomial Mₙ, built by a
        recursion <code style={{ color: '#67e8f9' }}>Mₙ = ½[Mₙ₋₁(Aₙ+Aₙ′) + M′ₙ₋₁(Aₙ−Aₙ′)]</code> — obeys{' '}
        <b style={{ color: '#f59e0b' }}>|⟨Mₙ⟩| ≤ 1</b> in every local-hidden-variable theory, yet the
        n-qubit GHZ state reaches <b style={{ color: '#34d399' }}>2^((n−1)/2)</b>. Unlike CHSH's fixed
        2√2, the quantum-over-classical ratio <i>doubles every two parties</i> — macroscopic
        entanglement is overwhelmingly non-classical.
      </p>

      <ViolationPlot rows={rows} />

      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%', marginTop: 12 }}>
        <thead>
          <tr style={{ color: '#94a3b8' }}>
            <th style={th}>parties n</th>
            <th style={th}>LHV bound</th>
            <th style={th}>quantum ⟨Mₙ⟩</th>
            <th style={th}>violation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.n} style={{ color: '#cbd5e1', background: row.n % 2 ? 'rgba(2,6,23,0.4)' : 'transparent' }}>
              <td style={td}>{row.n}</td>
              <td style={{ ...td, color: '#f59e0b' }}>1</td>
              <td style={{ ...td, color: '#34d399' }}>{row.quantum.toFixed(4)}</td>
              <td style={{ ...td, color: '#f472b6', fontWeight: 700 }}>{row.ratio.toFixed(2)}×</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        The quantum values come straight from the engine (the Mermin operator on the GHZ state with the
        optimal X–Y plane settings αⱼ = −(j−1)π/2n); the LHV bound 1 is brute-forced over all 2²ⁿ
        deterministic ±1 assignments. At n = 10 the violation is already{' '}
        <b style={{ color: '#f472b6' }}>{maxRatio.toFixed(1)}×</b> the classical limit.
      </p>
    </Card>
  );
}

function ViolationPlot({ rows }: { rows: { n: number; quantum: number; ratio: number }[] }) {
  const W = 800, H = 200, padL = 40, padR = 12, padT = 12, padB = 26;
  const nMax = rows[rows.length - 1].n, yMax = rows[rows.length - 1].quantum * 1.08;
  const xPix = (n: number) => padL + ((n - 2) / (nMax - 2)) * (W - padL - padR);
  const yPix = (y: number) => padT + ((yMax - y) / yMax) * (H - padT - padB);
  const qPath = rows.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.quantum).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {/* classical bound line at y=1 */}
      <line x1={padL} y1={yPix(1)} x2={W - padR} y2={yPix(1)} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={padL + 4} y={yPix(1) - 4} fontSize={10} fill="#f59e0b">classical bound = 1</text>
      {/* quantum curve */}
      <path d={qPath} fill="none" stroke="#34d399" strokeWidth={2} />
      {rows.map((p) => (
        <g key={p.n}>
          <circle cx={xPix(p.n)} cy={yPix(p.quantum)} r={3.5} fill="#34d399" />
          <text x={xPix(p.n)} y={H - 10} fontSize={9} fill="#475569" textAnchor="middle">{p.n}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 1} fontSize={9} fill="#64748b" textAnchor="middle">number of parties n</text>
      <text x={padL + 4} y={padT + 10} fontSize={10} fill="#34d399">quantum ⟨Mₙ⟩ = 2^((n−1)/2)</text>
    </svg>
  );
}

// ─────────────────────────────── CHSH ───────────────────────────────

function CHSHCard() {
  const [bell, setBell] = useState<BellName>('phi+');
  const [a, setA] = useState(OPTIMAL_CHSH.a);
  const [ap, setAp] = useState(OPTIMAL_CHSH.ap);
  const [b, setB] = useState(OPTIMAL_CHSH.b);
  const [bp, setBp] = useState(OPTIMAL_CHSH.bp);

  const state = useMemo(() => bellState(bell), [bell]);
  const S = useMemo(() => chshValue(state, { a, ap, b, bp }), [state, a, ap, b, bp]);
  const sweep = useMemo(() => chshSweep(state), [state]);
  const ceiling = useMemo(() => tsirelsonCeiling(state, 8000, 3), [state]);
  const pWin = chshWinProb(S);

  const optimize = () => {
    const r = optimizeCHSH(state, (Math.random() * 1e9) | 0);
    setA(r.angles.a); setAp(r.angles.ap); setB(r.angles.b); setBp(r.angles.bp);
  };
  const reset = () => { setA(OPTIMAL_CHSH.a); setAp(OPTIMAL_CHSH.ap); setB(OPTIMAL_CHSH.b); setBp(OPTIMAL_CHSH.bp); };

  const violates = Math.abs(S) > 2 + 1e-6;

  return (
    <Card title="The CHSH inequality — Bell's theorem, made quantitative" accent="#a78bfa">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Alice and Bob each pick one of two measurement directions on a shared Bell pair. Each measures
        a <b style={{ color: '#a78bfa' }}>±1 observable</b> A(θ) = cosθ·Z + sinθ·X, and we form the
        correlator E(a,b) = ⟨ψ|A(a)⊗B(b)|ψ⟩. The Bell quantity{' '}
        <code style={{ color: '#67e8f9' }}>S = E(a,b) + E(a,b′) + E(a′,b) − E(a′,b′)</code> can never exceed{' '}
        <b>2</b> for any local-hidden-variable theory — yet quantum mechanics reaches{' '}
        <b style={{ color: '#34d399' }}>2√2 ≈ 2.828</b>, Tsirelson's bound.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>shared state
          <select value={bell} onChange={(e) => setBell(e.target.value as BellName)} style={sel}>
            {(Object.keys(BELL_LABELS) as BellName[]).map((n) => <option key={n} value={n}>{BELL_LABELS[n]}</option>)}
          </select>
        </label>
        <button onClick={optimize} style={btn}>✨ Maximise S (Nelder–Mead)</button>
        <button onClick={reset} style={btnGhost}>↺ canonical angles</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 22px', marginBottom: 14 }}>
        <Slider label="Alice a" value={a} onChange={setA} color="#a78bfa" />
        <Slider label="Bob b" value={b} onChange={setB} color="#34d399" />
        <Slider label="Alice a′" value={ap} onChange={setAp} color="#a78bfa" />
        <Slider label="Bob b′" value={bp} onChange={setBp} color="#34d399" />
      </div>

      {/* S meter */}
      <SMeter S={S} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
        <Stat label="Bell quantity S" value={S.toFixed(4)} ok={violates} />
        <Stat label="classical bound" value="2" accent="#f59e0b" />
        <Stat label="Tsirelson 2√2" value={TSIRELSON_BOUND.toFixed(4)} accent="#34d399" />
        <Stat label="status" value={violates ? 'VIOLATED' : 'within LHV'} ok={violates} />
      </div>

      <SweepPlot sweep={sweep} currentB={b} currentS={S} />

      {/* The game */}
      <h4 style={subhead}>…as a cooperative game</h4>
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.6 }}>
        Reframe it: a referee sends bits x, y; the players (no communication) answer a, b and win iff{' '}
        <code style={{ color: '#67e8f9' }}>a ⊕ b = x ∧ y</code>. The dictionary{' '}
        <code>p = (S+4)/8</code> turns the bounds into win rates — quantum strategies beat every
        classical one.
      </p>
      <WinBars rows={[
        { label: 'classical optimum', value: CHSH_GAME_CLASSICAL, color: '#f59e0b' },
        { label: 'this strategy', value: Math.max(0, Math.min(1, pWin)), color: '#a78bfa' },
        { label: 'quantum optimum cos²(π/8)', value: CHSH_GAME_QUANTUM, color: '#34d399' },
      ]} />

      <p style={{ color: '#475569', fontSize: 10, margin: '12px 0 0', lineHeight: 1.5 }}>
        Monte-Carlo Tsirelson certificate: the largest |S| over 8,000 random measurement settings on
        this state is <b style={{ color: '#67e8f9' }}>{ceiling.toFixed(4)}</b> — never above 2√2 ={' '}
        {TSIRELSON_BOUND.toFixed(4)}. The quantum bound is not merely reached, it is a ceiling.
      </p>
    </Card>
  );
}

function SMeter({ S }: { S: number }) {
  const max = TSIRELSON_BOUND;
  const pct = (v: number) => ((v + max) / (2 * max)) * 100;
  const violates = Math.abs(S) > 2 + 1e-6;
  return (
    <div style={{ position: 'relative', height: 34, background: 'rgba(2,6,23,0.6)', border: '1px solid #1e293b', borderRadius: 8, overflow: 'hidden' }}>
      {/* classical band [-2,2] */}
      <div style={{ position: 'absolute', left: `${pct(-2)}%`, width: `${pct(2) - pct(-2)}%`, top: 0, bottom: 0, background: 'rgba(245,158,11,0.12)', borderLeft: '1px dashed #f59e0b', borderRight: '1px dashed #f59e0b' }} />
      {/* zero line */}
      <div style={{ position: 'absolute', left: `${pct(0)}%`, top: 0, bottom: 0, width: 1, background: '#334155' }} />
      {/* the needle */}
      <motion.div
        animate={{ left: `${pct(S)}%` }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
        style={{ position: 'absolute', top: 2, bottom: 2, width: 4, marginLeft: -2, borderRadius: 2, background: violates ? '#34d399' : '#f59e0b', boxShadow: `0 0 8px ${violates ? '#34d399' : '#f59e0b'}` }}
      />
      <span style={{ position: 'absolute', left: 6, top: 9, fontSize: 9, color: '#475569' }}>−2√2</span>
      <span style={{ position: 'absolute', right: 6, top: 9, fontSize: 9, color: '#475569' }}>+2√2</span>
    </div>
  );
}

function SweepPlot({ sweep, currentB, currentS }: { sweep: { theta: number; S: number }[]; currentB: number; currentS: number }) {
  const W = 800, H = 180, padL = 36, padR = 12, padT = 12, padB = 22;
  const xmax = 2 * Math.PI, ymax = TSIRELSON_BOUND * 1.05;
  const xPix = (t: number) => padL + (t / xmax) * (W - padL - padR);
  const yPix = (s: number) => padT + ((ymax - s) / (2 * ymax)) * (H - padT - padB);
  const path = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.theta).toFixed(1)},${yPix(p.S).toFixed(1)}`).join(' ');
  const markB = ((currentB % xmax) + xmax) % xmax;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>S as Bob's first angle b sweeps 0 → 2π (other angles fixed at the optimum)</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
        {[TSIRELSON_BOUND, 2, 0, -2, -TSIRELSON_BOUND].map((y) => {
          const isClass = Math.abs(y) === 2, isTsi = Math.abs(Math.abs(y) - TSIRELSON_BOUND) < 1e-6;
          return (
            <g key={y}>
              <line x1={padL} y1={yPix(y)} x2={W - padR} y2={yPix(y)} stroke={isTsi ? '#34d399' : isClass ? '#f59e0b' : '#1e293b'} strokeWidth={isTsi || isClass ? 1 : 0.5} strokeDasharray={isTsi || isClass ? '4 3' : ''} />
              <text x={4} y={yPix(y) + 3} fontSize={9} fill={isTsi ? '#34d399' : isClass ? '#f59e0b' : '#475569'}>{y === TSIRELSON_BOUND ? '2√2' : y === -TSIRELSON_BOUND ? '−2√2' : y.toFixed(0)}</text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke="#67e8f9" strokeWidth={1.8} />
        <line x1={xPix(markB)} y1={padT} x2={xPix(markB)} y2={H - padB} stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 2" />
        <circle cx={xPix(markB)} cy={yPix(currentS)} r={4} fill="#a78bfa" />
      </svg>
    </div>
  );
}

// ─────────────────────────────── GHZ / Mermin game ───────────────────────────────

function GHZCard() {
  const mermin = useMemo(() => merminExpectations(), []);
  const table = useMemo(() => ghzGameTable(), []);
  const classical = useMemo(() => ghzClassicalMax(), []);
  const quantum = useMemo(() => ghzQuantumWin(), []);

  return (
    <Card title="The GHZ / Mermin game — quantum pseudo-telepathy" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Three players share a <code style={{ color: '#34d399' }}>|GHZ⟩ = (|000⟩+|111⟩)/√2</code>. The
        referee sends bits (x,y,z) with x⊕y⊕z = 0; players answer a,b,c with no communication and win
        iff <code style={{ color: '#67e8f9' }}>a ⊕ b ⊕ c = x ∨ y ∨ z</code>. No classical strategy wins
        all four questions — but a quantum one does, <b style={{ color: '#34d399' }}>every time</b>. The
        strategy: measure X if your input is 0, Y if it is 1. The GHZ correlations do the rest.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {mermin.map((m) => (
          <div key={m.label} style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7 }}>
            <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>⟨{m.label}⟩</div>
            <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: m.value > 0 ? '#34d399' : '#f472b6' }}>{m.value >= 0 ? '+' : ''}{m.value.toFixed(2)}</div>
          </div>
        ))}
      </div>

      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%', marginBottom: 14 }}>
        <thead>
          <tr style={{ color: '#94a3b8' }}>
            <th style={th}>question (x,y,z)</th>
            <th style={th}>measure</th>
            <th style={th}>⟨op⟩</th>
            <th style={th}>a⊕b⊕c</th>
            <th style={th}>need x∨y∨z</th>
            <th style={th}>result</th>
          </tr>
        </thead>
        <tbody>
          {table.map((row, i) => (
            <tr key={i} style={{ color: '#cbd5e1', background: i % 2 ? 'rgba(2,6,23,0.4)' : 'transparent' }}>
              <td style={td}>({row.question.join(',')})</td>
              <td style={td}>{row.operator}</td>
              <td style={{ ...td, color: row.expectation > 0 ? '#34d399' : '#f472b6' }}>{row.expectation >= 0 ? '+' : ''}{row.expectation.toFixed(2)}</td>
              <td style={td}>{row.outcomeParity}</td>
              <td style={td}>{row.required}</td>
              <td style={{ ...td, color: '#34d399', fontWeight: 700 }}>{row.win ? '✓ win' : '✗ lose'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <WinBars rows={[
        { label: 'best classical strategy', value: classical.max, color: '#f59e0b' },
        { label: 'quantum (GHZ)', value: quantum, color: '#34d399' },
      ]} />
      <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        A brute force over all 64 deterministic classical strategies finds {classical.count} that tie at
        the maximum 3/4 — none reaches 1. Multiplying the four win constraints gives 0 = 1, a parity
        contradiction: <i>no</i> local assignment can satisfy them all. The quantum players win with
        certainty, sharing no information — pseudo-telepathy.
      </p>
    </Card>
  );
}

// ─────────────────────────────── Magic square ───────────────────────────────

function MagicSquareCard() {
  const algebra = useMemo(() => magicSquareAlgebra(), []);
  const classical = useMemo(() => magicClassicalMax(), []);
  const quantum = useMemo(() => magicQuantumWin(), []);

  return (
    <Card title="The Mermin–Peres magic-square game" accent="#67e8f9">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Alice gets a row, Bob a column of a 3×3 grid. Each fills their three cells with ±1 so that every
        row multiplies to <b style={{ color: '#34d399' }}>+1</b> and every column to{' '}
        <b style={{ color: '#34d399' }}>+1 — except the last column, which must be −1</b>. They win iff
        they agree on the shared cell. It is <i>impossible</i> classically (a parity contradiction), but
        quantum players sharing two Bell pairs win <b style={{ color: '#67e8f9' }}>every time</b>: the
        grid is realised by two-qubit Pauli observables whose product algebra is exactly this rule.
      </p>

      {/* the operator grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 6, marginBottom: 12, maxWidth: 520 }}>
        {[0, 1, 2].map((r) => (
          <Fragment key={r}>
            {[0, 1, 2].map((c) => (
              <div key={c} style={{
                padding: '12px 8px', textAlign: 'center', borderRadius: 8,
                background: 'rgba(2,6,23,0.6)', border: '1px solid #1e293b',
                fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: '#e2e8f0',
              }}>{magicCellLabel(r, c)}</div>
            ))}
            <ProductBadge sign={algebra.rowProducts[r]} axis="row" />
          </Fragment>
        ))}
        {[0, 1, 2].map((c) => <ProductBadge key={c} sign={algebra.colProducts[c]} axis="col" />)}
        <div />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Stat label="all cells ±1-valued (O²=I)" value={algebra.involutory ? 'yes' : 'no'} ok={algebra.involutory} />
        <Stat label="rows/cols commute" value={algebra.rowsCommute && algebra.colsCommute ? 'yes' : 'no'} ok={algebra.rowsCommute && algebra.colsCommute} />
        <Stat label="∏rows vs ∏cols" value="+1 vs −1" ok={algebra.parityContradiction} />
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.6 }}>
        The product of all nine entries is <b style={{ color: '#34d399' }}>+1</b> read by rows but{' '}
        <b style={{ color: '#f472b6' }}>−1</b> read by columns — a flat contradiction, so no consistent
        ±1 table exists. The best classical play satisfies only 8 of 9 question pairs.
      </p>

      <WinBars rows={[
        { label: 'best classical strategy', value: classical, color: '#f59e0b' },
        { label: 'quantum (2 Bell pairs)', value: quantum.win, color: '#67e8f9' },
      ]} />
      <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        Classical maximum = {classical.toFixed(4)} = {(MAGIC_CLASSICAL * 9).toFixed(0)}/9. Quantum: on the
        shared state |Φ⁺⟩⊗|Φ⁺⟩ all nine shared cells correlate at exactly +1 (worst deviation{' '}
        {quantum.worstDeviation.toExponential(1)}), so the players agree on every shared entry and win all
        81 (row, column) questions with certainty.
      </p>
    </Card>
  );
}

function ProductBadge({ sign, axis }: { sign: '+I' | '-I'; axis: 'row' | 'col' }) {
  const plus = sign === '+I';
  return (
    <div title={`${axis} product = ${sign}`} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 38, padding: '0 8px',
      borderRadius: 8, fontFamily: 'monospace', fontSize: 12, fontWeight: 800,
      color: plus ? '#34d399' : '#f472b6',
      background: plus ? 'rgba(52,211,153,0.1)' : 'rgba(244,114,182,0.12)',
      border: `1px solid ${plus ? 'rgba(52,211,153,0.4)' : 'rgba(244,114,182,0.5)'}`,
    }}>{sign}</div>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Fragment({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function Slider({ label, value, onChange, color }: { label: string; value: number; onChange: (v: number) => void; color: string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span><b style={{ color }}>{label}</b></span>
        <span style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{(value / Math.PI).toFixed(3)}π</span>
      </span>
      <input type="range" min={-Math.PI} max={Math.PI} step={Math.PI / 180} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: color }} />
    </label>
  );
}

function WinBars({ rows }: { rows: { label: string; value: number; color: string }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 200, fontSize: 10, color: '#94a3b8', textAlign: 'right', flexShrink: 0 }}>{row.label}</span>
          <div style={{ flex: 1, height: 18, background: 'rgba(2,6,23,0.6)', border: '1px solid #1e293b', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
            <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, row.value)) * 100}%` }} transition={{ duration: 0.5 }}
              style={{ height: '100%', background: row.color, opacity: 0.7 }} />
          </div>
          <span style={{ width: 56, fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: row.color }}>{(row.value * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, ok, accent }: { label: string; value: string; ok?: boolean; accent?: string }) {
  const color = ok === undefined ? (accent ?? '#cbd5e1') : ok ? '#34d399' : '#f59e0b';
  return (
    <div style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7, minWidth: 70 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color }}>{value}{ok !== undefined && (ok ? ' ✓' : '')}</div>
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
const btnGhost: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, background: 'transparent', color: '#94a3b8', border: '1px solid #334155', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const subhead: React.CSSProperties = { margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: '#cbd5e1' };
const th: React.CSSProperties = { padding: '3px 8px', fontWeight: 600, borderBottom: '1px solid #1e293b', textAlign: 'left' };
const td: React.CSSProperties = { padding: '3px 8px' };
