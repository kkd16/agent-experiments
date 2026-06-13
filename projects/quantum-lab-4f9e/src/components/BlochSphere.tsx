import { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';

interface BlochSphereProps {
  blochVector: [number, number, number];
  qubitIndex: number;
  label?: string;
}

export default function BlochSphere({ blochVector, qubitIndex, label }: BlochSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 200, height: 200 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { width, height } = size;
    if (width === 0 || height === 0) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.setClearColor(0x0a0a1a, 1);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(2.5, 1.5, 2.5);
    camera.lookAt(0, 0, 0);

    const sphereGeo = new THREE.SphereGeometry(1, 24, 16);
    const sphereWire = new THREE.WireframeGeometry(sphereGeo);
    const sphereMat = new THREE.LineBasicMaterial({ color: 0x6496ff, transparent: true, opacity: 0.3 });
    const sphere = new THREE.LineSegments(sphereWire, sphereMat);
    scene.add(sphere);

    const equatorPoints: THREE.Vector3[] = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      equatorPoints.push(new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)));
    }
    const equatorGeo = new THREE.BufferGeometry().setFromPoints(equatorPoints);
    const equatorMat = new THREE.LineBasicMaterial({ color: 0x6496ff, transparent: true, opacity: 0.5 });
    const equator = new THREE.Line(equatorGeo, equatorMat);
    scene.add(equator);

    const axisLength = 1.3;

    const xAxisGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-axisLength, 0, 0),
      new THREE.Vector3(axisLength, 0, 0),
    ]);
    scene.add(new THREE.Line(xAxisGeo, new THREE.LineBasicMaterial({ color: 0xff4444, opacity: 0.7, transparent: true })));

    const yAxisGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -axisLength, 0),
      new THREE.Vector3(0, axisLength, 0),
    ]);
    scene.add(new THREE.Line(yAxisGeo, new THREE.LineBasicMaterial({ color: 0x44ff44, opacity: 0.7, transparent: true })));

    const zAxisGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, -axisLength),
      new THREE.Vector3(0, 0, axisLength),
    ]);
    scene.add(new THREE.Line(zAxisGeo, new THREE.LineBasicMaterial({ color: 0x4488ff, opacity: 0.7, transparent: true })));

    const tipGeoX = new THREE.SphereGeometry(0.04, 8, 8);
    const tipX = new THREE.Mesh(tipGeoX, new THREE.MeshBasicMaterial({ color: 0xff4444 }));
    tipX.position.set(axisLength, 0, 0);
    scene.add(tipX);

    const tipGeoY = new THREE.SphereGeometry(0.04, 8, 8);
    const tipY = new THREE.Mesh(tipGeoY, new THREE.MeshBasicMaterial({ color: 0x44ff44 }));
    tipY.position.set(0, axisLength, 0);
    scene.add(tipY);

    const tipGeoZ = new THREE.SphereGeometry(0.04, 8, 8);
    const tipZ = new THREE.Mesh(tipGeoZ, new THREE.MeshBasicMaterial({ color: 0x4488ff }));
    tipZ.position.set(0, 0, axisLength);
    scene.add(tipZ);

    const [bx, by, bz] = blochVector;
    const len = Math.sqrt(bx * bx + by * by + bz * bz);
    const nx = len > 0 ? bx / len : 0;
    const ny = len > 0 ? by / len : 0;
    const nz = len > 0 ? bz / len : 0;

    const arrowPoints: THREE.Vector3[] = [];
    const arrowSegments = 32;
    for (let i = 0; i <= arrowSegments; i++) {
      const t = i / arrowSegments;
      arrowPoints.push(new THREE.Vector3(nx * t, ny * t, nz * t));
    }
    const arrowGeo = new THREE.BufferGeometry().setFromPoints(arrowPoints);
    const arrowMat = new THREE.LineBasicMaterial({ color: 0x00ff88 });
    const arrow = new THREE.Line(arrowGeo, arrowMat);
    scene.add(arrow);

    const markerGeo = new THREE.SphereGeometry(0.06, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(nx, ny, nz);
    scene.add(marker);

    const makeTextSprite = (text: string, position: THREE.Vector3): THREE.Sprite => {
      const cvs = document.createElement('canvas');
      cvs.width = 128;
      cvs.height = 64;
      const ctx = cvs.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, 128, 64);
        ctx.font = 'bold 28px monospace';
        ctx.fillStyle = 'rgba(160, 200, 255, 0.9)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 32);
      }
      const texture = new THREE.CanvasTexture(cvs);
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(position);
      sprite.scale.set(0.4, 0.2, 1);
      return sprite;
    };

    scene.add(makeTextSprite('|0⟩', new THREE.Vector3(0, 1.6, 0)));
    scene.add(makeTextSprite('|1⟩', new THREE.Vector3(0, -1.6, 0)));
    scene.add(makeTextSprite('|+⟩', new THREE.Vector3(1.6, 0, 0)));
    scene.add(makeTextSprite('|-⟩', new THREE.Vector3(-1.6, 0, 0)));

    let isDragging = false;
    let prevMouseX = 0;
    let prevMouseY = 0;
    let rotationX = 0.3;
    let rotationY = 0;
    const pivot = new THREE.Group();
    scene.add(pivot);

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - prevMouseX;
      const dy = e.clientY - prevMouseY;
      rotationY += dx * 0.01;
      rotationX += dy * 0.01;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };
    const onMouseUp = () => { isDragging = false; };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDragging = true;
        prevMouseX = e.touches[0].clientX;
        prevMouseY = e.touches[0].clientY;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - prevMouseX;
      const dy = e.touches[0].clientY - prevMouseY;
      rotationY += dx * 0.01;
      rotationX += dy * 0.01;
      prevMouseX = e.touches[0].clientX;
      prevMouseY = e.touches[0].clientY;
    };
    const onTouchEnd = () => { isDragging = false; };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('touchstart', onTouchStart);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);

    let animId = 0;
    let autoAngle = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);

      if (!isDragging) {
        autoAngle += 0.005;
      }

      const totalY = rotationY + autoAngle;
      const r = 3.5;
      camera.position.x = r * Math.sin(totalY) * Math.cos(rotationX);
      camera.position.y = r * Math.sin(rotationX);
      camera.position.z = r * Math.cos(totalY) * Math.cos(rotationX);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
        if (obj instanceof THREE.Sprite) {
          obj.material.map?.dispose();
          obj.material.dispose();
        }
      });
    };
  }, [blochVector, size]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <div style={{ color: '#a0c8ff', fontFamily: 'monospace', fontSize: '12px', fontWeight: 'bold' }}>
        {label ?? `Q${qubitIndex}`}
      </div>
      <div
        ref={containerRef}
        style={{ width: '200px', height: '200px', cursor: 'grab' }}
      >
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          style={{ display: 'block', width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
