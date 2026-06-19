import { useMemo, useState } from 'react'
import './App.css'
import Controls from './ui/Controls.tsx'
import { useEngine } from './engine/useEngine.ts'
import type { RenderSettings } from './engine/renderer.ts'
import { DEFAULT_POST } from './render/post.ts'
import { parseOBJ, SAMPLE_OBJ } from './geometry/obj.ts'

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

  const { canvasRef, containerRef, stats, resetCamera, loadCustomMesh, captureScreenshot } =
    useEngine(settings, preset, resolutionScale)

  const choosePreset = (key: string): void => {
    setPreset(key)
    if (RT_SCENES.has(key) && settings.engine !== 'rt') setSettings((s) => ({ ...s, engine: 'rt' }))
  }

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
