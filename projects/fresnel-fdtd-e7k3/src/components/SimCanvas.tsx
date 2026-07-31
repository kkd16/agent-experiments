import { useCallback, useRef } from 'react';
import type { SimController } from '../hooks/useSimulation';
import type { ToolState } from './types';
import { MATERIAL_BY_KEY } from '../sim/materials';

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  arrowsRef: React.RefObject<HTMLCanvasElement | null>;
  controller: SimController;
  toolRef: React.RefObject<ToolState>;
  /** bumped whenever sources/probes change; a changed value re-renders markers */
  revision: number;
  onStructureChange: () => void;
}

export function SimCanvas({
  canvasRef,
  arrowsRef,
  controller,
  toolRef,
  revision,
  onStructureChange,
}: Props) {
  const painting = useRef(false);
  const sim = controller.sim;

  const cellFromEvent = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const x = Math.round(fx * sim.nx);
      const y = Math.round(fy * sim.ny);
      if (x < 0 || y < 0 || x >= sim.nx || y >= sim.ny) return null;
      return { x, y };
    },
    [canvasRef, sim],
  );

  const applyPaint = useCallback(
    (x: number, y: number) => {
      const t = toolRef.current;
      if (t.tool === 'paint') {
        const mat = MATERIAL_BY_KEY[t.brushKey]?.material;
        if (mat) controller.sim.paintDisc(x, y, t.brushSize, mat);
        controller.syncMaterials();
      } else if (t.tool === 'erase') {
        controller.sim.paintDisc(x, y, t.brushSize, { epsR: 1, loss: 0, pec: false });
        controller.sim.removeNear(x, y, t.brushSize + 2);
        controller.syncMaterials();
        onStructureChange();
      }
    },
    [controller, toolRef, onStructureChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const cell = cellFromEvent(e);
      if (!cell) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const t = toolRef.current;
      if (t.tool === 'source') {
        controller.sim.addSource({
          x: cell.x,
          y: cell.y,
          kind: t.sourceKind,
          wavelength: t.sourceWavelength,
          amplitude: t.sourceAmplitude,
        });
        onStructureChange();
      } else if (t.tool === 'probe') {
        controller.sim.addProbe(cell.x, cell.y);
        onStructureChange();
      } else {
        painting.current = true;
        applyPaint(cell.x, cell.y);
      }
    },
    [cellFromEvent, controller, toolRef, applyPaint, onStructureChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!painting.current) return;
      const cell = cellFromEvent(e);
      if (cell) applyPaint(cell.x, cell.y);
    },
    [cellFromEvent, applyPaint],
  );

  const endPaint = useCallback(() => {
    painting.current = false;
  }, []);

  const pct = (v: number, span: number) => `${(v / span) * 100}%`;

  return (
    <div className="stage" data-rev={revision}>
      <div className="stage__frame" style={{ aspectRatio: `${sim.nx} / ${sim.ny}` }}>
        <canvas
          ref={canvasRef}
          className="stage__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPaint}
          onPointerLeave={endPaint}
          onPointerCancel={endPaint}
        />
        <canvas ref={arrowsRef} className="stage__arrows" aria-hidden />
        <div className="stage__markers">
          {sim.sources.map((s) => (
            <span
              key={'s' + s.id}
              className="marker marker--source"
              style={{ left: pct(s.x, sim.nx), top: pct(s.y, sim.ny) }}
              title={`source ${s.kind} λ=${s.wavelength}`}
            />
          ))}
          {sim.probes.map((p) => (
            <span
              key={'p' + p.id}
              className="marker marker--probe"
              style={{ left: pct(p.x, sim.nx), top: pct(p.y, sim.ny) }}
              title="probe"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
