import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// In dev, run the curve-engine invariant checks (attractor bounds + L-system
// sizing) once and log the result; tree-shaken out of production builds.
if (import.meta.env.DEV) {
  void import('./selftest').then((m) => m.reportSelfTests())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
