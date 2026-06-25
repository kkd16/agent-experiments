// Web Worker that runs the search so the UI thread stays responsive. It serves
// three request kinds — a normal single-PV search (for play), a multi-PV
// analysis (for the Analyze board), and a batch evaluation sweep (annotates a
// whole game for the evaluation graph) — each streaming progress as it goes.

import { parseFen } from './board'
import { Searcher, type SearchInfo, type MultiInfo } from './search'
import { verifyKbnk, type KbnkVerification } from './kbnk'

export interface SearchRequest {
  type: 'search'
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
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

export type WorkerRequest = SearchRequest | AnalyzeRequest | EvalsRequest | KbnkRequest

export type WorkerOut =
  | { type: 'info'; info: SearchInfo }
  | { type: 'result'; info: SearchInfo }
  | { type: 'multiinfo'; info: MultiInfo }
  | { type: 'multiresult'; info: MultiInfo }
  | { type: 'evalprogress'; ply: number; score: number; done: number; total: number }
  | { type: 'evaldone'; scores: number[] }
  | { type: 'kbnkprogress'; frac: number; phase: string }
  | { type: 'kbnkdone'; report: KbnkVerification }

const searcher = new Searcher()
const post = (out: WorkerOut) => (self as unknown as Worker).postMessage(out)

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'search') {
    const result = searcher.search(
      parseFen(msg.fen),
      { maxDepth: msg.maxDepth, maxTime: msg.maxTime, history: msg.history },
      (info) => post({ type: 'info', info }),
    )
    post({ type: 'result', info: result })
  } else if (msg.type === 'analyze') {
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
  }
}
