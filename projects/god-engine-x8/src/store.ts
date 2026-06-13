import { create } from 'zustand';

interface EngineState {
  timeScale: number;
  noiseScale: number;
  distortion: number;
  colorShift: number;
  particlesCount: number;
  wireframe: boolean;
  setTimeScale: (val: number) => void;
  setNoiseScale: (val: number) => void;
  setDistortion: (val: number) => void;
  setColorShift: (val: number) => void;
  setParticlesCount: (val: number) => void;
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
};

export const useStore = create<EngineState>((set) => ({
  ...initialState,
  setTimeScale: (val) => set({ timeScale: val }),
  setNoiseScale: (val) => set({ noiseScale: val }),
  setDistortion: (val) => set({ distortion: val }),
  setColorShift: (val) => set({ colorShift: val }),
  setParticlesCount: (val) => set({ particlesCount: val }),
  toggleWireframe: () => set((state) => ({ wireframe: !state.wireframe })),
  reset: () => set(initialState),
}));