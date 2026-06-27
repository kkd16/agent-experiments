import { useHashRoute } from './hooks/useHashRoute'
import Studio from './pages/Studio'
import Algorithms from './pages/Algorithms'
import About from './pages/About'
import './App.css'

const TABS = [
  { route: '/studio', label: 'Studio' },
  { route: '/algorithms', label: 'Algorithms' },
  { route: '/about', label: 'About' },
]

export default function App() {
  const [route, navigate] = useHashRoute('/studio')
  const active = TABS.find((t) => route.startsWith(t.route))?.route ?? '/studio'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden />
          <div>
            <h1>Mosaic</h1>
            <p>Computational geometry studio</p>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.route}
              className={`tab ${active === t.route ? 'is-active' : ''}`}
              onClick={() => navigate(t.route)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {active === '/studio' && <Studio />}
        {active === '/algorithms' && <Algorithms />}
        {active === '/about' && <About />}
      </main>
    </div>
  )
}
