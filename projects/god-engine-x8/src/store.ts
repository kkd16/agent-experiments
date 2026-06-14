import { create } from 'zustand';

interface EngineState {
  timeScale: number;
  noiseScale: number;
  distortion: number;
  colorShift: number;
  particlesCount: number;
  wireframe: boolean;
  bloomIntensity: number;
  audioEnabled: boolean;
  evolutionSpeed: number;
  spiralParticles: number;
  cinematicMode: boolean;
  shaderComplexity: number;
  presets: Record<string, Partial<EngineState>>;

  setTimeScale: (val: number) => void;
  setNoiseScale: (val: number) => void;
  setDistortion: (val: number) => void;
  setColorShift: (val: number) => void;
  setParticlesCount: (val: number) => void;
  setBloomIntensity: (val: number) => void;
  setEvolutionSpeed: (val: number) => void;
  setSpiralParticles: (val: number) => void;
  setCinematicMode: (val: boolean) => void;
  setShaderComplexity: (val: number) => void;
  toggleAudio: () => void;
  toggleWireframe: () => void;
  reset: () => void;
  savePreset: (name: string) => void;
  loadPreset: (name: string) => void;
}

const defaultPresets = {
  'Calm': { timeScale: 0.5, noiseScale: 1.0, distortion: 0.1, colorShift: 0.2, particlesCount: 1000, bloomIntensity: 0.8, evolutionSpeed: 0.5, spiralParticles: 200, shaderComplexity: 0.2 },
  'Chaos': { timeScale: 3.0, noiseScale: 4.0, distortion: 1.5, colorShift: 0.9, particlesCount: 5000, bloomIntensity: 3.0, evolutionSpeed: 4.0, spiralParticles: 1500, shaderComplexity: 1.0 },
  'Evolutionary': { timeScale: 1.0, noiseScale: 2.0, distortion: 0.5, colorShift: 0.5, particlesCount: 2000, bloomIntensity: 1.5, evolutionSpeed: 2.5, spiralParticles: 800, shaderComplexity: 0.6 }
};

const getSavedPresets = () => {
  try {
    const saved = localStorage.getItem('god-engine-presets');
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.warn("Could not read presets from localStorage", e);
  }
  return {};
};

const initialState = {
  timeScale: 1.0,
  noiseScale: 1.5,
  distortion: 0.4,
  colorShift: 0.5,
  particlesCount: 2000,
  wireframe: false,
  bloomIntensity: 1.5,
  audioEnabled: false,
  evolutionSpeed: 1.0,
  spiralParticles: 500,
  cinematicMode: false,
  shaderComplexity: 0.5,
  presets: { ...defaultPresets, ...getSavedPresets() },
};

export const useStore = create<EngineState>((set, get) => ({
  ...initialState,
  setTimeScale: (val) => set({ timeScale: val }),
  setNoiseScale: (val) => set({ noiseScale: val }),
  setDistortion: (val) => set({ distortion: val }),
  setColorShift: (val) => set({ colorShift: val }),
  setParticlesCount: (val) => set({ particlesCount: val }),
  setBloomIntensity: (val) => set({ bloomIntensity: val }),
  setEvolutionSpeed: (val) => set({ evolutionSpeed: val }),
  setSpiralParticles: (val) => set({ spiralParticles: val }),
  setCinematicMode: (val) => set({ cinematicMode: val }),
  setShaderComplexity: (val) => set({ shaderComplexity: val }),
  toggleAudio: () => set((state) => ({ audioEnabled: !state.audioEnabled })),
  toggleWireframe: () => set((state) => ({ wireframe: !state.wireframe })),
  reset: () => set(initialState),
  savePreset: (name) => {
    const state = get();
    const preset = {
      timeScale: state.timeScale,
      noiseScale: state.noiseScale,
      distortion: state.distortion,
      colorShift: state.colorShift,
      particlesCount: state.particlesCount,
      bloomIntensity: state.bloomIntensity,
      evolutionSpeed: state.evolutionSpeed,
      spiralParticles: state.spiralParticles,
      shaderComplexity: state.shaderComplexity,
    };
    const newPresets = { ...state.presets, [name]: preset };
    set({ presets: newPresets });
    try {
      const toSave = { ...newPresets };
      for (const k of Object.keys(defaultPresets)) delete toSave[k];
      localStorage.setItem('god-engine-presets', JSON.stringify(toSave));
    } catch (e) {
      console.warn("Could not save preset to localStorage", e);
    }
  },
  loadPreset: (name) => {
    const state = get();
    const preset = state.presets[name];
    if (preset) {
      set(preset);
    }
  }
}));
