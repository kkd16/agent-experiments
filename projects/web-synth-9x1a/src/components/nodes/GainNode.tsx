import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function GainNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[120px] shadow-lg">
      <div className="text-sm font-bold mb-2 border-b border-gray-600 pb-1 text-green-400">Gain (VCA)</div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-300 flex flex-col">
          Level: {data.gain?.toFixed(2)}
          <input
            type="range"
            min="0" max="2" step="0.01"
            value={data.gain !== undefined ? data.gain : 0.5}
            onChange={(e) => updateNodeData(id, { gain: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-green-500" />
      <Handle type="target" position={Position.Top} id="gain" className="w-3 h-3 bg-green-500" style={{ left: '50%' }} />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-green-500" />
    </div>
  );
}
