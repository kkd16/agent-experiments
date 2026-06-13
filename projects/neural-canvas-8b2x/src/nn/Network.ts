import { Matrix } from './Matrix';

export type ActivationType = 'sigmoid' | 'tanh' | 'relu';

export class ActivationFunction {
  func: (x: number) => number;
  dfunc: (y: number) => number; // Derivative expects the OUTPUT of the function (for sigmoid/tanh)

  constructor(type: ActivationType) {
    switch (type) {
      case 'sigmoid':
        this.func = (x) => 1 / (1 + Math.exp(-x));
        this.dfunc = (y) => y * (1 - y);
        break;
      case 'tanh':
        this.func = (x) => Math.tanh(x);
        this.dfunc = (y) => 1 - y * y;
        break;
      case 'relu':
        this.func = (x) => Math.max(0, x);
        this.dfunc = (y) => (y > 0 ? 1 : 0);
        break;
      default:
        this.func = (x) => 1 / (1 + Math.exp(-x));
        this.dfunc = (y) => y * (1 - y);
    }
  }
}

class Layer {
  weights: Matrix;
  bias: Matrix;

  constructor(inputNodes: number, outputNodes: number) {
    this.weights = new Matrix(outputNodes, inputNodes);
    this.weights.randomize();
    this.bias = new Matrix(outputNodes, 1);
    this.bias.randomize();
  }
}

export class NeuralNetwork {
  layers: Layer[];
  activationType: ActivationType;
  activation: ActivationFunction;
  learningRate: number;

  constructor(layerNodes: number[], activationType: ActivationType = 'tanh', learningRate = 0.1) {
    this.layers = [];
    this.activationType = activationType;
    this.activation = new ActivationFunction(activationType);
    this.learningRate = learningRate;

    for (let i = 0; i < layerNodes.length - 1; i++) {
      this.layers.push(new Layer(layerNodes[i], layerNodes[i + 1]));
    }
  }

  predict(inputArray: number[]): number[] {
    let inputs = Matrix.fromArray(inputArray);

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const outputs = Matrix.dot(layer.weights, inputs);
      outputs.add(layer.bias);
      outputs.map(this.activation.func);
      inputs = outputs; // Output of current becomes input for next
    }

    return inputs.toArray();
  }

  train(inputArray: number[], targetArray: number[]): void {
    let inputs = Matrix.fromArray(inputArray);

    // Forward pass
    const layerOutputs: Matrix[] = [inputs]; // Store inputs and all intermediate outputs

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const outputs = Matrix.dot(layer.weights, inputs);
      outputs.add(layer.bias);
      outputs.map(this.activation.func);
      layerOutputs.push(outputs);
      inputs = outputs;
    }

    // Backpropagation
    const targets = Matrix.fromArray(targetArray);
    let layerErrors = Matrix.subtract(targets, layerOutputs[layerOutputs.length - 1]);

    // Go backwards through the layers
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      const outputs = layerOutputs[i + 1];
      const prevOutputs = layerOutputs[i];

      // Calculate gradients
      const gradients = Matrix.map(outputs, this.activation.dfunc);
      gradients.multiply(layerErrors);
      gradients.multiply(this.learningRate);

      // Calculate deltas
      const prevOutputsT = Matrix.transpose(prevOutputs);
      const weightDeltas = Matrix.dot(gradients, prevOutputsT);

      // Adjust weights and bias
      layer.weights.add(weightDeltas);
      layer.bias.add(gradients);

      // Calculate error for previous layer (if not the first layer)
      if (i > 0) {
        const weightsT = Matrix.transpose(layer.weights);
        layerErrors = Matrix.dot(weightsT, layerErrors);
      }
    }
  }
}
