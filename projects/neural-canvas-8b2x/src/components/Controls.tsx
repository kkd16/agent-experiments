import React from 'react';
import type { Architecture } from '../worker';
import type { ActivationType } from '../nn/Network';

interface ControlsProps {
  arch: Architecture;
  onArchChange: (newArch: Architecture) => void;
  isTraining: boolean;
  onToggleTraining: () => void;
  onResetPoints: () => void;
  epoch: number;
  loss: number;
}

export const Controls: React.FC<ControlsProps> = ({
  arch, onArchChange, isTraining, onToggleTraining, onResetPoints, epoch, loss
}) => {

  const handleActivationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onArchChange({ ...arch, activation: e.target.value as ActivationType });
  };

  const handleLearningRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onArchChange({ ...arch, learningRate: parseFloat(e.target.value) });
  };

  const updateHiddenLayers = (layersStr: string) => {
    const layers = layersStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
    onArchChange({ ...arch, hiddenLayers: layers });
  };

  return (
    <div className="controls">
      <h2>Neural Architecture</h2>

      <div className="control-group">
        <label>Hidden Layers (comma separated nodes):</label>
        <input
          type="text"
          value={arch.hiddenLayers.join(', ')}
          onChange={(e) => updateHiddenLayers(e.target.value)}
          placeholder="e.g. 4, 4"
        />
      </div>

      <div className="control-group">
        <label>Activation Function:</label>
        <select value={arch.activation} onChange={handleActivationChange}>
          <option value="tanh">Tanh</option>
          <option value="sigmoid">Sigmoid</option>
          <option value="relu">ReLU</option>
        </select>
      </div>

      <div className="control-group">
        <label>Learning Rate: {arch.learningRate}</label>
        <input
          type="range"
          min="0.01" max="0.5" step="0.01"
          value={arch.learningRate}
          onChange={handleLearningRateChange}
        />
      </div>

      <div className="metrics">
        <div><strong>Epochs:</strong> {epoch}</div>
        <div><strong>Loss:</strong> {loss.toFixed(4)}</div>
      </div>

      <div className="button-group">
        <button
          className={`btn ${isTraining ? 'btn-stop' : 'btn-start'}`}
          onClick={onToggleTraining}
        >
          {isTraining ? 'Pause Training' : 'Start Training'}
        </button>
        <button className="btn btn-reset" onClick={onResetPoints}>
          Reset Data
        </button>
      </div>
    </div>
  );
};
