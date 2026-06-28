import { useEffect, useState } from 'react'
import { runSelfTest, type TestCase } from '../ecc/selftest'

/**
 * Run the live self-test off the initial paint. The suite now includes a
 * from-scratch BLS12-381 pairing (a Miller loop plus a final exponentiation in
 * F_p¹²), which is hundreds of milliseconds of BigInt math — too much to block
 * the first render or the sandboxed catalog thumbnail with. Deferring it behind
 * a timeout keeps the UI responsive and lets pages show a "running…" state.
 */
export function useSelfTest(): { tests: TestCase[]; ready: boolean; rerun: () => void } {
  const [state, setState] = useState<{ tests: TestCase[]; ready: boolean; nonce: number }>({
    tests: [],
    ready: false,
    nonce: 0,
  })

  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      const result = runSelfTest()
      if (!alive) return
      setState((s) => ({ ...s, tests: result, ready: true }))
    }, 20)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [state.nonce])

  return {
    tests: state.tests,
    ready: state.ready,
    rerun: () => setState((s) => ({ ...s, ready: false, nonce: s.nonce + 1 })),
  }
}
