import { useState } from 'react'
import { BoidsCanvas } from './BoidsCanvas'
import { type BoidParams } from './boids'
import './App.css'

const defaultParams: BoidParams = {
  separation: 1.5,
  alignment: 1.0,
  cohesion: 1.0,
  visualRange: 50,
  maxSpeed: 4,
  maxForce: 0.05,
  mouseInteraction: 'none',
  mouseRadius: 150,
  edgeBehavior: 'wrap',
  predatorAvoidance: 2.5,
  predatorVisualRange: 100,
  windX: 0,
  windY: 0,
  boidShape: 'triangle',
  gravity: 0,
  showTrails: false,
  showGrid: false,
  windVariation: false,
  nightMode: true,
  trailDecay: 0.1,
  cameraFollow: false,
  glowEffect: false
}

function App() {
  const [params, setParams] = useState<BoidParams>(defaultParams)

  const [numBoids, setNumBoids] = useState(150)
  const [numPredators, setNumPredators] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [isPaused, setIsPaused] = useState(false)

  const handleDownloadScreenshot = () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const dataURL = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = 'boids-simulation.png';
    a.click();
  }

  const handleResetDefaults = () => {
    setParams(defaultParams);
    setNumBoids(150);
    setNumPredators(0);
  }

  const handleParamChange = (key: keyof BoidParams, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="app-container">
      <BoidsCanvas params={params} numBoids={numBoids} numPredators={numPredators} isPaused={isPaused} />

      <button
        className="toggle-controls"
        onClick={() => setShowControls(!showControls)}
      >
        {showControls ? 'Hide Controls' : 'Show Controls'}
      </button>

      {showControls && (
        <div className="controls-panel">
          <h2>Boids Flocking</h2>

          <div className="control-group">
            <button
              onClick={() => setIsPaused(!isPaused)}
              style={{ width: '100%', padding: '8px', marginBottom: '10px', backgroundColor: isPaused ? '#ef4444' : '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              {isPaused ? '▶ Play' : '⏸ Pause'}
            </button>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Number of Boids: {numBoids}
              <input
                type="range"
                min="10"
                max="500"
                step="10"
                value={numBoids}
                onChange={(e) => setNumBoids(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Number of Predators: {numPredators}
              <input
                type="range"
                min="0"
                max="10"
                step="1"
                value={numPredators}
                onChange={(e) => setNumPredators(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Separation: {params.separation.toFixed(1)}
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                value={params.separation}
                onChange={(e) => handleParamChange('separation', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Alignment: {params.alignment.toFixed(1)}
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                value={params.alignment}
                onChange={(e) => handleParamChange('alignment', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Cohesion: {params.cohesion.toFixed(1)}
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                value={params.cohesion}
                onChange={(e) => handleParamChange('cohesion', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Visual Range: {params.visualRange}
              <input
                type="range"
                min="10"
                max="200"
                step="5"
                value={params.visualRange}
                onChange={(e) => handleParamChange('visualRange', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Max Speed: {params.maxSpeed.toFixed(1)}
              <input
                type="range"
                min="1"
                max="10"
                step="0.5"
                value={params.maxSpeed}
                onChange={(e) => handleParamChange('maxSpeed', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Edge Behavior
              <select
                value={params.edgeBehavior}
                onChange={(e) => setParams(prev => ({ ...prev, edgeBehavior: e.target.value as 'wrap' | 'bounce' }))}
              >
                <option value="wrap">Wrap Around</option>
                <option value="bounce">Bounce</option>
              </select>
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Mouse Interaction
              <select
                value={params.mouseInteraction}
                onChange={(e) => setParams(prev => ({ ...prev, mouseInteraction: e.target.value as 'none' | 'attract' | 'repel' }))}
              >
                <option value="none">None</option>
                <option value="attract">Attract</option>
                <option value="repel">Repel</option>
                <option value="obstacle">Place Obstacle</option>
              </select>
            </label>
          </div>

          {params.mouseInteraction !== 'none' && (
            <div className="control-group">
              <label title="Adjust this simulation parameter">
                Mouse Radius: {params.mouseRadius}
                <input
                  type="range"
                  min="50"
                  max="300"
                  step="10"
                  value={params.mouseRadius}
                  onChange={(e) => handleParamChange('mouseRadius', Number(e.target.value))}
                />
              </label>
            </div>
          )}

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Wind X: {params.windX.toFixed(2)}
              <input
                type="range"
                min="-0.2"
                max="0.2"
                step="0.01"
                value={params.windX}
                onChange={(e) => handleParamChange('windX', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Gravity: {params.gravity.toFixed(2)}
              <input
                type="range"
                min="-0.2"
                max="0.2"
                step="0.01"
                value={params.gravity}
                onChange={(e) => handleParamChange('gravity', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group" style={{ display: 'flex', gap: '10px', flexDirection: 'row' }}>
             <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <input
                  type="checkbox"
                  checked={params.showTrails}
                  onChange={(e) => setParams(prev => ({ ...prev, showTrails: e.target.checked }))}
                />
                Show Trails
             </label>
             <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <input
                  type="checkbox"
                  checked={params.showGrid}
                  onChange={(e) => setParams(prev => ({ ...prev, showGrid: e.target.checked }))}
                />
                Show Grid
             </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Wind Y: {params.windY.toFixed(2)}
              <input
                type="range"
                min="-0.2"
                max="0.2"
                step="0.01"
                value={params.windY}
                onChange={(e) => handleParamChange('windY', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Adjust this simulation parameter">
              Boid Shape
              <select
                value={params.boidShape}
                onChange={(e) => setParams(prev => ({ ...prev, boidShape: e.target.value as 'triangle' | 'circle' | 'arrow' }))}
              >
                <option value="triangle">Triangle</option>
                <option value="circle">Circle</option>
                <option value="arrow">Arrow</option>
              </select>
            </label>
          </div>

          <div className="control-group">
            <label title="Automatically vary wind strength and direction over time">
               <input
                 type="checkbox"
                 checked={params.windVariation}
                 onChange={(e) => setParams(prev => ({ ...prev, windVariation: e.target.checked }))}
               />
               Wind Variation (Time)
            </label>
          </div>

          <div className="control-group">
            <label title="Toggle dark/light theme">
               <input
                 type="checkbox"
                 checked={params.nightMode}
                 onChange={(e) => setParams(prev => ({ ...prev, nightMode: e.target.checked }))}
               />
               Night Mode
            </label>
          </div>

          <div className="control-group">
            <label title="Control how quickly trails fade out">
              Trail Decay: {params.trailDecay.toFixed(2)}
              <input
                type="range"
                min="0.01"
                max="0.5"
                step="0.01"
                value={params.trailDecay}
                onChange={(e) => handleParamChange('trailDecay', Number(e.target.value))}
              />
            </label>
          </div>

          <div className="control-group">
            <label title="Center camera on the leading boid">
               <input
                 type="checkbox"
                 checked={params.cameraFollow}
                 onChange={(e) => setParams(prev => ({ ...prev, cameraFollow: e.target.checked }))}
               />
               Camera Follow Leader
            </label>
          </div>

          <div className="control-group">
            <label title="Apply a visual bloom/glow effect to boids">
               <input
                 type="checkbox"
                 checked={params.glowEffect}
                 onChange={(e) => setParams(prev => ({ ...prev, glowEffect: e.target.checked }))}
               />
               Glow Effect
            </label>
          </div>

          <div className="control-group" style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
             <button onClick={handleResetDefaults} style={{ flex: 1, padding: '8px', cursor: 'pointer' }}>Reset Defaults</button>
             <button onClick={handleDownloadScreenshot} style={{ flex: 1, padding: '8px', cursor: 'pointer', backgroundColor: '#10b981', color: 'white', border: 'none', borderRadius: '4px' }}>Screenshot</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
