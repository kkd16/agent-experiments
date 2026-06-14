import { useEffect, useRef, useState } from 'react';
import { type World } from './engine';

interface CanvasRendererProps {
  world: World;
  width: number;
  height: number;
}

export function CanvasRenderer({ world, width, height }: CanvasRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const render = () => {
      // Clear background based on season
      let bgColor = '#0f172a'; // Default slate-900 (Summer/Spring night)
      if (world.season === 'Winter') {
        bgColor = '#0f172a'; // Stay dark, but maybe add snow effect later
      } else if (world.season === 'Autumn') {
         bgColor = '#1e1b4b'; // Deep violet/brown tint
      } else if (world.season === 'Spring') {
         bgColor = '#064e3b'; // Very dark green tint
      } else if (world.season === 'Summer') {
         bgColor = '#3b0764'; // Very dark purple tint
      }

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);

      ctx.save();

      // Apply transforms
      ctx.translate(offset.x, offset.y);
      ctx.scale(scale, scale);

      // Draw grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1 / scale;
      const gridSize = 100;
      for (let x = 0; x <= world.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, world.height);
        ctx.stroke();
      }
      for (let y = 0; y <= world.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(world.width, y);
        ctx.stroke();
      }

      // Draw world bounds
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(0, 0, world.width, world.height);

      // Draw hazard zones
      for (const hazard of world.hazards) {
        ctx.fillStyle = 'rgba(168, 85, 247, 0.1)'; // purple-500 with low opacity
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.3)';
        ctx.beginPath();
        ctx.arc(hazard.position.x, hazard.position.y, hazard.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Hazard symbol (simple cross or asterisk)
        ctx.fillStyle = 'rgba(168, 85, 247, 0.5)';
        ctx.font = '20px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('☢', hazard.position.x, hazard.position.y);
      }

      // Draw food
      ctx.fillStyle = '#22c55e'; // green-500
      for (const food of world.foods) {
        ctx.beginPath();
        ctx.arc(food.x, food.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw entities
      for (const entity of world.entities) {
        // Draw vision range (debug)
        // ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        // ctx.beginPath();
        // ctx.arc(entity.position.x, entity.position.y, 50, 0, Math.PI * 2);
        // ctx.stroke();

        // Draw body
        ctx.fillStyle = entity.color;
        ctx.beginPath();
        ctx.arc(entity.position.x, entity.position.y, entity.radius, 0, Math.PI * 2);
        ctx.fill();

        // Draw heading indicator
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(entity.position.x, entity.position.y);
        const headingLen = entity.radius * 1.5;
        const angle = Math.atan2(entity.velocity.y, entity.velocity.x);
        ctx.lineTo(
          entity.position.x + Math.cos(angle) * headingLen,
          entity.position.y + Math.sin(angle) * headingLen
        );
        ctx.stroke();

        // Draw health/energy bar
        const barWidth = 10;
        const barHeight = 2;
        ctx.fillStyle = 'red';
        ctx.fillRect(entity.position.x - barWidth/2, entity.position.y - entity.radius - 5, barWidth, barHeight);
        ctx.fillStyle = 'green';
        ctx.fillRect(entity.position.x - barWidth/2, entity.position.y - entity.radius - 5, barWidth * (entity.energy / entity.maxEnergy), barHeight);
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [world, width, height, scale, offset]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomSensitivity = 0.001;
    const delta = -e.deltaY * zoomSensitivity;
    const newScale = Math.min(Math.max(0.1, scale * (1 + delta)), 5);

    // Zoom towards cursor
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newOffset = {
        x: mouseX - (mouseX - offset.x) * (newScale / scale),
        y: mouseY - (mouseY - offset.y) * (newScale / scale),
      };

      setScale(newScale);
      setOffset(newOffset);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      className="w-full h-full block bg-slate-900"
    />
  );
}
