import { useState } from 'react'
import { BoidsCanvas } from './BoidsCanvas'
import { type BoidParams } from './boids'
import './App.css'

function App() {
  const [params, setParams] = useState<BoidParams>({
    separation: 1.5,
    alignment: 1.0,
    cohesion: 1.0,
    visualRange: 50,
    maxSpeed: 4,
    maxForce: 0.05,
    mouseInteraction: 'none',
    mouseRadius: 150
  })

  const [numBoids, setNumBoids] = useState(150)
  const [showControls, setShowControls] = useState(true)

  const handleParamChange = (key: keyof BoidParams, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="app-container">
      <BoidsCanvas params={params} numBoids={numBoids} />

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
            <label>
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
            <label>
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
            <label>
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
            <label>
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
            <label>
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
            <label>
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
            <label>
              Mouse Interaction
              <select
                value={params.mouseInteraction}
                onChange={(e) => setParams(prev => ({ ...prev, mouseInteraction: e.target.value as 'none' | 'attract' | 'repel' }))}
              >
                <option value="none">None</option>
                <option value="attract">Attract</option>
                <option value="repel">Repel</option>
              </select>
            </label>
          </div>

          {params.mouseInteraction !== 'none' && (
            <div className="control-group">
              <label>
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
        </div>
      )}
    </div>
  )
}

export default App
