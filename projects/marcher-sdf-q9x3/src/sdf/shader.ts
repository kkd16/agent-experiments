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

const RENDER_CODE = /* glsl */ `
vec3 skyColor(vec3 rd){
  float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizonColor, uSkyColor, pow(t, 0.75));
  float s = max(dot(rd, uSunDir), 0.0);
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

// Local (single-bounce) shading: sun + soft shadow + hemispheric ambient + a
// Blinn-Phong highlight + emission. No reflection or fog — the caller adds those.
vec3 localShade(vec3 pos, vec3 nor, vec3 rd, vec3 albedo, float metallic,
                float rough, float emis){
  vec3 L = uSunDir;
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

vec3 rayDir(vec2 uv, out vec3 ro){
  ro = uCamPos;
  vec3 fwd = normalize(uCamTarget - ro);
  vec3 rt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fwd);
  float f = 1.0 / tan(radians(uFov) * 0.5);
  return normalize(uv.x * rt + uv.y * up + f * fwd);
}

vec3 renderPixel(vec2 frag){
  vec2 uv = (2.0 * frag - uResolution) / uResolution.y;
  vec3 ro;
  vec3 rd = rayDir(uv, ro);
  vec2 res = raymarch(ro, rd);
  if (res.y < -1.5){
    vec3 sky = skyColor(rd);
    float fog = 1.0 - exp(-uFogDensity * min(res.x, uMaxDist));
    return mix(sky, uFogColor, clamp(fog * 0.4, 0.0, 1.0));
  }
  return shade(ro + rd * res.x, rd, res.y);
}

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

  col *= uExposure;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = clamp(col, 0.0, 1.0);

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(lum), col, uSaturation), 0.0, 1.0);
  col = pow(col, vec3(1.0 / uGamma));

  vec2 q = frag / uResolution;
  float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), uVignette * 0.35);
  col *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));

  fragColor = vec4(col, 1.0);
}
`

export interface BuiltShader {
  vertex: string
  fragment: string
  slots: number
  glsl: string
}

/** Build the full fragment shader for a scene. */
export function buildShader(scene: Scene): BuiltShader {
  const map = generateMap(scene)
  const fragment = [
    '#version 300 es',
    `#define NODE_COUNT ${map.slots}`,
    UNIFORM_BLOCK,
    SDF_PRIMITIVES,
    SDF_DOMAIN,
    SDF_OPS,
    SDF_TEXTURE,
    map.glsl,
    RENDER_CODE,
  ].join('\n')
  return { vertex: VERTEX_SHADER, fragment, slots: map.slots, glsl: map.glsl }
}
