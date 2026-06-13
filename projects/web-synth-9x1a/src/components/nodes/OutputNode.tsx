import { Handle, Position } from '@xyflow/react';
import { Volume2 } from 'lucide-react';
import { audioCore } from '../../audio/core';
import { useState } from 'react';

export function OutputNode() {
  const [isPlaying, setIsPlaying] = useState(false);

  const togglePlay = async () => {
    if (!isPlaying) {
      await audioCore.resumeContext();
      setIsPlaying(true);
    } else {
      audioCore.getContext().suspend();
      setIsPlaying(false);
    }
  };

  return (
    <div className="bg-gray-800 border-2 border-red-500 rounded-md p-4 min-w-[150px] shadow-[0_0_15px_rgba(239,68,68,0.3)]">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-bold text-red-400">Master Output</div>
        <Volume2 size={18} className="text-red-400" />
      </div>

      <button
        onClick={togglePlay}
        className={`w-full mt-2 py-1 px-2 rounded text-xs font-bold ${isPlaying ? 'bg-red-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
      >
        {isPlaying ? 'PAUSE AUDIO' : 'START AUDIO'}
      </button>

      <Handle type="target" position={Position.Left} id="in" className="w-4 h-4 bg-red-500" />
    </div>
  );
}
