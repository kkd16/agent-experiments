import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function RingModulatorNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[150px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'Ring Mod'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-pink-500'}`}
          style={data.color ? { color: data.color } : {}}
        />
        <input
          type="color"
          value={data.color || '#ffffff'}
          onChange={(e) => updateNodeData(id, { color: e.target.value })}
          className="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer ml-2 opacity-50 hover:opacity-100"
          title="Custom Color"
        />
        </div>
        <button onClick={() => removeNode(id)} className="text-gray-500 hover:text-red-400"><X size={14} /></button>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-300 flex flex-col">
          Freq: {data.frequency || 400} Hz
          <input
            type="range"
            min="20" max="2000" step="1"
            value={data.frequency || 400}
            onChange={(e) => updateNodeData(id, { frequency: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Type
          <select
            value={data.type || 'sine'}
            onChange={(e) => updateNodeData(id, { type: e.target.value })}
            className="mt-1 bg-gray-700 border border-gray-600 text-xs p-1 rounded"
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="triangle">Triangle</option>
          </select>
        </label>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-pink-500" />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-pink-500" />
    </div>
  );
}
