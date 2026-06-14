import { useState } from 'react';
import type React from 'react';
import { useStore } from './store';
import { Sliders, RefreshCw, Layers, Clock, Zap, Palette, Box, Sun, Volume2, Activity, Sparkles, Save, Download } from 'lucide-react';

export function Controls() {
  const [newPresetName, setNewPresetName] = useState('');
  const {
    timeScale, setTimeScale,
    noiseScale, setNoiseScale,
    distortion, setDistortion,
    colorShift, setColorShift,
    particlesCount, setParticlesCount,
    bloomIntensity, setBloomIntensity,
    evolutionSpeed, setEvolutionSpeed,
    spiralParticles, setSpiralParticles,
    audioEnabled, toggleAudio,
    wireframe, toggleWireframe,
    reset,
    presets, loadPreset, savePreset
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

        <ControlGroup title="Bloom Intensity" icon={<Sun className="w-4 h-4" />}>
          <input
            type="range" min="0" max="5" step="0.1"
            value={bloomIntensity} onChange={(e) => setBloomIntensity(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{bloomIntensity.toFixed(1)}</span>
            <span>5.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Evolution Speed" icon={<Activity className="w-4 h-4" />}>
          <input
            type="range" min="0" max="5" step="0.1"
            value={evolutionSpeed} onChange={(e) => setEvolutionSpeed(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{evolutionSpeed.toFixed(1)}</span>
            <span>5.0</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Spiral Particles" icon={<Sparkles className="w-4 h-4" />}>
          <input
            type="range" min="0" max="2000" step="10"
            value={spiralParticles} onChange={(e) => setSpiralParticles(parseInt(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0</span>
            <span>{spiralParticles}</span>
            <span>2k</span>
          </div>
        </ControlGroup>

        <ControlGroup title="Shader Complexity" icon={<Layers className="w-4 h-4" />}>
          <input
            type="range" min="0" max="2" step="0.05"
            value={useStore(state => state.shaderComplexity)} onChange={(e) => useStore.getState().setShaderComplexity(parseFloat(e.target.value))}
            className="w-full accent-cyan-400"
          />
          <div className="flex justify-between text-xs text-white/50 mt-1">
            <span>0.0</span>
            <span>{useStore(state => state.shaderComplexity).toFixed(2)}</span>
            <span>2.0</span>
          </div>
        </ControlGroup>

        {/* Presets Section */}
        <div className="pt-4 border-t border-white/10 space-y-3">
          <label className="flex items-center gap-2 text-white/80 font-medium text-sm">
            <Download className="w-4 h-4" />
            Presets
          </label>
          <div className="flex flex-wrap gap-2">
            {Object.keys(presets).map((name) => (
              <button
                key={name}
                onClick={() => loadPreset(name)}
                className="px-2 py-1 text-xs bg-white/10 hover:bg-cyan-500/50 rounded transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Preset Name..."
              className="flex-1 bg-black/50 border border-white/20 rounded px-2 py-1 text-xs outline-none focus:border-cyan-400 transition-colors"
            />
            <button
              onClick={() => {
                if (newPresetName.trim()) {
                  savePreset(newPresetName.trim());
                  setNewPresetName('');
                }
              }}
              className="p-1.5 bg-cyan-600 hover:bg-cyan-500 rounded transition-colors"
              title="Save Preset"
            >
              <Save className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-white/10">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-white/70" />
            <span className="text-white/80">Cinematic Camera</span>
          </div>
          <button
            onClick={() => useStore.getState().setCinematicMode(!useStore.getState().cinematicMode)}
            className={`w-12 h-6 rounded-full p-1 transition-colors ${useStore(state => state.cinematicMode) ? 'bg-cyan-500' : 'bg-white/20'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${useStore(state => state.cinematicMode) ? 'translate-x-6' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-white/10">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-white/70" />
            <span className="text-white/80">Procedural Audio</span>
          </div>
          <button
            onClick={toggleAudio}
            className={`w-12 h-6 rounded-full p-1 transition-colors ${audioEnabled ? 'bg-cyan-500' : 'bg-white/20'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${audioEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
          </button>
        </div>

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