import { useEffect, useRef } from 'react';
import { Boid, type BoidParams } from './boids';

interface BoidsCanvasProps {
  params: BoidParams;
  numBoids: number;
}

export function BoidsCanvas({ params, numBoids }: BoidsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boidsRef = useRef<Boid[]>([]);
  const animationFrameId = useRef<number>(0);
  const paramsRef = useRef(params);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);

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

    const render = () => {
      // Optional: Add a subtle trail effect
      ctx.fillStyle = 'rgba(15, 23, 42, 0.3)'; // Dark slate background with low opacity
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const boid of boidsRef.current) {
        boid.flock(boidsRef.current, paramsRef.current, mousePosRef.current);
        boid.update(paramsRef.current);
        boid.draw(ctx);
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

    render();

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [numBoids]); // Re-run effect only when numBoids changes

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#0f172a' // fallback background
      }}
    />
  );
}
