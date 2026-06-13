import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function OscillatorNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[150px] shadow-lg">
      <div className="text-sm font-bold mb-2 border-b border-gray-600 pb-1 text-blue-400">Oscillator</div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-300 flex flex-col">
          Type
          <select
            value={data.type || 'sawtooth'}
            onChange={(e) => updateNodeData(id, { type: e.target.value })}
            className="mt-1 bg-gray-700 border border-gray-600 text-xs p-1 rounded"
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="triangle">Triangle</option>
          </select>
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Frequency: {data.frequency} Hz
          <input
            type="range"
            min="20" max="2000"
            value={data.frequency || 440}
            onChange={(e) => updateNodeData(id, { frequency: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
      </div>

      <Handle type="target" position={Position.Left} id="frequency" className="w-3 h-3 bg-blue-500" />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-blue-500" />
    </div>
  );
}
