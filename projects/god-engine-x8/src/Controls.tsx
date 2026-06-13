import type React from 'react';
import { useStore } from './store';
import { Sliders, RefreshCw, Layers, Clock, Zap, Palette, Box } from 'lucide-react';

export function Controls() {
  const {
    timeScale, setTimeScale,
    noiseScale, setNoiseScale,
    distortion, setDistortion,
    colorShift, setColorShift,
    particlesCount, setParticlesCount,
    wireframe, toggleWireframe,
    reset
  } = useStore();

  return (
    <div className="absolute top-0 right-0 w-80 h-full bg-black/60 backdrop-blur-md border-l border-white/10 p-6 flex flex-col overflow-y-auto z-10 text-sm">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-white/10">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Zap className="w-5 h-5 text-cyan-400" />
          God Engine x8
        </h1>
        <button
          onClick={reset}
          className="p-2 hover:bg-white/10 rounded-full transition-colors"
          title="Reset Parameters"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-6 flex-1">
        <ControlGroup title="Time Scale" icon={<Clock className="w-4 h-4" />}>
          <input
            type="range" min="0" max="5" step="0.1"
            value={timeScale} onChange={(e) => setTimeScale(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{timeScale.toFixed(1)}</span>
            <span>5.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Topology Noise" icon={<Layers className="w-4 h-4" />}>
          <input
            type="range" min="0.1" max="5" step="0.1"
            value={noiseScale} onChange={(e) => setNoiseScale(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.1</span>
            <span>{noiseScale.toFixed(1)}</span>
            <span>5.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Distortion Power" icon={<Sliders className="w-4 h-4" />}>
          <input
            type="range" min="0" max="2" step="0.05"
            value={distortion} onChange={(e) => setDistortion(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{distortion.toFixed(2)}</span>
            <span>2.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Chromatic Shift" icon={<Palette className="w-4 h-4" />}>
          <input
            type="range" min="0" max="1" step="0.01"
            value={colorShift} onChange={(e) => setColorShift(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{colorShift.toFixed(2)}</span>
            <span>1.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Particle Density" icon={<Zap className="w-4 h-4" />}>
          <input
            type="range" min="0" max="10000" step="100"
            value={particlesCount} onChange={(e) => setParticlesCount(parseInt(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0</span>
            <span>{particlesCount}</span>
            <span>10k</span>
          </div>
        </ControlGroup>

        <div className="flex items-center justify-between pt-4 border-t border-white/10">
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-white/70" />
            <span className="text-white/80">Wireframe Mode</span>
          </div>
          <button
            onClick={toggleWireframe}
            className={`w-12 h-6 rounded-full p-1 transition-colors ${wireframe ? 'bg-cyan-500' : 'bg-white/20'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${wireframe ? 'translate-x-6' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      <div className="mt-8 text-xs text-white/30 text-center">
        God Engine x8 - Agent v1.0
      </div>
    </div>
  );
}

function ControlGroup({ title, icon, children }: { title: string, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-white/80 font-medium">
        {icon}
        {title}
      </label>
      {children}
    </div>
  );
}