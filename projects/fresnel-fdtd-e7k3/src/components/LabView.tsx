import { useCallback, useEffect, useRef, useState } from 'react';
import { useSimulation } from '../hooks/useSimulation';
import { SimCanvas } from './SimCanvas';
import { ControlPanel } from './ControlPanel';
import { Oscilloscope } from './Oscilloscope';
import type { ToolState } from './types';

export function LabView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arrowsRef = useRef<HTMLCanvasElement>(null);
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);
  // The hook loads a default scene once the renderer exists; bump so markers show.
  const { params, setParams, stats, glError, controller } = useSimulation(
    canvasRef,
    arrowsRef,
    bump,
  );

  const [tool, setTool] = useState<ToolState>({
    tool: 'source',
    brushKey: 'glass',
    brushSize: 8,
    sourceKind: 'sine',
    sourceWavelength: 14,
    sourceAmplitude: 1.0,
  });
  const toolRef = useRef(tool);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  const onSnapshot = useCallback(() => {
    const url = controller.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `fresnel-fdtd-step-${controller.sim.step_}.png`;
    a.click();
  }, [controller]);

  if (glError) {
    return (
      <div className="gl-error">
        <h2>WebGL2 unavailable</h2>
        <p>{glError}</p>
        <p>This lab needs a browser with WebGL2 enabled to render the field.</p>
      </div>
    );
  }

  return (
    <div className="lab">
      <div className="lab__stage-col">
        <SimCanvas
          canvasRef={canvasRef}
          arrowsRef={arrowsRef}
          controller={controller}
          toolRef={toolRef}
          revision={revision}
          onStructureChange={bump}
        />
        <Oscilloscope sim={controller.sim} />
      </div>
      <aside className="lab__panel-col">
        <ControlPanel
          params={params}
          setParams={setParams}
          tool={tool}
          setTool={setTool}
          controller={controller}
          stats={stats}
          onSnapshot={onSnapshot}
          onStructureChange={bump}
        />
      </aside>
    </div>
  );
}
