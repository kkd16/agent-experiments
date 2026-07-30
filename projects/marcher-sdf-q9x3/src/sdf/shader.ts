// Assembles the complete WebGL2 shader pair around the generated map() function.
// The fragment shader is a full raymarcher: orbit-camera ray setup, sphere
// tracing, tetrahedral normals, a soft-shadowed directional sun, ambient
// occlusion, hemispheric ambient, fake environment reflections, distance fog,
// ACES tonemapping and a vignette. Per-node data comes in as uniform arrays.

import type { Scene } from '../scene/types'
import { generateMap } from './codegen'
import { SDF_DOMAIN, SDF_OPS, SDF_PRIMITIVES, SDF_TEXTURE } from './library'

export const VERTEX_SHADER = `#version 300 es
// Fullscreen triangle generated from gl_VertexID — no vertex buffers needed.
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const UNIFORM_BLOCK = /* glsl */ `
precision highp float;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;

uniform vec3 uCamPos;
uniform vec3 uCamTarget;
uniform float uFov;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;

uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform float uAmbient;

uniform vec3 uFogColor;
uniform float uFogDensity;

uniform float uGroundH;
uniform int uCheck;
uniform vec3 uGroundCol1;
uniform vec3 uGroundCol2;

uniform int uMaxSteps;
uniform float uMaxDist;
uniform float uEps;
uniform float uFar;
uniform float uShadowSoft;
uniform float uShadowStr;
uniform float uAoStr;
uniform int uReflect;
uniform int uAA;

// Progressive accumulation + depth-of-field + area lights.
uniform int uSample;          // index of the sample being drawn this frame
uniform sampler2D uPrev;      // previous running-average target (accum path only)
uniform float uAperture;      // thin-lens radius (0 = pinhole)
uniform float uFocusDist;     // focal plane distance
uniform float uSunAngle;      // sun angular radius (degrees) for soft shadows
uniform int uEmissive;        // 1 = emissive nodes light the scene
uniform float uEmissiveStr;   // global multiplier on gathered emissive light
uniform int uEmisShadow;      // 1 = trace a visibility ray to each emitter

uniform float uExposure;
uniform float uGamma;
uniform float uVignette;
uniform float uSaturation;

uniform vec3 uPos[NODE_COUNT];
uniform mat3 uRot[NODE_COUNT];
uniform float uScale[NODE_COUNT];
uniform vec4 uParam[NODE_COUNT];
uniform float uBlend[NODE_COUNT];
uniform vec3 uMatColor[NODE_COUNT];
uniform vec4 uMatPBR[NODE_COUNT];
uniform vec4 uModA[NODE_COUNT];
uniform vec4 uModB[NODE_COUNT];
uniform vec4 uMatTex[NODE_COUNT];
`

// Shared tonemap + post: ACES filmic, saturation, gamma, vignette. Used by the
// direct main() and by the accumulation present pass (declared there separately).
const TONEMAP_FN = /* glsl */ `
vec3 tonemap(vec3 col, vec2 frag){
  col *= uExposure;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = clamp(col, 0.0, 1.0);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(lum), col, uSaturation), 0.0, 1.0);
  col = pow(col, vec3(1.0 / uGamma));
  vec2 q = frag / uResolution;
  float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), uVignette * 0.35);
  col *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));
  return col;
}
`

const RENDER_CODE = /* glsl */ `
// Jittered per-sample light direction (an area sun), set once per sample.
vec3 gSunDir;

// Small xorshift-ish RNG threaded through a global seed, re-seeded per sample.
float gSeed;
float rnd(){
  gSeed = fract(sin(gSeed * 12.9898 + 78.233) * 43758.5453123);
  return gSeed;
}
void seedRng(vec2 frag, int si){
  vec2 p = fract(frag * vec2(0.13317, 0.24571));
  gSeed = fract((p.x + p.y) * 0.61803398875 + float(si) * 0.375);
}

vec3 skyColor(vec3 rd){
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizonColor, uSkyColor, pow(t, 0.75));
  float s = max(dot(rd, gSunDir), 0.0);
  col += uSunColor * pow(s, 350.0) * 1.2 * uSunIntensity;
  col += uSunColor * pow(s, 5.0) * 0.04 * uSunIntensity;
  return col;
}

vec2 raymarch(vec3 ro, vec3 rd){
  float t = 0.0;
  for (int i = 0; i < 512; i++){
    if (i >= uMaxSteps) break;
    vec3 pos = ro + rd * t;
    vec2 h = map(pos);
    if (h.x < uEps * t){ return vec2(t, h.y); }
    t += h.x;
    if (t > uMaxDist) break;
  }
  return vec2(t, -2.0);
}

vec3 calcNormal(vec3 p){
  const vec2 k = vec2(1.0, -1.0);
  float h = 0.0006;
  return normalize(
    k.xyy * map(p + k.xyy * h).x +
    k.yyx * map(p + k.yyx * h).x +
    k.yxy * map(p + k.yxy * h).x +
    k.xxx * map(p + k.xxx * h).x);
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float w){
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 64; i++){
    if (t > maxt) break;
    float h = map(ro + rd * t).x;
    res = min(res, h / (w * t));
    if (res < -1.0) break;
    t += clamp(h, 0.02, 0.35);
  }
  res = max(res, -1.0);
  return 0.25 * (1.0 + res) * (1.0 + res) * (2.0 - res);
}

float calcAO(vec3 pos, vec3 nor){
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.012 + 0.12 * float(i) / 4.0;
    float d = map(pos + nor * h).x;
    occ += (h - d) * sca;
    sca *= 0.93;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

void getMaterial(float id, vec3 pos, vec3 nor, out vec3 albedo, out float metallic,
                 out float rough, out float refl, out float emis){
  if (id < -0.5){
    albedo = uGroundCol1;
    if (uCheck == 1){
      float c = mod(floor(pos.x) + floor(pos.z), 2.0);
      albedo = mix(uGroundCol1, uGroundCol2, c);
    }
    metallic = 0.0;
    rough = 0.7;
    refl = 0.04;
    emis = 0.0;
  } else {
    int i = int(id + 0.5);
    albedo = uMatColor[i];
    vec4 pbr = uMatPBR[i];
    metallic = pbr.x;
    rough = pbr.y;
    refl = pbr.z;
    emis = pbr.w;
    vec4 tex = uMatTex[i];
    int tk = int(tex.x + 0.5);
    if (tk > 0){
      float pat = clamp(texPattern(tk, pos, nor, max(tex.y, 0.001)), 0.0, 1.0);
      vec3 tinted = albedo * mix(0.32, 1.18, pat);
      albedo = mix(albedo, tinted, clamp(tex.z, 0.0, 1.0));
    }
  }
}

// Light gathered from every emissive node treated as a point/area light, with
// inverse-square falloff and an optional visibility ray. Returns the incident
// irradiance (the caller multiplies by albedo).
vec3 emissiveLight(vec3 pos, vec3 nor){
  if (uEmissive == 0) return vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < NODE_COUNT; i++){
    float em = uMatPBR[i].w;
    if (em <= 0.001) continue;
    vec3 d = uPos[i] - pos;
    float dist = length(d);
    if (dist < 1e-3) continue;
    vec3 L = d / dist;
    float ndl = max(dot(nor, L), 0.0);
    if (ndl <= 0.0) continue;
    float atten = 1.0 / (1.0 + 0.7 * dist * dist);
    float vis = 1.0;
    if (uEmisShadow == 1){
      vis = clamp(softShadow(pos + nor * 0.02, L, 0.03, dist - 0.08, uShadowSoft), 0.0, 1.0);
    }
    sum += uMatColor[i] * (em * ndl * atten * vis);
  }
  return sum * uEmissiveStr;
}

// Local (single-bounce) shading: sun + soft shadow + hemispheric ambient + a
// Blinn-Phong highlight + emission + emissive-node lighting. No reflection or
// fog — the caller adds those.
vec3 localShade(vec3 pos, vec3 nor, vec3 rd, vec3 albedo, float metallic,
                float rough, float emis){
  vec3 L = gSunDir;
  float shadow = softShadow(pos + nor * 0.02, L, 0.02, 14.0, uShadowSoft);
  shadow = mix(1.0, shadow, uShadowStr);
  float ao = mix(1.0, calcAO(pos, nor), uAoStr);

  float dif = max(dot(nor, L), 0.0);
  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * nor.y) * uAmbient;
  vec3 direct = uSunColor * uSunIntensity * dif * shadow;

  vec3 H = normalize(L - rd);
  float shin = mix(8.0, 420.0, 1.0 - rough);
  float spec = pow(max(dot(nor, H), 0.0), shin);
  vec3 specCol = mix(vec3(1.0), albedo, metallic);

  vec3 col = albedo * (amb * ao + direct);
  col += specCol * spec * direct * (0.6 + 0.5 * metallic);
  col += albedo * emissiveLight(pos, nor);
  col += albedo * emis * 2.5;
  return col;
}

// Full primary shade: local shading, then one real reflection bounce that mirrors
// the actual scene (or the sky), Fresnel-weighted and roughness-attenuated, then fog.
vec3 shade(vec3 pos, vec3 rd, float matId){
  vec3 nor = calcNormal(pos);
  vec3 albedo; float metallic, rough, refl, emis;
  getMaterial(matId, pos, nor, albedo, metallic, rough, refl, emis);
  vec3 col = localShade(pos, nor, rd, albedo, metallic, rough, emis);

  if (uReflect == 1){
    float fres = pow(clamp(1.0 - max(dot(nor, -rd), 0.0), 0.0, 1.0), 5.0);
    float amount = clamp(refl + fres * 0.4, 0.0, 1.0) * mix(1.0, 0.22, rough);
    if (amount > 0.01){
      vec3 tint = mix(vec3(1.0), albedo, metallic);
      vec3 rr = reflect(rd, nor);
      vec3 rro = pos + nor * 0.03;
      vec2 r2 = raymarch(rro, rr);
      vec3 rcol;
      if (r2.y < -1.5){
        rcol = skyColor(rr);
      } else {
        vec3 rp = rro + rr * r2.x;
        vec3 rn = calcNormal(rp);
        vec3 ra; float rmet, rrg, rrf, rem;
        getMaterial(r2.y, rp, rn, ra, rmet, rrg, rrf, rem);
        rcol = localShade(rp, rn, rr, ra, rmet, rrg, rem);
      }
      col = mix(col, rcol * tint, amount);
    }
  }

  float fog = 1.0 - exp(-uFogDensity * length(pos - uCamPos));
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  return col;
}

// The camera orthonormal basis (right, up, forward) for the current view.
void camBasis(out vec3 fwd, out vec3 rt, out vec3 up){
  fwd = normalize(uCamTarget - uCamPos);
  rt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  up = cross(rt, fwd);
}

// March one primary ray and return its linear-HDR radiance (scene or sky + fog).
vec3 shadeRay(vec3 ro, vec3 rd){
  vec2 res = raymarch(ro, rd);
  if (res.y < -1.5){
    vec3 sky = skyColor(rd);
    float fog = 1.0 - exp(-uFogDensity * min(res.x, uMaxDist));
    return mix(sky, uFogColor, clamp(fog * 0.4, 0.0, 1.0));
  }
  return shade(ro + rd * res.x, rd, res.y);
}

// Deterministic pinhole sample — used by the single-pass (direct) renderer and
// the standalone export, where there's no accumulation to hide jitter.
vec3 renderPixel(vec2 frag){
  gSunDir = uSunDir;
  vec2 uv = (2.0 * frag - uResolution) / uResolution.y;
  vec3 fwd, rt, up;
  camBasis(fwd, rt, up);
  float f = 1.0 / tan(radians(uFov) * 0.5);
  vec3 rd = normalize(uv.x * rt + uv.y * up + f * fwd);
  return shadeRay(uCamPos, rd);
}

// One jittered Monte-Carlo sample for the accumulation renderer: sub-pixel AA,
// a thin-lens aperture for depth-of-field, and an area sun for soft shadows.
vec3 renderSample(vec2 frag){
  seedRng(frag, uSample);

  // Area sun: perturb the light direction within a small disc each sample.
  gSunDir = uSunDir;
  if (uSunAngle > 0.001){
    vec3 su = abs(uSunDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 st = normalize(cross(uSunDir, su));
    vec3 sb = cross(uSunDir, st);
    float sr = tan(radians(uSunAngle)) * sqrt(rnd());
    float sa = 6.28318530718 * rnd();
    gSunDir = normalize(uSunDir + (st * cos(sa) + sb * sin(sa)) * sr);
  }

  vec2 jitter = vec2(rnd(), rnd()) - 0.5;
  vec2 uv = (2.0 * (frag + jitter) - uResolution) / uResolution.y;

  vec3 fwd, rt, up;
  camBasis(fwd, rt, up);
  float f = 1.0 / tan(radians(uFov) * 0.5);
  vec3 rd = normalize(uv.x * rt + uv.y * up + f * fwd);
  vec3 ro = uCamPos;

  // Thin-lens depth-of-field: sample the aperture disc, re-aim at the focal plane.
  if (uAperture > 0.001){
    float cosT = max(dot(rd, fwd), 1e-3);
    vec3 focal = ro + rd * (uFocusDist / cosT);
    float lr = uAperture * sqrt(rnd());
    float la = 6.28318530718 * rnd();
    ro += rt * (cos(la) * lr) + up * (sin(la) * lr);
    rd = normalize(focal - ro);
  }

  return shadeRay(ro, rd);
}
`

// Single-pass main: deterministic AA grid straight to the canvas (fallback path
// and standalone export). Uses the shared tonemap.
const DIRECT_MAIN = /* glsl */ `
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec3 col = vec3(0.0);
  int aa = uAA;
  for (int m = 0; m < 2; m++){
    for (int n = 0; n < 2; n++){
      if (m >= aa || n >= aa) continue;
      vec2 off = (aa == 1) ? vec2(0.0) : (vec2(float(m), float(n)) * 0.5 - 0.25);
      col += renderPixel(frag + off);
    }
  }
  col /= float(aa * aa);
  fragColor = vec4(tonemap(col, frag), 1.0);
}
`

// Accumulation main: one jittered sample folded into the running average stored
// in the float ping-pong target. No tonemap here — the present pass does that.
const ACCUM_MAIN = /* glsl */ `
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec3 s = renderSample(frag);
  vec3 prev = (uSample == 0) ? vec3(0.0) : texelFetch(uPrev, ivec2(frag), 0).rgb;
  float w = 1.0 / float(uSample + 1);
  fragColor = vec4(mix(prev, s, w), 1.0);
}
`

// Present pass: read the accumulated HDR average and tonemap it to the canvas.
export const PRESENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uAccum;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uGamma;
uniform float uVignette;
uniform float uSaturation;
${TONEMAP_FN}
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec3 col = texelFetch(uAccum, ivec2(frag), 0).rgb;
  fragColor = vec4(tonemap(col, frag), 1.0);
}
`

export interface BuiltShader {
  vertex: string
  /** Single-pass fragment shader (direct-to-canvas fallback + standalone export). */
  fragment: string
  /** Accumulation fragment shader: one jittered sample into a float target. */
  fragmentAccum: string
  /** Present fragment shader: tonemap the accumulated average to the canvas. */
  present: string
  slots: number
  glsl: string
}

/** Build the fragment-shader variants for a scene. */
export function buildShader(scene: Scene): BuiltShader {
  const map = generateMap(scene)
  const body = [
    '#version 300 es',
    `#define NODE_COUNT ${map.slots}`,
    UNIFORM_BLOCK,
    SDF_PRIMITIVES,
    SDF_DOMAIN,
    SDF_OPS,
    SDF_TEXTURE,
    map.glsl,
    TONEMAP_FN,
    RENDER_CODE,
  ].join('\n')
  return {
    vertex: VERTEX_SHADER,
    fragment: [body, DIRECT_MAIN].join('\n'),
    fragmentAccum: [body, ACCUM_MAIN].join('\n'),
    present: PRESENT_SHADER,
    slots: map.slots,
    glsl: map.glsl,
  }
}
