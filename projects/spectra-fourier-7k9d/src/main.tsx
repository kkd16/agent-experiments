import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { runSelfTests } from './lib/selftest'

// In development, verify the from-scratch FFT against the direct DFT and a few
// invariants. Tree-shaken out of the production build.
if (import.meta.env.DEV) {
  const { passed, failed, messages } = runSelfTests()
  if (failed === 0) {
    console.log(`%cSpectra FFT self-tests: ${passed} passed`, 'color:#5eead4;font-weight:bold')
  } else {
    console.error(`Spectra FFT self-tests: ${failed} FAILED`, messages)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
