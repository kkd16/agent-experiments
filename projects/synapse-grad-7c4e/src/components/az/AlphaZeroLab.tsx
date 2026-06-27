import { useMemo, useState } from 'react';
import { useAlphaZeroTrainer, type AZConfigUI } from '../../hooks/useAlphaZeroTrainer';
import type { GradCheckResult } from '../../engine/gradcheck';
import type { GameId } from '../../engine/games';
import AZBoard from './AZBoard';
import SearchTree from './SearchTree';

const TTT_DEFAULT: AZConfigUI = {
  gameId: 'ttt',
  channels: 16,
  blocks: 3,
  valueHidden: 16,
  seed: 1,
  selfPlaySims: 40,
  cPuct: 1.5,
  dirichletAlpha: 0.6,
  dirichletFrac: 0.25,
  tempMoves: 4,
  temperature: 1.0,
  augment: true,
  lr: 0.01,
  l2: 1e-4,
  clipNorm: 1.0,
  batchSize: 64,
  bufferCap: 8000,
  gamesPerFrame: 2,
  trainStepsPerFrame: 4,
  aiSims: 80,
  loadId: 0,
};

const C4_DEFAULT: AZConfigUI = {
  ...TTT_DEFAULT,
  gameId: 'c4',
  channels: 24,
  blocks: 4,
  valueHidden: 24,
  selfPlaySims: 50,
  dirichletAlpha: 1.0,
  bufferCap: 12000,
  gamesPerFrame: 1,
  trainStepsPerFrame: 3,
  aiSims: 110,
};

interface OracleResult {
  tested: number;
  optimal: number;
  emptyValue: number;
}

function moveLabel(gameId: GameId, action: number): string {
  if (gameId === 'c4') return `col ${action + 1}`;
  const r = Math.floor(action / 3);
  const c = action % 3;
  return `r${r + 1}·c${c + 1}`;
}

// A tiny inline-SVG line chart (the lab is library-free, like the rest of the app).
function MiniChart({
  series,
  height = 90,
  yMin,
  yMax,
  zeroLine,
  label,
  color = '#38bdf8',
}: {
  series: number[];
  height?: number;
  yMin?: number;
  yMax?: number;
  zeroLine?: number;
  label: string;
  color?: string;
}) {
  const W = 280;
  const H = height;
  const data = series.filter((v) => Number.isFinite(v));
  const lo = yMin ?? (data.length ? Math.min(...data) : 0);
  const hiRaw = yMax ?? (data.length ? Math.max(...data) : 1);
  const hi = hiRaw === lo ? lo + 1 : hiRaw;
  const x = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * (W - 8) + 4);
  const y = (v: number) => H - 6 - ((v - lo) / (hi - lo)) * (H - 12);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'var(--bg-soft)', borderRadius: 8, border: '1px solid var(--border)' }}>
        {zeroLine !== undefined && zeroLine >= lo && zeroLine <= hi && (
          <line x1={4} y1={y(zeroLine)} x2={W - 4} y2={y(zeroLine)} stroke="rgba(74,222,128,0.4)" strokeWidth={1} strokeDasharray="4 3" />
        )}
        {data.length > 0 && <path d={path} fill="none" stroke={color} strokeWidth={1.8} />}
      </svg>
    </div>
  );
}

export default function AlphaZeroLab() {
  const [config, setConfig] = useState<AZConfigUI>(TTT_DEFAULT);
  const [grad, setGrad] = useState<GradCheckResult | null>(null);
  const [oracle, setOracle] = useState<OracleResult | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);

  const az = useAlphaZeroTrainer(config);
  const m = az.metrics;
  const play = az.play;

  const set = <K extends keyof AZConfigUI>(k: K, v: AZConfigUI[K]) => setConfig((c) => ({ ...c, [k]: v }));

  const switchGame = (gameId: GameId) => {
    setConfig(gameId === 'ttt' ? TTT_DEFAULT : C4_DEFAULT);
    setGrad(null);
    setOracle(null);
  };

  // The status line for the play board.
  const statusText = useMemo(() => {
    const s = play.status;
    if (s.done) {
      if (s.winner === 0) return 'Draw.';
      const humanWon = (s.winner === 1) === (play.humanPlayer === 1);
      return humanWon ? 'You win!' : 'The network wins.';
    }
    return play.state.player === play.humanPlayer ? 'Your move.' : 'Network is thinking…';
  }, [play]);

  // Top moves from the live analysis, sorted by visit count.
  const topMoves = useMemo(() => {
    if (!play.analysis) return [];
    const a = play.analysis;
    let total = 0;
    for (let i = 0; i < a.counts.length; i++) total += a.counts[i];
    const rows = [];
    for (let i = 0; i < a.counts.length; i++) {
      if (a.counts[i] > 0 || a.priors[i] > 0) {
        rows.push({ action: i, n: a.counts[i], share: total > 0 ? a.counts[i] / total : 0, q: a.q[i], p: a.priors[i] });
      }
    }
    rows.sort((x, y) => y.n - x.n || y.p - x.p);
    return rows.slice(0, 7);
  }, [play.analysis]);

  const runGrad = () => setGrad(az.runGradCheck());
  const runOracle = () => setOracle(az.runOracleCheck());

  const vp = m.vsPerfect;
  const vr = m.vsRandom;

  return (
    <div className="lab">
      {/* ---- left: controls ---- */}
      <div className="panel">
        <div className="group">
          <h3>Game</h3>
          <div className="seg">
            <button className={config.gameId === 'ttt' ? 'on' : ''} onClick={() => switchGame('ttt')}>
              Tic-Tac-Toe
            </button>
            <button className={config.gameId === 'c4' ? 'on' : ''} onClick={() => switchGame('c4')}>
              Connect Four
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {config.gameId === 'ttt'
              ? 'Solved game — a from-scratch perfect solver is the ground-truth oracle. Watch the agent learn to never lose.'
              : 'The bigger cousin. Plays a depth-limited alpha-beta opponent in evaluation.'}
          </p>
        </div>

        <div className="group">
          <h3>Train</h3>
          <div className="run-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            {az.running ? (
              <button className="primary" onClick={az.pause}>
                Pause
              </button>
            ) : (
              <button className="primary" onClick={az.start}>
                Train ▶
              </button>
            )}
            <button className="ghost" onClick={az.reset}>
              Reset
            </button>
          </div>
          <button className="ghost wide" style={{ width: '100%', marginBottom: 10 }} onClick={az.evalNow}>
            Evaluate now
          </button>
          <Field label={`Self-play sims / move: ${config.selfPlaySims}`}>
            <input type="range" min={8} max={120} step={2} value={config.selfPlaySims} onChange={(e) => set('selfPlaySims', +e.target.value)} />
          </Field>
          <Field label={`c_puct (exploration): ${config.cPuct.toFixed(2)}`}>
            <input type="range" min={0.5} max={4} step={0.1} value={config.cPuct} onChange={(e) => set('cPuct', +e.target.value)} />
          </Field>
          <Field label={`Dirichlet noise ε: ${config.dirichletFrac.toFixed(2)}`}>
            <input type="range" min={0} max={0.5} step={0.05} value={config.dirichletFrac} onChange={(e) => set('dirichletFrac', +e.target.value)} />
          </Field>
          <Field label={`Learning rate: ${config.lr}`}>
            <input type="range" min={0.001} max={0.03} step={0.001} value={config.lr} onChange={(e) => set('lr', +e.target.value)} />
          </Field>
          <Field label={`Self-play games / frame: ${config.gamesPerFrame}`}>
            <input type="range" min={1} max={6} step={1} value={config.gamesPerFrame} onChange={(e) => set('gamesPerFrame', +e.target.value)} />
          </Field>
          <Field label={`Train steps / frame: ${config.trainStepsPerFrame}`}>
            <input type="range" min={1} max={10} step={1} value={config.trainStepsPerFrame} onChange={(e) => set('trainStepsPerFrame', +e.target.value)} />
          </Field>
        </div>

        <div className="group">
          <h3>Network</h3>
          <div className="two">
            <Field label={`Channels: ${config.channels}`}>
              <input type="range" min={8} max={48} step={4} value={config.channels} onChange={(e) => set('channels', +e.target.value)} />
            </Field>
            <Field label={`Conv blocks: ${config.blocks}`}>
              <input type="range" min={1} max={6} step={1} value={config.blocks} onChange={(e) => set('blocks', +e.target.value)} />
            </Field>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {m.paramCount.toLocaleString()} parameters · changing the architecture rebuilds from scratch.
          </p>
        </div>

        <div className="group">
          <h3>Prove it</h3>
          <button className="ghost wide" style={{ width: '100%', marginBottom: 8 }} onClick={runGrad}>
            Gradient-check the AZ loss
          </button>
          {grad && (
            <div className={`gradres ${grad.maxRelError < 1e-3 ? 'ok' : 'warn'}`}>
              max rel-error <b>{grad.maxRelError.toExponential(2)}</b> over {grad.checked} entries —{' '}
              {grad.maxRelError < 1e-3 ? 'backward passes verified ✓' : 'check inputs'}
            </div>
          )}
          {config.gameId === 'ttt' && (
            <>
              <button className="ghost wide" style={{ width: '100%', margin: '8px 0' }} onClick={runOracle}>
                Verify search soundness
              </button>
              {oracle && (
                <div className={`gradres ${oracle.optimal === oracle.tested && oracle.emptyValue === 0 ? 'ok' : 'warn'}`}>
                  MCTS+perfect picked a minimax-optimal move <b>{oracle.optimal}/{oracle.tested}</b> times; the solver values
                  the empty board as a <b>{oracle.emptyValue === 0 ? 'draw' : oracle.emptyValue > 0 ? 'win' : 'loss'}</b> ✓
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ---- center: play + search ---- */}
      <div className="stage">
        <div className="board-card">
          <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Play against the network</span>
            <label className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} /> search overlay
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 210px', gap: 16, alignItems: 'start' }}>
            <div>
              <AZBoard
                game={play.game}
                state={play.state}
                analysis={play.analysis}
                humanPlayer={play.humanPlayer}
                lastAIMove={play.lastAIMove}
                winLine={play.status.line}
                interactive
                showOverlay={showOverlay}
                onPlay={az.humanMove}
              />
            </div>
            <div>
              <div className={`az-status ${play.status.done ? 'done' : ''}`}>{statusText}</div>
              <div className="seg" style={{ marginTop: 10 }}>
                <button onClick={() => az.newGame(true)}>You first</button>
                <button onClick={() => az.newGame(false)}>AI first</button>
              </div>
              <div className="az-eval">
                <div className="muted small">Network evaluation of this position</div>
                {play.analysis ? (
                  <ValueBar value={play.analysis.rootValue} />
                ) : (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {play.status.done ? 'game over' : '—'}
                  </div>
                )}
              </div>
              <p className="muted small" style={{ marginTop: 10 }}>
                Coloured halos show where the search spent its visits (size) and how good each move
                looks (green→good, red→bad). The yellow ring marks the network's last move. The AI
                gets stronger as training runs.
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Search — top moves at the current position</div>
          {topMoves.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>No live search (game over, or the network hasn't been built yet).</p>
          ) : (
            <table className="az-table">
              <thead>
                <tr>
                  <th>move</th>
                  <th>visits</th>
                  <th>share</th>
                  <th>Q (value)</th>
                  <th>P (prior)</th>
                </tr>
              </thead>
              <tbody>
                {topMoves.map((row) => (
                  <tr key={row.action}>
                    <td>{moveLabel(config.gameId, row.action)}</td>
                    <td>{row.n}</td>
                    <td>
                      <div className="az-bar">
                        <span style={{ width: `${row.share * 100}%`, background: '#38bdf8' }} />
                      </div>
                      <span className="az-bar-num">{(row.share * 100).toFixed(0)}%</span>
                    </td>
                    <td>
                      <div className="az-bar center">
                        <span
                          style={{
                            width: `${Math.abs(row.q) * 50}%`,
                            marginLeft: row.q >= 0 ? '50%' : `${50 - Math.abs(row.q) * 50}%`,
                            background: row.q >= 0 ? '#4ade80' : '#f87171',
                          }}
                        />
                      </div>
                      <span className="az-bar-num">{row.q >= 0 ? '+' : ''}{row.q.toFixed(2)}</span>
                    </td>
                    <td>
                      <div className="az-bar">
                        <span style={{ width: `${row.p * 100}%`, background: '#a78bfa' }} />
                      </div>
                      <span className="az-bar-num">{(row.p * 100).toFixed(0)}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            The policy head proposes priors <b>P</b>; the search reallocates its <b>visits</b> toward moves whose backed-up
            value <b>Q</b> holds up under lookahead. The visit distribution is the policy we train the network to imitate.
          </p>
        </div>

        {play.analysis?.tree && play.analysis.tree.children.length > 0 && (
          <div className="card">
            <div className="card-title">Watch it think — the search tree</div>
            <SearchTree tree={play.analysis.tree} label={(a) => moveLabel(config.gameId, a)} />
            <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
              The most-visited branches the search grew from the current position (top {4} per node, depth 3). Node
              size is its visit count; colour is its value from the side-to-move's view (green good, red bad). Thicker
              edges carry more of the search's attention.
            </p>
          </div>
        )}
      </div>

      {/* ---- right: metrics + charts ---- */}
      <div className="panel">
        <div className="card">
          <div className="card-title">Training</div>
          <div className="stat-row">
            <div className="stat">
              <span className="muted small">updates</span>
              <b>{m.iter.toLocaleString()}</b>
            </div>
            <div className="stat">
              <span className="muted small">self-play</span>
              <b>{m.selfPlayGames.toLocaleString()}</b>
            </div>
            <div className="stat">
              <span className="muted small">buffer</span>
              <b>{m.bufferSize.toLocaleString()}</b>
            </div>
          </div>
          <div className="stat-row" style={{ marginTop: 8 }}>
            <div className="stat">
              <span className="muted small">policy loss</span>
              <b>{Number.isFinite(m.policyLoss) ? m.policyLoss.toFixed(3) : '—'}</b>
            </div>
            <div className="stat">
              <span className="muted small">value loss</span>
              <b>{Number.isFinite(m.valueLoss) ? m.valueLoss.toFixed(3) : '—'}</b>
            </div>
            <div className="stat">
              <span className="muted small">params</span>
              <b>{m.paramCount.toLocaleString()}</b>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Strength vs reference players</div>
          <div className="az-eval-grid">
            <EvalRow
              label={config.gameId === 'ttt' ? 'vs PERFECT play' : 'vs strong (αβ) play'}
              w={vp?.wins}
              d={vp?.draws}
              l={vp?.losses}
              highlight={config.gameId === 'ttt'}
            />
            <EvalRow label="vs RANDOM play" w={vr?.wins} d={vr?.draws} l={vr?.losses} />
          </div>
          {config.gameId === 'ttt' && vp && (
            <div className={`gradres ${vp.losses === 0 ? 'ok' : 'warn'}`} style={{ marginTop: 10 }}>
              {vp.losses === 0 ? (
                <>
                  <b>0 losses to perfect play</b> — the agent has learned at least a drawing strategy. Tic-Tac-Toe is a
                  draw under optimal play, so this is the ceiling.
                </>
              ) : (
                <>Still losing {vp.losses}/{vp.games} to perfect play — keep training.</>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Learning curves</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MiniChart series={m.valueLossHistory} label="value loss" color="#f472b6" />
            <MiniChart series={m.policyLossHistory} label="policy loss" color="#38bdf8" />
            {config.gameId === 'ttt' ? (
              <MiniChart series={m.lossesToPerfectHistory} label="losses to perfect (→ 0)" color="#f87171" yMin={0} zeroLine={0} />
            ) : null}
            <MiniChart series={m.scoreVsRandomHistory} label="score vs random (→ 1)" color="#4ade80" yMin={0} yMax={1} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ValueBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, (value + 1) * 50));
  return (
    <div style={{ marginTop: 6 }}>
      <div className="az-value-bar">
        <span style={{ width: `${pct}%`, background: value >= 0 ? 'linear-gradient(90deg,#334155,#4ade80)' : 'linear-gradient(90deg,#f87171,#334155)' }} />
        <i style={{ left: '50%' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span className="muted small">losing</span>
        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{value >= 0 ? '+' : ''}{value.toFixed(2)}</b>
        <span className="muted small">winning</span>
      </div>
    </div>
  );
}

function EvalRow({ label, w, d, l, highlight }: { label: string; w?: number; d?: number; l?: number; highlight?: boolean }) {
  const total = (w ?? 0) + (d ?? 0) + (l ?? 0);
  return (
    <div className={`az-eval-row ${highlight ? 'hl' : ''}`}>
      <div className="muted small" style={{ marginBottom: 4 }}>{label}</div>
      {total === 0 ? (
        <div className="muted small">not evaluated yet — hit “Evaluate now” or start training</div>
      ) : (
        <div className="az-wdl">
          <span className="win">W {w}</span>
          <span className="draw">D {d}</span>
          <span className="loss">L {l}</span>
        </div>
      )}
    </div>
  );
}
