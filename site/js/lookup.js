// Country, sea and city lookups built on Natural Earth and GeoNames extracts.
import { xyz, dot, angle, R_KM, initialBearing, compass } from './geo.js';

export class Countries {
  constructor(fc) {
    this.features = fc.features;
    // flat vertex table for nearest-polygon fallback (the GSHHG shore may sit just outside NE's 50m polygons)
    let n = 0;
    for (const f of this.features) for (const ring of rings(f.geometry)) n += ring.length;
    this.vx = new Float64Array(n * 3);
    this.vf = new Uint16Array(n);
    let i = 0;
    this.features.forEach((f, fi) => {
      for (const ring of rings(f.geometry)) for (const [lon, lat] of ring) {
        const v = xyz(lon, lat);
        this.vx[3 * i] = v[0]; this.vx[3 * i + 1] = v[1]; this.vx[3 * i + 2] = v[2]; this.vf[i] = fi; i++;
      }
    });
  }
  /** @returns {{feature, distKm}} the containing country, or the nearest one with its distance. */
  at(lon, lat) {
    const pt = [lon, lat];
    let hit = null;
    for (const f of this.features) if (d3.geoContains(f, pt)) { hit = f; break; }
    if (hit) return { feature: hit, distKm: 0 };
    const q = xyz(lon, lat);
    let best = -2, bi = -1;
    const V = this.vx;
    for (let i = 0; i < this.vf.length; i++) {
      const d = V[3 * i] * q[0] + V[3 * i + 1] * q[1] + V[3 * i + 2] * q[2];
      if (d > best) { best = d; bi = i; }
    }
    if (bi < 0) return null;
    return { feature: this.features[this.vf[bi]], distKm: Math.acos(Math.min(1, best)) * R_KM };
  }
}

export class Oceans {
  constructor(fc) { this.features = fc.features; }
  at(lon, lat) {
    const pt = [lon, lat];
    let best = null;
    for (const f of this.features) {
      if (!d3.geoContains(f, pt)) continue;
      if (!best || f.properties.rank > best.properties.rank) best = f;
    }
    return best ? best.properties : null;
  }
}

export class Cities {
  /** rows: [name, lat, lon, pop, cc, capital, tz] sorted by population desc */
  constructor(rows) {
    this.rows = rows;
    const n = rows.length;
    this.vx = new Float64Array(n * 3);
    rows.forEach((r, i) => { const v = xyz(r[2], r[1]); this.vx[3 * i] = v[0]; this.vx[3 * i + 1] = v[1]; this.vx[3 * i + 2] = v[2]; });
  }
  /** Nearest place overall and nearest with population >= minBig. */
  near(lon, lat, minBig = 100000) {
    const q = xyz(lon, lat);
    const V = this.vx;
    let b1 = -2, i1 = -1, b2 = -2, i2 = -1;
    for (let i = 0; i < this.rows.length; i++) {
      const d = V[3 * i] * q[0] + V[3 * i + 1] * q[1] + V[3 * i + 2] * q[2];
      if (d > b1) { b1 = d; i1 = i; }
      if (d > b2 && this.rows[i][3] >= minBig) { b2 = d; i2 = i; }
    }
    const mk = (i, c) => {
      if (i < 0) return null;
      const r = this.rows[i];
      const v = [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
      const km = Math.acos(Math.min(1, c)) * R_KM;
      return { name: r[0], lat: r[1], lon: r[2], pop: r[3], cc: r[4], capital: !!r[5], tz: r[6], km, bearing: initialBearing(q, v), dir: compass(initialBearing(q, v)) };
    };
    return { any: mk(i1, b1), big: mk(i2, b2) };
  }
}

function rings(geom) {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

export function utcOffsetMinutes(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date);
    const s = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(s);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (60 * +m[2] + (+m[3] || 0));
  } catch { return null; }
}
export function localTime(tz, date = new Date()) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(date); }
  catch { return null; }
}
