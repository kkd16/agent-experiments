import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function DelayNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[150px] shadow-lg">
      <div className="text-sm font-bold mb-2 border-b border-gray-600 pb-1 text-purple-400">Delay</div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-300 flex flex-col">
          Time: {data.delayTime?.toFixed(2)} s
          <input
            type="range"
            min="0" max="2" step="0.01"
            value={data.delayTime !== undefined ? data.delayTime : 0.5}
            onChange={(e) => updateNodeData(id, { delayTime: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Feedback: {data.feedback?.toFixed(2)}
          <input
            type="range"
            min="0" max="1" step="0.01"
            value={data.feedback !== undefined ? data.feedback : 0.5}
            onChange={(e) => updateNodeData(id, { feedback: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-3 h-3 bg-purple-500" />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-purple-500" />
    </div>
  );
}
