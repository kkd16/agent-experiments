import { X, Play } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';
import { useState } from 'react';

export function AdsrNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);
  const triggerNode = useStore(state => (state as any).triggerNode);

  const [active, setActive] = useState(false);



  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[160px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'ADSR Envelope'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-indigo-400'}`}
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
        <label className="text-xs text-gray-300 flex flex-col">
          Attack: {data.attack} s
          <input
            type="range"
            min="0.01" max="5" step="0.01"
            value={data.attack || 0.1}
            onChange={(e) => updateNodeData(id, { attack: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Decay: {data.decay} s
          <input
            type="range"
            min="0.01" max="5" step="0.01"
            value={data.decay || 0.1}
            onChange={(e) => updateNodeData(id, { decay: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Sustain: {data.sustain}
          <input
            type="range"
            min="0" max="1" step="0.01"
            value={data.sustain !== undefined ? data.sustain : 0.5}
            onChange={(e) => updateNodeData(id, { sustain: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Release: {data.release} s
          <input
            type="range"
            min="0.01" max="5" step="0.01"
            value={data.release || 0.3}
            onChange={(e) => updateNodeData(id, { release: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <button
          onMouseDown={() => { setActive(true); triggerNode(id, 'attack'); }}
          onMouseUp={() => { setActive(false); triggerNode(id, 'release'); }}
          onMouseLeave={() => { if(active) { setActive(false); triggerNode(id, 'release'); } }}
          className="mt-2 w-full py-1 bg-indigo-600 hover:bg-indigo-500 text-xs rounded text-white flex items-center justify-center gap-1"
        >
          <Play size={12} /> Trigger
        </button>
      </div>

      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-indigo-500" />
    </div>
  );
}
