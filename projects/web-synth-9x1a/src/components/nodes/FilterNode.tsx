import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function FilterNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[150px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'Filter (VCF)'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-orange-400'}`}
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
          Bypass
          <input
            type="checkbox"
            checked={data.bypass || false}
            onChange={(e) => updateNodeData(id, { bypass: e.target.checked })}
            className="ml-2 accent-orange-500"
          />
        </label>
        <label className="text-xs text-gray-300 flex flex-col">
          Drive: {data.drive !== undefined ? data.drive : 50}
          <input type="range" min="0" max="400" step="1" value={data.drive !== undefined ? data.drive : 50} onChange={(e) => updateNodeData(id, { drive: Number(e.target.value) })} className="mt-1" />
        </label>
        <label className="text-xs text-gray-300 flex flex-col">
          Type
          <select
            value={data.type || 'lowpass'}
            onChange={(e) => updateNodeData(id, { type: e.target.value })}
            className="mt-1 bg-gray-700 border border-gray-600 text-xs p-1 rounded"
          >
            <option value="lowpass">Lowpass</option>
            <option value="highpass">Highpass</option>
            <option value="bandpass">Bandpass</option>
            <option value="notch">Notch</option>
            <option value="peaking">Peaking</option>
            <option value="lowshelf">Low Shelf</option>
            <option value="highshelf">High Shelf</option>
          </select>
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Freq: {data.frequency} Hz
          <input
            type="range"
            min="20" max="10000"
            value={data.frequency || 1000}
            onChange={(e) => updateNodeData(id, { frequency: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Resonance (Q): {data.Q}
          <input
            type="range"
            min="0" max="20" step="0.1"
            value={data.Q !== undefined ? data.Q : 1}
            onChange={(e) => updateNodeData(id, { Q: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <button
          onClick={() => {
            const types = ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf'];
            updateNodeData(id, {
              frequency: Math.floor(Math.random() * (10000 - 20) + 20),
              Q: Math.random() * 20,
              type: types[Math.floor(Math.random() * types.length)]
            });
          }}
          className="mt-1 bg-gray-700 hover:bg-gray-600 text-xs py-1 rounded text-gray-300 transition-colors"
        >
          Randomize
        </button>
        <button
          onClick={() => updateNodeData(id, {
            frequency: 1000,
            Q: 1,
            type: 'lowpass',
            bypass: false
          })}
          className="mt-1 bg-gray-700 hover:bg-gray-600 text-xs py-1 rounded text-gray-300 transition-colors"
        >
          Reset to Default
        </button>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-orange-500" />
      <Handle type="target" position={Position.Top} id="frequency" className="w-3 h-3 bg-orange-500" style={{ left: '50%' }} />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-orange-500" />
    </div>
  );
}
