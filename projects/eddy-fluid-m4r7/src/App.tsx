import { useHashRoute } from './hooks/useHashRoute';
import { Studio } from './ui/Studio';
import { About } from './ui/About';
import { Verify } from './ui/Verify';
import { SpectraLab } from './ui/SpectraLab';
import { KineticLab } from './ui/KineticLab';
import { PhaseLab } from './ui/PhaseLab';
import './App.css';

export default function App() {
  const [route] = useHashRoute();
  const onAbout = route.startsWith('/about');
  const onVerify = route.startsWith('/verify');
  const onSpectra = route.startsWith('/spectra');
  const onKinetic = route.startsWith('/kinetic');
  const onPhase = route.startsWith('/phase');

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            ≋
          </span>
          <span className="brand-text">
            Eddy <em>fluid studio</em>
          </span>
        </a>
        <nav>
          <a className={!onAbout && !onVerify && !onSpectra && !onKinetic && !onPhase ? 'active' : ''} href="#/">
            Studio
          </a>
          <a className={onKinetic ? 'active' : ''} href="#/kinetic">
            Kinetic
          </a>
          <a className={onPhase ? 'active' : ''} href="#/phase">
            Phase
          </a>
          <a className={onSpectra ? 'active' : ''} href="#/spectra">
            Spectra
          </a>
          <a className={onAbout ? 'active' : ''} href="#/about">
            How it works
          </a>
          <a className={onVerify ? 'active' : ''} href="#/verify">
            Verify
          </a>
        </nav>
      </header>
      <main>
        {onAbout ? (
          <About />
        ) : onVerify ? (
          <Verify />
        ) : onSpectra ? (
          <SpectraLab />
        ) : onKinetic ? (
          <KineticLab />
        ) : onPhase ? (
          <PhaseLab />
        ) : (
          <Studio />
        )}
      </main>
    </div>
  );
}
