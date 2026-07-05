import { useHashRoute } from './hooks/useHashRoute'
import Epicycles from './modes/Epicycles'
import Spectrum from './modes/Spectrum'
import Resolve from './modes/Resolve'
import FilterMode from './modes/Filter'
import DesignMode from './modes/Design'
import Live from './modes/Live'
import Spectrogram from './modes/Spectrogram'
import Reassign from './modes/Reassign'
import Wavelet from './modes/Wavelet'
import ImageFFT from './modes/ImageFFT'
import Tomography from './modes/Tomography'
import Sensing from './modes/Sensing'
import Vocoder from './modes/Vocoder'
import Compress from './modes/Compress'
import Cepstrum from './modes/Cepstrum'
import About from './modes/About'

const ROUTES = [
  { id: 'epicycles', label: 'Epicycles' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'resolve', label: 'Resolve' },
  { id: 'filter', label: 'Filter' },
  { id: 'design', label: 'Design' },
  { id: 'spectrogram', label: 'Spectrogram' },
  { id: 'reassign', label: 'Reassign' },
  { id: 'live', label: 'Live' },
  { id: 'wavelet', label: 'Wavelet' },
  { id: 'image', label: 'Image 2D' },
  { id: 'tomography', label: 'Tomography' },
  { id: 'sensing', label: 'Sensing' },
  { id: 'vocoder', label: 'Vocoder' },
  { id: 'compress', label: 'Compress' },
  { id: 'cepstrum', label: 'Cepstrum' },
  { id: 'about', label: 'About' },
]

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="0.55" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="20" stroke="url(#g)" strokeWidth="2" opacity="0.5" />
      <circle cx="34" cy="19" r="9" stroke="url(#g)" strokeWidth="2" opacity="0.8" />
      <circle cx="30" cy="27" r="4" stroke="url(#g)" strokeWidth="2" />
      <circle cx="24" cy="24" r="2.4" fill="#eef1ff" />
      <line x1="24" y1="24" x2="34" y2="19" stroke="url(#g)" strokeWidth="1.6" />
      <line x1="34" y1="19" x2="30" y2="27" stroke="url(#g)" strokeWidth="1.6" />
    </svg>
  )
}

export default function App() {
  const [route, navigate] = useHashRoute('epicycles')
  const active = ROUTES.some((r) => r.id === route) ? route : 'epicycles'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">Spectra</span>
            <span className="brand-sub">Fourier Analysis &amp; Synthesis Lab</span>
          </div>
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button
              key={r.id}
              className={r.id === active ? 'nav-link active' : 'nav-link'}
              onClick={() => navigate(r.id)}
            >
              {r.label}
            </button>
          ))}
        </nav>
      </header>

      {active === 'epicycles' && <Epicycles />}
      {active === 'spectrum' && <Spectrum />}
      {active === 'resolve' && <Resolve />}
      {active === 'filter' && <FilterMode />}
      {active === 'design' && <DesignMode />}
      {active === 'spectrogram' && <Spectrogram />}
      {active === 'reassign' && <Reassign />}
      {active === 'live' && <Live />}
      {active === 'wavelet' && <Wavelet />}
      {active === 'image' && <ImageFFT />}
      {active === 'tomography' && <Tomography />}
      {active === 'sensing' && <Sensing />}
      {active === 'vocoder' && <Vocoder />}
      {active === 'compress' && <Compress />}
      {active === 'cepstrum' && <Cepstrum />}
      {active === 'about' && <About />}

      <footer className="footer">
        <span>Spectra — a from-scratch FFT lab. All transforms computed live in your browser.</span>
        <span>
          <a href="#/about">How it works →</a>
        </span>
      </footer>
    </div>
  )
}
