import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Icosahedron, Points, PointMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from './store';

const vertexShader = `
  uniform float uTime;
  uniform float uNoiseScale;
  uniform float uDistortion;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vPosition;

  // Simplex 3D Noise
  // by Ian McEwan, Ashima Arts
  vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

  float snoise(vec3 v){
    const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
    const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy) );
    vec3 x0 = v - i + dot(i, C.xxx) ;

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min( g.xyz, l.zxy );
    vec3 i2 = max( g.xyz, l.zxy );

    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

    i = mod(i, 289.0 );
    vec4 p = permute( permute( permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

    float n_ = 1.0/7.0;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_ );

    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4( x.xy, y.xy );
    vec4 b1 = vec4( x.zw, y.zw );

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                  dot(p2,x2), dot(p3,x3) ) );
  }

  void main() {
    vUv = uv;
    vNormal = normal;

    float noise = snoise(position * uNoiseScale + uTime * 0.5);
    vec3 newPosition = position + normal * noise * uDistortion;
    vPosition = newPosition;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform float uColorShift;
  uniform float uShaderComplexity;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vPosition;

  // Pseudo-random function
  float random(vec3 st) {
      return fract(sin(dot(st.xyz, vec3(12.9898, 78.233, 45.164))) * 43758.5453123);
  }

  // 3D Value Noise
  float noise3D(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float n = mix(
          mix(mix(random(i + vec3(0,0,0)), random(i + vec3(1,0,0)), f.x),
              mix(random(i + vec3(0,1,0)), random(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(random(i + vec3(0,0,1)), random(i + vec3(1,0,1)), f.x),
              mix(random(i + vec3(0,1,1)), random(i + vec3(1,1,1)), f.x), f.y), f.z
      );
      return n;
  }

  void main() {
    // Advanced Shader Materials Logic
    vec3 color1 = vec3(0.1, 0.8, 0.9); // Cyan
    vec3 color2 = vec3(0.9, 0.1, 0.8); // Magenta
    vec3 color3 = vec3(0.8, 0.9, 0.1); // Yellow

    float t = uTime * 0.5;
    float complexNoise = noise3D(vPosition * (3.0 + uShaderComplexity * 5.0) + t) * uShaderComplexity;

    float noise1 = sin(vPosition.x * 2.0 + t) * 0.5 + 0.5;
    float noise2 = cos(vPosition.y * 3.0 - t * 0.5) * 0.5 + 0.5;
    float noise3 = sin(vPosition.z * 1.5 + t * 1.2) * 0.5 + 0.5;

    // Distort noise fields with complexity
    noise1 += complexNoise * 0.5;
    noise2 -= complexNoise * 0.3;

    vec3 finalColor = mix(
      mix(color1, color2, clamp(noise1 + uColorShift * 0.5, 0.0, 1.0)),
      color3,
      clamp(noise2 * noise3, 0.0, 1.0)
    );

    // Fresnel effect
    vec3 viewDirection = normalize(cameraPosition - vPosition);
    float fresnel = dot(viewDirection, vNormal);
    fresnel = clamp(1.0 - fresnel, 0.0, 1.0);
    fresnel = pow(fresnel, 3.0) * (0.5 + uShaderComplexity);

    // Add lighting and fresnel glow
    float light = dot(vNormal, normalize(vec3(1.0, 1.0, 1.0))) * 0.5 + 0.5;

    // Specular highlight
    vec3 halfVector = normalize(normalize(vec3(1.0, 1.0, 1.0)) + viewDirection);
    float specular = pow(max(dot(vNormal, halfVector), 0.0), 32.0) * uShaderComplexity;

    vec3 outColor = finalColor * light + vec3(fresnel) + vec3(specular);

    gl_FragColor = vec4(outColor, 1.0);
  }
`;

export function ProceduralMesh() {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const timeScale = useStore(state => state.timeScale);
  const noiseScale = useStore(state => state.noiseScale);
  const distortion = useStore(state => state.distortion);
  const colorShift = useStore(state => state.colorShift);
  const shaderComplexity = useStore(state => state.shaderComplexity);
  const wireframe = useStore(state => state.wireframe);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uNoiseScale: { value: noiseScale },
      uDistortion: { value: distortion },
      uColorShift: { value: colorShift },
      uShaderComplexity: { value: shaderComplexity },
    }),
    [noiseScale, distortion, colorShift, shaderComplexity]
  );

  useFrame(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value += 0.01 * timeScale;
      materialRef.current.uniforms.uNoiseScale.value = noiseScale;
      materialRef.current.uniforms.uDistortion.value = distortion;
      materialRef.current.uniforms.uColorShift.value = colorShift;
      materialRef.current.uniforms.uShaderComplexity.value = shaderComplexity;
    }
    if (meshRef.current) {
      meshRef.current.rotation.x += 0.002 * timeScale;
      meshRef.current.rotation.y += 0.003 * timeScale;
    }
  });

  return (
    <Icosahedron ref={meshRef} args={[2, 64]}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        wireframe={wireframe}
      />
    </Icosahedron>
  );
}

export function ParticleSystem() {
  const particlesCount = useStore(state => state.particlesCount);
  const timeScale = useStore(state => state.timeScale);
  const spiralParticles = useStore(state => state.spiralParticles);
  const pointsRef = useRef<THREE.Points>(null);
  const spiralRef = useRef<THREE.Points>(null);

  const [positions, randoms, spiralPos] = useMemo(() => {
    const pos = new Float32Array(particlesCount * 3);
    const rand = new Float32Array(particlesCount);
    // Use a simple seeded PRNG to avoid React purity warnings
    let seed = 12345;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < particlesCount; i++) {
      // Sphere distribution
      const theta = random() * Math.PI * 2;
      const phi = Math.acos((random() * 2) - 1);
      const r = 3 + random() * 5;

      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);

      rand[i] = random();
    }

    const sPos = new Float32Array(spiralParticles * 3);
    for (let i = 0; i < spiralParticles; i++) {
      sPos[i * 3] = 0;
      sPos[i * 3 + 1] = 0;
      sPos[i * 3 + 2] = 0;
    }

    return [pos, rand, sPos];
  }, [particlesCount, spiralParticles]);

  useFrame((state) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.001 * timeScale;
      pointsRef.current.rotation.z -= 0.0005 * timeScale;

      const positions = pointsRef.current.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < particlesCount; i++) {
        const i3 = i * 3;
        // Subtle wave motion
        positions[i3 + 1] += Math.sin(state.clock.elapsedTime * timeScale + randoms[i] * 10) * 0.01;
      }
      pointsRef.current.geometry.attributes.position.needsUpdate = true;
    }

    if (spiralRef.current) {
      const sPositions = spiralRef.current.geometry.attributes.position.array as Float32Array;
      const time = state.clock.elapsedTime * timeScale;

      for (let i = 0; i < spiralParticles; i++) {
        const i3 = i * 3;
        const t = time * 2 + i * 0.1;
        const radius = 2 + Math.sin(time + i * 0.05) * 1.5;

        sPositions[i3] = Math.cos(t) * radius;
        sPositions[i3 + 1] = Math.sin(t * 0.8) * radius * 0.5;
        sPositions[i3 + 2] = Math.sin(t) * radius;
      }

      spiralRef.current.geometry.attributes.position.needsUpdate = true;
      spiralRef.current.rotation.y -= 0.005 * timeScale;
    }
  });

  return (
    <group>
      <Points ref={pointsRef} positions={positions}>
        <PointMaterial
          transparent
          color="#88ccff"
          size={0.05}
          sizeAttenuation={true}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          opacity={0.6}
        />
      </Points>

      <Points ref={spiralRef} positions={spiralPos}>
        <PointMaterial
          transparent
          color="#ff0088"
          size={0.08}
          sizeAttenuation={true}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          opacity={0.8}
        />
      </Points>
    </group>
  );
}