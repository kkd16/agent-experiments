import { NeuralNetwork } from './nn/Network';
import type { ActivationType } from './nn/Network';

export type Point = { x: number; y: number; label: number };
export type Architecture = {
  hiddenLayers: number[];
  learningRate: number;
  activation: ActivationType;
};

let nn: NeuralNetwork | null = null;
let points: Point[] = [];
let isTraining = false;
let epoch = 0;

export type WorkerMessage =
  | { type: 'INIT'; arch: Architecture }
  | { type: 'SET_POINTS'; points: Point[] }
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'GET_PREDICTIONS'; resolution: number };

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'INIT': {
      // input 2 (x,y), hidden layers, output 1 (probability of class 1)
      const layerNodes = [2, ...msg.arch.hiddenLayers, 1];
      nn = new NeuralNetwork(layerNodes, msg.arch.activation, msg.arch.learningRate);
      epoch = 0;
      self.postMessage({ type: 'EPOCH', epoch, loss: 0 });
      break;
    }

    case 'SET_POINTS': {
      points = msg.points;
      break;
    }

    case 'START': {
      isTraining = true;
      trainLoop();
      break;
    }

    case 'STOP': {
      isTraining = false;
      break;
    }

    case 'GET_PREDICTIONS': {
      if (!nn) return;
      const res = msg.resolution;
      const predictions = new Float32Array(res * res);

      for (let i = 0; i < res; i++) {
        for (let j = 0; j < res; j++) {
          // Map index back to -1 to 1 coordinate space
          const x = (i / res) * 2 - 1;
          const y = (j / res) * 2 - 1;
          const output = nn.predict([x, y]);
          predictions[i * res + j] = output[0];
        }
      }
      // Send back using transferable object for speed
      self.postMessage({ type: 'PREDICTIONS', predictions, resolution: res }, { transfer: [predictions.buffer] });
      break;
    }
  }
};

function trainLoop() {
  if (!isTraining || !nn || points.length === 0) return;

  let totalLoss = 0;

  // Train for a few epochs per loop to balance UI responsiveness and training speed
  for (let e = 0; e < 10; e++) {
    // Shuffle points
    const shuffled = [...points].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i++) {
      const p = shuffled[i];
      const target = [p.label];
      const output = nn.predict([p.x, p.y]);

      // MSE loss calculation
      const loss = Math.pow(target[0] - output[0], 2);
      totalLoss += loss;

      nn.train([p.x, p.y], target);
    }
    epoch++;
  }

  const avgLoss = totalLoss / (10 * points.length);
  self.postMessage({ type: 'EPOCH', epoch, loss: avgLoss });

  // Schedule next iteration
  setTimeout(trainLoop, 0);
}
