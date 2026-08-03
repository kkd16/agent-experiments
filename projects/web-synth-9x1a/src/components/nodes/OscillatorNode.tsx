import { X } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store';

export function OscillatorNode({ id, data }: { id: string, data: Record<string, any> }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const removeNode = useStore(state => state.removeNode);

  return (
    <div style={data.color ? { borderColor: data.color } : {}} className="bg-gray-800 border border-gray-700 rounded-md p-3 min-w-[150px] shadow-lg">
      <div className="flex justify-between items-center mb-2 border-b border-gray-600 pb-1">
        <div className="flex items-center">
        <input
          value={data.label || 'Oscillator'}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          className={`bg-transparent outline-none w-24 text-sm font-bold ${data.color ? '' : 'text-blue-400'}`}
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
          Invert Phase
          <input
            type="checkbox"
            checked={data.invertPhase || false}
            onChange={(e) => updateNodeData(id, { invertPhase: e.target.checked })}
            className="ml-2 accent-blue-500"
          />
        </label>
        <label className="text-xs text-gray-300 flex items-center justify-between mb-1">
          Sub-Oscillator
          <input
            type="checkbox"
            checked={data.subOscEnabled || false}
            onChange={(e) => updateNodeData(id, { subOscEnabled: e.target.checked })}
            className="ml-2 accent-blue-500"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Type
          <select
            value={data.type || 'sawtooth'}
            onChange={(e) => updateNodeData(id, { type: e.target.value })}
            className="mt-1 bg-gray-700 border border-gray-600 text-xs p-1 rounded"
          >
            <option value="sine">Sine</option>
            <option value="square">Square</option>
            <option value="sawtooth">Sawtooth</option>
            <option value="triangle">Triangle</option>
          </select>
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Frequency: {data.frequency} Hz
          <input
            type="range"
            min="20" max="2000"
            value={data.frequency || 440}
            onChange={(e) => updateNodeData(id, { frequency: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-gray-300 flex flex-col">
          Detune: {data.detune || 0} cents
          <input
            type="range"
            min="-1200" max="1200" step="1"
            value={data.detune || 0}
            onChange={(e) => updateNodeData(id, { detune: Number(e.target.value) })}
            className="mt-1"
          />
        </label>
        <label className="text-xs text-gray-300 flex flex-col">
          Fine Tune: {data.fineTune || 0} cents
          <input
            type="range"
            min="-100" max="100" step="1"
            value={data.fineTune || 0}
            onChange={(e) => updateNodeData(id, { fineTune: Number(e.target.value) })}
            className="mt-1"
          />
        </label>


        <label className="text-xs text-gray-300 flex flex-col">
          Octave
          <select
            value={data.octave || 0}
            onChange={(e) => updateNodeData(id, { octave: Number(e.target.value) })}
            className="mt-1 bg-gray-700 border border-gray-600 text-xs p-1 rounded"
          >
            <option value="-2">-2</option>
            <option value="-1">-1</option>
            <option value="0">0</option>
            <option value="1">+1</option>
            <option value="2">+2</option>
          </select>
        </label>


        <label className="text-xs text-gray-300 flex flex-col">
          Glide: {data.glideTime || 0}s
          <input
            type="range"
            min="0" max="2" step="0.01"
            value={data.glideTime || 0}
            onChange={(e) => updateNodeData(id, { glideTime: Number(e.target.value) })}
            className="mt-1"
          />
        </label>

        <div className="flex gap-1 mt-1">
          <button
            onClick={() => updateNodeData(id, { frequency: 440, type: 'sawtooth', detune: 0, octave: 0, invertPhase: false, glideTime: 0, subOscEnabled: false, fineTune: 0 })}
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-[10px] py-1 rounded text-gray-300 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={() => {
              const types = ['sine', 'square', 'sawtooth', 'triangle'];
              updateNodeData(id, {
                frequency: Math.floor(Math.random() * (2000 - 20) + 20),
                type: types[Math.floor(Math.random() * types.length)],
                detune: Math.floor(Math.random() * 2400 - 1200),
                octave: Math.floor(Math.random() * 5 - 2),
                invertPhase: Math.random() > 0.5,
                glideTime: Math.round(Math.random() * 200) / 100,
                subOscEnabled: Math.random() > 0.5,
                fineTune: Math.floor(Math.random() * 200 - 100)
              });
            }}
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-[10px] py-1 rounded text-gray-300 transition-colors"
          >
            Randomize
          </button>
        </div>
      </div>

      <Handle type="target" position={Position.Left} id="frequency" className="w-3 h-3 bg-blue-500" />
      <Handle type="source" position={Position.Right} id="out" className="w-3 h-3 bg-blue-500" />
    </div>
  );
}
