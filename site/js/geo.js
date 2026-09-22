// Spherical geometry helpers. Unit-vector convention: x toward lon 0, y toward lon 90E, z toward the north pole.
import { ringInfo } from './gshb.js';

export const R_KM = 6371.0088;
export const DEG = Math.PI / 180;
export const TAU = 2 * Math.PI;

export function xyz(lon, lat) {
  const φ = lat * DEG, λ = lon * DEG, c = Math.cos(φ);
  return [c * Math.cos(λ), c * Math.sin(λ), Math.sin(φ)];
}
export function lonlat(v) {
  return [Math.atan2(v[1], v[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG];
}
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function norm(v) { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
export const angle = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

export function frame(lon, lat) {
  const φ = lat * DEG, λ = lon * DEG;
  return {
    east: [-Math.sin(λ), Math.cos(λ), 0],
    north: [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)],
  };
}
export function dirFromBearing(lon, lat, bearingDeg) {
  const { east, north } = frame(lon, lat);
  const θ = bearingDeg * DEG, c = Math.cos(θ), s = Math.sin(θ);
  return [north[0] * c + east[0] * s, north[1] * c + east[1] * s, north[2] * c + east[2] * s];
}
export function bearingOfDir(lon, lat, d) {
  const { east, north } = frame(lon, lat);
  return ((Math.atan2(dot(d, east), dot(d, north)) / DEG) + 360) % 360;
}
/** Initial bearing from a to b (unit vectors). */
export function initialBearing(a, b) {
  const [lon, lat] = lonlat(a);
  const d = norm([b[0] - dot(a, b) * a[0], b[1] - dot(a, b) * a[1], b[2] - dot(a, b) * a[2]]);
  return bearingOfDir(lon, lat, d);
}

const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const WORDS = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };
export function compass(b) { return POINTS16[Math.round((((b % 360) + 360) % 360) / 22.5) % 16]; }
export function compassWord(b) { return WORDS[compass(b)]; }

export function fmtLat(lat) { return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`; }
export function fmtLon(lon) { return `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`; }
export function fmtLatLon(lon, lat) { return `${fmtLat(lat)} ${fmtLon(lon)}`; }
export function fmtKm(km) {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
}
export function fmtDist(km) {
  const mi = km * 0.621371, nmi = km / 1.852;
  return `${fmtKm(km)} (${Math.round(mi).toLocaleString()} mi, ${Math.round(nmi).toLocaleString()} nmi)`;
}

/** Points along the great circle P + d, from angle 0 to alphaEnd (radians). */
export function greatCirclePoints(P, d, alphaEnd, stepRad = 0.5 * DEG) {
  const pts = [];
  const n = Math.max(2, Math.ceil(alphaEnd / stepRad));
  for (let i = 0; i <= n; i++) {
    const a = alphaEnd * i / n, c = Math.cos(a), s = Math.sin(a);
    pts.push(lonlat([P[0] * c + d[0] * s, P[1] * c + d[1] * s, P[2] * c + d[2] * s]));
  }
  return pts;
}
export function pointAlong(P, d, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [P[0] * c + d[0] * s, P[1] * c + d[1] * s, P[2] * c + d[2] * s];
}

/**
 * Direction of the coast at a snapped point, smoothed over ±windowKm of shoreline.
 * Rings are clockwise (land on the right), so the sea is to the LEFT of the tangent.
 */
export function coastNormal(g, snap, windowKm) {
  const { s, m } = ringInfo(g, snap.poly);
  const X = g.xyz;
  const P = snap.xyz;
  const { east, north } = frame(snap.lon, snap.lat);
  const W = windowKm / R_KM;
  const j0 = snap.k - s;
  const at = (j) => { const k = s + (((j % m) + m) % m); return [X[3 * k], X[3 * k + 1], X[3 * k + 2]]; };
  const local = (v) => [dot(v, east), dot(v, north)];
  const pts = [[0, 0]];
  const walk = (j, step) => {
    let acc = 0, prev = P, last = null;
    for (let i = 0; i < m && i < 20000; i++) {
      const v = at(j);
      acc += angle(prev, v);
      pts.push(local(v));
      last = v;
      if (acc >= W) break;
      prev = v; j += step;
    }
    return last ? local(last) : [0, 0];
  };
  const fwdEnd = walk(j0 + 1, +1);
  const backEnd = walk(j0, -1);
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  let te, tn;
  if (sxx + syy < 1e-20) { te = fwdEnd[0] - backEnd[0]; tn = fwdEnd[1] - backEnd[1]; }
  else { const θ = 0.5 * Math.atan2(2 * sxy, sxx - syy); te = Math.cos(θ); tn = Math.sin(θ); }
  const vx = fwdEnd[0] - backEnd[0], vy = fwdEnd[1] - backEnd[1];
  if (te * vx + tn * vy < 0) { te = -te; tn = -tn; }
  const tl = Math.hypot(te, tn) || 1; te /= tl; tn /= tl;
  const ne = -tn, nn = te; // rotate the tangent 90° counter-clockwise: the sea side
  const bearing = ((Math.atan2(ne, nn) / DEG) + 360) % 360;
  const tangentBearing = ((Math.atan2(te, tn) / DEG) + 360) % 360;
  return { bearing, tangentBearing, points: pts.length, windowKm };
}

/** All crossings of coast rings (given levels) by the great circle through P with direction d. */
export function greatCircleHits(g, P, d, levels = [1, 5]) {
  const n = norm(cross(P, d));
  const [nx, ny, nz] = n, [px, py, pz] = P, [dx, dy, dz] = d;
  const X = g.xyz;
  const want = new Uint8Array(256);
  for (const l of levels) want[l] = 1;
  const out = [];
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]]) continue;
    const cd = g.cx[p] * nx + g.cy[p] * ny + g.cz[p] * nz;
    if (g.crad[p] < Math.PI / 2 && Math.abs(cd) > Math.sin(g.crad[p])) continue;
    const s = g.start[p], e = g.start[p + 1];
    let a = X[3 * s] * nx + X[3 * s + 1] * ny + X[3 * s + 2] * nz;
    for (let k = s; k < e - 1; k++) {
      const b = X[3 * k + 3] * nx + X[3 * k + 4] * ny + X[3 * k + 5] * nz;
      if ((a < 0) !== (b < 0)) {
        const t = a / (a - b);
        let cx = X[3 * k] + t * (X[3 * k + 3] - X[3 * k]);
        let cy = X[3 * k + 1] + t * (X[3 * k + 4] - X[3 * k + 1]);
        let cz = X[3 * k + 2] + t * (X[3 * k + 5] - X[3 * k + 2]);
        const cn = Math.hypot(cx, cy, cz) || 1; cx /= cn; cy /= cn; cz /= cn;
        let alpha = Math.atan2(cx * dx + cy * dy + cz * dz, cx * px + cy * py + cz * pz);
        if (alpha < 0) alpha += TAU;
        out.push({ alpha, entry: a < 0, k, poly: p, xyz: [cx, cy, cz], lonlat: lonlat([cx, cy, cz]) });
      }
      a = b;
    }
  }
  out.sort((u, v) => u.alpha - v.alpha);
  return out;
}

/** Crossings of the parallel lat0 by coast rings, travelling east or west from lon0. delta in degrees of longitude. */
export function parallelHits(g, lon0, lat0, eastward, levels = [1, 5]) {
  const want = new Uint8Array(256);
  for (const l of levels) want[l] = 1;
  const LON = g.lon, LAT = g.lat;
  const out = [];
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]]) continue;
    const s = g.start[p], e = g.start[p + 1];
    for (let k = s; k < e - 1; k++) {
      const la = LAT[k], lb = LAT[k + 1];
      if ((la < lat0) === (lb < lat0)) continue;
      let dl = LON[k + 1] - LON[k];
      if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
      const t = (lat0 - la) / (lb - la);
      let lonc = LON[k] + t * dl;
      let delta = eastward ? (lonc - lon0) : (lon0 - lonc);
      delta = ((delta % 360) + 360) % 360;
      lonc = ((lonc + 540) % 360) - 180;
      const entry = eastward ? la < lb : la > lb;
      out.push({ delta, entry, k, poly: p, lonlat: [lonc, lat0] });
    }
  }
  out.sort((u, v) => u.delta - v.delta);
  return out;
}
