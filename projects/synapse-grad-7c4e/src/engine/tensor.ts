// A tiny reverse-mode automatic-differentiation engine.
//
// Everything is a 2-D matrix stored row-major in a flat Float64Array. That keeps the
// hot path (matmul + elementwise ops) cache-friendly and fast enough to re-render a
// dense decision-boundary grid every animation frame, while still being a *real* tape:
// every op records a vector-Jacobian-product closure, and `backward()` walks the graph
// in reverse topological order accumulating gradients. No external math libraries — the
// gradients below are hand-derived, and `gradcheck.ts` proves them against finite
// differences right inside the app.

let NEXT_ID = 0;

export class Tensor {
  readonly id: number;
  readonly rows: number;
  readonly cols: number;
  data: Float64Array;
  grad: Float64Array;
  requiresGrad: boolean;
  // Graph bookkeeping (used by backward and the live computation-graph viewer).
  op: string;
  label: string;
  prev: Tensor[];
  backwardFn: (() => void) | null;

  constructor(data: Float64Array, rows: number, cols: number, requiresGrad = false) {
    if (data.length !== rows * cols) {
      throw new Error(`Tensor shape [${rows},${cols}] != data length ${data.length}`);
    }
    this.id = NEXT_ID++;
    this.rows = rows;
    this.cols = cols;
    this.data = data;
    this.grad = new Float64Array(rows * cols);
    this.requiresGrad = requiresGrad;
    this.op = 'leaf';
    this.label = '';
    this.prev = [];
    this.backwardFn = null;
  }

  static zeros(rows: number, cols: number, requiresGrad = false): Tensor {
    return new Tensor(new Float64Array(rows * cols), rows, cols, requiresGrad);
  }

  static from(values: number[][], requiresGrad = false): Tensor {
    const rows = values.length;
    const cols = rows > 0 ? values[0].length : 0;
    const data = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) data[r * cols + c] = values[r][c];
    }
    return new Tensor(data, rows, cols, requiresGrad);
  }

  static fromFlat(data: Float64Array, rows: number, cols: number, requiresGrad = false): Tensor {
    return new Tensor(data, rows, cols, requiresGrad);
  }

  named(label: string): Tensor {
    this.label = label;
    return this;
  }

  get size(): number {
    return this.rows * this.cols;
  }

  zeroGrad(): void {
    this.grad.fill(0);
  }

  clone(): Tensor {
    return new Tensor(this.data.slice(), this.rows, this.cols, this.requiresGrad);
  }

  // ---- forward ops (each records a backward closure) -------------------------------

  // Matrix multiply: [R,K] x [K,C] -> [R,C].
  matmul(other: Tensor): Tensor {
    if (this.cols !== other.rows) {
      throw new Error(`matmul shape mismatch [${this.rows},${this.cols}] x [${other.rows},${other.cols}]`);
    }
    const R = this.rows;
    const K = this.cols;
    const C = other.cols;
    const out = Tensor.zeros(R, C);
    const a = this.data;
    const b = other.data;
    const o = out.data;
    for (let i = 0; i < R; i++) {
      for (let k = 0; k < K; k++) {
        const aik = a[i * K + k];
        if (aik === 0) continue;
        const bRow = k * C;
        const oRow = i * C;
        for (let j = 0; j < C; j++) o[oRow + j] += aik * b[bRow + j];
      }
    }
    out.op = 'matmul';
    out.prev = [this, other];
    out.backwardFn = () => {
      const g = out.grad;
      // dA = dY @ B^T
      if (this.requiresGrad || this.op !== 'leaf') {
        const ga = this.grad;
        for (let i = 0; i < R; i++) {
          for (let j = 0; j < C; j++) {
            const gij = g[i * C + j];
            if (gij === 0) continue;
            const bRow = j; // B^T row j == B col j
            for (let k = 0; k < K; k++) ga[i * K + k] += gij * b[k * C + bRow];
          }
        }
      }
      // dB = A^T @ dY
      if (other.requiresGrad || other.op !== 'leaf') {
        const gb = other.grad;
        for (let i = 0; i < R; i++) {
          for (let k = 0; k < K; k++) {
            const aik = a[i * K + k];
            if (aik === 0) continue;
            const gRow = i * C;
            for (let j = 0; j < C; j++) gb[k * C + j] += aik * g[gRow + j];
          }
        }
      }
    };
    return out;
  }

  // Add. Supports same-shape and row-broadcast (other has 1 row, e.g. a bias [1,C]).
  add(other: Tensor): Tensor {
    if (this.cols !== other.cols || (other.rows !== this.rows && other.rows !== 1)) {
      throw new Error(`add shape mismatch [${this.rows},${this.cols}] + [${other.rows},${other.cols}]`);
    }
    const broadcast = other.rows === 1 && this.rows !== 1;
    const out = this.clone();
    out.requiresGrad = false;
    out.grad = new Float64Array(this.size);
    const o = out.data;
    const b = other.data;
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        o[i * this.cols + j] += broadcast ? b[j] : b[i * this.cols + j];
      }
    }
    out.op = broadcast ? 'add+bias' : 'add';
    out.prev = [this, other];
    out.backwardFn = () => {
      const g = out.grad;
      const ga = this.grad;
      for (let i = 0; i < g.length; i++) ga[i] += g[i];
      const gb = other.grad;
      if (broadcast) {
        for (let i = 0; i < this.rows; i++) {
          for (let j = 0; j < this.cols; j++) gb[j] += g[i * this.cols + j];
        }
      } else {
        for (let i = 0; i < g.length; i++) gb[i] += g[i];
      }
    };
    return out;
  }

  scale(s: number): Tensor {
    const out = Tensor.zeros(this.rows, this.cols);
    const o = out.data;
    const a = this.data;
    for (let i = 0; i < a.length; i++) o[i] = a[i] * s;
    out.op = 'scale';
    out.prev = [this];
    out.backwardFn = () => {
      const g = out.grad;
      const ga = this.grad;
      for (let i = 0; i < g.length; i++) ga[i] += s * g[i];
    };
    return out;
  }

  relu(): Tensor {
    const out = Tensor.zeros(this.rows, this.cols);
    const o = out.data;
    const a = this.data;
    for (let i = 0; i < a.length; i++) o[i] = a[i] > 0 ? a[i] : 0;
    out.op = 'relu';
    out.prev = [this];
    out.backwardFn = () => {
      const g = out.grad;
      const ga = this.grad;
      for (let i = 0; i < g.length; i++) if (a[i] > 0) ga[i] += g[i];
    };
    return out;
  }

  tanh(): Tensor {
    const out = Tensor.zeros(this.rows, this.cols);
    const o = out.data;
    const a = this.data;
    for (let i = 0; i < a.length; i++) o[i] = Math.tanh(a[i]);
    out.op = 'tanh';
    out.prev = [this];
    out.backwardFn = () => {
      const g = out.grad;
      const ga = this.grad;
      for (let i = 0; i < g.length; i++) ga[i] += (1 - o[i] * o[i]) * g[i];
    };
    return out;
  }

  sigmoid(): Tensor {
    const out = Tensor.zeros(this.rows, this.cols);
    const o = out.data;
    const a = this.data;
    for (let i = 0; i < a.length; i++) o[i] = 1 / (1 + Math.exp(-a[i]));
    out.op = 'sigmoid';
    out.prev = [this];
    out.backwardFn = () => {
      const g = out.grad;
      const ga = this.grad;
      for (let i = 0; i < g.length; i++) ga[i] += o[i] * (1 - o[i]) * g[i];
    };
    return out;
  }

  // ---- backward --------------------------------------------------------------------

  // Walk the graph in reverse topological order. The starting tensor is assumed to be a
  // scalar loss; its grad is seeded to 1 unless already set.
  backward(): void {
    const topo: Tensor[] = [];
    const seen = new Set<number>();
    const build = (t: Tensor) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      for (const p of t.prev) build(p);
      topo.push(t);
    };
    build(this);
    // zero all grads in the graph, then seed.
    for (const t of topo) t.grad.fill(0);
    if (this.size === 1) this.grad[0] = 1;
    else this.grad.fill(1);
    for (let i = topo.length - 1; i >= 0; i--) {
      const fn = topo[i].backwardFn;
      if (fn) fn();
    }
  }
}
