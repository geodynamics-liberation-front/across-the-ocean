// Loader and spatial index for the GSHB binary produced by tools/build_data.py.
const MAGIC = 0x42485347;
const DEG = Math.PI / 180;

export async function fetchBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}

export function parseGSHB(ab) {
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a GSHB file');
  const npoly = dv.getUint32(8, true);
  const npts = dv.getUint32(12, true);
  const hdr = new Int32Array(ab, 16, npoly * 6);
  const raw = new Int32Array(ab, 16 + npoly * 24, npts * 2);
  const level = new Uint8Array(npoly);
  const start = new Uint32Array(npoly + 1);
  const lon = new Float64Array(npts), lat = new Float64Array(npts);
  const xyz = new Float32Array(npts * 3);
  // per-polygon bounding cap for culling: unit centre + angular radius (radians)
  const cx = new Float64Array(npoly), cy = new Float64Array(npoly), cz = new Float64Array(npoly), crad = new Float64Array(npoly);
  let off = 0;
  for (let i = 0; i < npoly; i++) {
    level[i] = hdr[i * 6];
    const n = hdr[i * 6 + 1];
    start[i] = off; off += n;
    const w = hdr[i * 6 + 2] * 1e-6, e = hdr[i * 6 + 3] * 1e-6, s = hdr[i * 6 + 4] * 1e-6, no = hdr[i * 6 + 5] * 1e-6;
    const clon = (w + e) / 2, clat = (s + no) / 2;
    const c = unit(clon, clat);
    cx[i] = c[0]; cy[i] = c[1]; cz[i] = c[2];
    if (e - w >= 180) { crad[i] = Math.PI; continue; }
    let r = 0;
    for (const [a, b] of [[w, s], [w, no], [e, s], [e, no]]) {
      const v = unit(a, b);
      const d = Math.acos(Math.max(-1, Math.min(1, c[0] * v[0] + c[1] * v[1] + c[2] * v[2])));
      if (d > r) r = d;
    }
    crad[i] = r * 1.02 + 1e-4;
  }
  start[npoly] = off;
  for (let k = 0; k < npts; k++) {
    const lo = raw[2 * k] * 1e-6, la = raw[2 * k + 1] * 1e-6;
    lon[k] = lo; lat[k] = la;
    const φ = la * DEG, λ = lo * DEG, cφ = Math.cos(φ);
    xyz[3 * k] = cφ * Math.cos(λ); xyz[3 * k + 1] = cφ * Math.sin(λ); xyz[3 * k + 2] = Math.sin(φ);
  }
  return { npoly, npts, level, start, lon, lat, xyz, cx, cy, cz, crad };
}

function unit(lon, lat) {
  const φ = lat * DEG, λ = lon * DEG, c = Math.cos(φ);
  return [c * Math.cos(λ), c * Math.sin(λ), Math.sin(φ)];
}

/** Ring bookkeeping: first index, number of distinct vertices, whether it closes on itself. */
export function ringInfo(g, p) {
  const s = g.start[p], e = g.start[p + 1];
  const X = g.xyz;
  const dx = X[3 * s] - X[3 * (e - 1)], dy = X[3 * s + 1] - X[3 * (e - 1) + 1], dz = X[3 * s + 2] - X[3 * (e - 1) + 2];
  const closed = e - s > 2 && dx * dx + dy * dy + dz * dz < 1e-12;
  return { s, m: closed ? e - s - 1 : e - s, closed };
}

export function polyOfPoint(g, k) {
  let lo = 0, hi = g.npoly - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.start[mid] <= k) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Grid index over the vertices that start a segment of the given levels. */
export function buildCoastIndex(g, levels = [1, 5], cell = 1) {
  const nx = Math.ceil(360 / cell), ny = Math.ceil(180 / cell);
  const want = new Uint8Array(256);
  for (const l of levels) want[l] = 1;
  const counts = new Uint32Array(nx * ny + 1);
  const cellOf = (k) => {
    let cx = Math.floor((g.lon[k] + 180) / cell) % nx; if (cx < 0) cx += nx;
    let cy = Math.floor((g.lat[k] + 90) / cell); if (cy >= ny) cy = ny - 1; if (cy < 0) cy = 0;
    return cy * nx + cx;
  };
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]]) continue;
    const s = g.start[p], e = g.start[p + 1];
    for (let k = s; k < e - 1; k++) counts[cellOf(k) + 1]++;
  }
  for (let i = 0; i < nx * ny; i++) counts[i + 1] += counts[i];
  const offsets = counts;
  const fill = new Uint32Array(nx * ny);
  const idx = new Uint32Array(offsets[nx * ny]);
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]]) continue;
    const s = g.start[p], e = g.start[p + 1];
    for (let k = s; k < e - 1; k++) { const c = cellOf(k); idx[offsets[c] + fill[c]++] = k; }
  }
  return { cell, nx, ny, offsets, idx, levels };
}

/** Closest point on the great-circle arc a→b to q (all unit vectors). Returns chord² and the point. */
function closestOnArc(X, ka, kb, qx, qy, qz, out) {
  const ax = X[3 * ka], ay = X[3 * ka + 1], az = X[3 * ka + 2];
  const bx = X[3 * kb], by = X[3 * kb + 1], bz = X[3 * kb + 2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const nn = Math.hypot(nx, ny, nz);
  let px, py, pz, t = 0, inside = false;
  if (nn > 1e-14) {
    nx /= nn; ny /= nn; nz /= nn;
    const qn = qx * nx + qy * ny + qz * nz;
    px = qx - qn * nx; py = qy - qn * ny; pz = qz - qn * nz;
    const pn = Math.hypot(px, py, pz);
    if (pn > 1e-12) {
      px /= pn; py /= pn; pz /= pn;
      const c1 = (ay * pz - az * py) * nx + (az * px - ax * pz) * ny + (ax * py - ay * px) * nz;
      const c2 = (py * bz - pz * by) * nx + (pz * bx - px * bz) * ny + (px * by - py * bx) * nz;
      if (c1 >= 0 && c2 >= 0) {
        inside = true;
        const ab = Math.atan2(nn, ax * bx + ay * by + az * bz);
        const ap = Math.atan2(Math.hypot(ay * pz - az * py, az * px - ax * pz, ax * py - ay * px), ax * px + ay * py + az * pz);
        t = ab > 0 ? ap / ab : 0;
      }
    }
  }
  if (!inside) {
    const da = (ax - qx) ** 2 + (ay - qy) ** 2 + (az - qz) ** 2;
    const db = (bx - qx) ** 2 + (by - qy) ** 2 + (bz - qz) ** 2;
    if (da <= db) { px = ax; py = ay; pz = az; t = 0; } else { px = bx; py = by; pz = bz; t = 1; }
  }
  const d2 = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d2 < out.d2) { out.d2 = d2; out.k = ka; out.t = t; out.x = px; out.y = py; out.z = pz; }
}

/** Nearest coast point to (lon, lat). Returns null if nothing within maxRings grid cells. */
export function nearestCoast(g, index, lon, lat, maxRings = 6) {
  const { cell, nx, ny, offsets, idx } = index;
  const q = unit(lon, lat);
  const X = g.xyz;
  const out = { d2: Infinity, k: -1, t: 0, x: 0, y: 0, z: 0 };
  let cx0 = Math.floor((lon + 180) / cell) % nx; if (cx0 < 0) cx0 += nx;
  let cy0 = Math.floor((lat + 90) / cell); if (cy0 >= ny) cy0 = ny - 1; if (cy0 < 0) cy0 = 0;
  const visit = (cx, cy) => {
    if (cy < 0 || cy >= ny) return;
    cx = ((cx % nx) + nx) % nx;
    const c = cy * nx + cx;
    for (let i = offsets[c]; i < offsets[c + 1]; i++) { const k = idx[i]; closestOnArc(X, k, k + 1, q[0], q[1], q[2], out); }
  };
  for (let r = 0; r <= maxRings; r++) {
    if (r === 0) visit(cx0, cy0);
    else {
      for (let dx = -r; dx <= r; dx++) { visit(cx0 + dx, cy0 - r); visit(cx0 + dx, cy0 + r); }
      for (let dy = -r + 1; dy <= r - 1; dy++) { visit(cx0 - r, cy0 + dy); visit(cx0 + r, cy0 + dy); }
    }
    if (out.k >= 0) {
      const bestDeg = 2 * Math.asin(Math.min(1, Math.sqrt(out.d2) / 2)) / DEG;
      const lb = r * cell * Math.cos(Math.min(89, Math.abs(lat) + (r + 1) * cell) * DEG);
      if (bestDeg <= lb) break;
    }
  }
  if (out.k < 0) return null;
  const v = [out.x, out.y, out.z];
  return {
    k: out.k, t: out.t, poly: polyOfPoint(g, out.k), xyz: v,
    lon: Math.atan2(v[1], v[0]) / DEG, lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG,
    distRad: 2 * Math.asin(Math.min(1, Math.sqrt(out.d2) / 2)),
  };
}
