import React, { useRef, useEffect } from 'react';
import type { Point } from '../worker';

interface CanvasProps {
  points: Point[];
  predictions: Float32Array | null;
  resolution: number;
  onAddPoint: (x: number, y: number, label: number) => void;
}

export const Canvas: React.FC<CanvasProps> = ({ points, predictions, resolution, onAddPoint }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Handle click to add point
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>, label: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Map to -1 to 1
    const x = (px / canvas.width) * 2 - 1;
    const y = (py / canvas.height) * 2 - 1;

    onAddPoint(x, y, label);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw decision boundary
    if (predictions) {
      const imgData = ctx.createImageData(resolution, resolution);
      for (let i = 0; i < resolution; i++) {
        for (let j = 0; j < resolution; j++) {
          const val = predictions[i * resolution + j];
          const idx = (j * resolution + i) * 4; // Note: row-major vs col-major

          // Color mapping: 0 -> orangeish, 1 -> blueish
          const r = Math.floor(255 * (1 - val) + 50 * val);
          const g = Math.floor(150 * (1 - val) + 150 * val);
          const b = Math.floor(50 * (1 - val) + 255 * val);

          imgData.data[idx] = r;
          imgData.data[idx + 1] = g;
          imgData.data[idx + 2] = b;
          imgData.data[idx + 3] = 200; // Alpha
        }
      }

      // Scale up to canvas size
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = resolution;
      tempCanvas.height = resolution;
      tempCanvas.getContext('2d')?.putImageData(imgData, 0, 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false; // keep it pixelated or true to blur
      ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Draw points
    for (const p of points) {
      // Map back to canvas coords
      const cx = (p.x + 1) / 2 * canvas.width;
      const cy = (p.y + 1) / 2 * canvas.height;

      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
      ctx.fillStyle = p.label === 1 ? '#007bff' : '#ff7b00';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [points, predictions, resolution]);

  return (
    <div className="canvas-container">
      <canvas
        ref={canvasRef}
        width={400}
        height={400}
        onContextMenu={(e) => { e.preventDefault(); handleClick(e, 0); }} // Right click for orange
        onClick={(e) => handleClick(e, 1)} // Left click for blue
      />
      <div className="canvas-hint">
        Left click to add blue points (Class 1). Right click to add orange points (Class 0).
      </div>
    </div>
  );
};
