/**
 * WebGL2 renderer. The CPU FDTD solver produces the Ez field each frame; this
 * class uploads it as a single-channel float texture and colour-maps it on the
 * GPU, together with a static material texture that draws crisp outlines around
 * dielectrics and metal so optical elements stay legible over the field.
 *
 * The physics stays on the CPU (correctness, portability); the GPU only does the
 * cheap, embarrassingly-parallel colour mapping and smooth upscaling.
 */

import { buildLUT, type ColormapName } from '../sim/colormaps';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_field;     // R32F Ez
uniform sampler2D u_intensity; // R32F time-averaged Ez^2
uniform sampler2D u_lut;       // 256x1 RGBA colormap
uniform sampler2D u_mat;       // RGBA8: R=epsNorm, G=pec, B=lossNorm
uniform float u_gain;
uniform vec2 u_grid;           // (nx, ny)
uniform float u_matOverlay;    // 0..1 overlay strength
uniform int u_mode;            // 0 = signed field, 1 = intensity

void main() {
  // Flip vertically so row 0 is at the top of the canvas.
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);

  float t;
  if (u_mode == 1) {
    // Long-exposure intensity: sqrt for a photographic dynamic range.
    float ii = texture(u_intensity, uv).r;
    t = clamp(sqrt(max(ii, 0.0)) * u_gain, 0.0, 1.0);
  } else {
    float ez = texture(u_field, uv).r;
    t = clamp(ez * u_gain * 0.5 + 0.5, 0.0, 1.0);
  }
  vec3 col = texture(u_lut, vec2(t, 0.5)).rgb;

  // Material sampling (nearest) + neighbour edge detection for outlines.
  ivec2 ip = ivec2(uv * u_grid);
  ip = clamp(ip, ivec2(1), ivec2(u_grid) - ivec2(2));
  vec4 m = texelFetch(u_mat, ip, 0);
  float epsN = m.r;
  float pec = m.g;
  float lossN = m.b;
  float disp = m.a; // dispersive (Drude/Lorentz) metal marker

  // Subtle body tint so material regions are visible over the field.
  if (u_matOverlay > 0.0) {
    // dielectric: cool darkening proportional to index
    col = mix(col, col * vec3(0.80, 0.88, 1.06), clamp(epsN * 1.3, 0.0, 0.55) * u_matOverlay);
    // absorber: warm damping
    col = mix(col, col * vec3(1.05, 0.92, 0.80), clamp(lossN, 0.0, 0.5) * u_matOverlay);
    // metal: flat metallic gray
    col = mix(col, vec3(0.62, 0.64, 0.68), pec * 0.9 * u_matOverlay);
    // dispersive metal: warm burnished tint (gold/silver-ish)
    col = mix(col, vec3(0.60, 0.55, 0.40), disp * 0.62 * u_matOverlay);

    // Edge outlines: compare a combined material key against 4-neighbours.
    float c = epsN + pec * 2.0 + disp * 1.6;
    vec4 mr = texelFetch(u_mat, ip + ivec2(1,0), 0);
    vec4 ml = texelFetch(u_mat, ip + ivec2(-1,0), 0);
    vec4 mu = texelFetch(u_mat, ip + ivec2(0,1), 0);
    vec4 md = texelFetch(u_mat, ip + ivec2(0,-1), 0);
    float e = 0.0;
    e = max(e, abs(c - (mr.r + mr.g*2.0 + mr.a*1.6)));
    e = max(e, abs(c - (ml.r + ml.g*2.0 + ml.a*1.6)));
    e = max(e, abs(c - (mu.r + mu.g*2.0 + mu.a*1.6)));
    e = max(e, abs(c - (md.r + md.g*2.0 + md.a*1.6)));
    float edge = smoothstep(0.04, 0.25, e);
    col = mix(col, vec3(0.95, 0.97, 1.0), edge * 0.5 * u_matOverlay);
  }

  outColor = vec4(col, 1.0);
}`;

export class FieldRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private fieldTex: WebGLTexture;
  private intensityTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private matTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private nx: number;
  private ny: number;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private linearFloat: boolean;

  constructor(canvas: HTMLCanvasElement, nx: number, ny: number) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true, // allow toDataURL snapshots
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.nx = nx;
    this.ny = ny;
    this.linearFloat = !!gl.getExtension('OES_texture_float_linear');

    this.program = this.buildProgram();
    gl.useProgram(this.program);
    for (const name of [
      'u_field',
      'u_intensity',
      'u_lut',
      'u_mat',
      'u_gain',
      'u_grid',
      'u_matOverlay',
      'u_mode',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    gl.uniform1i(this.uniforms.u_field, 0);
    gl.uniform1i(this.uniforms.u_lut, 1);
    gl.uniform1i(this.uniforms.u_mat, 2);
    gl.uniform1i(this.uniforms.u_intensity, 3);
    gl.uniform2f(this.uniforms.u_grid, nx, ny);

    this.vao = this.buildQuad();
    this.fieldTex = this.buildFieldTex();
    this.intensityTex = this.buildFieldTex();
    this.lutTex = this.buildLutTex();
    this.matTex = this.buildMatTex();
    this.setColormap('rdbu');
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('Shader compile error: ' + log);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  private buildQuad(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // two triangles covering clip space
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildFieldTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = this.linearFloat ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.nx, this.ny, 0, gl.RED, gl.FLOAT, null);
    return tex;
  }

  private buildLutTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private buildMatTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.nx, this.ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  setColormap(name: ColormapName): void {
    const gl = this.gl;
    const lut = buildLUT(name);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  /** Upload the material description. epsR & loss arrays sized nx*ny; dispId
   *  marks frequency-dispersive (Drude/Lorentz) cells so they stay visible even
   *  though their stored εr is just ε∞. */
  updateMaterials(
    epsR: Float32Array,
    loss: Float32Array,
    pec: Uint8Array,
    dispId?: Uint8Array,
  ): void {
    const gl = this.gl;
    const n = this.nx * this.ny;
    const data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      // eps normalized against a nominal max of 12
      data[i * 4 + 0] = Math.min(255, Math.round(((epsR[i] - 1) / 11) * 255));
      data[i * 4 + 1] = pec[i] ? 255 : 0;
      data[i * 4 + 2] = Math.min(255, Math.round((loss[i] / 0.5) * 255));
      data[i * 4 + 3] = dispId && dispId[i] ? 255 : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /**
   * Draw one frame. In `field` mode the signed Ez texture is shown; in
   * `intensity` mode the supplied time-averaged intensity buffer is shown.
   */
  render(
    ez: Float32Array,
    gain: number,
    matOverlay: number,
    mode: 'field' | 'intensity' = 'field',
    intensity?: Float32Array,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RED, gl.FLOAT, ez);
    if (mode === 'intensity' && intensity) {
      gl.bindTexture(gl.TEXTURE_2D, this.intensityTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RED, gl.FLOAT, intensity);
    }

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.u_gain, gain);
    gl.uniform1f(this.uniforms.u_matOverlay, matOverlay);
    gl.uniform1i(this.uniforms.u_mode, mode === 'intensity' ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.intensityTex);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.fieldTex);
    gl.deleteTexture(this.intensityTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.matTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
