import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from './store';

const GRID_SIZE = 30;
const SPACING = 0.5;

export function Evolution() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const evolutionSpeed = useStore(state => state.evolutionSpeed);

  // Game of Life state
  const stateRef = useRef<Uint8Array>(new Uint8Array(GRID_SIZE * GRID_SIZE * GRID_SIZE));
  const nextStateRef = useRef<Uint8Array>(new Uint8Array(GRID_SIZE * GRID_SIZE * GRID_SIZE));
  const timeAccumulator = useRef(0);

  // Initialize random state
  useEffect(() => {
    const state = stateRef.current;
    for (let i = 0; i < state.length; i++) {
      state[i] = Math.random() > 0.85 ? 1 : 0;
    }
  }, []);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    if (!meshRef.current || evolutionSpeed === 0) return;

    timeAccumulator.current += delta * evolutionSpeed;

    if (timeAccumulator.current > 0.2) { // Update frequency
      timeAccumulator.current = 0;

      const state = stateRef.current;
      const nextState = nextStateRef.current;

      // 3D Conway's Game of Life rules (4,5/5)
      for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
          for (let z = 0; z < GRID_SIZE; z++) {
            const idx = x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;

            // Count neighbors
            let neighbors = 0;
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                  if (dx === 0 && dy === 0 && dz === 0) continue;

                  const nx = (x + dx + GRID_SIZE) % GRID_SIZE;
                  const ny = (y + dy + GRID_SIZE) % GRID_SIZE;
                  const nz = (z + dz + GRID_SIZE) % GRID_SIZE;

                  const nIdx = nx + ny * GRID_SIZE + nz * GRID_SIZE * GRID_SIZE;
                  neighbors += state[nIdx];
                }
              }
            }

            // Apply rules
            if (state[idx] === 1) {
              nextState[idx] = (neighbors === 4 || neighbors === 5) ? 1 : 0;
            } else {
              nextState[idx] = (neighbors === 5) ? 1 : 0;
            }
          }
        }
      }

      // Swap buffers
      stateRef.current = nextState;
      nextStateRef.current = state;
    }

    // Update instance matrices
    const currentState = stateRef.current;
    const offset = (GRID_SIZE * SPACING) / 2 - (SPACING / 2);
    let i = 0;

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let z = 0; z < GRID_SIZE; z++) {
          const idx = x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;
          const isAlive = currentState[idx] === 1;

          if (isAlive) {
            dummy.position.set(
              x * SPACING - offset,
              y * SPACING - offset,
              z * SPACING - offset
            );
            // Pulsating effect based on global time
            const scale = 0.2 + Math.sin(timeAccumulator.current * 10 + x + y + z) * 0.1;
            dummy.scale.setScalar(scale);
          } else {
            dummy.scale.setScalar(0); // Hide dead cells
          }

          dummy.updateMatrix();
          meshRef.current.setMatrixAt(i, dummy.matrix);
          i++;
        }
      }
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.rotation.y += 0.001 * evolutionSpeed;
    meshRef.current.rotation.x += 0.0005 * evolutionSpeed;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, GRID_SIZE * GRID_SIZE * GRID_SIZE]}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color="#aa00ff"
        emissive="#ff00aa"
        emissiveIntensity={0.5}
        transparent
        opacity={0.6}
        wireframe
      />
    </instancedMesh>
  );
}
