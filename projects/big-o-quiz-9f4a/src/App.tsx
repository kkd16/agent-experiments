import { useState } from 'react';
import './App.css';
import { Cheatsheet } from './components/Cheatsheet';
import { Quiz } from './components/Quiz';

function App() {
  const [view, setView] = useState<'cheatsheet' | 'quiz'>('cheatsheet');

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Big-O Quiz & Cheatsheet</h1>
        <p>Master Data Structures and Algorithms Complexities</p>

        <div className="nav-tabs">
          <button
            className={`tab-btn ${view === 'cheatsheet' ? 'active' : ''}`}
            onClick={() => setView('cheatsheet')}
          >
            Cheatsheet
          </button>
          <button
            className={`tab-btn ${view === 'quiz' ? 'active' : ''}`}
            onClick={() => setView('quiz')}
          >
            Quiz
          </button>
        </div>
      </header>

      <main className="app-main">
        {view === 'cheatsheet' ? <Cheatsheet /> : <Quiz />}
      </main>

      <footer className="app-footer">
        <p>Built for CS students.</p>
      </footer>
    </div>
  );
}

export default App;
