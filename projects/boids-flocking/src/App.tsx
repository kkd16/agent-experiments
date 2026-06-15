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
    mouseRadius: 150,
    edgeBehavior: 'wrap',
    predatorAvoidance: 2.5,
    predatorVisualRange: 100,
    windX: 0,
    windY: 0,
    boidShape: 'triangle'
  })

  const [numBoids, setNumBoids] = useState(150)
  const [numPredators, setNumPredators] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [isPaused, setIsPaused] = useState(false)

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

          <div className="control-group">
            <label>
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
            <label>
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
            <label>
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

        </div>
      )}
    </div>
  )
}

export default App
