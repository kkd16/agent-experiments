// A curated tactical test suite for the Engine Lab. Every position and its
// solution was verified against this engine: the mates are forced and unique,
// and the "win" puzzles have a single clearly best move that wins decisive
// material. The Lab runs the search on each at a fixed time budget and reports
// how many it solves — a live, honest measure of the engine's tactical strength.

export interface TacticCase {
  id: string
  fen: string
  best: string[] // accepted best move(s) in UCI (from+to[+promo])
  kind: 'mate' | 'win'
  note: string
}

export const TACTICS: TacticCase[] = [
  {
    id: 'back-rank',
    fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    best: ['d1d8'],
    kind: 'mate',
    note: 'Back-rank mate in 1 — Rd8#',
  },
  {
    id: 'wac-001',
    fen: '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1',
    best: ['g3g6'],
    kind: 'mate',
    note: 'WAC.001 — Qg6!! forces mate',
  },
  {
    id: 'wac-003',
    fen: 'r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1',
    best: ['h6h7'],
    kind: 'mate',
    note: 'WAC.003 — Qxh7+! and mate',
  },
  {
    id: 'knight-mate',
    fen: '1k5r/pP3ppp/3p2b1/1BN1n3/1Q2P3/P1B5/KP3P1P/7q w - - 1 0',
    best: ['c5a6'],
    kind: 'mate',
    note: 'Na6+! forces mate in 3',
  },
  {
    id: 'wac-005',
    fen: '5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1',
    best: ['e3g3'],
    kind: 'win',
    note: 'WAC.005 — Rg3 traps the queen',
  },
  {
    id: 'wac-014',
    fen: 'r1b1kb1r/3q1ppp/pBp1pn2/8/Np3P2/5B2/PPP3PP/R2Q1RK1 w kq - 0 1',
    best: ['f3c6'],
    kind: 'win',
    note: 'WAC.014 — Bxc6 wins a piece',
  },
  {
    id: 'wac-024',
    fen: '5k2/1p3ppp/p1q5/2Pn4/8/2Q2N2/P4PPP/3R2K1 b - - 0 1',
    best: ['d5c3'],
    kind: 'win',
    note: 'WAC.024 — Nxc3 wins material',
  },
  {
    id: 'wac-030',
    fen: 'r3k2r/pb3pp1/5q1p/1p1bp3/8/1B3N2/PP3PPP/2RQR1K1 w kq - 0 1',
    best: ['b3d5'],
    kind: 'win',
    note: 'WAC.030 — Bxd5 wins',
  },
  {
    id: 'win-queen',
    fen: 'r5k1/pp3ppp/4p3/3pP3/3P4/P1q2Q2/5PPP/R5K1 w - - 0 1',
    best: ['f3c3'],
    kind: 'win',
    note: 'Qxc3 — snap off the loose queen',
  },
  {
    id: 'promo-technique',
    fen: 'R7/P4k2/8/8/8/8/r7/6K1 w - - 0 1',
    best: ['a8h8'],
    kind: 'win',
    note: 'Rh8! clears a8 for the new queen',
  },
]
