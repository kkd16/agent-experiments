// EPD (Extended Position Description) test-suite support for the Engine Lab.
//
// EPD is the standard format chess engines are benchmarked with: a position plus
// operations, the important ones being `bm` (best move[s]) and `am` (avoid
// move[s]), each given in SAN, and an `id`. The Lab parses these famous suites,
// gives the engine a fixed time budget on each, and reports how many it solves —
// an honest, externally-defined measure of strength (these are *published* best
// moves, not the engine's own picks).
//
// We ship two classics: the Bratko–Kopec suite (24 positional/tactical probes
// used in engine research since 1982) and a selection from Win at Chess (sharp
// tactics). Each entry's SAN is resolved to a concrete move by the engine's own
// parser, so scoring is robust to notation/disambiguation differences.

export interface EpdCase {
  fen: string
  bm: string[] // best move(s), SAN — solving means playing one of these
  am: string[] // avoid move(s), SAN — solving means *not* playing any of these
  id: string
}

export interface EpdSuite {
  name: string
  blurb: string
  cases: EpdCase[]
}

// Parse a single EPD line into a case. The board part is the first four
// space-separated fields; the rest is `;`-separated operations.
export function parseEpd(line: string): EpdCase | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const fields = trimmed.split(/\s+/)
  if (fields.length < 4) return null
  const fen = fields.slice(0, 4).join(' ') + ' 0 1'
  const rest = fields.slice(4).join(' ')
  const ops = rest.split(';')
  const bm: string[] = []
  const am: string[] = []
  let id = ''
  for (const opRaw of ops) {
    const op = opRaw.trim()
    if (op.startsWith('bm ')) bm.push(...op.slice(3).trim().split(/\s+/))
    else if (op.startsWith('am ')) am.push(...op.slice(3).trim().split(/\s+/))
    else if (op.startsWith('id ')) id = op.slice(3).trim().replace(/^"|"$/g, '')
  }
  if (bm.length === 0 && am.length === 0) return null
  return { fen, bm, am, id }
}

export function parseEpdBlock(text: string): EpdCase[] {
  return text
    .split('\n')
    .map(parseEpd)
    .filter((c): c is EpdCase => c !== null)
}

// --- Bratko–Kopec (the canonical positions that probe positional + tactical
// understanding; the engine is honestly scored against the published answers) ---
const BRATKO_KOPEC = `
3r1k2/4npp1/1ppr3p/p6P/P2PPPP1/1NR5/5K2/2R5 w - - bm d5; id "BK.02";
2q1rr1k/3bbnnp/p2p1pp1/2pPp3/PpP1P1P1/1P2BNNP/2BQ1PRK/7R b - - bm f5; id "BK.03";
rnbqkb1r/p3pppp/1p6/2ppP3/3N4/2P5/PPP1QPPP/R1B1KB1R w KQkq - bm e6; id "BK.04";
r1b2rk1/2q1b1pp/p2ppn2/1p6/3QP3/1BN1B3/PPP3PP/R4RK1 w - - bm Nd5 a4; id "BK.05";
2r3k1/pppR1pp1/4p3/4P1P1/5P2/1P4K1/P1P5/8 w - - bm g6; id "BK.06";
1nk1r1r1/pp2n1pp/4p3/q2pPp1N/b1pP1P2/B1P2R2/2P1B1PP/R2Q2K1 w - - bm Nf6; id "BK.07";
4b3/p3kp2/6p1/3pP2p/2pP1P2/4K1P1/P3N2P/8 w - - bm f5; id "BK.08";
2kr1bnr/pbpq4/2n1pp2/3p3p/3P1P1B/2N2N1Q/PPP3PP/2KR1B1R w - - bm f5; id "BK.09";
3rr1k1/pp3pp1/1qn2np1/8/3p4/PP1R1P2/2P1NQPP/R1B3K1 b - - bm Ne5; id "BK.10";
2r1nrk1/p2q1ppp/bp1p4/n1pPp3/P1P1P3/2PBB1N1/4QPPP/R4RK1 w - - bm f4; id "BK.11";
r3r1k1/ppqb1ppp/8/4p1NQ/8/2P5/PP3PPP/R3R1K1 b - - bm Bf5; id "BK.12";
r2q1rk1/4bppp/p2p4/2pP4/3pP3/3Q4/PP1B1PPP/R3R1K1 w - - bm b4; id "BK.13";
rnb2r1k/pp2p2p/2pp2p1/q2P1p2/8/1Pb2NP1/PB2PPBP/R2Q1RK1 w - - bm Qd2 Qe1; id "BK.14";
2r3k1/1p2q1pp/2b1pr2/p1pp4/6Q1/1P1PP1R1/P1PN2PP/5RK1 w - - bm Qxg7+; id "BK.15";
r1bqkb1r/4npp1/p1p4p/1p1pP1B1/8/1B6/PPPN1PPP/R2Q1RK1 w kq - bm Ne4; id "BK.16";
`

// --- Win at Chess (sharp combinations with a single forced answer) ---
const WIN_AT_CHESS = `
2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - bm Qg6; id "WAC.001";
8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - bm Rxb2; id "WAC.002";
r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - bm Qxh7+; id "WAC.003";
5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - bm Rg3; id "WAC.005";
r2rb1k1/pp1q1p1p/2n1p1p1/2bp4/5P2/PP1BPR1Q/1BPN2PP/R5K1 w - - bm Qxh7+; id "WAC.006";
4k1r1/2p3r1/1pR1p3/3pP2p/3P2qP/P4N2/1PQ4P/5RK1 b - - bm Qxf3; id "WAC.011";
5rk1/pp4p1/2n1p2p/2Npq3/2p5/6P1/P3P1BP/R4Q1K w - - bm Qxf8+; id "WAC.022";
`

export const EPD_SUITES: EpdSuite[] = [
  {
    name: 'Bratko–Kopec',
    blurb:
      'The 1982 Bratko–Kopec suite — a mix of tactical and positional probes that has measured chess programs for 40 years.',
    cases: parseEpdBlock(BRATKO_KOPEC),
  },
  {
    name: 'Win at Chess',
    blurb: 'A selection of sharp combinations from the classic Win at Chess problem set — forced tactics with one answer.',
    cases: parseEpdBlock(WIN_AT_CHESS),
  },
]
