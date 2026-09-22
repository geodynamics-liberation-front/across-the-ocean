// Canvas renderers that stream GSHB polygons/lines through a d3-geo projection without building GeoJSON.
import { xyz, DEG } from './geo.js';

/** A d3-geo stream sink that writes straight into a 2D canvas path. */
export function canvasSink(ctx) {
  let first = true, inPolygon = false;
  return {
    point(x, y) { if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y); },
    lineStart() { first = true; },
    lineEnd() { if (inPolygon) ctx.closePath(); },
    polygonStart() { inPolygon = true; },
    polygonEnd() { inPolygon = false; },
    sphere() {},
  };
}

/** The spherical cap currently visible in a w×h viewport (centre unit vector + angular radius). */
export function viewCap(projection, w, h) {
  const r = projection.rotate();
  const c = xyz(-r[0], -r[1]);
  let rad = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    for (const pt of [[t * w, 0], [w, t * h], [w - t * w, h], [0, h - t * h]]) {
      const ll = projection.invert(pt);
      if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return { c, rad: Math.PI / 2 + 0.01 };
      const back = projection(ll);
      if (!back || Math.hypot(back[0] - pt[0], back[1] - pt[1]) > 1) return { c, rad: Math.PI / 2 + 0.01 };
      const v = xyz(ll[0], ll[1]);
      const d = Math.acos(Math.max(-1, Math.min(1, c[0] * v[0] + c[1] * v[1] + c[2] * v[2])));
      if (d > rad) rad = d;
    }
  }
  return { c, rad: rad * 1.05 + 0.01 };
}

function visible(g, p, cap) {
  if (!cap) return true;
  const d = Math.acos(Math.max(-1, Math.min(1, g.cx[p] * cap.c[0] + g.cy[p] * cap.c[1] + g.cz[p] * cap.c[2])));
  return d - g.crad[p] <= cap.rad;
}

/** Stream polygons of the given levels as (spherical) polygons into the current canvas path. */
export function streamPolygons(ctx, projection, g, levels, cap) {
  const st = projection.stream(canvasSink(ctx));
  const want = new Uint8Array(256);
  for (const l of levels) want[l] = 1;
  const LON = g.lon, LAT = g.lat;
  let count = 0;
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]] || !visible(g, p, cap)) continue;
    const s = g.start[p], e = g.start[p + 1];
    const closed = LON[s] === LON[e - 1] && LAT[s] === LAT[e - 1];
    const last = closed ? e - 1 : e;
    st.polygonStart(); st.lineStart();
    for (let k = s; k < last; k++) st.point(LON[k], LAT[k]);
    st.lineEnd(); st.polygonEnd();
    count++;
  }
  return count;
}

/** Stream polygons/lines of the given levels as plain lines into the current canvas path. */
export function streamLines(ctx, projection, g, levels, cap) {
  const st = projection.stream(canvasSink(ctx));
  const want = new Uint8Array(256);
  for (const l of levels) want[l] = 1;
  const LON = g.lon, LAT = g.lat;
  let count = 0;
  for (let p = 0; p < g.npoly; p++) {
    if (!want[g.level[p]] || !visible(g, p, cap)) continue;
    const s = g.start[p], e = g.start[p + 1];
    st.lineStart();
    for (let k = s; k < e; k++) st.point(LON[k], LAT[k]);
    st.lineEnd();
    count++;
  }
  return count;
}

export function streamGeoJSON(ctx, projection, obj) {
  d3.geoStream(obj, projection.stream(canvasSink(ctx)));
}

const graticule10 = d3.geoGraticule().step([10, 10]);
const graticule30 = d3.geoGraticule().step([30, 30]);

/**
 * Draw the base map (ocean, graticule, land, coasts, borders) into ctx.
 * layers: {coast, borders} GSHB datasets; opts: {fill, graticule, borders2, cap, lineWidth, colors}
 */
export function drawBaseMap(ctx, projection, layers, opts) {
  const { coast, borders } = layers;
  const cap = opts.cap || null;
  const lw = opts.lineWidth || 1;
  const col = opts.colors;
  const sphere = { type: 'Sphere' };

  ctx.beginPath(); streamGeoJSON(ctx, projection, sphere);
  ctx.fillStyle = col.ocean; ctx.fill();

  if (opts.graticule) {
    ctx.beginPath(); streamGeoJSON(ctx, projection, opts.coarseGraticule ? graticule30() : graticule10());
    ctx.lineWidth = lw * 0.8; ctx.strokeStyle = col.graticule; ctx.stroke();
  }
  if (coast) {
    if (opts.fill) {
      ctx.beginPath(); streamPolygons(ctx, projection, coast, [1, 5], cap); ctx.fillStyle = col.land; ctx.fill();
      ctx.beginPath(); streamPolygons(ctx, projection, coast, [2], cap); ctx.fillStyle = col.ocean; ctx.fill();
      ctx.beginPath(); streamPolygons(ctx, projection, coast, [3], cap); ctx.fillStyle = col.land; ctx.fill();
      ctx.beginPath(); streamPolygons(ctx, projection, coast, [4], cap); ctx.fillStyle = col.ocean; ctx.fill();
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); streamLines(ctx, projection, coast, [2, 3, 4], cap);
    ctx.lineWidth = lw * 0.7; ctx.strokeStyle = col.lakeCoast; ctx.stroke();
    ctx.beginPath(); streamLines(ctx, projection, coast, [1, 5], cap);
    ctx.lineWidth = lw; ctx.strokeStyle = col.coast; ctx.stroke();
  }
  if (borders) {
    if (opts.borders2) {
      ctx.beginPath(); streamLines(ctx, projection, borders, [2], cap);
      ctx.lineWidth = lw * 0.6; ctx.strokeStyle = col.border; ctx.setLineDash([lw * 1.5, lw * 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); streamLines(ctx, projection, borders, [1], cap);
    ctx.lineWidth = lw * 0.9; ctx.strokeStyle = col.border; ctx.setLineDash([lw * 5, lw * 3]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.beginPath(); streamGeoJSON(ctx, projection, sphere);
  ctx.lineWidth = lw * 1.2; ctx.strokeStyle = col.coast; ctx.stroke();
}

export const COLORS = {
  ocean: '#d6e6f2', land: '#f7f2e8', coast: '#3d5a73', lakeCoast: '#6f8ea8', border: '#8a6b4f',
  graticule: 'rgba(61,90,115,0.16)', route: '#d1491f', routeHalo: 'rgba(255,255,255,0.85)',
  start: '#1f7a5c', end: '#d1491f', parallel: '#7d5ba6',
};

/** Draw a lon/lat polyline through the projection (handles antimeridian cuts and clipping). */
export function drawLine(ctx, projection, coords, style) {
  ctx.beginPath();
  streamGeoJSON(ctx, projection, { type: 'LineString', coordinates: coords });
  if (style.halo) { ctx.lineWidth = style.width + 3; ctx.strokeStyle = style.halo; ctx.setLineDash([]); ctx.stroke(); }
  ctx.lineWidth = style.width; ctx.strokeStyle = style.color; ctx.setLineDash(style.dash || []); ctx.stroke(); ctx.setLineDash([]);
}

/** Is a lon/lat point on the visible side of the projection? */
export function projectVisible(projection, lonlat) {
  const p = projection(lonlat);
  if (!p || !isFinite(p[0])) return null;
  const back = projection.invert(p);
  if (!back) return null;
  const d = d3.geoDistance(back, lonlat);
  return d < 1e-4 ? p : null;
}

export function drawMarker(ctx, pt, color, label, opts = {}) {
  const r = opts.r || 6;
  ctx.beginPath(); ctx.arc(pt[0], pt[1], r + 2.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
  ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  if (label) {
    ctx.font = `600 ${opts.fontSize || 12}px 'IBM Plex Sans', system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const dx = opts.left ? -1 : 1;
    ctx.textAlign = opts.left ? 'right' : 'left';
    const x = pt[0] + dx * (r + 6), y = pt[1];
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(label, x, y);
    ctx.fillStyle = color; ctx.fillText(label, x, y);
  }
}

export function drawArrow(ctx, from, to, color, size = 9) {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - size * Math.cos(a - 0.45), to[1] - size * Math.sin(a - 0.45));
  ctx.lineTo(to[0] - size * Math.cos(a + 0.45), to[1] - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}
