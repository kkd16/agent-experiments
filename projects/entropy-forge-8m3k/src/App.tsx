import { useEffect } from 'react'
import './App.css'
import { useHashRoute } from './hooks/useHashRoute'
import { Nav } from './components/Nav'
import { Overview } from './routes/Overview'
import { Analyzer } from './routes/Analyzer'
import { Huffman } from './routes/Huffman'
import { Adaptive } from './routes/Adaptive'
import { Arithmetic } from './routes/Arithmetic'
import { Rans } from './routes/Rans'
import { Ppm } from './routes/Ppm'
import { Lempel } from './routes/Lempel'
import { Burrows } from './routes/Burrows'
import { Suffix } from './routes/Suffix'
import { Workbench } from './routes/Workbench'
import { Benchmark } from './routes/Benchmark'
import { SelfTest } from './routes/SelfTest'

const ROUTES: Record<string, () => React.JSX.Element> = {
  overview: Overview,
  analyzer: Analyzer,
  huffman: Huffman,
  adaptive: Adaptive,
  arithmetic: Arithmetic,
  rans: Rans,
  ppm: Ppm,
  lempel: Lempel,
  burrows: Burrows,
  suffix: Suffix,
  workbench: Workbench,
  benchmark: Benchmark,
  selftest: SelfTest,
}

export default function App() {
  const route = useHashRoute()
  const Page = ROUTES[route] ?? Overview

  // Scroll to top whenever the route changes so long pages start fresh.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route])

  return (
    <div className="shell">
      <Nav route={route} />
      <main className="content">
        <Page />
      </main>
    </div>
  )
}
