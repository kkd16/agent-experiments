import { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import { useGameOfLife } from './useGameOfLife';
import { AudioEngine } from './audio';

const ROWS = 20;
const COLS = 30;
const SPEED = 200; // ms per generation

export default function App() {
  const [audioStarted, setAudioStarted] = useState(false);
  const audioEngineRef = useRef<AudioEngine | null>(null);

  useEffect(() => {
    audioEngineRef.current = new AudioEngine(ROWS);
  }, []);

  const handleCellBirth = useCallback((row: number, col: number) => {
    if (audioStarted && audioEngineRef.current) {
      audioEngineRef.current.playNote(row, col);
    }
  }, [audioStarted]);

  const {
    grid,
    isRunning,
    setIsRunning,
    toggleCell,
    nextGeneration,
    clearGrid,
    randomizeGrid,
    generation
  } = useGameOfLife(ROWS, COLS, handleCellBirth);

  useEffect(() => {
    let timerId: number | undefined;
    if (isRunning) {
      timerId = window.setInterval(nextGeneration, SPEED);
    } else {
      clearInterval(timerId);
    }
    return () => clearInterval(timerId);
  }, [isRunning, nextGeneration]);

  const startAudio = () => {
    if (audioEngineRef.current) {
      audioEngineRef.current.init();
      setAudioStarted(true);
    }
  };

  const handleToggleRunning = () => {
    if (!audioStarted) {
      startAudio();
    }
    setIsRunning(!isRunning);
  };

  return (
    <main className="app">
      <div className="layout">
        <aside className="sidebar">
          <div className="info-card">
            <h2>How it Works</h2>
            <p className="intro">
              <strong>Conway's Game of Life</strong> is a cellular automaton. It's a zero-player game, meaning its evolution is determined by its initial state, requiring no further input.
            </p>
            <h3>The Rules</h3>
            <ul className="rules-list">
              <li><strong>Underpopulation:</strong> A live cell with fewer than two live neighbors dies.</li>
              <li><strong>Survival:</strong> A live cell with two or three live neighbors lives on.</li>
              <li><strong>Overpopulation:</strong> A live cell with more than three live neighbors dies.</li>
              <li><strong>Reproduction:</strong> A dead cell with exactly three live neighbors becomes a live cell.</li>
            </ul>
            <h3>The Soundscape</h3>
            <p>
              As the cells evolve, their "births" trigger musical notes. The vertical position (row) of a newly born cell maps to a note in a pentatonic scale, creating a generative musical sequence as the automaton runs.
            </p>
          </div>
        </aside>

        <section className="main-content">
          <div className="card">
            <h1>Conway's Soundscape</h1>
            <p>Click cells to toggle them, or Randomize. "Start" to play.</p>

            <div className="controls">
              <button onClick={handleToggleRunning} className={isRunning ? 'active' : ''}>
                {isRunning ? 'Pause' : 'Start'}
              </button>
              <button onClick={nextGeneration} disabled={isRunning}>Next Step</button>
              <button onClick={randomizeGrid}>Randomize</button>
              <button onClick={clearGrid}>Clear</button>
            </div>

            <div className="stats">
              Generation: {generation} | Audio: {audioStarted ? 'On' : 'Off'}
            </div>

            <div className="grid-container" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
              {grid.map((rowArr, rowIndex) =>
                rowArr.map((cell, colIndex) => (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`cell ${cell ? 'alive' : ''}`}
                    onClick={() => {
                      if (!audioStarted) startAudio();
                      toggleCell(rowIndex, colIndex);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
