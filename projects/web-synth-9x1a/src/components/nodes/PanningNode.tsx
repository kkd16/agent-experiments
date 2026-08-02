import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function PanningNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[120px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'Panning'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-yellow-400'}`}
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
          Auto-Pan
          <input
            type="checkbox"
            checked={data.autoPan || false}
            onChange={(e) => updateNodeData(id, { autoPan: e.target.checked })}
            className="ml-2 accent-yellow-500"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Pan: {data.pan?.toFixed(2)}
          <input
            type="range"
            min="-1" max="1" step="0.01"
            value={data.pan !== undefined ? data.pan : 0}
            onChange={(e) => updateNodeData(id, { pan: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        {data.autoPan && (
          <>
            <label className="text-xs text-gray-300 flex flex-col">
              Rate: {data.autoPanRate?.toFixed(2) || '1.00'} Hz
              <input
                type="range"
                min="0.1" max="20" step="0.1"
                value={data.autoPanRate !== undefined ? data.autoPanRate : 1.0}
                onChange={(e) => updateNodeData(id, { autoPanRate: Number(e.target.value) })}
                className="mt-1 accent-yellow-500"
              />
            </label>
            <label className="text-xs text-gray-300 flex flex-col">
              Depth: {data.autoPanDepth?.toFixed(2) || '1.00'}
              <input
                type="range"
                min="0" max="1" step="0.01"
                value={data.autoPanDepth !== undefined ? data.autoPanDepth : 1.0}
                onChange={(e) => updateNodeData(id, { autoPanDepth: Number(e.target.value) })}
                className="mt-1 accent-yellow-500"
              />
            </label>
          </>
        )}
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-yellow-500" />
      <Handle type="target" position={Position.Top} id="pan" className="w-3 h-3 bg-yellow-500" style={{ left: '50%' }} />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-yellow-500" />
    </div>
  );
}