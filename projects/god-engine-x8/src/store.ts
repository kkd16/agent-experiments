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
  setTimeScale: (val: number) => void;
  setNoiseScale: (val: number) => void;
  setDistortion: (val: number) => void;
  setColorShift: (val: number) => void;
  setParticlesCount: (val: number) => void;
  setBloomIntensity: (val: number) => void;
  setEvolutionSpeed: (val: number) => void;
  setSpiralParticles: (val: number) => void;
  toggleAudio: () => void;
  toggleWireframe: () => void;
  reset: () => void;
}

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
};

export const useStore = create<EngineState>((set) => ({
  ...initialState,
  setTimeScale: (val) => set({ timeScale: val }),
  setNoiseScale: (val) => set({ noiseScale: val }),
  setDistortion: (val) => set({ distortion: val }),
  setColorShift: (val) => set({ colorShift: val }),
  setParticlesCount: (val) => set({ particlesCount: val }),
  setBloomIntensity: (val) => set({ bloomIntensity: val }),
  setEvolutionSpeed: (val) => set({ evolutionSpeed: val }),
  setSpiralParticles: (val) => set({ spiralParticles: val }),
  toggleAudio: () => set((state) => ({ audioEnabled: !state.audioEnabled })),
  toggleWireframe: () => set((state) => ({ wireframe: !state.wireframe })),
  reset: () => set(initialState),
}));