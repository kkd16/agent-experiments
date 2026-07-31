// Standalone shader-toy exporter. Given a Scene, this bakes the whole thing —
// the generated fragment shader plus every uniform value — into a single, fully
// self-contained HTML file with no dependencies. It reuses the exact shader the
// studio compiles, and ships a tiny WebGL2 runtime that reproduces the camera
// orbit and per-node animation, so the exported page looks and moves like the app.

import type { Scene, SdfNode } from '../scene/types'
import { BLOOM_BLUR_SHADER, BLOOM_PREFILTER_SHADER, buildShader } from '../sdf/shader'
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
    case 'elongate':
      return [m.elongate[0], m.elongate[1], m.elongate[2], 0]
    case 'polar':
      return [m.polar, 0, 0, 0]
    default:
      return [0, 0, 0, 0]
  }
}

function packModB(n: SdfNode): [number, number, number, number] {
  const m = n.modifier
  return [m.round, m.shellOn ? m.shell : 0, 0, 0]
}

function packGlass(n: SdfNode): [number, number, number, number] {
  const m = n.material
  return [m.transmission, m.ior, m.absorption, m.dispersion]
}

function packFilm(n: SdfNode): [number, number, number, number] {
  const m = n.material
  return [m.iridescence, m.filmThickness, 0, 0]
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
  const matGlass: number[] = []
  const matFilm: number[] = []
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
    matGlass.push(...packGlass(nd))
    matFilm.push(...packFilm(nd))
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
  const dispersive = scene.nodes.some(
    (n) => n.material.transmission > 0.001 && n.material.dispersion > 0.001,
  )
    ? 1
    : 0
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
      aperture: scene.camera.aperture,
      focusDist: scene.camera.focusDistance,
    },
    sun,
    sunColor: scene.sun.color,
    sunIntensity: scene.sun.intensity,
    sunAngle: scene.sun.angle,
    // Progressive accumulation + path tracer: baked so a shared page converges to
    // the same GI image the studio shows (falls back to the direct shader when
    // float render targets aren't available, or accumulation is off).
    accumulate: scene.render.accumulate ? 1 : 0,
    maxSamples: Math.max(1, Math.round(scene.render.maxSamples)),
    integrator: scene.render.integrator === 'pathtrace' ? 1 : 0,
    bounces: Math.max(1, Math.round(scene.render.bounces)),
    fireflyClamp: Math.max(0, scene.render.fireflyClamp),
    dispersive,
    bloom: scene.post.bloom,
    bloomThreshold: scene.post.bloomThreshold,
    bloomRadius: scene.post.bloomRadius,
    skyMode: scene.env.skyMode === 'physical' ? 1 : 0,
    turbidity: scene.env.turbidity,
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
    emissive: scene.env.emissive ? 1 : 0,
    emissiveStr: scene.env.emissiveStrength,
    emisShadow: scene.env.emissiveShadows ? 1 : 0,
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
    matGlass,
    matFilm,
    nodes,
  }
}

// The self-contained runtime that lives inside the exported page. Written as a
// plain string (no template literals) so it can be embedded verbatim. It mirrors
// the studio renderer: a direct single pass, or — when float render targets are
// available and accumulation is on — a progressive path that folds jittered
// samples (path-traced GI, depth-of-field, soft shadows) into a float ping-pong
// average, blooms it, and tonemaps, resetting the moment the view moves.
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
  function mkProg(fs){
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  const progDirect = mkProg(FRAG);
  let floatOk = !!gl.getExtension('EXT_color_buffer_float');
  let progAccum=null, progPresent=null, progPre=null, progBlur=null;
  if(floatOk){
    try {
      progAccum = mkProg(FRAG_ACCUM);
      progPresent = mkProg(FRAG_PRESENT);
      progPre = mkProg(FRAG_PRE);
      progBlur = mkProg(FRAG_BLUR);
    } catch(e){ floatOk=false; progAccum=null; progPresent=null; progPre=null; progBlur=null; }
  }
  const useAccum = S.accumulate===1 && floatOk;

  const cache = new Map();
  function loc(prog,n){ let m=cache.get(prog); if(!m){m=new Map();cache.set(prog,m);} if(m.has(n)) return m.get(n); const l=gl.getUniformLocation(prog,n); m.set(n,l); return l; }

  const N = S.nodeCount;
  const posArr = new Float32Array(N*3), rotArr = new Float32Array(N*9), scaleArr = new Float32Array(N), rt = new Float32Array(9);

  // Upload the scene-static + material uniforms (constant over the export's life).
  function uploadScene(prog){
    gl.useProgram(prog);
    gl.uniform3fv(loc(prog,'uSunDir'), S.sun);
    gl.uniform3fv(loc(prog,'uSunColor'), S.sunColor);
    gl.uniform1f(loc(prog,'uSunIntensity'), S.sunIntensity);
    gl.uniform1f(loc(prog,'uSunAngle'), S.sunAngle);
    gl.uniform3fv(loc(prog,'uSkyColor'), S.skyColor);
    gl.uniform3fv(loc(prog,'uHorizonColor'), S.horizonColor);
    gl.uniform3fv(loc(prog,'uGroundColor'), S.groundColor);
    gl.uniform1i(loc(prog,'uSkyMode'), S.skyMode);
    gl.uniform1f(loc(prog,'uTurbidity'), S.turbidity);
    gl.uniform1f(loc(prog,'uAmbient'), S.ambient);
    gl.uniform3fv(loc(prog,'uFogColor'), S.fogColor);
    gl.uniform1f(loc(prog,'uFogDensity'), S.fogDensity);
    gl.uniform1f(loc(prog,'uGroundH'), S.groundH);
    gl.uniform1i(loc(prog,'uCheck'), S.check);
    gl.uniform3fv(loc(prog,'uGroundCol1'), S.groundCol1);
    gl.uniform3fv(loc(prog,'uGroundCol2'), S.groundCol2);
    gl.uniform1i(loc(prog,'uMaxSteps'), S.maxSteps);
    gl.uniform1f(loc(prog,'uMaxDist'), S.maxDist);
    gl.uniform1f(loc(prog,'uEps'), S.eps);
    gl.uniform1f(loc(prog,'uFar'), S.maxDist);
    gl.uniform1f(loc(prog,'uShadowSoft'), S.shadowSoft);
    gl.uniform1f(loc(prog,'uShadowStr'), S.shadowStr);
    gl.uniform1f(loc(prog,'uAoStr'), S.aoStr);
    gl.uniform1i(loc(prog,'uReflect'), S.reflect);
    gl.uniform1i(loc(prog,'uAA'), S.aa);
    gl.uniform1i(loc(prog,'uEmissive'), S.emissive);
    gl.uniform1f(loc(prog,'uEmissiveStr'), S.emissiveStr);
    gl.uniform1i(loc(prog,'uEmisShadow'), S.emisShadow);
    gl.uniform1i(loc(prog,'uIntegrator'), S.integrator);
    gl.uniform1i(loc(prog,'uBounces'), S.bounces);
    gl.uniform1f(loc(prog,'uClamp'), S.fireflyClamp);
    gl.uniform1i(loc(prog,'uDispersive'), S.dispersive);
    gl.uniform1f(loc(prog,'uExposure'), S.exposure);
    gl.uniform1f(loc(prog,'uGamma'), S.gamma);
    gl.uniform1f(loc(prog,'uVignette'), S.vignette);
    gl.uniform1f(loc(prog,'uSaturation'), S.saturation);
    gl.uniform4fv(loc(prog,'uParam'), new Float32Array(S.params));
    gl.uniform1fv(loc(prog,'uBlend'), new Float32Array(S.blend));
    gl.uniform3fv(loc(prog,'uMatColor'), new Float32Array(S.matColor));
    gl.uniform4fv(loc(prog,'uMatPBR'), new Float32Array(S.matPBR));
    gl.uniform4fv(loc(prog,'uModA'), new Float32Array(S.modA));
    gl.uniform4fv(loc(prog,'uModB'), new Float32Array(S.modB));
    gl.uniform4fv(loc(prog,'uMatTex'), new Float32Array(S.matTex));
    gl.uniform4fv(loc(prog,'uMatGlass'), new Float32Array(S.matGlass));
    gl.uniform4fv(loc(prog,'uMatFilm'), new Float32Array(S.matFilm));
  }
  uploadScene(progDirect);
  if(useAccum) uploadScene(progAccum);

  let spin = 0, last = 0, hashAcc = 0;
  function hput(x){ const v = Math.round(x*4096)|0; hashAcc = (Math.imul(hashAcc,16777619) ^ v)|0; }

  // Advance animation, fill the node transform arrays, and hash everything that
  // changes the image so accumulation resets on motion.
  function computeFrame(t, dt){
    if(S.cam.autoRotate) spin += S.cam.autoRotateSpeed*dt;
    const eye = orbit(S.cam.target, S.cam.distance, S.cam.azimuth+spin, S.cam.elevation);
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
    hashAcc = 0;
    hput(eye[0]); hput(eye[1]); hput(eye[2]);
    for(let i=0;i<posArr.length;i++) hput(posArr[i]);
    for(let i=0;i<rotArr.length;i++) hput(rotArr[i]);
    for(let i=0;i<scaleArr.length;i++) hput(scaleArr[i]);
    return eye;
  }

  // Upload the per-frame camera + node transforms to the active program.
  function uploadFrame(prog, eye, t, w, h){
    gl.uniform2f(loc(prog,'uResolution'), w, h);
    gl.uniform1f(loc(prog,'uTime'), t);
    gl.uniform3fv(loc(prog,'uCamPos'), eye);
    gl.uniform3fv(loc(prog,'uCamTarget'), S.cam.target);
    gl.uniform1f(loc(prog,'uFov'), S.cam.fov);
    gl.uniform1f(loc(prog,'uAperture'), S.cam.aperture);
    gl.uniform1f(loc(prog,'uFocusDist'), S.cam.focusDist);
    gl.uniform3fv(loc(prog,'uPos'), posArr);
    gl.uniformMatrix3fv(loc(prog,'uRot'), false, rotArr);
    gl.uniform1fv(loc(prog,'uScale'), scaleArr);
  }

  function resize(){
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = Math.floor(canvas.clientWidth*dpr), h = Math.floor(canvas.clientHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; return true; }
    return false;
  }

  // --- accumulation state ---
  let tex=[null,null], fbo=[null,null], aw=0, ah=0, cur=0, sample=0, lastTex=null, viewSig=NaN;
  let bTex=[null,null], bFbo=[null,null], bw=0, bh=0;
  function makeTarget(w,h,filter){
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    return ok ? [tx, fb] : null;
  }
  function setupTargets(w,h){
    for(let i=0;i<2;i++){ if(tex[i]) gl.deleteTexture(tex[i]); if(fbo[i]) gl.deleteFramebuffer(fbo[i]); if(bTex[i]) gl.deleteTexture(bTex[i]); if(bFbo[i]) gl.deleteFramebuffer(bFbo[i]); }
    for(let i=0;i<2;i++){ const r=makeTarget(w,h,gl.NEAREST); if(!r){ return false; } tex[i]=r[0]; fbo[i]=r[1]; }
    bw=Math.max(1,w>>1); bh=Math.max(1,h>>1);
    for(let i=0;i<2;i++){ const r=makeTarget(bw,bh,gl.LINEAR); if(!r){ return false; } bTex[i]=r[0]; bFbo[i]=r[1]; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    aw=w; ah=h; cur=0; sample=0; lastTex=null;
    return true;
  }

  function renderBloom(w,h){
    if(S.bloom<=0 || !progPre || !progBlur || !lastTex || !bTex[0] || !bTex[1]) return false;
    const spread = Math.max(0.2, S.bloomRadius)*1.5;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bFbo[0]); gl.viewport(0,0,bw,bh);
    gl.useProgram(progPre);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, lastTex);
    gl.uniform1i(loc(progPre,'uSrc'), 0);
    gl.uniform1f(loc(progPre,'uThresh'), Math.max(0,S.bloomThreshold));
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.useProgram(progBlur);
    gl.uniform2f(loc(progBlur,'uTexSize'), bw, bh);
    function blur(src,dst,dx,dy){
      gl.bindFramebuffer(gl.FRAMEBUFFER,dst); gl.viewport(0,0,bw,bh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,src);
      gl.uniform1i(loc(progBlur,'uSrc'),0);
      gl.uniform2f(loc(progBlur,'uDir'),dx,dy);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    blur(bTex[0],bFbo[1],spread,0);
    blur(bTex[1],bFbo[0],0,spread);
    return true;
  }

  function frameDirect(t, eye, w, h){
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0,0,w,h);
    gl.useProgram(progDirect);
    uploadFrame(progDirect, eye, t, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frameAccum(t, eye, w, h){
    if(aw!==w || ah!==h){ if(!setupTargets(w,h)){ floatOk=false; frameDirect(t,eye,w,h); return; } }
    if(hashAcc!==viewSig){ viewSig=hashAcc; sample=0; cur=0; lastTex=null; }
    const maxS = S.maxSamples;
    if(sample<maxS){
      const read=1-cur, write=cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[write]); gl.viewport(0,0,w,h);
      gl.useProgram(progAccum);
      uploadFrame(progAccum, eye, t, w, h);
      gl.uniform1i(loc(progAccum,'uSample'), sample);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[read]);
      gl.uniform1i(loc(progAccum,'uPrev'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      lastTex=tex[write]; sample++; cur=read;
    }
    if(lastTex){
      const bloomOn = renderBloom(w,h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0,0,w,h);
      gl.useProgram(progPresent);
      gl.uniform2f(loc(progPresent,'uResolution'), w, h);
      gl.uniform1f(loc(progPresent,'uExposure'), S.exposure);
      gl.uniform1f(loc(progPresent,'uGamma'), S.gamma);
      gl.uniform1f(loc(progPresent,'uVignette'), S.vignette);
      gl.uniform1f(loc(progPresent,'uSaturation'), S.saturation);
      gl.uniform1f(loc(progPresent,'uBloomInt'), bloomOn?S.bloom:0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, lastTex);
      gl.uniform1i(loc(progPresent,'uAccum'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bTex[0]);
      gl.uniform1i(loc(progPresent,'uBloomTex'), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  function frame(ts){
    const t = ts/1000; const dt = last? Math.min(t-last,0.05):0.016; last = t;
    resize();
    const w = canvas.width, h = canvas.height;
    const eye = computeFrame(t, dt);
    if(useAccum && floatOk) frameAccum(t, eye, w, h);
    else frameDirect(t, eye, w, h);
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
    'const FRAG_ACCUM = ' + JSON.stringify(built.fragmentAccum) + ';',
    'const FRAG_PRESENT = ' + JSON.stringify(built.present) + ';',
    'const FRAG_PRE = ' + JSON.stringify(BLOOM_PREFILTER_SHADER) + ';',
    'const FRAG_BLUR = ' + JSON.stringify(BLOOM_BLUR_SHADER) + ';',
    'const S = ' + JSON.stringify(cfg) + ';',
    RUNTIME,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}
