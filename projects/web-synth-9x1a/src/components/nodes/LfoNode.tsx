import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';
import { Activity } from 'lucide-react';

export function LfoNode({ id, data }: { id: string; data: any }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  return (
    <div className="bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[200px] overflow-hidden">
      <div className="bg-gray-900 px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-blue-400" />
          <span className="text-xs font-semibold text-gray-200">LFO</span>
        </div>
      </div>

      <div className="p-3 flex flex-col gap-3 relative">
        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Rate</label>
            <span className="text-[10px] text-gray-300">{data.frequency?.toFixed(1) || 5.0} Hz</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="20"
            step="0.1"
            value={data.frequency || 5.0}
            onChange={(e) => updateNodeData(id, { frequency: parseFloat(e.target.value) })}
            className="w-full accent-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Depth</label>
            <span className="text-[10px] text-gray-300">{data.depth?.toFixed(0) || 100}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            value={data.depth || 100}
            onChange={(e) => updateNodeData(id, { depth: parseFloat(e.target.value) })}
            className="w-full accent-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Type</label>
          <select
            value={data.type || 'sine'}
            onChange={(e) => updateNodeData(id, { type: e.target.value })}
            className="w-full bg-gray-700 border border-gray-600 rounded text-xs p-1 text-white"
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="triangle">Triangle</option>
          </select>
        </div>

        <div className="relative mt-2 h-4">
          <Handle
            type="source"
            position={Position.Right}
            className="w-3 h-3 bg-blue-400 border-2 border-gray-800 !right-[-18px]"
          />
          <span className="absolute right-0 text-[10px] text-gray-400 leading-4">OUT</span>
        </div>
      </div>
    </div>
  );
}
