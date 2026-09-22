// WebGL2 renderer for the globe. Vertices are unit vectors on the GPU; the vertex shaders apply
// d3's rotation and the orthographic projection, so the CPU does no per-vertex work per frame.
//
// Coordinate conventions match d3.geoOrthographic: with rotate [λ, φ, γ] a unit vector v maps to
// v' = M v, screen = translate + scale * (v'.y, -v'.z), visible where v'.x > 0.

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // per quad vertex: (along 0|1, across -1|1)
layout(location=1) in vec3 aA;        // per instance: segment start (unit vector)
layout(location=2) in vec3 aB;        // per instance: segment end
layout(location=3) in float aEnd;     // per instance: 1 when aA is the last vertex of a polyline
uniform mat3 uM; uniform vec2 uTranslate; uniform float uScale; uniform vec2 uViewport; uniform float uHalfWidth;
void main() {
  vec3 a = uM * aA; vec3 b = uM * aB;
  if (aEnd > 0.5 || (a.x <= 0.0 && b.x <= 0.0)) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  if (a.x < 0.0) { float t = a.x / (a.x - b.x); a = mix(a, b, t); }
  else if (b.x < 0.0) { float t = a.x / (a.x - b.x); b = mix(a, b, t); }
  vec2 pa = uTranslate + uScale * vec2(a.y, -a.z);
  vec2 pb = uTranslate + uScale * vec2(b.y, -b.z);
  vec2 d = pb - pa; float len = length(d);
  vec2 u = len > 1e-7 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  vec2 p = mix(pa, pb, aCorner.x) + n * (aCorner.y * uHalfWidth) + u * ((aCorner.x * 2.0 - 1.0) * uHalfWidth);
  gl_Position = vec4(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0, 0.0, 1.0);
}`;
const FLAT_FS = `#version 300 es
precision highp float;
uniform vec4 uColor; out vec4 outColor;
void main() { outColor = uColor; }`;

const FILL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat3 uM; uniform vec2 uTranslate; uniform float uScale; uniform vec2 uViewport;
out float vDepth;
void main() {
  vec3 p = uM * aPos; vDepth = p.x;
  vec2 s = uTranslate + uScale * vec2(p.y, -p.z);
  gl_Position = vec4(s.x / uViewport.x * 2.0 - 1.0, 1.0 - s.y / uViewport.y * 2.0, 0.0, 1.0);
}`;
const FILL_FS = `#version 300 es
precision highp float;
in float vDepth; uniform vec4 uColor; out vec4 outColor;
void main() { if (vDepth < 0.0) discard; outColor = uColor; }`;

const DISC_VS = `#version 300 es
layout(location=0) in vec2 aXY;
void main() { gl_Position = vec4(aXY, 0.0, 1.0); }`;
const DISC_FS = `#version 300 es
precision highp float;
uniform vec2 uCenter; uniform float uRadius; uniform vec4 uOcean; uniform vec4 uRim; uniform float uRimWidth;
out vec4 outColor;
void main() {
  float d = length(gl_FragCoord.xy - uCenter) - uRadius;
  float inside = 1.0 - smoothstep(-0.75, 0.75, d);
  float rim = 1.0 - smoothstep(uRimWidth - 0.75, uRimWidth + 0.75, abs(d));
  vec4 c = uOcean * inside;
  c = mix(c, vec4(uRim.rgb, 1.0), rim * uRim.a);
  outColor = c;
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

export function rotationMatrix(rotate) {
  const [λ, φ, γ] = rotate.map(d => d * Math.PI / 180);
  const cl = Math.cos(λ), sl = Math.sin(λ), cp = Math.cos(φ), sp = Math.sin(φ), cg = Math.cos(γ), sg = Math.sin(γ);
  // Mφγ · Mλ, row-major
  const A = [[cp, 0, -sp], [-sg * sp, cg, -sg * cp], [cg * sp, sg, cg * cp]];
  const B = [[cl, -sl, 0], [sl, cl, 0], [0, 0, 1]];
  const M = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M.push(A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]);
  // column-major for WebGL: element (i,j) at j*3+i
  return new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
}

export function parseColor(css) {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (m) { const v = parseInt(m[1], 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]; }
  const r = /rgba?\(([^)]+)\)/.exec(css);
  if (r) { const p = r[1].split(',').map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
  return [0, 0, 0, 1];
}

export class GLRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.line = compile(gl, LINE_VS, FLAT_FS);
    this.fill = compile(gl, FILL_VS, FILL_FS);
    this.disc = compile(gl, DISC_VS, DISC_FS);
    this.corner = this.buffer(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));
    this.quad = this.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.layers = new WeakMap();   // dataset object -> GPU layer
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  buffer(data, target = this.gl.ARRAY_BUFFER) {
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  /**
   * Upload a GSHB dataset as polylines. runs = contiguous polygon ranges grouped by "class"
   * (computed from g.level with classOf), each drawn with its own style.
   */
  layerFor(g, classOf) {
    let L = this.layers.get(g);
    if (L) return L;
    const gl = this.gl;
    const flags = new Float32Array(g.npts);
    for (let p = 0; p < g.npoly; p++) flags[g.start[p + 1] - 1] = 1;
    const runs = [];
    for (let p = 0; p < g.npoly; p++) {
      const cls = classOf(g.level[p]);
      const last = runs[runs.length - 1];
      if (last && last.cls === cls && last.first + last.count === g.start[p]) last.count += g.start[p + 1] - g.start[p];
      else runs.push({ cls, first: g.start[p], count: g.start[p + 1] - g.start[p] });
    }
    L = { pos: this.buffer(g.xyz), flags: this.buffer(flags), npts: g.npts, runs, fill: null };
    this.layers.set(g, L);
    return L;
  }

  /** Attach a triangle mesh (from fillworker.js) to a dataset: extra vertices + uint32 indices + level ranges. */
  setFill(g, mesh) {
    const L = this.layers.get(g);
    if (!L) return;
    const gl = this.gl;
    if (mesh.extra.length) {
      const all = new Float32Array(g.npts * 3 + mesh.extra.length);
      all.set(g.xyz); all.set(mesh.extra, g.npts * 3);
      L.fillPos = this.buffer(all);
    } else L.fillPos = L.pos;
    L.fill = { idx: this.buffer(mesh.indices, gl.ELEMENT_ARRAY_BUFFER), ranges: mesh.ranges };
  }

  /** Upload plain polylines (Float32 xyz + end flags) as a layer with a single class. */
  lineLayer(pos, flags) {
    return { pos: this.buffer(pos), flags: this.buffer(flags), npts: flags.length, runs: [{ cls: 'all', first: 0, count: flags.length }] };
  }

  begin(view, bg) {
    const gl = this.gl;
    const W = Math.round(view.width * view.dpr), H = Math.round(view.height * view.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.view = view;
    this.M = rotationMatrix(view.rotate);
    this.tx = view.translate[0] * view.dpr; this.ty = view.translate[1] * view.dpr;
    this.scale = view.scale * view.dpr;
    this.W = W; this.H = H;
  }

  setCommon(prog) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.uniformMatrix3fv(prog.u.uM, false, this.M);
    gl.uniform2f(prog.u.uTranslate, this.tx, this.ty);
    gl.uniform1f(prog.u.uScale, this.scale);
    gl.uniform2f(prog.u.uViewport, this.W, this.H);
  }

  drawDisc(ocean, rim, rimWidthPx) {
    const gl = this.gl, P = this.disc;
    gl.useProgram(P.p);
    gl.uniform2f(P.u.uCenter, this.tx, this.H - this.ty);
    gl.uniform1f(P.u.uRadius, this.scale);
    gl.uniform4fv(P.u.uOcean, ocean);
    gl.uniform4fv(P.u.uRim, rim);
    gl.uniform1f(P.u.uRimWidth, rimWidthPx * this.view.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw the runs of the given class of a layer as lines of widthPx (CSS pixels). */
  drawLines(L, cls, color, widthPx) {
    const gl = this.gl, P = this.line;
    this.setCommon(P);
    gl.uniform1f(P.u.uHalfWidth, widthPx * this.view.dpr / 2);
    gl.uniform4fv(P.u.uColor, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.enableVertexAttribArray(3);
    gl.vertexAttribDivisor(1, 1); gl.vertexAttribDivisor(2, 1); gl.vertexAttribDivisor(3, 1);
    for (const r of L.runs) {
      if (r.cls !== cls || r.count < 2) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, L.pos);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, r.first * 12);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, (r.first + 1) * 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.flags);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, r.first * 4);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.count - 1);
    }
  }

  /** Draw the fill mesh ranges whose level is in levels. */
  drawFill(L, levels, color) {
    if (!L.fill) return;
    const gl = this.gl, P = this.fill;
    this.setCommon(P);
    gl.uniform4fv(P.u.uColor, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, L.fillPos);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.fill.idx);
    for (const r of L.fill.ranges) {
      if (!levels.includes(r.level) || !r.count) continue;
      gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, r.first * 4);
    }
  }
}
