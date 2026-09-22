// Web Worker: triangulate GSHB coast polygons with earcut in the (unwrapped) lon/lat plane, then
// refine long edges so the chord triangles stay close to the sphere. Refinement midpoints are taken
// in lon/lat space, not on the sphere: earcut's triangles are only guaranteed to lie inside the
// polygon in the lon/lat plane, and a great-circle midpoint of a long edge can stray far from the
// planar edge (a chord from James Bay to Alaska would cut through Hudson Bay). Returns extra
// vertices, uint32 indices and per-level index ranges.
import earcut from 'https://cdn.jsdelivr.net/npm/earcut@3.0.1/+esm';

const DEG = Math.PI / 180;
const MAX_CHORD = 2 * Math.sin(0.5 * DEG);     // edges longer than 1° get split
const MAX_CHORD2 = MAX_CHORD * MAX_CHORD;

self.onmessage = (e) => {
  const { lon, lat, start, level, npoly, npts, id } = e.data;
  const t0 = performance.now();
  // vertex table: coast points first, then extras (grows)
  let cap = npts + 65536;
  let X = new Float32Array(cap * 3);      // unit vectors
  let LL = new Float64Array(cap * 2);     // lon (unwrapped within its polygon) / lat, for planar midpoints
  let nv = npts;
  for (let k = 0; k < npts; k++) {
    const φ = lat[k] * DEG, λ = lon[k] * DEG, c = Math.cos(φ);
    X[3 * k] = c * Math.cos(λ); X[3 * k + 1] = c * Math.sin(λ); X[3 * k + 2] = Math.sin(φ);
    LL[2 * k] = lon[k]; LL[2 * k + 1] = lat[k];
  }
  const addVertex = (lo, la) => {
    if (nv >= cap) {
      cap *= 2;
      const Y = new Float32Array(cap * 3); Y.set(X); X = Y;
      const M = new Float64Array(cap * 2); M.set(LL); LL = M;
    }
    const φ = la * DEG, λ = lo * DEG, c = Math.cos(φ);
    X[3 * nv] = c * Math.cos(λ); X[3 * nv + 1] = c * Math.sin(λ); X[3 * nv + 2] = Math.sin(φ);
    LL[2 * nv] = lo; LL[2 * nv + 1] = la;
    return nv++;
  };
  const byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (let p = 0; p < npoly; p++) {
    const lv = level[p];
    if (!byLevel[lv]) continue;
    const s = start[p], e = start[p + 1];
    let n = e - s;
    if (n < 3) continue;
    const closed = lon[s] === lon[e - 1] && lat[s] === lat[e - 1];
    if (closed) n--;
    const flat = new Float64Array(2 * (n + 2));
    let prev = 0, minLon = Infinity, maxLon = -Infinity, minLat = Infinity;
    for (let k = 0; k < n; k++) {
      let lo = lon[s + k];
      if (k > 0) { const d = lo - prev; if (d > 180) lo -= 360; else if (d < -180) lo += 360; }
      prev = lo;
      flat[2 * k] = lo; flat[2 * k + 1] = lat[s + k];
      LL[2 * (s + k)] = lo;   // unwrapped longitude, consistent within this polygon
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; if (lat[s + k] < minLat) minLat = lat[s + k];
    }
    let m = n, extras = null;
    if (maxLon - minLon > 300 && minLat < -60) {
      // Antarctica: close the ring through the south pole (two extra vertices at the pole)
      flat[2 * n] = flat[2 * (n - 1)]; flat[2 * n + 1] = -90;
      flat[2 * n + 2] = flat[0]; flat[2 * n + 3] = -90;
      m = n + 2;
      extras = [addVertex(flat[2 * n], -90), addVertex(flat[2 * n + 2], -90)];
    }
    const idx = earcut(m === n ? flat.subarray(0, 2 * n) : flat);
    const out = byLevel[lv];
    for (let i = 0; i < idx.length; i++) {
      const j = idx[i];
      out.push(j < n ? s + j : extras[j - n]);
    }
  }
  // subdivide long edges at their lon/lat midpoints (shared midpoints keep the mesh crack-free)
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = (a < b ? a : b) * 4194304 + (a < b ? b : a);
    let v = mid.get(key);
    if (v !== undefined) return v;
    v = addVertex((LL[2 * a] + LL[2 * b]) / 2, (LL[2 * a + 1] + LL[2 * b + 1]) / 2);
    mid.set(key, v);
    return v;
  };
  const chord2 = (a, b) => (X[3 * a] - X[3 * b]) ** 2 + (X[3 * a + 1] - X[3 * b + 1]) ** 2 + (X[3 * a + 2] - X[3 * b + 2]) ** 2;
  const ranges = [];
  const final = [];
  for (const lv of [1, 5, 2, 3, 4]) {
    const first = final.length;
    const stack = byLevel[lv];
    while (stack.length) {
      const c = stack.pop(), b = stack.pop(), a = stack.pop();
      const ab = chord2(a, b) > MAX_CHORD2, bc = chord2(b, c) > MAX_CHORD2, ca = chord2(c, a) > MAX_CHORD2;
      if (!ab && !bc && !ca) { final.push(a, b, c); continue; }
      const mab = ab ? midpoint(a, b) : -1, mbc = bc ? midpoint(b, c) : -1, mca = ca ? midpoint(c, a) : -1;
      if (ab && bc && ca) stack.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
      else if (ab && bc) stack.push(a, mab, mbc, a, mbc, c, mab, b, mbc);
      else if (bc && ca) stack.push(b, mbc, mca, b, mca, a, mbc, c, mca);
      else if (ca && ab) stack.push(c, mca, mab, c, mab, b, mca, a, mab);
      else if (ab) stack.push(a, mab, c, mab, b, c);
      else if (bc) stack.push(b, mbc, a, mbc, c, a);
      else stack.push(c, mca, b, mca, a, b);
    }
    ranges.push({ level: lv, first, count: final.length - first });
  }
  const indices = Uint32Array.from(final);
  const extra = X.slice(npts * 3, nv * 3);
  self.postMessage({ id, extra, indices, ranges, ms: performance.now() - t0 }, [extra.buffer, indices.buffer]);
};
