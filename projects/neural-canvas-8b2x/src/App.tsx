import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { Canvas } from './components/Canvas';
import { Controls } from './components/Controls';
import type { Architecture, Point, WorkerMessage } from './worker';

const INITIAL_ARCH: Architecture = {
  hiddenLayers: [4, 4],
  learningRate: 0.1,
  activation: 'tanh'
};

const RESOLUTION = 50;

function App() {
  const workerRef = useRef<Worker | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [arch, setArch] = useState<Architecture>(INITIAL_ARCH);
  const [isTraining, setIsTraining] = useState(false);
  const [predictions, setPredictions] = useState<Float32Array | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [loss, setLoss] = useState(0);
  const [lossHistory, setLossHistory] = useState<number[]>([]);

  // Initialize Worker
  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'PREDICTIONS') {
        setPredictions(msg.predictions);
      } else if (msg.type === 'EPOCH') {
        setEpoch(msg.epoch);
        setLoss(msg.loss);
        setLossHistory(prev => {
          const newHistory = [...prev, msg.loss];
          if (newHistory.length > 100) return newHistory.slice(newHistory.length - 100);
          return newHistory;
        });
        // Request new predictions to update UI
        worker.postMessage({ type: 'GET_PREDICTIONS', resolution: RESOLUTION } as WorkerMessage);
      }
    };

    worker.postMessage({ type: 'INIT', arch } as WorkerMessage);

    return () => {
      worker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update worker when arch changes
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'INIT', arch } as WorkerMessage);
      if (isTraining) {
         workerRef.current.postMessage({ type: 'START' } as WorkerMessage);
      }
      // Request initial prediction canvas even if not training
      workerRef.current.postMessage({ type: 'GET_PREDICTIONS', resolution: RESOLUTION } as WorkerMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arch]);

  // Update worker when points change
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'SET_POINTS', points } as WorkerMessage);
    }
  }, [points]);

  const handleAddPoint = useCallback((x: number, y: number, label: number) => {
    setPoints(prev => [...prev, { x, y, label }]);
  }, []);

  const handleToggleTraining = () => {
    if (workerRef.current) {
      if (isTraining) {
        workerRef.current.postMessage({ type: 'STOP' } as WorkerMessage);
      } else {
        workerRef.current.postMessage({ type: 'START' } as WorkerMessage);
      }
      setIsTraining(!isTraining);
    }
  };

  const handleResetPoints = () => {
    setPoints([]);
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'INIT', arch } as WorkerMessage); // reset weights
      workerRef.current.postMessage({ type: 'GET_PREDICTIONS', resolution: RESOLUTION } as WorkerMessage);
    }
    setEpoch(0);
    setLoss(0);
    setLossHistory([]);
  };

  return (
    <div className="app-container">
      <header>
        <h1>Neural Canvas</h1>
        <p>Interactive Multi-Layer Perceptron Playground</p>
      </header>

      <main className="main-content">
        <Controls
          arch={arch}
          onArchChange={setArch}
          isTraining={isTraining}
          onToggleTraining={handleToggleTraining}
          onResetPoints={handleResetPoints}
          epoch={epoch}
          loss={loss}
          lossHistory={lossHistory}
        />
        <Canvas
          points={points}
          predictions={predictions}
          resolution={RESOLUTION}
          onAddPoint={handleAddPoint}
        />
      </main>
    </div>
  );
}

export default App;
