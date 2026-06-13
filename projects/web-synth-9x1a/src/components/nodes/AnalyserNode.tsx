import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';
import { MonitorPlay } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AnalyserWrapper } from '../../audio/nodes/visualizers';

export function AnalyserNode({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioNodes = useStore((state) => state.audioNodes);
  const reqRef = useRef<number>(0);

  useEffect(() => {
    const wrapper = audioNodes.get(id) as AnalyserWrapper;
    if (!wrapper || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    const draw = () => {
      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;

      // Get latest data
      const dataArray = wrapper.getWaveformData();
      const bufferLength = dataArray.length;

      // Draw background
      canvasCtx.fillStyle = 'rgb(31, 41, 55)'; // gray-800
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

      // Draw line
      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = 'rgb(96, 165, 250)'; // blue-400
      canvasCtx.beginPath();

      const sliceWidth = WIDTH * 1.0 / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * HEIGHT / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();

      reqRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(reqRef.current);
    };
  }, [id, audioNodes]);

  return (
    <div className="bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[200px] overflow-hidden">
      <div className="bg-gray-900 px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorPlay size={14} className="text-teal-400" />
          <span className="text-xs font-semibold text-gray-200">Oscilloscope</span>
        </div>
      </div>

      <div className="p-3 flex flex-col gap-3 relative">
        <div className="relative h-4 mb-2">
          <Handle
            type="target"
            position={Position.Left}
            className="w-3 h-3 bg-gray-400 border-2 border-gray-800 !left-[-18px]"
          />
          <span className="absolute left-0 text-[10px] text-gray-400 leading-4">IN</span>
        </div>

        <div className="w-full bg-gray-900 rounded border border-gray-700 p-1 flex justify-center">
            <canvas ref={canvasRef} width="180" height="80" className="w-full h-auto bg-gray-900" />
        </div>

        <div className="relative mt-2 h-4">
          <Handle
            type="source"
            position={Position.Right}
            className="w-3 h-3 bg-teal-400 border-2 border-gray-800 !right-[-18px]"
          />
          <span className="absolute right-0 text-[10px] text-gray-400 leading-4">OUT</span>
        </div>
      </div>
    </div>
  );
}
