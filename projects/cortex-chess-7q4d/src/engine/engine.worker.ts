// Web Worker that runs the search so the UI thread stays responsive. It serves
// several request kinds — a normal single-PV search (for play), a multi-PV
// analysis (for the Analyze board), a batch evaluation sweep (annotates a whole
// game for the evaluation graph), the KBN-vs-K verifier, and the generalized
// tablebase build/verify — each streaming progress as it goes.

import { parseFen } from './board'
import { generateLegal, inCheck } from './movegen'
import { Searcher, MATE, type SearchInfo, type MultiInfo } from './search'
import { deserializeNnue, type NnueBlob } from './nnue'
import { quantize } from './nnue-quant'
import type { NodeAnalysis } from './review'
import { verifyKbnk, type KbnkVerification } from './kbnk'
import { probeKxK } from './egtb'
import { probeKbnk, buildKbnk } from './kbnk'
import { ROOK, QUEEN } from './board'
import {
  verifyGtb,
  tryLoadGtbFromCache,
  persistGtb,
  type GtbVerification,
  type Oracle,
} from './gtb'
import { verifyWdl, tryLoadWdlFromCache, persistWdl, type WdlVerification } from './wdltb'
import { verifyPawnTb, tryLoadPawnTbFromCache, persistPawnTb, type PawnTbVerification } from './pawntb'
import { warmTablebasesFor } from './endgames'

export interface SearchRequest {
  type: 'search'
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
  softTime?: number
  maxNodes?: number
}

export interface AnalyzeRequest {
  type: 'analyze'
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
  multiPv: number
}

export interface EvalsRequest {
  type: 'evals'
  items: { fen: string; history: bigint[] }[]
  maxDepth: number
  maxTime: number
}

export interface KbnkRequest {
  type: 'kbnk'
  sample: number
  games: number
}

export interface GtbRequest {
  type: 'gtb'
  id: string
  sample: number
  games: number
}

export interface WdlRequest {
  type: 'wdl'
  id: string
  sample: number
  games: number
}

export interface PawnTbRequest {
  type: 'pawntb'
  sample: number
  games: number
}

export interface ReviewRequest {
  type: 'review'
  items: { fen: string; history: bigint[] }[]
  maxDepth: number
  maxTime: number
}

// Fire-and-forget config: install (or remove) the NNUE evaluation on the persistent
// searcher. No reply — it just changes how subsequent searches evaluate.
export interface SetNnueRequest {
  type: 'setnnue'
  blob: NnueBlob | null
  /** When set, the net is quantized to int16/int8 and the search runs the integer eval. */
  quantize?: boolean
}

export type WorkerRequest =
  | SearchRequest
  | AnalyzeRequest
  | EvalsRequest
  | KbnkRequest
  | GtbRequest
  | WdlRequest
  | PawnTbRequest
  | ReviewRequest
  | SetNnueRequest

export type WorkerOut =
  | { type: 'info'; info: SearchInfo }
  | { type: 'result'; info: SearchInfo }
  | { type: 'multiinfo'; info: MultiInfo }
  | { type: 'multiresult'; info: MultiInfo }
  | { type: 'evalprogress'; ply: number; score: number; done: number; total: number }
  | { type: 'evaldone'; scores: number[] }
  | { type: 'kbnkprogress'; frac: number; phase: string }
  | { type: 'kbnkdone'; report: KbnkVerification }
  | { type: 'gtbprogress'; frac: number; phase: string }
  | { type: 'gtbdone'; report: GtbVerification; cached: boolean }
  | { type: 'wdlprogress'; frac: number; phase: string }
  | { type: 'wdldone'; report: WdlVerification; cached: boolean }
  | { type: 'pawntbprogress'; frac: number; phase: string }
  | { type: 'pawntbdone'; report: PawnTbVerification; cached: boolean }
  | { type: 'reviewprogress'; done: number; total: number }
  | { type: 'reviewdone'; nodes: NodeAnalysis[] }

const searcher = new Searcher()
const post = (out: WorkerOut) => (self as unknown as Worker).postMessage(out)

// Analyse one position to top-2 lines for the game-review model. A terminal node
// (no legal moves) yields a synthetic read: a mated side-to-move scores −MATE, a
// stalemate scores 0 — both with empty lines.
function analyseNode(
  fen: string,
  history: bigint[],
  maxDepth: number,
  maxTime: number,
): NodeAnalysis {
  const pos = parseFen(fen)
  if (generateLegal(pos).length === 0) {
    const mated = inCheck(pos, pos.turn)
    return {
      score: mated ? -MATE : 0,
      mate: mated ? -1 : null,
      bestPv: [],
      secondScore: null,
      secondMate: null,
    }
  }
  const r = searcher.searchMultiPv(pos, { maxDepth, maxTime, history }, 2)
  const l0 = r.lines[0]
  const l1 = r.lines[1]
  return {
    score: l0?.score ?? 0,
    mate: l0?.mate ?? null,
    bestPv: l0?.pv ?? [],
    secondScore: l1?.score ?? null,
    secondMate: l1?.mate ?? null,
  }
}

// Hand-rolled-table oracles, attached to the matching generic config so the Lab can
// prove the generic engine reproduces the bespoke tablebases bit-for-bit.
function oracleFor(id: string): { oracle: Oracle; name: string } | null {
  if (id === 'KRvK')
    return {
      name: 'egtb rook',
      oracle: (wk, bk, ps, wtm) => {
        const r = probeKxK(ROOK, wk, bk, ps[0], true, wtm)
        return r.win ? r.dtm : -1
      },
    }
  if (id === 'KQvK')
    return {
      name: 'egtb queen',
      oracle: (wk, bk, ps, wtm) => {
        const r = probeKxK(QUEEN, wk, bk, ps[0], true, wtm)
        return r.win ? r.dtm : -1
      },
    }
  if (id === 'KBNvK')
    return {
      name: 'kbnk.ts',
      oracle: (wk, bk, ps, wtm) => {
        const r = probeKbnk(wk, bk, ps[0], ps[1], true, wtm)
        return r.win ? r.dtm : -1
      },
    }
  return null
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'setnnue') {
    if (msg.blob && msg.quantize) {
      searcher.setQuantEvaluator(quantize(deserializeNnue(msg.blob)))
    } else {
      searcher.setEvaluator(msg.blob ? deserializeNnue(msg.blob) : null)
    }
    return
  }
  if (msg.type === 'search') {
    // Warm any cached endgame tablebase that applies to this position, so the
    // engine plays the ending perfectly without a multi-second rebuild mid-move.
    await warmTablebasesFor(msg.fen)
    const result = searcher.search(
      parseFen(msg.fen),
      { maxDepth: msg.maxDepth, maxTime: msg.maxTime, softTime: msg.softTime, maxNodes: msg.maxNodes, history: msg.history },
      (info) => post({ type: 'info', info }),
    )
    post({ type: 'result', info: result })
  } else if (msg.type === 'analyze') {
    await warmTablebasesFor(msg.fen)
    const result = searcher.searchMultiPv(
      parseFen(msg.fen),
      { maxDepth: msg.maxDepth, maxTime: msg.maxTime, history: msg.history },
      msg.multiPv,
      (info) => post({ type: 'multiinfo', info }),
    )
    post({ type: 'multiresult', info: result })
  } else if (msg.type === 'evals') {
    const scores: number[] = []
    const total = msg.items.length
    for (let i = 0; i < total; i++) {
      const it = msg.items[i]
      const r = searcher.search(parseFen(it.fen), {
        maxDepth: msg.maxDepth,
        maxTime: msg.maxTime,
        history: it.history,
      })
      scores.push(r.score)
      post({ type: 'evalprogress', ply: i, score: r.score, done: i + 1, total })
    }
    post({ type: 'evaldone', scores })
  } else if (msg.type === 'kbnk') {
    const report = verifyKbnk(msg.sample, msg.games, (frac, phase) => post({ type: 'kbnkprogress', frac, phase }))
    post({ type: 'kbnkdone', report })
  } else if (msg.type === 'gtb') {
    const o = oracleFor(msg.id)
    if (msg.id === 'KBNvK') buildKbnk() // build the oracle table first
    const cached = await tryLoadGtbFromCache(msg.id)
    const report = verifyGtb(
      msg.id,
      { sample: msg.sample, games: msg.games, oracle: o?.oracle, oracleName: o?.name },
      (frac, phase) => post({ type: 'gtbprogress', frac, phase }),
    )
    if (!cached) await persistGtb(msg.id)
    post({ type: 'gtbdone', report, cached })
  } else if (msg.type === 'wdl') {
    const cached = await tryLoadWdlFromCache(msg.id)
    const report = verifyWdl(
      msg.id,
      { sample: msg.sample, games: msg.games },
      (frac, phase) => post({ type: 'wdlprogress', frac, phase }),
    )
    if (!cached) await persistWdl(msg.id)
    post({ type: 'wdldone', report, cached })
  } else if (msg.type === 'pawntb') {
    const cached = await tryLoadPawnTbFromCache()
    const report = verifyPawnTb(
      { sample: msg.sample, games: msg.games },
      (frac, phase) => post({ type: 'pawntbprogress', frac, phase }),
    )
    if (!cached) await persistPawnTb()
    post({ type: 'pawntbdone', report, cached })
  } else if (msg.type === 'review') {
    const total = msg.items.length
    const nodes: NodeAnalysis[] = []
    for (let i = 0; i < total; i++) {
      const it = msg.items[i]
      nodes.push(analyseNode(it.fen, it.history, msg.maxDepth, msg.maxTime))
      post({ type: 'reviewprogress', done: i + 1, total })
    }
    post({ type: 'reviewdone', nodes })
  }
}
