import { toHalfArray } from '../core/half';
import type { FloatImage } from '../core/types';

const VERT = `#version 300 es
in vec2 pos;
out vec2 ndc;
void main() { ndc = pos; gl_Position = vec4(pos, 0.0, 1.0); }`;

// Même convention de direction que core/projection.ts (equirectDirection).
const FRAG = `#version 300 es
precision highp float;
in vec2 ndc;
out vec4 color;
uniform sampler2D env;
uniform float yaw, pitch, tanFov, aspect, exposure;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 f = vec3(-sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
  vec3 u = cross(r, f);
  vec3 d = normalize(f + ndc.x * tanFov * aspect * r + ndc.y * tanFov * u);
  float lon = atan(-d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  vec2 uv = vec2(lon / 6.28318530718 + 0.5, 0.5 - lat / 3.14159265359);
  vec3 hdr = texture(env, uv).rgb * exp2(exposure);
  color = vec4(toSrgb(aces(hdr)), 1.0);
}`;

export class Viewer360 {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private yaw = 0;
  private pitch = 0;
  private fov = 75;
  exposure = 0;
  private raf = 0;
  private cleanup: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 indisponible dans ce navigateur.');
    this.gl = gl;
    this.prog = this.program();
    this.tex = gl.createTexture()!;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.bindInput();
  }

  setImage(img: FloatImage) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, img.width, img.height, 0, gl.RGB, gl.HALF_FLOAT, toHalfArray(img.data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.draw();
  }

  draw = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const { gl, canvas } = this;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.prog);
      const u = (n: string) => gl.getUniformLocation(this.prog, n);
      gl.uniform1f(u('yaw'), this.yaw);
      gl.uniform1f(u('pitch'), this.pitch);
      gl.uniform1f(u('tanFov'), Math.tan((this.fov * Math.PI) / 360));
      gl.uniform1f(u('aspect'), w / Math.max(1, h));
      gl.uniform1f(u('exposure'), this.exposure);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.gl.deleteTexture(this.tex);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private bindInput() {
    const c = this.canvas;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const k = (Math.tan((this.fov * Math.PI) / 360) * 2) / c.clientHeight;
      this.yaw -= (e.clientX - drag.x) * k;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + (e.clientY - drag.y) * k));
      drag = { x: e.clientX, y: e.clientY };
      this.draw();
    };
    const up = () => (drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.fov = Math.max(20, Math.min(120, this.fov * Math.exp(e.deltaY * 0.001)));
      this.draw();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', this.draw);
    this.cleanup.push(() => window.removeEventListener('resize', this.draw));
  }

  private program(): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
  }
}
