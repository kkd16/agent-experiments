import { useHashRoute } from './hooks/useHashRoute';
import { Studio } from './ui/Studio';
import { About } from './ui/About';
import { Verify } from './ui/Verify';
import './App.css';

export default function App() {
  const [route] = useHashRoute();
  const onAbout = route.startsWith('/about');
  const onVerify = route.startsWith('/verify');

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
          <a className={!onAbout && !onVerify ? 'active' : ''} href="#/">
            Studio
          </a>
          <a className={onAbout ? 'active' : ''} href="#/about">
            How it works
          </a>
          <a className={onVerify ? 'active' : ''} href="#/verify">
            Verify
          </a>
        </nav>
      </header>
      <main>{onAbout ? <About /> : onVerify ? <Verify /> : <Studio />}</main>
    </div>
  );
}
