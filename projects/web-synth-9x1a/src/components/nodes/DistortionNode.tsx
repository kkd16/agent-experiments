import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function DistortionNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[120px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="text-sm font-bold text-orange-600">Distortion</div>
        <button onClick={() => removeNode(id)} className="text-gray-500 hover:text-red-400"><X size={14} /></button>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-300 flex flex-col">
          Drive: {data.drive !== undefined ? data.drive : 50}
          <input
            type="range"
            min="0" max="400" step="1"
            value={data.drive !== undefined ? data.drive : 50}
            onChange={(e) => updateNodeData(id, { drive: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-orange-600" />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-orange-600" />
    </div>
  );
}