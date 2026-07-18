import { useEffect, useRef } from 'react';

export type Palette = 'focus' | 'signed' | 'bits';

// A small canvas heatmap. `data` is row-major [rows*cols]; each cell is coloured by `palette`
// after normalizing into [0,1] (for 'focus'/'bits') or [-1,1] (for 'signed'). Used for the head
// weightings over time, the memory matrix, and the input/target/output bit rasters.
interface Props {
  data: Float64Array;
  rows: number;
  cols: number;
  cell: number; // pixel size of a cell
  palette: Palette;
  vmax?: number; // override the normalization scale (default: data max magnitude, or 1)
  gap?: number;
  rowLabels?: string[];
  colLabels?: string[];
}

function focusColor(t: number): [number, number, number] {
  // Dark navy -> teal -> bright green -> pale yellow (a legible "attention" ramp on dark bg).
  const stops: [number, number[]][] = [
    [0.0, [11, 18, 32]],
    [0.35, [14, 68, 90]],
    [0.6, [16, 150, 129]],
    [0.82, [74, 222, 128]],
    [1.0, [240, 250, 200]],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return [240, 250, 200];
}

function signedColor(v: number): [number, number, number] {
  // Diverging: rose (negative) -> dark (zero) -> cyan (positive).
  const t = Math.max(-1, Math.min(1, v));
  if (t >= 0) return [17 + (56 - 17) * (1 - t), 24 + (189 - 24) * t, 39 + (248 - 39) * t];
  const a = -t;
  return [251 * a + 17 * (1 - a), 113 * a + 24 * (1 - a), 133 * a + 39 * (1 - a)];
}

function bitsColor(t: number): [number, number, number] {
  // Greyscale-ish for probabilities/bits: dark -> warm white.
  t = Math.max(0, Math.min(1, t));
  return [20 + 232 * t, 26 + 224 * t, 40 + 200 * t];
}

export default function Heatmap({ data, rows, cols, cell, palette, vmax, gap = 1, rowLabels, colLabels }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const labelW = rowLabels ? 26 : 0;
  const labelH = colLabels ? 14 : 0;
  const W = labelW + cols * cell + (cols - 1) * gap;
  const H = labelH + rows * cell + (rows - 1) * gap;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    let scale = vmax ?? 0;
    if (!vmax) {
      for (let i = 0; i < data.length; i++) scale = Math.max(scale, Math.abs(data[i]));
      scale = scale || 1;
    }
    const colorOf = (v: number): string => {
      let rgb: [number, number, number];
      if (palette === 'signed') rgb = signedColor(v / scale);
      else if (palette === 'bits') rgb = bitsColor(v / scale);
      else rgb = focusColor(v / scale);
      return `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = colorOf(data[r * cols + c]);
        ctx.fillRect(labelW + c * (cell + gap), labelH + r * (cell + gap), cell, cell);
      }
    }

    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    if (rowLabels) {
      ctx.textAlign = 'right';
      for (let r = 0; r < rows; r++) {
        if (rowLabels[r]) ctx.fillText(rowLabels[r], labelW - 4, labelH + r * (cell + gap) + cell / 2);
      }
    }
    if (colLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let c = 0; c < cols; c++) {
        if (colLabels[c]) ctx.fillText(colLabels[c], labelW + c * (cell + gap) + cell / 2, labelH - 4);
      }
    }
  }, [data, rows, cols, cell, palette, vmax, gap, rowLabels, colLabels, W, H, labelW, labelH]);

  return <canvas ref={ref} width={W} height={H} className="ntm-heatmap" style={{ width: W, height: H }} />;
}
