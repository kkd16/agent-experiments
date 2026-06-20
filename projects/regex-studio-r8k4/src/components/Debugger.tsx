import { useEffect, useMemo, useState } from 'react';
import type { DFA } from '../engine/dfa';
import type { Layout } from '../engine/layout';
import type { NFA } from '../engine/nfa';
import { traceDFA, traceNFA } from '../engine/simulate';
import { AutomatonGraph } from './AutomatonGraph';

interface Props {
  nfa: NFA | null;
  dfa: DFA | null;
  nfaLayout: Layout | null;
  dfaLayout: Layout | null;
  text: string;
}

type Mode = 'nfa' | 'dfa';

export function Debugger({ nfa, dfa, nfaLayout, dfaLayout, text }: Props) {
  const [mode, setMode] = useState<Mode>('nfa');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(600);

  const nfaTrace = useMemo(() => (nfa ? traceNFA(nfa, text) : null), [nfa, text]);
  const dfaTrace = useMemo(() => (dfa ? traceDFA(dfa, text) : null), [dfa, text]);

  const frames = mode === 'nfa' ? nfaTrace?.frames ?? [] : dfaTrace?.frames ?? [];
  const accepted = mode === 'nfa' ? nfaTrace?.accepted : dfaTrace?.accepted;
  const maxStep = Math.max(0, frames.length - 1);

  // Reset the cursor when the input or automaton changes underneath us. Doing
  // this during render (rather than in an effect) avoids a flash of stale state.
  const resetKey = `${mode}|${text}`;
  const [lastKey, setLastKey] = useState(resetKey);
  if (lastKey !== resetKey) {
    setLastKey(resetKey);
    setStep(0);
    setPlaying(false);
  }

  const clampedStep = Math.min(step, maxStep);
  const isPlaying = playing && clampedStep < maxStep;

  useEffect(() => {
    if (!playing || clampedStep >= maxStep) return;
    const id = setTimeout(() => setStep((s) => Math.min(s + 1, maxStep)), speed);
    return () => clearTimeout(id);
  }, [playing, clampedStep, maxStep, speed]);

  const togglePlay = () => {
    if (clampedStep >= maxStep) {
      setStep(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  const nfaFrame = mode === 'nfa' ? nfaTrace?.frames[clampedStep] : undefined;
  const dfaFrame = mode === 'dfa' ? dfaTrace?.frames[clampedStep] : undefined;

  const highlight = useMemo(() => {
    if (nfaFrame) return new Set(nfaFrame.active);
    if (dfaFrame && dfaFrame.state >= 0) return new Set([dfaFrame.state]);
    return new Set<number>();
  }, [nfaFrame, dfaFrame]);

  const layout = mode === 'nfa' ? nfaLayout : dfaLayout;
  const chars = useMemo(() => Array.from(text), [text]);
  const consumed = nfaFrame?.consumed ?? dfaFrame?.consumed ?? 0;
  const lastChar = nfaFrame?.char ?? dfaFrame?.char ?? null;
  const stuck = mode === 'nfa' ? !!nfaFrame?.stuck : dfaFrame?.state === -1;
  const stateLabel =
    mode === 'nfa'
      ? `${highlight.size} active state${highlight.size === 1 ? '' : 's'}`
      : `state ${dfaFrame?.state ?? '–'}`;
  const atEnd = clampedStep >= maxStep;

  if (!nfa || !layout) return <div className="placeholder">Fix the pattern to start debugging.</div>;

  return (
    <div className="debugger">
      <div className="debug-controls">
        <div className="seg">
          <button className={mode === 'nfa' ? 'active' : ''} onClick={() => setMode('nfa')}>
            NFA
          </button>
          <button className={mode === 'dfa' ? 'active' : ''} onClick={() => setMode('dfa')}>
            DFA
          </button>
        </div>
        <div className="transport">
          <button onClick={() => { setPlaying(false); setStep(0); }} title="Reset">⏮</button>
          <button onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }} title="Step back">◀</button>
          <button className="play" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={() => { setPlaying(false); setStep((s) => Math.min(maxStep, s + 1)); }} title="Step forward">▶</button>
        </div>
        <label className="speed">
          speed
          <input
            type="range"
            min={120}
            max={1200}
            step={60}
            value={1320 - speed}
            onChange={(e) => setSpeed(1320 - Number(e.target.value))}
          />
        </label>
        <div className="step-readout">
          step {clampedStep}/{maxStep}
        </div>
      </div>

      <div className="ribbon">
        {chars.length === 0 && <span className="ribbon-empty">empty input — checking ε-acceptance</span>}
        {chars.map((ch, i) => (
          <span
            key={i}
            className={`cell${i < consumed ? ' done' : ''}${i === consumed ? ' cursor' : ''}`}
          >
            {ch === ' ' ? '␣' : ch === '\n' ? '↵' : ch}
          </span>
        ))}
        <span className={`cell end${consumed >= chars.length ? ' cursor' : ''}`}>⏹</span>
      </div>

      <div className="debug-status">
        {lastChar != null ? (
          <span>
            read <code>{lastChar === ' ' ? '␣' : lastChar}</code> →{' '}
          </span>
        ) : (
          <span>start · </span>
        )}
        {stuck ? (
          <span className="bad">stuck (no transition) — rejected</span>
        ) : (
          <span>{stateLabel}</span>
        )}
        {atEnd && !stuck && (
          <span className={accepted ? 'good' : 'bad'}> · {accepted ? 'ACCEPTED ✓' : 'rejected'}</span>
        )}
      </div>

      <AutomatonGraph layout={layout} highlight={highlight} accent={mode === 'nfa' ? '#f59e0b' : '#34d399'} />
    </div>
  );
}
