import { useEffect, useState, useRef } from 'react';
import { World } from './engine';
import { CanvasRenderer } from './CanvasRenderer';
import { Dashboard } from './Dashboard';
import './index.css';

function App() {
  const [world] = useState(() => new World(2000, 2000, 100, 200));
  const [, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();
    const TICK_RATE = 1000 / 60; // target 60fps logic updates

    const loop = (time: number) => {
      const delta = time - lastTime;
      if (delta >= TICK_RATE) {
        world.update();
        setTick(t => t + 1); // trigger react update for UI
        lastTime = time - (delta % TICK_RATE);
      }
      animationFrameId = requestAnimationFrame(loop);
    };

    animationFrameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animationFrameId);
  }, [world]);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const handleUpdateMutation = (val: number) => {
    world.mutationRate = val;
    setTick(t => t + 1);
  };

  const handleUpdateFoodSpawn = (val: number) => {
    world.foodSpawnRate = val;
    setTick(t => t + 1);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 font-sans text-slate-200">
      <div ref={containerRef} className="flex-grow relative">
        <CanvasRenderer world={world} width={dimensions.width} height={dimensions.height} />
      </div>
      <Dashboard
        world={world}
        onUpdateMutation={handleUpdateMutation}
        onUpdateFoodSpawn={handleUpdateFoodSpawn}
      />
    </div>
  );
}

export default App;
