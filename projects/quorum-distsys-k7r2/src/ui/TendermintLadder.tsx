// The Tendermint round-ladder visualiser — the protocol's signature picture.
//
// The top strip is the DECIDED CHAIN: one green block per height, the immutable
// output of consensus (Tendermint has immediate finality — a decided block is
// never reverted). Below it is the live round ladder for the height currently
// under decision: one row per round, three cells per row (propose · prevote ·
// precommit), each vote drawn as a pip so the 2f+1 quorum is something you can
// literally count. A round that gathers a 2f+1 prevote quorum lights a **Polka**
// badge; the validator then **locks** (🔒) and precommits; a 2f+1 precommit
// quorum lights **Commit** and the height decides. Watching the lock hold across
// a bad round — and the ladder climb to the next proposer — *is* Tendermint.
import { useMemo } from 'react';
import { quorum, proposerOf, opStr, NIL, type TendermintState } from '../protocols/tendermint/types';

interface Props {
  state: TendermintState | null;
  /** All validator ids, in order — for the (H+R) mod N proposer and quorum size. */
  all: string[];
}

const C = {
  propose: '#b08bff',
  prevoteVal: '#7c9cff',
  precommitVal: '#5bd6c8',
  nil: '#4b556b',
  forged: '#ff5d6c',
  decided: '#73e08a',
  lock: '#f5c451',
  empty: 'rgba(255,255,255,0.10)',
  frame: 'rgba(255,255,255,0.14)',
};

const ROUND_WINDOW = 5; // most-recent rounds to show
const CHAIN_WINDOW = 9; // most-recent decided heights to show

interface VoteBreak {
  val: number;
  nil: number;
  forged: number;
  polka: boolean;
}

/** Count a round's votes for the proposal value, nil, and everything else. */
function breakdown(byId: Record<string, Record<string, true>> | undefined, valueId: string | null, q: number): VoteBreak {
  const out: VoteBreak = { val: 0, nil: 0, forged: 0, polka: false };
  if (!byId) return out;
  for (const id of Object.keys(byId)) {
    const c = Object.keys(byId[id]).length;
    if (id === NIL) out.nil += c;
    else if (valueId && id === valueId) out.val += c;
    else out.forged += c;
    if (id !== NIL && c >= q) out.polka = true;
  }
  return out;
}

/** A row of N pips filled by category, so the 2f+1 line is countable. */
function Pips({ n, br, valColor, q }: { n: number; br: VoteBreak; valColor: string; q: number }) {
  const cells: string[] = [];
  for (let i = 0; i < br.val; i++) cells.push(valColor);
  for (let i = 0; i < br.nil; i++) cells.push(C.nil);
  for (let i = 0; i < br.forged; i++) cells.push(C.forged);
  while (cells.length < n) cells.push('');
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      {cells.slice(0, n).map((c, i) => (
        <span
          key={i}
          title={i + 1 === q ? `2f+1 = ${q} (quorum)` : undefined}
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            background: c || C.empty,
            border: `1px solid ${c ? 'transparent' : C.frame}`,
            // Mark the quorum threshold with a bright left edge on the q-th pip.
            boxShadow: i + 1 === q ? `-2px 0 0 0 ${C.decided}` : undefined,
          }}
        />
      ))}
    </div>
  );
}

export function TendermintLadder({ state, all }: Props) {
  const n = all.length;
  const q = quorum(n);

  const chain = useMemo(() => {
    if (!state) return [];
    const rows = [...state.committed].sort((a, b) => a.height - b.height);
    return rows.slice(-CHAIN_WINDOW);
  }, [state]);

  const rounds = useMemo(() => {
    if (!state) return [];
    const present = new Set<number>();
    for (const map of [state.proposals, state.prevotes, state.precommits, state.roundSenders]) {
      for (const k of Object.keys(map)) present.add(Number(k));
    }
    present.add(state.round);
    const all = [...present].sort((a, b) => a - b);
    return all.slice(-ROUND_WINDOW);
  }, [state]);

  if (!state) {
    return (
      <div style={box}>
        <div style={{ color: '#8a93a6', padding: 16, fontSize: 13 }}>No validator selected yet.</div>
      </div>
    );
  }

  const H = state.height;

  return (
    <div style={box}>
      {/* -------- decided chain -------- */}
      <div style={{ padding: '10px 12px 6px' }}>
        <div style={hdr}>
          <span>Decided chain</span>
          <span style={{ color: '#8a93a6' }}>height ≤ #{state.decidedHeight}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 4 }}>
          <div style={{ ...blockCard, background: 'rgba(115,224,138,0.12)', borderColor: 'rgba(115,224,138,0.3)', minWidth: 52 }}>
            <div style={{ fontSize: 10, color: '#8a93a6' }}>genesis</div>
            <div style={{ fontSize: 12, color: '#73e08a', fontWeight: 600 }}>#0</div>
          </div>
          {chain.length === 0 && <div style={{ color: '#8a93a6', fontSize: 12, alignSelf: 'center' }}>nothing decided yet — send a client request</div>}
          {chain.map((e) => (
            <div key={e.height} style={{ ...blockCard, background: 'rgba(115,224,138,0.12)', borderColor: 'rgba(115,224,138,0.32)' }}>
              <div style={{ fontSize: 10, color: '#8a93a6' }}>
                #{e.height} · r{e.round}
                {e.via === 'sync' ? ' · sync' : ''}
              </div>
              <div style={{ fontSize: 12, color: C.decided, fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{opStr(e.cmd)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* -------- current-height ladder -------- */}
      <div style={{ padding: '4px 12px 12px' }}>
        <div style={hdr}>
          <span>
            Deciding height <b style={{ color: '#e8eaf0' }}>#{H}</b> · round {state.round} · <span style={{ textTransform: 'capitalize' }}>{state.step}</span>
          </span>
          <span style={{ color: '#8a93a6' }}>2f+1 = {q}</span>
        </div>

        {/* lock / valid status */}
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: '#9aa2b1', margin: '2px 0 8px' }}>
          <span>
            🔒 locked:{' '}
            {state.lockedValue ? (
              <b style={{ color: C.lock, fontFamily: 'ui-monospace, monospace' }}>
                {opStr(state.lockedValue.cmd)} @r{state.lockedRound}
              </b>
            ) : (
              <span style={{ color: '#6b7385' }}>none</span>
            )}
          </span>
          <span>
            ✓ valid:{' '}
            {state.validValue ? (
              <b style={{ color: '#7c9cff', fontFamily: 'ui-monospace, monospace' }}>
                {opStr(state.validValue.cmd)} @r{state.validRound}
              </b>
            ) : (
              <span style={{ color: '#6b7385' }}>none</span>
            )}
          </span>
        </div>

        {/* column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '54px 1.3fr 1fr 1fr', gap: 8, fontSize: 10.5, color: '#6b7385', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          <span>round</span>
          <span style={{ color: C.propose }}>propose</span>
          <span style={{ color: C.prevoteVal }}>prevote</span>
          <span style={{ color: C.precommitVal }}>precommit</span>
        </div>

        {rounds.map((r) => {
          const prop = state.proposals[r];
          const valueId = prop ? prop.block.hash : null;
          const preBr = breakdown(state.prevotes[r], valueId, q);
          const comBr = breakdown(state.precommits[r], valueId, q);
          const proposerId = proposerOf(all, H, r);
          const isCur = r === state.round;
          const committed = comBr.polka;
          return (
            <div
              key={r}
              style={{
                display: 'grid',
                gridTemplateColumns: '54px 1.3fr 1fr 1fr',
                gap: 8,
                alignItems: 'center',
                padding: '6px 6px',
                borderRadius: 8,
                marginBottom: 4,
                background: isCur ? 'rgba(124,156,255,0.07)' : 'transparent',
                border: `1px solid ${isCur ? 'rgba(124,156,255,0.22)' : 'transparent'}`,
              }}
            >
              {/* round + proposer */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <b style={{ fontSize: 13, color: '#e8eaf0' }}>r{r}</b>
                <span style={{ fontSize: 10, color: '#8a93a6' }}>by {proposerId}</span>
              </div>

              {/* proposal */}
              <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: prop ? '#d6d9e2' : '#6b7385', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {prop ? (
                  <>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        padding: '2px 7px',
                        borderRadius: 6,
                        background: 'rgba(176,139,255,0.14)',
                        border: '1px solid rgba(176,139,255,0.3)',
                      }}
                    >
                      {opStr(prop.block.cmd)}
                    </span>
                    {prop.validRound >= 0 && <span style={{ fontSize: 10, color: C.lock }}>↻ valid r{prop.validRound}</span>}
                  </>
                ) : (
                  <span>{isCur && state.step === 'propose' ? 'waiting…' : '—'}</span>
                )}
              </div>

              {/* prevotes */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Pips n={n} br={preBr} valColor={C.prevoteVal} q={q} />
                {preBr.polka && <span style={badge(C.prevoteVal)}>Polka {preBr.val}/{q}</span>}
              </div>

              {/* precommits */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Pips n={n} br={comBr} valColor={C.precommitVal} q={q} />
                {committed && <span style={badge(C.decided)}>Commit {comBr.val}/{q}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const box: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  marginTop: 10,
};
const hdr: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 12,
  fontWeight: 600,
  color: '#c3c8d4',
  marginBottom: 6,
};
const blockCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid',
  minWidth: 64,
  alignItems: 'center',
  justifyContent: 'center',
};
const badge = (color: string): React.CSSProperties => ({
  alignSelf: 'flex-start',
  fontSize: 10,
  fontWeight: 700,
  color,
  background: `${color}22`,
  border: `1px solid ${color}55`,
  borderRadius: 5,
  padding: '0px 6px',
});
