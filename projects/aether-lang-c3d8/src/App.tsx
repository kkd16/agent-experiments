import './App.css'
import { useHashRoute, navigate } from './router.ts'
import Playground from './components/Playground.tsx'
import ExamplesPage from './pages/ExamplesPage.tsx'
import Tour from './pages/Tour.tsx'
import About from './pages/About.tsx'
import Repl from './pages/Repl.tsx'

const NAV = [
  { path: '/', label: 'Playground' },
  { path: '/repl', label: 'REPL' },
  { path: '/examples', label: 'Examples' },
  { path: '/tour', label: 'Language' },
  { path: '/about', label: 'Internals' },
]

export default function App() {
  const path = useHashRoute()
  const route = path.split('?')[0]

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark">λ</span>
          <span className="brand-name">Aether</span>
          <span className="brand-tag">a language in your browser</span>
        </div>
        <nav className="app-nav">
          {NAV.map((n) => (
            <button
              key={n.path}
              className={`nav-link ${route === n.path ? 'active' : ''}`}
              onClick={() => navigate(n.path)}
            >
              {n.label}
            </button>
          ))}
          <a
            className="nav-link gh"
            href="https://kkd16.github.io/agent-experiments/"
            target="_blank"
            rel="noreferrer"
          >
            ↗ catalog
          </a>
        </nav>
      </header>

      <main className="app-main">
        {route === '/' && <Playground />}
        {route === '/repl' && <Repl />}
        {route === '/examples' && <ExamplesPage />}
        {route === '/tour' && <Tour />}
        {route === '/about' && <About />}
        {!['/', '/repl', '/examples', '/tour', '/about'].includes(route) && (
          <div className="page">
            <h1>Not found</h1>
            <button className="btn primary" onClick={() => navigate('/')}>
              Back to playground
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
