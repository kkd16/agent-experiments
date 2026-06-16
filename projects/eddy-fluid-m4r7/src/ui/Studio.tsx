// Studio.tsx — the interactive fluid studio: canvas + engine + controls.

import { useEffect, useRef, useState } from 'react';
import { FluidEngine, type Stats } from '../sim/engine';
import { Controls } from './Controls';
import { Hud } from './Hud';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from '../state/settings';

export function Studio() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<FluidEngine | null>(null);
  const lastPtr = useRef<{ x: number; y: number } | null>(null);

  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    return { ...DEFAULT_SETTINGS, ...s };
  });
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  // Create the engine once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new FluidEngine(canvas, settings);
    engine.onStats = setStats;
    engineRef.current = engine;
    // Seed the saved scene without clobbering the user's stored params.
    engine.loadScene(settings.sceneId, false);
    engine.start();
    return () => {
      engine.stop();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the engine in sync with settings + persist them.
  useEffect(() => {
    engineRef.current?.setSettings(settings);
    saveSettings(settings);
  }, [settings]);

  // Size the canvas backing buffer to its (square) CSS box for crisp output.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ro = new ResizeObserver(() => {
      const side = Math.max(64, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(side * dpr);
      canvas.height = Math.floor(side * dpr);
      canvas.style.width = `${side}px`;
      canvas.style.height = `${side}px`;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));
  const patchParam = (p: Partial<Settings['params']>) =>
    setSettings((s) => ({ ...s, params: { ...s.params, ...p } }));

  const onScene = (id: string) => {
    const eng = engineRef.current;
    if (!eng) return;
    const update = eng.loadScene(id, true);
    if (update) setSettings((s) => ({ ...s, ...update }));
  };

  const togglePause = () => {
    setPaused((p) => {
      const next = !p;
      engineRef.current?.setPaused(next);
      return next;
    });
  };

  // --- Pointer plumbing ---------------------------------------------------
  const toNorm = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const n = toNorm(e);
    lastPtr.current = n;
    engineRef.current?.pointerDown(n.x, n.y);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!lastPtr.current) return;
    const n = toNorm(e);
    const dx = n.x - lastPtr.current.x;
    const dy = n.y - lastPtr.current.y;
    lastPtr.current = n;
    engineRef.current?.pointerMove(n.x, n.y, dx, dy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    lastPtr.current = null;
    engineRef.current?.pointerUp();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'r') {
        engineRef.current?.reset();
      } else if (e.key === 'c') {
        engineRef.current?.clearDye();
      } else if (e.key === '.' && paused) {
        engineRef.current?.requestStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused]);

  return (
    <div className="studio">
      <div className="stage" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`fluid-canvas tool-${settings.tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
        <Hud stats={stats} />
        <div className="stage-hint">
          {settings.tool === 'dye'
            ? 'Drag to inject dye & stir the fluid'
            : settings.tool === 'wall'
              ? 'Drag to draw solid walls'
              : 'Drag to erase walls'}
          {'  ·  space = pause · r = reset · c = clear dye'}
        </div>
      </div>
      <Controls
        settings={settings}
        paused={paused}
        onChange={patch}
        onParam={patchParam}
        onScene={onScene}
        onReset={() => engineRef.current?.reset()}
        onClearDye={() => engineRef.current?.clearDye()}
        onClearWalls={() => engineRef.current?.clearWalls()}
        onTogglePause={togglePause}
        onStep={() => engineRef.current?.requestStep()}
      />
    </div>
  );
}
