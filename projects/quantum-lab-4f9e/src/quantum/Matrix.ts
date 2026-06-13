import { Complex, C } from './Complex';

export type Matrix = Complex[][];

export function matMul(A: Matrix, B: Matrix): Matrix {
  const n = A.length;
  const m = B[0].length;
  const k = B.length;
  const result: Matrix = Array.from({ length: n }, () => Array.from({ length: m }, () => C(0)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      for (let l = 0; l < k; l++) {
        result[i][j] = result[i][j].add(A[i][l].mul(B[l][j]));
      }
    }
  }
  return result;
}

export function tensorProduct(A: Matrix, B: Matrix): Matrix {
  const ra = A.length, ca = A[0].length;
  const rb = B.length, cb = B[0].length;
  const result: Matrix = Array.from({ length: ra * rb }, () =>
    Array.from({ length: ca * cb }, () => C(0))
  );
  for (let i = 0; i < ra; i++) {
    for (let j = 0; j < ca; j++) {
      for (let k = 0; k < rb; k++) {
        for (let l = 0; l < cb; l++) {
          result[i * rb + k][j * cb + l] = A[i][j].mul(B[k][l]);
        }
      }
    }
  }
  return result;
}

export function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? C(1) : C(0)))
  );
}

export function matVecMul(M: Matrix, v: Complex[]): Complex[] {
  const n = M.length;
  const result = Array.from({ length: n }, () => C(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < v.length; j++) {
      result[i] = result[i].add(M[i][j].mul(v[j]));
    }
  }
  return result;
}

export function dagger(M: Matrix): Matrix {
  return M[0].map((_, j) => M.map((row) => row[j].conj()));
}
