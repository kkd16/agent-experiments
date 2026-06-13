import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from './store';
import { OscillatorNode } from './components/nodes/OscillatorNode';
import { NoiseNode } from './components/nodes/NoiseNode';
import { LfoNode } from './components/nodes/LfoNode';
import { GainNode } from './components/nodes/GainNode';
import { FilterNode } from './components/nodes/FilterNode';
import { DelayNode } from './components/nodes/DelayNode';
import { ReverbNode } from './components/nodes/ReverbNode';
import { AnalyserNode } from './components/nodes/AnalyserNode';
import { OutputNode } from './components/nodes/OutputNode';
import { Settings, Waves, Sliders, AudioWaveform, Activity, MonitorPlay } from 'lucide-react';
import { useState } from 'react';

const nodeTypes = {
  oscillatorNode: OscillatorNode,
  noiseNode: NoiseNode,
  lfoNode: LfoNode,
  gainNode: GainNode,
  filterNode: FilterNode,
  delayNode: DelayNode,
  reverbNode: ReverbNode,
  analyserNode: AnalyserNode,
  outputNode: OutputNode,
};

export default function App() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleAddNode = (type: string) => {
    addNode(type, { x: 100 + Math.random() * 100, y: 100 + Math.random() * 100 });
  };

  return (
    <div className="w-screen h-screen flex bg-gray-900 text-white overflow-hidden">
      {/* Sidebar */}
      <div className={`w-64 bg-gray-800 border-r border-gray-700 flex flex-col transition-all duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-64'}`}>
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h1 className="font-bold text-lg flex items-center gap-2">
            <AudioWaveform className="text-blue-400" />
            Web Synth
          </h1>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <h2 className="text-xs font-semibold text-gray-400 uppercase mb-3">Sources</h2>
          <div className="grid grid-cols-2 gap-2 mb-6">
            <button onClick={() => handleAddNode('oscillatorNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Waves size={18} className="mb-1 text-blue-400" />
              Oscillator
            </button>
            <button onClick={() => handleAddNode('noiseNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Waves size={18} className="mb-1 text-gray-400" />
              Noise
            </button>
            <button onClick={() => handleAddNode('lfoNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors col-span-2">
              <Activity size={18} className="mb-1 text-blue-400" />
              LFO
            </button>
          </div>

          <h2 className="text-xs font-semibold text-gray-400 uppercase mb-3">Processors</h2>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => handleAddNode('gainNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Sliders size={18} className="mb-1 text-green-400" />
              Gain VCA
            </button>
            <button onClick={() => handleAddNode('filterNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Sliders size={18} className="mb-1 text-orange-400" />
              Filter VCF
            </button>
            <button onClick={() => handleAddNode('delayNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Settings size={18} className="mb-1 text-purple-400" />
              Delay
            </button>
            <button onClick={() => handleAddNode('reverbNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <Settings size={18} className="mb-1 text-pink-400" />
              Reverb
            </button>
          </div>

          <h2 className="text-xs font-semibold text-gray-400 uppercase mb-3">Tools</h2>
          <div className="grid grid-cols-1 gap-2">
            <button onClick={() => handleAddNode('analyserNode')} className="flex flex-col items-center justify-center p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs transition-colors">
              <MonitorPlay size={18} className="mb-1 text-teal-400" />
              Oscilloscope
            </button>
          </div>
        </div>
      </div>

      {/* Main Canvas */}
      <div className="flex-1 relative">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="absolute top-4 left-4 z-10 p-2 bg-gray-800 rounded-md shadow-lg border border-gray-700 hover:bg-gray-700"
        >
          <Settings size={20} />
        </button>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          className="bg-gray-900"
        >
          <Background color="#333" gap={16} />
          <Controls className="bg-gray-800 text-white fill-white border-gray-700" />
          <MiniMap className="bg-gray-800 border-gray-700" maskColor="rgba(0,0,0,0.5)" />
        </ReactFlow>
      </div>
    </div>
  );
}
