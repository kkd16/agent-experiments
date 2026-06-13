import React, { useRef, useEffect } from 'react';

interface LossGraphProps {
  lossHistory: number[];
}

export const LossGraph: React.FC<LossGraphProps> = ({ lossHistory }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (lossHistory.length < 2) return;

    const maxLoss = Math.max(...lossHistory, 1.0); // Minimum max of 1.0
    const minLoss = 0; // Loss is always non-negative

    ctx.beginPath();
    ctx.strokeStyle = '#bb86fc';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    for (let i = 0; i < lossHistory.length; i++) {
      const x = (i / (lossHistory.length - 1)) * canvas.width;
      // Invert y so 0 is at bottom
      const y = canvas.height - ((lossHistory[i] - minLoss) / (maxLoss - minLoss)) * canvas.height;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();

  }, [lossHistory]);

  return (
    <div className="loss-graph-container" style={{ marginTop: '1rem' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', color: '#ccc', fontSize: '0.9rem' }}>Loss Curve</label>
      <canvas
        ref={canvasRef}
        width={260}
        height={80}
        style={{
          width: '100%',
          border: '1px solid #444',
          borderRadius: '4px',
        }}
      />
    </div>
  );
};
