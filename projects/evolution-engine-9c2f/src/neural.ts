// Activation functions
export function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

export function relu(x: number): number {
    return Math.max(0, x);
}

export function tanh(x: number): number {
    return Math.tanh(x);
}

export class NeuralNetwork {
    inputNodes: number;
    hiddenNodes: number;
    outputNodes: number;

    // Weights and biases as flat arrays for simplicity and speed
    weightsIH: number[][]; // Input to Hidden
    weightsHO: number[][]; // Hidden to Output
    biasH: number[];
    biasO: number[];

    constructor(inputNodes: number, hiddenNodes: number, outputNodes: number) {
        this.inputNodes = inputNodes;
        this.hiddenNodes = hiddenNodes;
        this.outputNodes = outputNodes;

        this.weightsIH = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weightsHO = this.createMatrix(this.outputNodes, this.hiddenNodes);

        this.biasH = this.createArray(this.hiddenNodes);
        this.biasO = this.createArray(this.outputNodes);

        this.randomize();
    }

    createMatrix(rows: number, cols: number): number[][] {
        const result: number[][] = [];
        for (let i = 0; i < rows; i++) {
            result.push(new Array(cols).fill(0));
        }
        return result;
    }

    createArray(size: number): number[] {
        return new Array(size).fill(0);
    }

    randomize() {
        for (let i = 0; i < this.weightsIH.length; i++) {
            for (let j = 0; j < this.weightsIH[i].length; j++) {
                this.weightsIH[i][j] = Math.random() * 2 - 1; // -1 to 1
            }
        }

        for (let i = 0; i < this.weightsHO.length; i++) {
            for (let j = 0; j < this.weightsHO[i].length; j++) {
                this.weightsHO[i][j] = Math.random() * 2 - 1;
            }
        }

        for (let i = 0; i < this.biasH.length; i++) {
            this.biasH[i] = Math.random() * 2 - 1;
        }

        for (let i = 0; i < this.biasO.length; i++) {
            this.biasO[i] = Math.random() * 2 - 1;
        }
    }

    feedForward(inputArray: number[]): number[] {
        if (inputArray.length !== this.inputNodes) {
            throw new Error('Input length must match input nodes');
        }

        // Input to Hidden
        const hiddenOutputs: number[] = new Array(this.hiddenNodes);
        for (let i = 0; i < this.hiddenNodes; i++) {
            let sum = 0;
            for (let j = 0; j < this.inputNodes; j++) {
                sum += inputArray[j] * this.weightsIH[i][j];
            }
            sum += this.biasH[i];
            hiddenOutputs[i] = tanh(sum); // Use tanh for hidden layer activation (-1 to 1)
        }

        // Hidden to Output
        const outputs: number[] = new Array(this.outputNodes);
        for (let i = 0; i < this.outputNodes; i++) {
            let sum = 0;
            for (let j = 0; j < this.hiddenNodes; j++) {
                sum += hiddenOutputs[j] * this.weightsHO[i][j];
            }
            sum += this.biasO[i];
            // Output node activation depends on the use case. Using tanh for movement direction/speed mapped to -1 to 1
            outputs[i] = tanh(sum);
        }

        return outputs;
    }

    clone(): NeuralNetwork {
        const nn = new NeuralNetwork(this.inputNodes, this.hiddenNodes, this.outputNodes);

        for (let i = 0; i < this.weightsIH.length; i++) {
            for (let j = 0; j < this.weightsIH[i].length; j++) {
                nn.weightsIH[i][j] = this.weightsIH[i][j];
            }
        }

        for (let i = 0; i < this.weightsHO.length; i++) {
            for (let j = 0; j < this.weightsHO[i].length; j++) {
                nn.weightsHO[i][j] = this.weightsHO[i][j];
            }
        }

        for (let i = 0; i < this.biasH.length; i++) {
            nn.biasH[i] = this.biasH[i];
        }

        for (let i = 0; i < this.biasO.length; i++) {
            nn.biasO[i] = this.biasO[i];
        }

        return nn;
    }

    mutate(rate: number) {
        const mutateFunc = (val: number) => {
            if (Math.random() < rate) {
                // Randomly add or subtract a bit to mutate
                return val + (Math.random() * 0.5 - 0.25);
            }
            return val;
        };

        for (let i = 0; i < this.weightsIH.length; i++) {
            for (let j = 0; j < this.weightsIH[i].length; j++) {
                this.weightsIH[i][j] = mutateFunc(this.weightsIH[i][j]);
            }
        }

        for (let i = 0; i < this.weightsHO.length; i++) {
            for (let j = 0; j < this.weightsHO[i].length; j++) {
                this.weightsHO[i][j] = mutateFunc(this.weightsHO[i][j]);
            }
        }

        for (let i = 0; i < this.biasH.length; i++) {
            this.biasH[i] = mutateFunc(this.biasH[i]);
        }

        for (let i = 0; i < this.biasO.length; i++) {
            this.biasO[i] = mutateFunc(this.biasO[i]);
        }
    }

    // Simple crossover between this network and a partner
    crossover(partner: NeuralNetwork): NeuralNetwork {
        const child = new NeuralNetwork(this.inputNodes, this.hiddenNodes, this.outputNodes);

        // Crossover weights
        for (let i = 0; i < this.weightsIH.length; i++) {
            for (let j = 0; j < this.weightsIH[i].length; j++) {
                child.weightsIH[i][j] = Math.random() > 0.5 ? this.weightsIH[i][j] : partner.weightsIH[i][j];
            }
        }

        for (let i = 0; i < this.weightsHO.length; i++) {
            for (let j = 0; j < this.weightsHO[i].length; j++) {
                child.weightsHO[i][j] = Math.random() > 0.5 ? this.weightsHO[i][j] : partner.weightsHO[i][j];
            }
        }

        // Crossover biases
        for (let i = 0; i < this.biasH.length; i++) {
            child.biasH[i] = Math.random() > 0.5 ? this.biasH[i] : partner.biasH[i];
        }

        for (let i = 0; i < this.biasO.length; i++) {
            child.biasO[i] = Math.random() > 0.5 ? this.biasO[i] : partner.biasO[i];
        }

        return child;
    }
}
