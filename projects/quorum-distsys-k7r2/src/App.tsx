import { useEffect, useState } from 'react';
import './App.css';
import { LABS } from './labs/registry';
import { Home } from './labs/Home';

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#\/?/, '') || '');
  useEffect(() => {
    const on = () => setHash(window.location.hash.replace(/^#\/?/, '') || '');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const route = useHashRoute();
  const lab = LABS.find((l) => l.id === route);

  return (
    <div className="app-root">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">◆</span> Quorum
          <span className="brand-sub">distributed-systems lab</span>
        </a>
        <nav className="topnav">
          {LABS.map((l) => (
            <a key={l.id} href={`#/${l.id}`} className={route === l.id ? 'on' : ''}>
              <span className="nav-ic">{l.icon}</span>
              <span className="nav-tx">{l.title}</span>
            </a>
          ))}
        </nav>
      </header>
      <main className="content">{lab ? <lab.Component /> : <Home />}</main>
      <footer className="footer">
        Quorum · every protocol implemented from scratch on one deterministic kernel ·
        runs entirely in your browser
      </footer>
    </div>
  );
}
