import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from './store';

export function CameraControl() {
  const cinematicMode = useStore(state => state.cinematicMode);
  const timeScale = useStore(state => state.timeScale);
  const { camera } = useThree();
  const timeAccumulator = useRef(0);

  // We use a predefined procedural path
  const spline = useMemo(() => {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 5, 10),
      new THREE.Vector3(-8, 2, 5),
      new THREE.Vector3(-10, -3, -2),
      new THREE.Vector3(-2, -8, -8),
      new THREE.Vector3(6, -2, -10),
      new THREE.Vector3(10, 6, -2),
      new THREE.Vector3(5, 8, 5),
    ], true);
  }, []);

  useFrame((_, delta) => {
    if (cinematicMode) {
      timeAccumulator.current += delta * timeScale * 0.05;
      const t = (timeAccumulator.current % 1.0);

      const position = spline.getPointAt(t);
      const lookAtTarget = new THREE.Vector3(0, 0, 0); // Focus on origin

      // Interpolate camera to the curve point smoothly
      camera.position.lerp(position, 0.05);

      // Calculate look direction
      const targetRotation = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(camera.position, lookAtTarget, camera.up)
      );
      camera.quaternion.slerp(targetRotation, 0.05);
    }
  });

  return null;
}
