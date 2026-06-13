import { useState } from 'react'
import './App.css'

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

function makeGradient() {
  const a = rand(0, 360)
  const b = (a + rand(40, 200)) % 360
  const angle = rand(0, 360)
  return `linear-gradient(${angle}deg, hsl(${a} 80% 62%), hsl(${b} 80% 58%))`
}

export default function App() {
  const [gradient, setGradient] = useState(makeGradient)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(`background: ${gradient};`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <main className="stage" style={{ background: gradient }}>
      <div className="panel">
        <h1>Gradient Lab</h1>
        <p className="sub">A React + Vite + TS seed demo. Tap to remix.</p>
        <code className="readout">{gradient}</code>
        <div className="row">
          <button onClick={() => setGradient(makeGradient())}>Remix ↻</button>
          <button className="ghost" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy CSS'}
          </button>
        </div>
      </div>
    </main>
  )
}
