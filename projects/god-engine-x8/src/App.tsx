import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stars, Environment } from '@react-three/drei';
import { EffectComposer, Bloom, DepthOfField, Vignette } from '@react-three/postprocessing';
import { ProceduralMesh, ParticleSystem } from './Engine';
import { Evolution } from './Evolution';
import { AudioSystem } from './Audio';
import { Controls } from './Controls';
import { CameraControl } from './CameraControl';
import { useStore } from './store';
import './index.css'; // Ensure tailwind is imported

function Effects() {
  const bloomIntensity = useStore(state => state.bloomIntensity);
  return (
    <EffectComposer>
      <DepthOfField target={[0, 0, 0]} focalLength={0.02} bokehScale={2} height={480} />
      <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.9} height={300} intensity={bloomIntensity} />
      <Vignette eskil={false} offset={0.1} darkness={1.1} />
    </EffectComposer>
  );
}

export default function App() {
  const cinematicMode = useStore(state => state.cinematicMode);

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {/* 3D Canvas */}
      <div className="absolute inset-0">
        <Canvas camera={{ position: [0, 0, 8], fov: 60 }}>
          <color attach="background" args={['#050505']} />
          <ambientLight intensity={0.5} />
          <pointLight position={[10, 10, 10]} intensity={1} />

          <ProceduralMesh />
          <ParticleSystem />
          <Evolution />

          <Effects />
          <CameraControl />

          <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
          <Environment preset="city" />
          {!cinematicMode && (
            <OrbitControls
              enablePan={false}
              maxDistance={20}
              minDistance={3}
              autoRotate
              autoRotateSpeed={0.5}
            />
          )}
        </Canvas>
      </div>

      {/* Audio System */}
      <AudioSystem />

      {/* UI Overlay */}
      <Controls />

      {/* Vignette Overlay for atmosphere */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.8)_100%)] z-0" />
    </div>
  );
}