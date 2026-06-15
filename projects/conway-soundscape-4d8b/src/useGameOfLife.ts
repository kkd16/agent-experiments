import { useState, useCallback } from 'react';

export type Grid = boolean[][];

export function createEmptyGrid(rows: number, cols: number): Grid {
  return Array.from({ length: rows }, () => Array(cols).fill(false));
}

export function createRandomGrid(rows: number, cols: number, density = 0.3): Grid {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => Math.random() < density)
  );
}

const neighborOffsets = [
  [0, 1], [0, -1], [1, -1], [-1, 1],
  [1, 1], [-1, -1], [1, 0], [-1, 0]
];

export function useGameOfLife(rows: number, cols: number, onCellBirth: (row: number, col: number) => void) {
  const [grid, setGrid] = useState<Grid>(() => createEmptyGrid(rows, cols));
  const [isRunning, setIsRunning] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [wrapAround, setWrapAround] = useState(false);

  const toggleCell = (r: number, c: number) => {
    setGrid((prevGrid) => {
      const newGrid = prevGrid.map((row, i) =>
        i === r ? row.map((cell, j) => (j === c ? !cell : cell)) : row
      );
      if (newGrid[r][c]) {
        onCellBirth(r, c);
      }
      return newGrid;
    });
  };

  const nextGeneration = useCallback(() => {
    setGrid((currentGrid) => {
      const newGrid = currentGrid.map((rowArr, r) =>
        rowArr.map((cell, c) => {
          let neighbors = 0;
          for (let i = 0; i < neighborOffsets.length; i++) {
            let nr = r + neighborOffsets[i][0];
            let nc = c + neighborOffsets[i][1];

            if (wrapAround) {
              nr = (nr + rows) % rows;
              nc = (nc + cols) % cols;
              neighbors += currentGrid[nr][nc] ? 1 : 0;
            } else {
              if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                neighbors += currentGrid[nr][nc] ? 1 : 0;
              }
            }
          }

          if (cell && (neighbors < 2 || neighbors > 3)) {
            return false;
          } else if (!cell && neighbors === 3) {
            onCellBirth(r, c);
            return true;
          }
          return cell;
        })
      );
      return newGrid;
    });
    setGeneration((g) => g + 1);
  }, [rows, cols, onCellBirth, wrapAround]);

  const clearGrid = () => {
    setGrid(createEmptyGrid(rows, cols));
    setGeneration(0);
    setIsRunning(false);
  };

  const randomizeGrid = () => {
    setGrid(createRandomGrid(rows, cols));
    setGeneration(0);
  };

  return {
    grid,
    isRunning,
    setIsRunning,
    toggleCell,
    nextGeneration,
    clearGrid,
    randomizeGrid,
    generation,
    wrapAround,
    setWrapAround
  };
}
