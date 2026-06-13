import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';
import { Settings } from 'lucide-react';

export function ReverbNode({ id, data }: { id: string; data: any }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  return (
    <div className="bg-gray-800 rounded-lg shadow-xl border border-gray-700 min-w-[200px] overflow-hidden">
      <div className="bg-gray-900 px-3 py-2 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings size={14} className="text-pink-400" />
          <span className="text-xs font-semibold text-gray-200">Reverb</span>
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

        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Decay</label>
            <span className="text-[10px] text-gray-300">{data.decay?.toFixed(1) || 2.0} s</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.1"
            value={data.decay || 2.0}
            onChange={(e) => updateNodeData(id, { decay: parseFloat(e.target.value) })}
            className="w-full accent-pink-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex justify-between">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Mix</label>
            <span className="text-[10px] text-gray-300">{(data.mix * 100).toFixed(0) || 50}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={data.mix || 0.5}
            onChange={(e) => updateNodeData(id, { mix: parseFloat(e.target.value) })}
            className="w-full accent-pink-500"
          />
        </div>

        <div className="relative mt-2 h-4">
          <Handle
            type="source"
            position={Position.Right}
            className="w-3 h-3 bg-pink-400 border-2 border-gray-800 !right-[-18px]"
          />
          <span className="absolute right-0 text-[10px] text-gray-400 leading-4">OUT</span>
        </div>
      </div>
    </div>
  );
}
