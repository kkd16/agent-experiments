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
    </main>
  );
}
