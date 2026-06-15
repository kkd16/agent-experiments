import { useEffect, useRef } from 'react';
import { Boid, Predator, Grid, type BoidParams } from './boids';

interface BoidsCanvasProps {
  params: BoidParams;
  numBoids: number;
  numPredators: number;
  isPaused: boolean;
}

export function BoidsCanvas({ params, numBoids, numPredators, isPaused }: BoidsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boidsRef = useRef<Boid[]>([]);
  const predatorsRef = useRef<Predator[]>([]);
  const animationFrameId = useRef<number>(0);
  const paramsRef = useRef(params);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const lastTimeRef = useRef<number>(0);
  const fpsRef = useRef<number>(0);
  const fpsDisplayRef = useRef<HTMLDivElement>(null);

  // Keep paramsRef up to date without triggering re-renders of the effect
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resize canvas to fill window
    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Update boids boundaries on resize
      boidsRef.current.forEach(boid => {
        boid.width = canvas.width;
        boid.height = canvas.height;
      });
      predatorsRef.current.forEach(pred => {
        pred.width = canvas.width;
        pred.height = canvas.height;
      });
    };

    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseLeave = () => {
      mousePosRef.current = null;
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);
    handleResize();

    // Initialize boids if needed
    if (boidsRef.current.length === 0) {
      for (let i = 0; i < numBoids; i++) {
        boidsRef.current.push(new Boid(Math.random() * canvas.width, Math.random() * canvas.height, canvas.width, canvas.height));
      }
    } else if (boidsRef.current.length < numBoids) {
       for (let i = boidsRef.current.length; i < numBoids; i++) {
         boidsRef.current.push(new Boid(Math.random() * canvas.width, Math.random() * canvas.height, canvas.width, canvas.height));
       }
    } else if (boidsRef.current.length > numBoids) {
       boidsRef.current = boidsRef.current.slice(0, numBoids);
    }

    // Initialize predators if needed
    if (predatorsRef.current.length === 0 && numPredators > 0) {
      for (let i = 0; i < numPredators; i++) {
        predatorsRef.current.push(new Predator(Math.random() * canvas.width, Math.random() * canvas.height, canvas.width, canvas.height));
      }
    } else if (predatorsRef.current.length < numPredators) {
       for (let i = predatorsRef.current.length; i < numPredators; i++) {
         predatorsRef.current.push(new Predator(Math.random() * canvas.width, Math.random() * canvas.height, canvas.width, canvas.height));
       }
    } else if (predatorsRef.current.length > numPredators) {
       predatorsRef.current = predatorsRef.current.slice(0, numPredators);
    }

    lastTimeRef.current = performance.now();
    const render = (time: number) => {
      const dt = time - lastTimeRef.current;
      lastTimeRef.current = time;
      if (dt > 0) {
        fpsRef.current = 1000 / dt;
        if (fpsDisplayRef.current) {
          fpsDisplayRef.current.innerText = `FPS: ${Math.round(fpsRef.current)}`;
        }
      }

      const grid = new Grid(canvas.width, canvas.height, Math.max(paramsRef.current.visualRange, 50));
      for (const boid of boidsRef.current) {
        grid.insert(boid);
      }

      // Optional: Add a subtle trail effect
      ctx.fillStyle = 'rgba(15, 23, 42, 0.3)'; // Dark slate background with low opacity
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const boid of boidsRef.current) {
        if (!isPaused) {
          boid.flock(grid, predatorsRef.current, paramsRef.current, mousePosRef.current);
          boid.update(paramsRef.current);
        }
        boid.draw(ctx, paramsRef.current);
      }

      for (const predator of predatorsRef.current) {
        if (!isPaused) {
          predator.hunt(grid, paramsRef.current);
          predator.update(paramsRef.current);
        }
        predator.draw(ctx, paramsRef.current);
      }

      // Draw mouse interaction radius
      if (mousePosRef.current && paramsRef.current.mouseInteraction !== 'none') {
        ctx.beginPath();
        ctx.arc(
          mousePosRef.current.x,
          mousePosRef.current.y,
          paramsRef.current.mouseRadius,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = paramsRef.current.mouseInteraction === 'attract'
          ? 'rgba(59, 130, 246, 0.1)'
          : 'rgba(239, 68, 68, 0.1)';
        ctx.fill();
        ctx.strokeStyle = paramsRef.current.mouseInteraction === 'attract'
          ? 'rgba(59, 130, 246, 0.3)'
          : 'rgba(239, 68, 68, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      animationFrameId.current = requestAnimationFrame(render);
    };

    requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [numBoids, numPredators, isPaused]); // Re-run effect only when counts change

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <div
        ref={fpsDisplayRef}
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          color: 'white',
          fontFamily: 'monospace',
          fontSize: '14px',
          zIndex: 10,
          backgroundColor: 'rgba(0,0,0,0.5)',
          padding: '4px 8px',
          borderRadius: '4px'
        }}
      >
        FPS: 0
      </div>
      <canvas
        ref={canvasRef}
      style={{
        display: 'block',
        width: '100vw',
        height: '100vh',
          backgroundColor: '#0f172a'
        }}
      />
    </div>
  ); // Make sure this matches
}
