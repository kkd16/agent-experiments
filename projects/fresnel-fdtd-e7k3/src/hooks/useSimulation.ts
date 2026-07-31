import { useCallback, useEffect, useRef, useState } from 'react';
import { FDTD, type BoundaryMode } from '../sim/FDTD';
import { FieldRenderer } from '../render/FieldRenderer';
import { drawFluxArrows } from '../render/fluxArrows';
import type { ColormapName } from '../sim/colormaps';
import { PRESET_BY_KEY, PRESETS } from '../sim/presets';

export const DEFAULT_NX = 360;
export const DEFAULT_NY = 240;

export interface SimStats {
  step: number;
  fps: number;
  energy: number;
}

export type DisplayMode = 'field' | 'intensity' | 'flux';

export interface SimParams {
  running: boolean;
  substeps: number;
  gain: number;
  colormap: ColormapName;
  matOverlay: number;
  displayMode: DisplayMode;
  boundary: BoundaryMode;
  showArrows: boolean;
}

export interface SimController {
  sim: FDTD;
  /** re-upload materials to the GPU after painting */
  syncMaterials: () => void;
  loadPreset: (key: string) => void;
  reset: () => void;
  resetFields: () => void;
  resetExposure: () => void;
  stepOnce: () => void;
  snapshot: () => string | null;
}

export function useSimulation(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  arrowsRef: React.RefObject<HTMLCanvasElement | null>,
  onReady?: () => void,
) {
  // Stable engine instance (created once, never reassigned).
  const [sim] = useState(() => new FDTD(DEFAULT_NX, DEFAULT_NY));
  const rendererRef = useRef<FieldRenderer | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const [params, setParams] = useState<SimParams>({
    running: true,
    substeps: 3,
    gain: 1.0,
    colormap: 'rdbu',
    matOverlay: 1,
    displayMode: 'field',
    boundary: 'cpml',
    showArrows: true,
  });
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  const [stats, setStats] = useState<SimStats>({ step: 0, fps: 0, energy: 0 });
  const [glError, setGlError] = useState<string | null>(null);

  // Set up renderer + RAF loop once the canvas is mounted.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: FieldRenderer;
    try {
      renderer = new FieldRenderer(canvas, sim.nx, sim.ny);
    } catch (err) {
      // Defer out of the effect body so we don't setState synchronously here.
      const msg = err instanceof Error ? err.message : String(err);
      queueMicrotask(() => setGlError(msg));
      return;
    }
    rendererRef.current = renderer;
    renderer.setColormap(paramsRef.current.colormap);
    // Load the default scene now that the GPU renderer exists.
    sim.reset();
    (PRESET_BY_KEY['lens'] ?? PRESETS[0]).build(sim);
    renderer.updateMaterials(sim.epsR, sim.loss, sim.pec, sim.dispId);
    onReadyRef.current?.();

    // Keep the drawing buffer matched to the on-screen size for crisp output.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ac = arrowsRef.current;
      if (ac && (ac.width !== w || ac.height !== h)) {
        ac.width = w;
        ac.height = h;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsAccum = 0;
    let statTimer = 0;
    let lastColormap = paramsRef.current.colormap;
    let lastMode = paramsRef.current.displayMode;
    let lastBoundary = paramsRef.current.boundary;
    const applyAccum = (mode: DisplayMode) => {
      sim.setAccumulate(mode === 'intensity');
      sim.setAccumulateFlux(mode === 'flux');
    };
    applyAccum(lastMode);
    const arrowsCanvas = arrowsRef.current;
    const arrowCtx = arrowsCanvas ? arrowsCanvas.getContext('2d') : null;
    const clearArrows = () => {
      if (arrowsCanvas && arrowCtx)
        arrowCtx.clearRect(0, 0, arrowsCanvas.width, arrowsCanvas.height);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = now - last;
      last = now;
      const p = paramsRef.current;

      if (p.colormap !== lastColormap) {
        renderer.setColormap(p.colormap);
        lastColormap = p.colormap;
      }
      if (p.boundary !== lastBoundary) {
        sim.setBoundaryMode(p.boundary);
        lastBoundary = p.boundary;
      }
      if (p.displayMode !== lastMode) {
        // Entering an averaged mode starts a fresh exposure.
        if (p.displayMode === 'intensity' || p.displayMode === 'flux') sim.resetExposure();
        applyAccum(p.displayMode);
        if (p.displayMode !== 'flux') clearArrows();
        lastMode = p.displayMode;
      }

      if (p.running) {
        for (let s = 0; s < p.substeps; s++) sim.step();
      }
      if (p.displayMode === 'intensity') {
        renderer.render(sim.ez, p.gain, p.matOverlay, 'intensity', sim.normalizedIntensity());
        clearArrows();
      } else if (p.displayMode === 'flux') {
        const flux = sim.normalizedFlux();
        renderer.render(sim.ez, p.gain * 1.4, p.matOverlay, 'intensity', flux.mag);
        if (arrowsCanvas && arrowCtx && p.showArrows) {
          drawFluxArrows(arrowCtx, arrowsCanvas.width, arrowsCanvas.height, sim.nx, sim.ny, flux);
        } else {
          clearArrows();
        }
      } else {
        renderer.render(sim.ez, p.gain, p.matOverlay, 'field');
        clearArrows();
      }

      // FPS + stats throttled to ~5 Hz.
      frames++;
      fpsAccum += dt;
      statTimer += dt;
      if (statTimer >= 200) {
        const fps = fpsAccum > 0 ? (frames * 1000) / fpsAccum : 0;
        setStats({ step: sim.step_, fps, energy: sim.energy() });
        frames = 0;
        fpsAccum = 0;
        statTimer = 0;
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncMaterials = useCallback(() => {
    rendererRef.current?.updateMaterials(sim.epsR, sim.loss, sim.pec, sim.dispId);
  }, [sim]);

  const loadPreset = useCallback(
    (key: string) => {
      const preset = PRESET_BY_KEY[key];
      if (!preset) return;
      sim.reset();
      preset.build(sim);
      syncMaterials();
    },
    [sim, syncMaterials],
  );

  const reset = useCallback(() => {
    sim.reset();
    syncMaterials();
  }, [sim, syncMaterials]);

  const resetFields = useCallback(() => {
    sim.resetFields();
  }, [sim]);

  const resetExposure = useCallback(() => {
    sim.resetExposure();
  }, [sim]);

  const stepOnce = useCallback(() => {
    sim.step();
  }, [sim]);

  const snapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controller: SimController = {
    sim,
    syncMaterials,
    loadPreset,
    reset,
    resetFields,
    resetExposure,
    stepOnce,
    snapshot,
  };

  return { params, setParams, stats, glError, controller };
}
