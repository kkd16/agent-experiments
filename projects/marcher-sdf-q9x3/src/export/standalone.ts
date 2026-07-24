// Standalone shader-toy exporter. Given a Scene, this bakes the whole thing —
// the generated fragment shader plus every uniform value — into a single, fully
// self-contained HTML file with no dependencies. It reuses the exact shader the
// studio compiles, and ships a tiny WebGL2 runtime that reproduces the camera
// orbit and per-node animation, so the exported page looks and moves like the app.

import type { Scene, SdfNode } from '../scene/types'
import { buildShader } from '../sdf/shader'
import { TEXTURE_INDEX } from '../scene/primitives'
import { sunDirection } from '../gl/math'

function packModA(n: SdfNode): [number, number, number, number] {
  const m = n.modifier
  switch (m.domain) {
    case 'repeat':
      return [m.repeat[0], m.repeat[1], m.repeat[2], m.repeatLimit]
    case 'mirror':
      return [m.mirror[0], m.mirror[1], m.mirror[2], 0]
    case 'twist':
      return [m.twist, 0, 0, 0]
    case 'bend':
      return [m.bend, 0, 0, 0]
    default:
      return [0, 0, 0, 0]
  }
}

function packModB(n: SdfNode): [number, number, number, number] {
  const m = n.modifier
  return [m.round, m.shellOn ? m.shell : 0, 0, 0]
}

interface NodeAnimData {
  p: [number, number, number]
  r: [number, number, number]
  s: number
  on: boolean
  posAmp: [number, number, number]
  posSpeed: [number, number, number]
  spin: [number, number, number]
  scalePulse: number
  scaleSpeed: number
}

/** Serialise everything the runtime needs to reconstruct the scene's uniforms. */
function buildConfig(scene: Scene) {
  const params: number[] = []
  const blend: number[] = []
  const matColor: number[] = []
  const matPBR: number[] = []
  const modA: number[] = []
  const modB: number[] = []
  const matTex: number[] = []
  const nodes: NodeAnimData[] = []

  scene.nodes.forEach((nd) => {
    params.push(nd.params[0] ?? 0, nd.params[1] ?? 0, nd.params[2] ?? 0, nd.params[3] ?? 0)
    blend.push(nd.combine.radius)
    matColor.push(nd.material.color[0], nd.material.color[1], nd.material.color[2])
    matPBR.push(
      nd.material.metallic,
      nd.material.roughness,
      nd.material.reflectivity,
      nd.material.emission,
    )
    modA.push(...packModA(nd))
    modB.push(...packModB(nd))
    matTex.push(TEXTURE_INDEX[nd.material.texture] ?? 0, nd.material.texScale, nd.material.texStrength, 0)
    nodes.push({
      p: [nd.transform.position[0], nd.transform.position[1], nd.transform.position[2]],
      r: [nd.transform.rotation[0], nd.transform.rotation[1], nd.transform.rotation[2]],
      s: nd.transform.scale,
      on: scene.animate && nd.anim.enabled,
      posAmp: [nd.anim.posAmp[0], nd.anim.posAmp[1], nd.anim.posAmp[2]],
      posSpeed: [nd.anim.posSpeed[0], nd.anim.posSpeed[1], nd.anim.posSpeed[2]],
      spin: [nd.anim.spin[0], nd.anim.spin[1], nd.anim.spin[2]],
      scalePulse: nd.anim.scalePulse,
      scaleSpeed: nd.anim.scaleSpeed,
    })
  })

  const sun = sunDirection(scene.sun.azimuth, scene.sun.elevation)
  const q = scene.quality
  return {
    nodeCount: Math.max(scene.nodes.length, 1),
    cam: {
      target: scene.camera.target,
      distance: scene.camera.distance,
      azimuth: scene.camera.azimuth,
      elevation: scene.camera.elevation,
      fov: scene.camera.fov,
      autoRotate: scene.camera.autoRotate,
      autoRotateSpeed: scene.camera.autoRotateSpeed,
    },
    sun,
    sunColor: scene.sun.color,
    sunIntensity: scene.sun.intensity,
    skyColor: scene.env.skyColor,
    horizonColor: scene.env.horizonColor,
    groundColor: scene.env.groundColor,
    ambient: scene.env.ambient,
    fogColor: scene.env.fogColor,
    fogDensity: scene.env.fogDensity,
    groundH: scene.ground.height,
    check: scene.ground.checker ? 1 : 0,
    groundCol1: scene.ground.color1,
    groundCol2: scene.ground.color2,
    maxSteps: Math.round(q.maxSteps),
    maxDist: q.maxDist,
    eps: q.surfaceEps,
    shadowSoft: q.shadowSoftness,
    shadowStr: q.shadowStrength,
    aoStr: q.aoStrength,
    reflect: q.reflections ? 1 : 0,
    aa: q.antialias ? 2 : 1,
    exposure: scene.post.exposure,
    gamma: scene.post.gamma,
    vignette: scene.post.vignette,
    saturation: scene.post.saturation,
    params,
    blend,
    matColor,
    matPBR,
    modA,
    modB,
    matTex,
    nodes,
  }
}

// The self-contained runtime that lives inside the exported page. Written as a
// plain string (no template literals) so it can be embedded verbatim.
const RUNTIME = `
const DEG = Math.PI / 180;
function orbit(target, dist, azDeg, elDeg){
  const az = azDeg*DEG, el = elDeg*DEG, ce = Math.cos(el);
  return [target[0]+dist*ce*Math.sin(az), target[1]+dist*Math.sin(el), target[2]+dist*ce*Math.cos(az)];
}
function rotMat(rot, out){
  const rx=rot[0]*DEG, ry=rot[1]*DEG, rz=rot[2]*DEG;
  const cx=Math.cos(rx), sx=Math.sin(rx), cy=Math.cos(ry), sy=Math.sin(ry), cz=Math.cos(rz), sz=Math.sin(rz);
  const r=[[cy*cz,-cy*sz,sy],[sx*sy*cz+cx*sz,-sx*sy*sz+cx*cz,-sx*cy],[-cx*sy*cz+sx*sz,cx*sy*sz+sx*cz,cx*cy]];
  for(let col=0;col<3;col++) for(let row=0;row<3;row++) out[col*3+row]=r[col][row];
  return out;
}
function compile(gl, type, src){
  const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', {antialias:false, preserveDrawingBuffer:true, powerPreference:'high-performance'});
if(!gl){ document.body.innerHTML = '<p style="color:#fff;font-family:sans-serif;padding:2rem">WebGL2 is not available.</p>'; }
else {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const loc = {};
  function u(n){ if(!(n in loc)) loc[n]=gl.getUniformLocation(prog,n); return loc[n]; }
  // static uniforms
  gl.uniform3fv(u('uSunDir'), S.sun);
  gl.uniform3fv(u('uSunColor'), S.sunColor);
  gl.uniform1f(u('uSunIntensity'), S.sunIntensity);
  gl.uniform3fv(u('uSkyColor'), S.skyColor);
  gl.uniform3fv(u('uHorizonColor'), S.horizonColor);
  gl.uniform3fv(u('uGroundColor'), S.groundColor);
  gl.uniform1f(u('uAmbient'), S.ambient);
  gl.uniform3fv(u('uFogColor'), S.fogColor);
  gl.uniform1f(u('uFogDensity'), S.fogDensity);
  gl.uniform1f(u('uGroundH'), S.groundH);
  gl.uniform1i(u('uCheck'), S.check);
  gl.uniform3fv(u('uGroundCol1'), S.groundCol1);
  gl.uniform3fv(u('uGroundCol2'), S.groundCol2);
  gl.uniform1i(u('uMaxSteps'), S.maxSteps);
  gl.uniform1f(u('uMaxDist'), S.maxDist);
  gl.uniform1f(u('uEps'), S.eps);
  gl.uniform1f(u('uFar'), S.maxDist);
  gl.uniform1f(u('uShadowSoft'), S.shadowSoft);
  gl.uniform1f(u('uShadowStr'), S.shadowStr);
  gl.uniform1f(u('uAoStr'), S.aoStr);
  gl.uniform1i(u('uReflect'), S.reflect);
  gl.uniform1i(u('uAA'), S.aa);
  gl.uniform1f(u('uExposure'), S.exposure);
  gl.uniform1f(u('uGamma'), S.gamma);
  gl.uniform1f(u('uVignette'), S.vignette);
  gl.uniform1f(u('uSaturation'), S.saturation);
  gl.uniform4fv(u('uParam'), new Float32Array(S.params));
  gl.uniform1fv(u('uBlend'), new Float32Array(S.blend));
  gl.uniform3fv(u('uMatColor'), new Float32Array(S.matColor));
  gl.uniform4fv(u('uMatPBR'), new Float32Array(S.matPBR));
  gl.uniform4fv(u('uModA'), new Float32Array(S.modA));
  gl.uniform4fv(u('uModB'), new Float32Array(S.modB));
  gl.uniform4fv(u('uMatTex'), new Float32Array(S.matTex));
  const N = S.nodeCount;
  const posArr = new Float32Array(N*3), rotArr = new Float32Array(N*9), scaleArr = new Float32Array(N), rt = new Float32Array(9);
  let spin = 0, last = 0;
  function resize(){
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = Math.floor(canvas.clientWidth*dpr), h = Math.floor(canvas.clientHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; }
  }
  function frame(ts){
    const t = ts/1000; const dt = last? Math.min(t-last,0.05):0.016; last = t;
    if(S.cam.autoRotate) spin += S.cam.autoRotateSpeed*dt;
    resize();
    gl.viewport(0,0,canvas.width,canvas.height);
    const eye = orbit(S.cam.target, S.cam.distance, S.cam.azimuth+spin, S.cam.elevation);
    gl.uniform2f(u('uResolution'), canvas.width, canvas.height);
    gl.uniform1f(u('uTime'), t);
    gl.uniform3fv(u('uCamPos'), eye);
    gl.uniform3fv(u('uCamTarget'), S.cam.target);
    gl.uniform1f(u('uFov'), S.cam.fov);
    for(let i=0;i<S.nodes.length;i++){
      const nd = S.nodes[i];
      let px=nd.p[0],py=nd.p[1],pz=nd.p[2],rx=nd.r[0],ry=nd.r[1],rz=nd.r[2],sc=nd.s;
      if(nd.on){
        px+=nd.posAmp[0]*Math.sin(t*nd.posSpeed[0]);
        py+=nd.posAmp[1]*Math.sin(t*nd.posSpeed[1]);
        pz+=nd.posAmp[2]*Math.sin(t*nd.posSpeed[2]);
        rx+=nd.spin[0]*t; ry+=nd.spin[1]*t; rz+=nd.spin[2]*t;
        sc*=1+nd.scalePulse*Math.sin(t*nd.scaleSpeed);
      }
      posArr[i*3]=px; posArr[i*3+1]=py; posArr[i*3+2]=pz;
      rotMat([rx,ry,rz], rt); rotArr.set(rt, i*9);
      scaleArr[i]=Math.max(sc,1e-3);
    }
    gl.uniform3fv(u('uPos'), posArr);
    gl.uniformMatrix3fv(u('uRot'), false, rotArr);
    gl.uniform1fv(u('uScale'), scaleArr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
`

/** Build a complete, standalone HTML document that renders the scene. */
export function buildStandaloneHtml(scene: Scene, title = 'Marcher scene'): string {
  const built = buildShader(scene)
  const cfg = buildConfig(scene)
  const safeTitle = title.replace(/[<>&]/g, '')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle} — Marcher</title>`,
    '<style>',
    'html,body{margin:0;height:100%;background:#05060a;overflow:hidden}',
    '#c{width:100vw;height:100vh;display:block}',
    '.tag{position:fixed;left:12px;bottom:10px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#8a90a6;opacity:.7;pointer-events:none}',
    '</style>',
    '</head>',
    '<body>',
    '<canvas id="c"></canvas>',
    '<div class="tag">rendered with Marcher — a from-scratch SDF ray marcher</div>',
    '<script>',
    'const VERT = ' + JSON.stringify(built.vertex) + ';',
    'const FRAG = ' + JSON.stringify(built.fragment) + ';',
    'const S = ' + JSON.stringify(cfg) + ';',
    RUNTIME,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}
