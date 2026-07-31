import { useEffect, useState } from 'react';
import './App.css';
import { LabView } from './components/LabView';
import { Guide } from './components/Guide';
import { VerifyView } from './components/VerifyView';

type Route = 'lab' | 'verify' | 'guide';

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h === 'guide') return 'guide';
  if (h === 'verify') return 'verify';
  return 'lab';
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden />
          <div className="brand__text">
            <h1>Fresnel</h1>
            <p>FDTD electromagnetics lab</p>
          </div>
        </div>
        <nav className="nav">
          <a href="#/" className={route === 'lab' ? 'is-active' : ''}>
            Lab
          </a>
          <a href="#/verify" className={route === 'verify' ? 'is-active' : ''}>
            Measure
          </a>
          <a href="#/guide" className={route === 'guide' ? 'is-active' : ''}>
            Guide
          </a>
        </nav>
      </header>
      <main className="main">
        {route === 'guide' ? <Guide /> : route === 'verify' ? <VerifyView /> : <LabView />}
      </main>
    </div>
  );
}
