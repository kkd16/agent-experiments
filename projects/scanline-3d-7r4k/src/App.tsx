import { useEffect, useMemo, useState } from 'react'
import './App.css'
import Controls from './ui/Controls.tsx'
import { useEngine } from './engine/useEngine.ts'
import type { RenderSettings } from './engine/renderer.ts'
import { DEFAULT_POST } from './render/post.ts'
import { DEFAULT_SSFX } from './render/ssfx.ts'
import { DEFAULT_DENOISE } from './raytrace/denoise.ts'
import { parseOBJ, SAMPLE_OBJ } from './geometry/obj.ts'
import { buildSdf } from './sdf/scenes.ts'
import { marchingCubes, fitMesh } from './sdf/marchingcubes.ts'
import type { SdfInfo } from './sdf/marchingcubes.ts'

const DEFAULT_SETTINGS: RenderSettings = {
  engine: 'raster',
  mode: 'shaded',
  cullBack: false,
  autoRotate: true,
  showGround: true,
  fog: true,
  ambientBoost: 1,
  lightBoost: 1,
  shadows: true,
  shadingModel: 'pbr',
  environment: true,
  normalMaps: true,
  post: DEFAULT_POST,
  ssfx: DEFAULT_SSFX,
  rt: {
    mode: 'path',
    maxBounces: 4,
    softShadows: true,
    sunSoftness: 1.5,
    lightRadius: 0.25,
    aoRadius: 1.5,
    resolutionScale: 0.5,
    compare: false,
    splitPos: 0.5,
    denoise: DEFAULT_DENOISE,
    view: 'denoised',
  },
}

// Scenes that are built for global illumination — selecting one flips to the ray
// tracer so they don't read as a flat rasterized box.
const RT_SCENES = new Set(['cornell', 'reflections'])

export default function App() {
  const [settings, setSettings] = useState<RenderSettings>(DEFAULT_SETTINGS)
  const [preset, setPreset] = useState('showcase')
  const [resolutionScale, setResolutionScale] = useState(1)
  const [objError, setObjError] = useState<string | null>(null)
  const [objInfo, setObjInfo] = useState<string | null>(null)

  // Implicit / SDF subsystem state. The marched mesh lives in the renderer's custom-mesh
  // slot; this panel keeps it fed and reports what marching cubes produced.
  const [sdfPreset, setSdfPreset] = useState('metaballs')
  const [sdfRes, setSdfRes] = useState(48)
  const [sdfSmooth, setSdfSmooth] = useState(0.2)
  const [sdfIso, setSdfIso] = useState(0)
  const [sdfInfo, setSdfInfo] = useState<SdfInfo | null>(null)

  const { canvasRef, containerRef, stats, resetCamera, loadCustomMesh, captureScreenshot } =
    useEngine(settings, preset, resolutionScale)

  // Re-march whenever the field or its sampling changes. Debounced so dragging a slider
  // doesn't fire a full re-mesh on every animation frame.
  useEffect(() => {
    const id = setTimeout(() => {
      const sdf = buildSdf(sdfPreset, sdfSmooth, sdfIso)
      const out = marchingCubes(sdf, sdfRes, 0)
      fitMesh(out.mesh, 2.1)
      loadCustomMesh(out.mesh)
      setSdfInfo({ triangles: out.triangleCount, vertices: out.vertexCount, watertight: out.watertight, ms: out.ms })
    }, 60)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdfPreset, sdfRes, sdfSmooth, sdfIso])

  const choosePreset = (key: string): void => {
    setPreset(key)
    if (RT_SCENES.has(key) && settings.engine !== 'rt') setSettings((s) => ({ ...s, engine: 'rt' }))
  }

  const viewImplicit = (): void => setPreset('implicit')

  const fill = useMemo(() => {
    const px = stats.width * stats.height
    return px > 0 ? stats.pixelsFilled / px : 0
  }, [stats])

  const loadOBJ = (text: string): void => {
    const res = parseOBJ(text)
    if (!res.mesh) {
      setObjError(res.error)
      setObjInfo(null)
      return
    }
    loadCustomMesh(res.mesh)
    setObjError(null)
    setObjInfo(`Loaded ${res.triangles.toLocaleString()} triangles`)
    setPreset('custom')
  }

  return (
    <div className="app">
      <Controls
        settings={settings}
        setSettings={setSettings}
        preset={preset}
        setPreset={choosePreset}
        resolutionScale={resolutionScale}
        setResolutionScale={setResolutionScale}
        onResetCamera={resetCamera}
        onScreenshot={captureScreenshot}
        onLoadOBJ={loadOBJ}
        sampleOBJ={SAMPLE_OBJ}
        objError={objError}
        objInfo={objInfo}
        sdfPreset={sdfPreset}
        setSdfPreset={setSdfPreset}
        sdfRes={sdfRes}
        setSdfRes={setSdfRes}
        sdfSmooth={sdfSmooth}
        setSdfSmooth={setSdfSmooth}
        sdfIso={sdfIso}
        setSdfIso={setSdfIso}
        sdfInfo={sdfInfo}
        onViewImplicit={viewImplicit}
      />

      <main className="stage" ref={containerRef}>
        <canvas ref={canvasRef} className="viewport" />

        <div className="hud">
          <div className="hud-row hud-fps">
            <span className="big">{stats.fps.toFixed(0)}</span>
            <span className="unit">fps</span>
            <span className="hud-sub">{stats.ms.toFixed(1)} ms/frame</span>
          </div>
          {settings.engine === 'rt' ? (
            <dl className="hud-stats">
              <div><dt>Resolution</dt><dd>{stats.width}×{stats.height}</dd></div>
              <div><dt>Triangles</dt><dd>{stats.trianglesIn.toLocaleString()}</dd></div>
              <div><dt>BVH nodes</dt><dd>{stats.rtNodes.toLocaleString()}</dd></div>
              <div><dt>Samples / px</dt><dd>{stats.rtSamples.toLocaleString()}</dd></div>
            </dl>
          ) : (
            <dl className="hud-stats">
              <div><dt>Resolution</dt><dd>{stats.width}×{stats.height}</dd></div>
              <div><dt>Triangles in</dt><dd>{stats.trianglesIn.toLocaleString()}</dd></div>
              <div><dt>Drawn</dt><dd>{stats.trianglesDrawn.toLocaleString()}</dd></div>
              <div><dt>Pixels shaded</dt><dd>{stats.pixelsFilled.toLocaleString()}</dd></div>
              <div><dt>Fill / pixel</dt><dd>{fill.toFixed(2)}×</dd></div>
            </dl>
          )}
        </div>

        <div className="watermark">
          no WebGL · CPU {settings.engine === 'rt' ? 'path tracer' : 'rasterizer'}
        </div>
      </main>
    </div>
  )
}
