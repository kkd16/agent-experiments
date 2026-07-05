// Runs the Proof Lab battery off the main thread so the UI stays responsive while several
// worlds are generated and checked. The report is plain JSON, so it structured-clones back
// cleanly. The UI keeps a synchronous fallback for environments without workers.

import { runProofs } from './proofs'

self.onmessage = (): void => {
  try {
    const report = runProofs()
    ;(self as unknown as Worker).postMessage({ report })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ error: String(err) })
  }
}
