import { useState } from 'react';
import PlaygroundLab from './components/PlaygroundLab';
import VisionLab from './components/vision/VisionLab';
import './App.css';

type Tab = 'playground' | 'vision';

// If the page was opened from a shared CNN link (#v=…), start on the vision tab.
function initialTab(): Tab {
  try {
    return /[#&]v=/.test(location.hash) ? 'vision' : 'playground';
  } catch {
    return 'playground';
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="logo">∇</span>
          <div>
            <h1>Synapse</h1>
            <p>A deep-learning framework from scratch — reverse-mode tensor autograd, live in your browser.</p>
          </div>
        </div>
        <div className="header-right">
          <nav className="tabs">
            <button className={tab === 'playground' ? 'on' : ''} onClick={() => setTab('playground')}>
              2-D Playground
            </button>
            <button className={tab === 'vision' ? 'on' : ''} onClick={() => setTab('vision')}>
              Vision · CNN
            </button>
          </nav>
          <div className="kbd-hint">
            <kbd>space</kbd> train · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>g</kbd> gradcheck
          </div>
        </div>
      </header>

      {tab === 'playground' ? <PlaygroundLab /> : <VisionLab />}

      <footer className="foot">
        <span>
          No ML libraries — the tensor autograd, convolutions, pooling, normalization layers, optimizers, schedules,
          losses and datasets are all hand-written. Open <code>src/engine/</code> to read the gradients, or hit{' '}
          <b>Run engine self-test</b> to watch every one of them (including <code>conv2d</code>) get gradchecked.
        </span>
      </footer>
    </div>
  );
}
