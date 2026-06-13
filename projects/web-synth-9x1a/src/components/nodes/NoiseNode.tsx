import { Handle, Position } from '@xyflow/react';

export function NoiseNode() {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[120px] shadow-lg">
      <div className="text-sm font-bold mb-2 border-b border-gray-600 pb-1 text-gray-400">Noise Generator</div>
      <div className="text-xs text-gray-400 italic">White Noise</div>
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-gray-400" />
    </div>
  );
}
