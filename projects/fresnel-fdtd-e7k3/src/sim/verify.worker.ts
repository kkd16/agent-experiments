/**
 * Runs the verification experiments off the main thread so the (multi-second)
 * FDTD sweeps never freeze the UI. The main thread posts an experiment id; the
 * worker runs the real solver and posts back the structured result.
 */

import { EXPERIMENTS, type ExperimentResult } from './experiments';

export interface VerifyRequest {
  id: string;
}
export interface VerifyResponse {
  id: string;
  result?: ExperimentResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<VerifyRequest>) => {
  const { id } = e.data;
  const exp = EXPERIMENTS.find((x) => x.id === id);
  const post = (msg: VerifyResponse) => (self as unknown as Worker).postMessage(msg);
  if (!exp) {
    post({ id, error: 'unknown experiment' });
    return;
  }
  try {
    post({ id, result: exp.run() });
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
