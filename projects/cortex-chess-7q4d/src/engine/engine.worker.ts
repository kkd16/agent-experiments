// Web Worker that runs the search so the UI thread stays responsive. It serves
// several request kinds — a normal single-PV search (for play), a multi-PV
// analysis (for the Analyze board), a batch evaluation sweep (annotates a whole
// game for the evaluation graph), the KBN-vs-K verifier, and the generalized
// tablebase build/verify — each streaming progress as it goes.

import { parseFen } from './board'
import { Searcher, type SearchInfo, type MultiInfo } from './search'
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

export type WorkerRequest = SearchRequest | AnalyzeRequest | EvalsRequest | KbnkRequest | GtbRequest

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

const searcher = new Searcher()
const post = (out: WorkerOut) => (self as unknown as Worker).postMessage(out)

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
  }
}
