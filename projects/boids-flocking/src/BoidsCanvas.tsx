import { useEffect, useRef } from 'react';
import { Boid, Predator, Grid, type BoidParams, type Obstacle } from './boids';

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
  const obstaclesRef = useRef<Obstacle[]>([]);
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

    const handleClick = (e: MouseEvent) => {
      if (paramsRef.current.mouseInteraction === 'obstacle') {
         // Check if clicking on an existing obstacle to remove it
         const clickedIdx = obstaclesRef.current.findIndex(obs => {
            const dx = obs.x - e.clientX;
            const dy = obs.y - e.clientY;
            return Math.sqrt(dx * dx + dy * dy) <= obs.radius;
         });

         if (clickedIdx !== -1) {
            obstaclesRef.current.splice(clickedIdx, 1);
         } else {
            obstaclesRef.current.push({
               x: e.clientX,
               y: e.clientY,
               radius: 30
            });
         }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseLeave = () => {
      mousePosRef.current = null;
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('click', handleClick);
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

      // Dynamically calculate wind if windVariation is enabled
      const currentParams = { ...paramsRef.current };
      if (currentParams.windVariation) {
        currentParams.windX += Math.sin(time * 0.001) * 0.05;
        currentParams.windY += Math.cos(time * 0.0013) * 0.05;
      }

      const grid = new Grid(canvas.width, canvas.height, Math.max(currentParams.visualRange, 50));
      for (const boid of boidsRef.current) {
        grid.insert(boid);
      }

      // Background rendering & Trail Decay
      const isNight = currentParams.nightMode;
      const bgR = isNight ? 15 : 241;
      const bgG = isNight ? 23 : 245;
      const bgB = isNight ? 42 : 249;

      const decay = currentParams.showTrails ? currentParams.trailDecay : 1.0;
      ctx.fillStyle = `rgba(${bgR}, ${bgG}, ${bgB}, ${decay})`;

      ctx.save();

      // Camera Follow logic
      if (currentParams.cameraFollow && boidsRef.current.length > 0) {
         const leader = boidsRef.current[0];
         // Translate canvas context so leader is in center
         ctx.translate(canvas.width / 2 - leader.position.x, canvas.height / 2 - leader.position.y);
      }

      // Fill full area regardless of translation
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform for background clear
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();


      if (currentParams.showGrid) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        const gridSize = 50;
        // Slowly scroll the grid using time
        const offsetX = (time * 0.02) % gridSize;
        const offsetY = (time * 0.02) % gridSize;

        ctx.beginPath();
        for (let x = offsetX; x < canvas.width; x += gridSize) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
        }
        for (let y = offsetY; y < canvas.height; y += gridSize) {
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
        }
        ctx.stroke();
      }

      for (const boid of boidsRef.current) {
        if (!isPaused) {
          boid.flock(grid, predatorsRef.current, obstaclesRef.current, currentParams, mousePosRef.current);
          boid.update(currentParams);
        }
        boid.draw(ctx, currentParams);
      }

      // Draw obstacles
      for (const obs of obstaclesRef.current) {
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, obs.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#64748b'; // slate-500
        ctx.fill();
        ctx.strokeStyle = '#94a3b8'; // slate-400
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      for (const predator of predatorsRef.current) {
        if (!isPaused) {
          predator.hunt(grid, currentParams);
          predator.update(currentParams);
        }
        predator.draw(ctx, currentParams);
      }

      // Draw mouse interaction radius
      if (mousePosRef.current && currentParams.mouseInteraction !== 'none') {
        ctx.beginPath();
        ctx.arc(
          mousePosRef.current.x,
          mousePosRef.current.y,
          currentParams.mouseInteraction === 'obstacle' ? 30 : currentParams.mouseRadius,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = currentParams.mouseInteraction === 'attract'
          ? 'rgba(59, 130, 246, 0.1)'
          : currentParams.mouseInteraction === 'obstacle'
          ? 'rgba(100, 116, 139, 0.2)'
          : 'rgba(239, 68, 68, 0.1)';
        ctx.fill();
        ctx.strokeStyle = currentParams.mouseInteraction === 'attract'
          ? 'rgba(59, 130, 246, 0.3)'
          : currentParams.mouseInteraction === 'obstacle'
          ? 'rgba(100, 116, 139, 0.5)'
          : 'rgba(239, 68, 68, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();
      animationFrameId.current = requestAnimationFrame(render);
    };

    requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('click', handleClick);
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
          backgroundColor: params.nightMode ? '#0f172a' : '#f1f5f9'
        }}
      />
    </div>
  ); // Make sure this matches
}
