// The memory-mapped display. The framebuffer is just FB_W×FB_H bytes of ordinary memory at
// FB_BASE; each byte indexes a 16-colour palette. We read it straight out of the CPU's
// memory every render and blit it to a canvas via ImageData, scaled up with nearest-neighbour.

import { useEffect, useRef } from 'react';
import type { Cpu } from '../vm/cpu';
import { FB_BASE, FB_BYTES, FB_H, FB_W, PALETTE } from '../vm/constants';

interface Props {
  cpu: Cpu;
  tick: number;
}

// Pre-parse the palette into RGB triples once.
const RGB: [number, number, number][] = PALETTE.map((hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
});

const SCALE = 3;

export default function Framebuffer({ cpu, tick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<ImageData | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!imageRef.current) imageRef.current = ctx.createImageData(FB_W, FB_H);
    const img = imageRef.current;
    const data = img.data;
    const fb = cpu.mem.readRange(FB_BASE, FB_BYTES);

    for (let i = 0; i < FB_BYTES; i++) {
      const [r, g, b] = RGB[fb[i] & 0x0f];
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }

    // Blit at 1:1 to an offscreen, then scale up with image smoothing off.
    const off = document.createElement('canvas');
    off.width = FB_W;
    off.height = FB_H;
    off.getContext('2d')?.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, [cpu, tick]);

  return (
    <div className="panel framebuffer">
      <div className="panel-head">
        <h2>Display</h2>
        <span className="muted">
          {FB_W}×{FB_H} @ 0x{FB_BASE.toString(16)}
        </span>
      </div>
      <div className="fb-stage">
        <canvas ref={canvasRef} width={FB_W * SCALE} height={FB_H * SCALE} className="fb-canvas" />
      </div>
      <div className="fb-palette">
        {PALETTE.map((c, i) => (
          <span key={i} className="swatch" style={{ background: c }} title={`palette ${i}`} />
        ))}
      </div>
      <p className="muted fb-hint">
        Write a palette byte (0–15) to memory at <code>0x{FB_BASE.toString(16)} + y*{FB_W} + x</code> to
        plot a pixel. Run the <strong>Mandelbrot</strong> or <strong>Colour rings</strong> example.
      </p>
    </div>
  );
}
