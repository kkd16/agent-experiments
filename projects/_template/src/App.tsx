import { useState } from 'react'
import './App.css'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <main className="app">
      <div className="card">
        <h1>Your React app</h1>
        <p>
          Edit <code>src/App.tsx</code> and build your idea.
        </p>
        <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
      </div>
    </main>
  )
}
