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
import { Tans } from './routes/Tans'
import { Ppm } from './routes/Ppm'
import { ContextMixing } from './routes/ContextMixing'
import { Lempel } from './routes/Lempel'
import { Deflate } from './routes/Deflate'
import { Lzma } from './routes/Lzma'
import { Png } from './routes/Png'
import { Channel } from './routes/Channel'
import { HammingCode } from './routes/HammingCode'
import { ReedSolomon } from './routes/ReedSolomon'
import { Convolutional } from './routes/Convolutional'
import { Ldpc } from './routes/Ldpc'
import { Polar } from './routes/Polar'
import { ChannelLab } from './routes/ChannelLab'
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
  tans: Tans,
  ppm: Ppm,
  cm: ContextMixing,
  lempel: Lempel,
  deflate: Deflate,
  lzma: Lzma,
  png: Png,
  channel: Channel,
  hamming: HammingCode,
  reedsolomon: ReedSolomon,
  convolutional: Convolutional,
  ldpc: Ldpc,
  polar: Polar,
  channellab: ChannelLab,
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
