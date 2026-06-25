// Web Worker that runs the search so the UI thread stays responsive. It streams
// `info` messages each completed depth and a final `result` message.

import { parseFen } from './board'
import { Searcher, type SearchInfo } from './search'

export interface SearchRequest {
  type: 'search'
  fen: string
  history: bigint[]
  maxDepth: number
  maxTime: number
}

export type WorkerOut =
  | { type: 'info'; info: SearchInfo }
  | { type: 'result'; info: SearchInfo }

const searcher = new Searcher()

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const msg = e.data
  if (msg.type !== 'search') return
  const pos = parseFen(msg.fen)
  const result = searcher.search(
    pos,
    { maxDepth: msg.maxDepth, maxTime: msg.maxTime, history: msg.history },
    (info) => {
      const out: WorkerOut = { type: 'info', info }
      ;(self as unknown as Worker).postMessage(out)
    },
  )
  const out: WorkerOut = { type: 'result', info: result }
  ;(self as unknown as Worker).postMessage(out)
}
