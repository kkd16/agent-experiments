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
import { BlsPage } from './pages/BlsPage'
import { AdaptorPage } from './pages/AdaptorPage'
import { Bip32Page } from './pages/Bip32Page'
import { Attacks } from './pages/Attacks'
import { RhoWalk } from './pages/RhoWalk'
import { PohligHellman } from './pages/PohligHellman'
import { InvalidCurvePage } from './pages/InvalidCurvePage'
import { EdgeCases } from './pages/EdgeCases'
import { ShamirPage } from './pages/ShamirPage'
import { FrostPage } from './pages/FrostPage'
import { ZkPage } from './pages/ZkPage'
import { KzgPage } from './pages/KzgPage'
import { HashToCurvePage } from './pages/HashToCurvePage'
import { Groth16Page } from './pages/Groth16Page'
import { BulletproofsPage } from './pages/BulletproofsPage'
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
  { path: '/bls', label: 'BLS Pairing' },
  { path: '/adaptor', label: 'Adaptor Sigs' },
  { path: '/bip32', label: 'HD Wallets' },
  { path: '/attacks', label: 'ECDLP Attacks' },
  { path: '/rho', label: "Pollard's ρ" },
  { path: '/pohlig', label: 'Pohlig–Hellman' },
  { path: '/invalid', label: 'Invalid Curve' },
  { path: '/edge', label: 'Edge Cases' },
  { path: '/shamir', label: 'Secret Sharing' },
  { path: '/frost', label: 'FROST' },
  { path: '/zk', label: 'Zero-Knowledge' },
  { path: '/kzg', label: 'KZG' },
  { path: '/h2c', label: 'Hash-to-Curve' },
  { path: '/groth16', label: 'Groth16 SNARK' },
  { path: '/bulletproofs', label: 'Bulletproofs' },
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
      {base === '/bls' && <BlsPage />}
      {base === '/adaptor' && <AdaptorPage />}
      {base === '/bip32' && <Bip32Page />}
      {base === '/attacks' && <Attacks />}
      {base === '/rho' && <RhoWalk />}
      {base === '/pohlig' && <PohligHellman />}
      {base === '/invalid' && <InvalidCurvePage />}
      {base === '/edge' && <EdgeCases />}
      {base === '/shamir' && <ShamirPage />}
      {base === '/frost' && <FrostPage />}
      {base === '/zk' && <ZkPage />}
      {base === '/kzg' && <KzgPage />}
      {base === '/h2c' && <HashToCurvePage />}
      {base === '/groth16' && <Groth16Page />}
      {base === '/bulletproofs' && <BulletproofsPage />}
      {base === '/verify' && <SelfTestPage />}

      <footer className="foot">
        Curvefield — every key, signature, and curve here is computed in your browser by a
        from-scratch engine: BigInt field arithmetic, hand-written SHA-256 / SHA-512 / RIPEMD-160,
        RFC 6979, BIP-340, MuSig2, X25519 / Ed25519, a BLS12-381 pairing, Shamir / FROST threshold
        signing, zero-knowledge Σ-protocols, KZG polynomial commitments, and logarithmic-size
        Bulletproofs range proofs — zero crypto dependencies.
        <br />
        An educational lab. Do not use these keys to guard anything real.
      </footer>
    </div>
  )
}
