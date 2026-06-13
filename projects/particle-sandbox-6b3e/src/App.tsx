import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Engine } from './engine'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const requestRef = useRef<number>(0);
  const mouseRef = useRef({ x: 0, y: 0, isDown: false, mode: 'attract' as 'attract' | 'repel' | 'emit' });
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const handleResize = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
      if (engineRef.current) {
        engineRef.current.state.width = window.innerWidth;
        engineRef.current.state.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Initialize Engine
    if (!engineRef.current) {
       engineRef.current = new Engine(dimensions.width, dimensions.height);

       // Add some initial particles
       for(let i=0; i < 100; i++) {
         engineRef.current.addParticle({
            position: { x: Math.random() * dimensions.width, y: Math.random() * dimensions.height },
            velocity: { x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 5 },
            acceleration: { x: 0, y: 0 },
            mass: Math.random() * 5 + 1,
            radius: Math.random() * 5 + 2,
            color: `hsl(${Math.random() * 360}, 80%, 50%)`
         });
       }
    }

    let lastTime = performance.now();

    const animate = (time: number) => {
      const deltaTime = Math.min((time - lastTime) / 16.666, 3); // Normalize to ~60fps, cap at 3 to prevent huge jumps
      lastTime = time;

      // Clear canvas
      ctx.fillStyle = 'rgba(10, 10, 20, 0.3)'; // Trail effect
      ctx.fillRect(0, 0, dimensions.width, dimensions.height);

      // Apply mouse forces or emit
      if (mouseRef.current.isDown && engineRef.current) {
        if (mouseRef.current.mode === 'emit') {
          engineRef.current.addParticle({
            position: { x: mouseRef.current.x, y: mouseRef.current.y },
            velocity: { x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10 },
            acceleration: { x: 0, y: 0 },
            mass: Math.random() * 5 + 1,
            radius: Math.random() * 3 + 1,
            color: `hsl(${Math.random() * 360}, 80%, 60%)`
          });
        } else {
           const forceMultiplier = mouseRef.current.mode === 'attract' ? 1.5 : -2.5;
           for (const p of engineRef.current.state.particles) {
              const dx = mouseRef.current.x - p.position.x;
              const dy = mouseRef.current.y - p.position.y;
              const distSq = dx * dx + dy * dy;

              if (distSq > 100 && distSq < 90000) { // Limit effect range and avoid singularity
                 const force = forceMultiplier * (5000 / distSq);
                 const angle = Math.atan2(dy, dx);
                 p.acceleration.x += Math.cos(angle) * force;
                 p.acceleration.y += Math.sin(angle) * force;
              }
           }
        }
      }

      // Update Engine
      engineRef.current?.update(deltaTime);

      // Draw Particles
      if (engineRef.current) {
        for (const p of engineRef.current.state.particles) {
          ctx.beginPath();
          ctx.arc(p.position.x, p.position.y, p.radius, 0, Math.PI * 2);

          // Dynamic color based on velocity
          const speedSq = p.velocity.x * p.velocity.x + p.velocity.y * p.velocity.y;
          const speed = Math.sqrt(speedSq);
          const hue = Math.min(360, Math.max(0, 240 - (speed * 8))); // Blue to Red

          ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.8)`;
          ctx.fill();
        }
      }

      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(requestRef.current);
    };
  }, [dimensions]);

  const handlePointerDown = (e: React.PointerEvent) => {
    mouseRef.current.isDown = true;
    mouseRef.current.x = e.clientX;
    mouseRef.current.y = e.clientY;
    // Left click = attract, Right click = repel, Middle click = emit
    if (e.button === 0) mouseRef.current.mode = 'attract';
    if (e.button === 1) mouseRef.current.mode = 'emit';
    if (e.button === 2) mouseRef.current.mode = 'repel';
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    mouseRef.current.x = e.clientX;
    mouseRef.current.y = e.clientY;
  };

  const handlePointerUp = () => {
    mouseRef.current.isDown = false;
  };

  const clearParticles = () => {
    if (engineRef.current) {
      engineRef.current.state.particles = [];
    }
  };

  const toggleGravity = () => {
    if (engineRef.current) {
      const currentGravity = engineRef.current.state.gravity.y;
      engineRef.current.state.gravity.y = currentGravity > 0 ? 0 : 0.2;
    }
  };

  return (
    <div
      style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#0a0a14', position: 'relative' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={e => e.preventDefault()}
    >
      <div style={{ position: 'absolute', top: 10, left: 10, color: 'white', pointerEvents: 'none', fontFamily: 'monospace', zIndex: 10 }}>
         <h1 style={{ margin: '0 0 10px 0', fontSize: '1.2rem', color: '#00ffcc' }}>Particle Sandbox</h1>
         <p style={{ margin: '5px 0' }}>Left Click: Attract</p>
         <p style={{ margin: '5px 0' }}>Right Click: Repel</p>
         <p style={{ margin: '5px 0' }}>Middle Click: Emit</p>
         <p style={{ margin: '5px 0', fontSize: '0.8rem', opacity: 0.7 }}>Color maps to velocity</p>
         <div style={{ pointerEvents: 'auto', marginTop: '15px', display: 'flex', gap: '10px' }}>
            <button onClick={clearParticles} style={{ background: '#333', color: 'white', border: 'none', padding: '5px 10px', cursor: 'pointer', borderRadius: '4px' }}>Clear</button>
            <button onClick={toggleGravity} style={{ background: '#333', color: 'white', border: 'none', padding: '5px 10px', cursor: 'pointer', borderRadius: '4px' }}>Toggle Gravity</button>
         </div>
      </div>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ display: 'block', position: 'absolute', top: 0, left: 0 }}
      />
    </div>
  )
}

export default App
