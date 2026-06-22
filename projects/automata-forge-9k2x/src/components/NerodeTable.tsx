// The Myhill–Nerode distinguishability table: a lower-triangular grid where cell (i, j) is filled
// when states i and j are distinguishable, coloured by the round it was marked in, and carrying the
// concrete distinguishing string as a tooltip. Beneath it, the equivalence classes — the states the
// minimal DFA merges — each with a shortest access string.

import { showSym } from '../engine/types'
import type { NerodeResult } from '../engine/myhill'
import './NerodeTable.css'

function word(syms: string[]): string {
  return syms.length ? syms.map(showSym).join('') : 'ε'
}

/** Fade marked cells from the accent colour (early rounds) toward a cooler tone (later rounds). */
function roundStyle(round: number, maxRound: number): React.CSSProperties {
  const t = maxRound > 0 ? round / maxRound : 0
  // round 0 → bright accent; later rounds → dimmer / shifted.
  const alpha = 0.85 - 0.5 * t
  return { background: `rgba(92, 200, 255, ${alpha.toFixed(2)})`, color: '#06121f' }
}

export default function NerodeTable({ result }: { result: NerodeResult }) {
  const { n, marked, round, witness, classes, access, dfa, rounds } = result
  const stateLabel = (i: number) => `q${i}`
  const isAcc = (i: number) => dfa.accepting.has(i)

  if (n > 48) {
    return (
      <div className="nerode-toobig">
        This DFA has {n} states — too many to draw a readable {n}×{n} table. The equivalence still
        collapses to {classes.length} classes (the minimal machine). Try a smaller pattern.
      </div>
    )
  }

  const cols = n - 1 // columns 0 … n-2
  const rows = n - 1 // rows 1 … n-1

  return (
    <div className="nerode">
      <div className="nerode-scroll">
        <table className="nerode-table">
          <thead>
            <tr>
              <th className="corner" />
              {Array.from({ length: cols }, (_, i) => (
                <th key={i} className="head">
                  <span className={`qlab${isAcc(i) ? ' acc' : ''}${i === dfa.start ? ' st' : ''}`}>
                    {stateLabel(i)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => {
              const j = r + 1
              return (
                <tr key={j}>
                  <th className="head">
                    <span className={`qlab${isAcc(j) ? ' acc' : ''}${j === dfa.start ? ' st' : ''}`}>
                      {stateLabel(j)}
                    </span>
                  </th>
                  {Array.from({ length: cols }, (_, i) => {
                    if (i >= j) return <td key={i} className="blank" />
                    const m = marked[i][j]
                    if (!m) {
                      return (
                        <td key={i} className="equiv" title={`${stateLabel(i)} ≡ ${stateLabel(j)} — indistinguishable`}>
                          ≡
                        </td>
                      )
                    }
                    const w = witness[i][j] ?? []
                    return (
                      <td
                        key={i}
                        className="dist"
                        style={roundStyle(round[i][j], rounds)}
                        title={`distinguished in round ${round[i][j]} by “${word(w)}”`}
                      >
                        {round[i][j]}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="nerode-legend">
        <span className="ner-key equiv-key">≡ indistinguishable</span>
        <span className="ner-key">n = round marked · hover for the distinguishing string</span>
      </div>

      <div className="nerode-classes">
        <h3>
          {classes.length} Nerode {classes.length === 1 ? 'class' : 'classes'} → minimal DFA states
        </h3>
        <ul>
          {classes.map((cls, ci) => {
            const rep = cls[0]
            const accepting = isAcc(rep)
            return (
              <li key={ci} className={accepting ? 'acc' : ''}>
                <span className="cls-id">[{ci}]</span>
                <span className="cls-members">{cls.map(stateLabel).join(' ≡ ')}</span>
                <span className="cls-access" title="a shortest string reaching this class from the start">
                  ⟨{word(access[rep])}⟩
                </span>
                {accepting && <span className="cls-acc">accept</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
