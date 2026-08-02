import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function GainNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[120px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'Gain (VCA)'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-green-400'}`}
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
        <label className="text-xs text-gray-300 flex items-center justify-between mb-1">
          Mute
          <input
            type="checkbox"
            checked={data.muted || false}
            onChange={(e) => updateNodeData(id, { muted: e.target.checked })}
            className="ml-2 accent-green-500"
          />
        </label>
        <label className="text-xs text-gray-300 flex items-center justify-between mb-1">
          Invert Phase
          <input
            type="checkbox"
            checked={data.invertPhase || false}
            onChange={(e) => updateNodeData(id, { invertPhase: e.target.checked })}
            className="ml-2 accent-green-500"
          />
        </label>
        <label className="text-xs text-gray-300 flex flex-col">
          Level: {data.gain !== undefined ? data.gain.toFixed(2) : '0.50'}
          <input
            type="range"
            min="0" max="2" step="0.01"
            value={data.gain !== undefined ? data.gain : 0.5}
            onChange={(e) => updateNodeData(id, { gain: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
        <button
          onClick={() => updateNodeData(id, { gain: 0.5, muted: false })}
          className="mt-1 bg-gray-700 hover:bg-gray-600 text-xs py-1 rounded text-gray-300 transition-colors"
        >
          Reset to Default
        </button>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-green-500" />
      <Handle type="target" position={Position.Top} id="gain" className="w-3 h-3 bg-green-500" style={{ left: '50%' }} />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-green-500" />
    </div>
  );
}
