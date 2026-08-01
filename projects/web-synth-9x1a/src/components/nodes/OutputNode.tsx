import { Handle, Position } from '@xyflow/react';
import { Volume2 } from 'lucide-react';
import { audioCore } from '../../audio/core';
import { useState } from 'react';

import { useStore } from '../../store';
export function OutputNode({ id = 'output', data = {} }: { id?: string, data?: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const [isPlaying, setIsPlaying] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1.0);

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
        <div className="flex items-center">
        <input
          value={data.label || 'Master Output'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-red-400'}`}
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
        <Volume2 size={18} className="text-red-400" />
      </div>

      <button
        onClick={togglePlay}
        className={`w-full mt-2 py-1 px-2 rounded text-xs font-bold ${isPlaying ? 'bg-red-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
      >
        {isPlaying ? 'PAUSE AUDIO' : 'START AUDIO'}
      </button>


      <div className="mt-3 flex flex-col gap-1">
        <label className="text-[10px] text-gray-400 font-semibold uppercase flex justify-between">
          <span>Master Vol</span>
          <span>{Math.round(masterVolume * 100)}%</span>
        </label>
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={masterVolume}
          onChange={(e) => {
            const vol = parseFloat(e.target.value);
            setMasterVolume(vol);
            audioCore.setMasterVolume(vol);
          }}
          className="w-full accent-red-500"
        />
      </div>

      <Handle type="target" position={Position.Left} id="in" className="w-4 h-4 bg-red-500" />
    </div>
  );
}
