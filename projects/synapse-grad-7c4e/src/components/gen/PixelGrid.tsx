import { useEffect, useRef } from 'react';
import { drawGrid, inkColor } from '../../lib/raster';

interface Props {
  pixels: Float64Array;
  size: number;
  cell: number;
  className?: string;
  title?: string;
}

// A crisp little canvas that paints one flat intensity grid (display range, ink ≈ +0.5) with
// the shared ink ramp — the unit of every gallery in the generative lab.
export default function PixelGrid({ pixels, size, cell, className, title }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    drawGrid(ref.current, pixels, size, size, cell, inkColor);
  }, [pixels, size, cell]);
  return <canvas ref={ref} className={className ? `img-canvas ${className}` : 'img-canvas'} title={title} />;
}
