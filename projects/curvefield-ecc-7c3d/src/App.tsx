import './App.css'
import { useHashRoute, navigate } from './hooks/useHashRoute'
import { Overview } from './pages/Overview'
import { RealGroupLaw } from './pages/RealGroupLaw'
import { FiniteField } from './pages/FiniteField'
import { ScalarMult } from './pages/ScalarMult'
import { Secp256k1Page } from './pages/Secp256k1Page'
import { Encodings } from './pages/Encodings'
import { MuSigPage } from './pages/MuSigPage'
import { Curve25519Page } from './pages/Curve25519Page'
import { Attacks } from './pages/Attacks'
import { RhoWalk } from './pages/RhoWalk'
import { PohligHellman } from './pages/PohligHellman'
import { EdgeCases } from './pages/EdgeCases'
import { SelfTestPage } from './pages/SelfTestPage'

const ROUTES = [
  { path: '/', label: 'Overview' },
  { path: '/real', label: 'Group Law' },
  { path: '/field', label: 'Finite Field' },
  { path: '/scalar', label: 'Scalar Mult' },
  { path: '/secp', label: 'secp256k1' },
  { path: '/encode', label: 'Encodings' },
  { path: '/musig', label: 'MuSig' },
  { path: '/ed25519', label: 'Curve25519' },
  { path: '/attacks', label: 'ECDLP Attacks' },
  { path: '/rho', label: "Pollard's ρ" },
  { path: '/pohlig', label: 'Pohlig–Hellman' },
  { path: '/edge', label: 'Edge Cases' },
  { path: '/verify', label: 'Self-Test' },
]

export default function App() {
  const route = useHashRoute()
  const base = '/' + route.split('/')[1]

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => navigate('/')}>
          <span className="glyph">∮</span>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span>Curvefield</span>
            <small>elliptic-curve cryptography lab</small>
          </div>
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <a key={r.path} href={'#' + r.path} className={base === r.path ? 'active' : ''}>
              {r.label}
            </a>
          ))}
        </nav>
      </header>

      {base === '/' && <Overview />}
      {base === '/real' && <RealGroupLaw />}
      {base === '/field' && <FiniteField />}
      {base === '/scalar' && <ScalarMult />}
      {base === '/secp' && <Secp256k1Page />}
      {base === '/encode' && <Encodings />}
      {base === '/musig' && <MuSigPage />}
      {base === '/ed25519' && <Curve25519Page />}
      {base === '/attacks' && <Attacks />}
      {base === '/rho' && <RhoWalk />}
      {base === '/pohlig' && <PohligHellman />}
      {base === '/edge' && <EdgeCases />}
      {base === '/verify' && <SelfTestPage />}

      <footer className="foot">
        Curvefield — every key, signature, and curve here is computed in your browser by a
        from-scratch engine: BigInt field arithmetic, hand-written SHA-256 / SHA-512 / RIPEMD-160,
        RFC 6979, BIP-340, MuSig2, X25519 &amp; Ed25519 — zero crypto dependencies.
        <br />
        An educational lab. Do not use these keys to guard anything real.
      </footer>
    </div>
  )
}
