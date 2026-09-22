// Across the Ocean: wiring, data loading and the route computation.
import { fetchBuffer, parseGSHB, buildCoastIndex, nearestCoast } from './gshb.js';
import { xyz, lonlat, dirFromBearing, greatCircleHits, parallelHits, greatCirclePoints, pointAlong, bearingOfDir, norm, cross, dot, angle, R_KM, DEG, TAU, fmtLatLon, compass } from './geo.js';
import { Countries, Oceans, Cities } from './lookup.js';
import { Globe } from './globe.js';
import { Results } from './results.js';

const $ = (id) => document.getElementById(id);
const data = { coast: {}, borders: {}, rivers: {}, index: {} };
const lookups = { countries: null, oceans: null, cities: null };
const options = { fill: true, graticule: true, borders2: false, rivers: false, windowKm: 20 };
const loading = new Map();
const DATA_VERSION = '2026-09-21b'; // bump when files in data/ change, so browsers refetch them
let hiResRequested = null; // promise once the high-resolution coast has been requested

function status(msg) { $('status').textContent = msg; }
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
function progressText() {
  const parts = [];
  for (const [name, p] of loading) parts.push(p.total ? `${name} ${Math.round(100 * p.got / p.total)}%` : `${name}…`);
  return parts.length ? `loading ${parts.join(', ')}` : '';
}

async function loadGSHB(kind, res) {
  const name = `${kind}_${res}`;
  loading.set(name, { got: 0, total: 0 });
  try {
    const ab = await fetchBuffer(`data/${name}.bin?v=${DATA_VERSION}`, (got, total) => { loading.set(name, { got, total }); status(progressText()); });
    const g = parseGSHB(ab);
    if (kind === 'coast' && (res === 'i' || res === 'h')) data.index[res] = buildCoastIndex(g, [1, 5], res === 'h' ? 0.5 : 1);
    data[kind][res] = g;
    if (kind === 'coast') triangulate(g, res);
  } finally { loading.delete(name); status(progressText()); }
  globe.invalidate('high');
  return data[kind][res];
}

// ---------- land fill meshes (built in a worker) ----------
let fillWorker = null;
const fillJobs = new Map();
function triangulate(g, res) {
  if (!fillWorker) {
    try { fillWorker = new Worker('js/fillworker.js', { type: 'module' }); }
    catch (err) { console.warn('no worker for land fill', err); return; }
    fillWorker.onmessage = (e) => {
      const job = fillJobs.get(e.data.id); fillJobs.delete(e.data.id);
      if (job) globe.setFillMesh(job.g, e.data);
      loading.delete(`land ${job ? job.res : ''}`); status(progressText());
    };
    fillWorker.onerror = (e) => { console.warn('land fill worker failed', e.message); };
  }
  const id = `${res}-${Date.now()}`;
  fillJobs.set(id, { g, res });
  loading.set(`land ${res}`, { got: 0, total: 0 }); status(progressText());
  const lon = g.lon.slice(), lat = g.lat.slice(), start = g.start.slice(), level = g.level.slice();
  fillWorker.postMessage({ id, lon, lat, start, level, npoly: g.npoly, npts: g.npts }, [lon.buffer, lat.buffer, start.buffer, level.buffer]);
}

async function loadRivers() {
  for (const res of ['l', 'i']) if (!data.rivers[res]) await loadGSHB('rivers', res);
  if (data.coast.h && !data.rivers.h) await loadGSHB('rivers', 'h');
}

// ---------- globe ----------
const globe = new Globe({
  baseCanvas: $('base'), overlayCanvas: $('overlay'), data, options,
  onSnap: showHover,
  onClick: () => lookAcross(),
  onNeedHiRes: () => loadHiRes(),
  onStats: () => {},
});

function loadHiRes() {
  if (hiResRequested) return hiResRequested;
  $('opt-hires').checked = true;
  hiResRequested = Promise.all([loadGSHB('coast', 'h'), loadGSHB('borders', 'h')]).then(() => { toast('High-resolution coastline loaded'); globe.updateSnap(true); if (options.rivers) loadRivers(); });
  return hiResRequested;
}

let hoverTimer = null;
function showHover(snap) {
  const box = $('hover');
  if (!snap) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('hover-latlon').textContent = fmtLatLon(snap.lon, snap.lat);
  $('hover-bearing').textContent = `${compass(snap.bearing)} (${snap.bearing.toFixed(0)}°)`;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!lookups.countries || globe.snap !== snap) return;
    const c = lookups.countries.at(snap.lon, snap.lat);
    const w = lookups.oceans ? lookups.oceans.at(...seaward(snap, 3)) : null;
    $('hover-country').textContent = (c ? `Coast of ${c.feature.properties.name}` : 'Coast') + (w ? ` · ${w.name}` : '');
  }, 60);
  $('hover-country').textContent = 'Coast';
}

/** A point a few km out to sea from the snap point (for naming the water). */
function seaward(snap, km) {
  const d = dirFromBearing(snap.lon, snap.lat, snap.bearing);
  return lonlat(pointAlong(snap.xyz, d, km / R_KM));
}

// ---------- results ----------
const results = new Results({
  panel: $('results'), title: $('r-title'), summary: $('r-summary'), body: $('r-body'), canvas: $('worldmap'),
  select: $('projection'), note: $('proj-note'), fly: $('r-fly'), back: $('r-back'), share: $('r-share'), close: $('r-close'), handle: $('r-handle'), png: $('r-png'),
}, data.coast, {
  onFly: () => { const r = current; if (r) globe.flyAlong(r.coords, { scale: Math.max(globe.projection.scale(), 1800) }); },
  onBack: () => { const r = current; if (r) globe.flyAlong([...r.coords].reverse(), { scale: Math.max(globe.projection.scale(), 1800) }); },
  onShare: () => { navigator.clipboard?.writeText(location.href).then(() => toast('Link copied')); },
  onClose: () => { current = null; globe.setRoute(null); history.replaceState(null, '', location.pathname); },
});
results.layers = { get coast() { return data.coast.l || data.coast.c; }, get borders() { return data.borders.l || data.borders.c; } };

let current = null;

function describePlace(lon, lat) {
  const out = { lonlat: [lon, lat] };
  if (lookups.countries) {
    const c = lookups.countries.at(lon, lat);
    if (c) out.country = { name: c.feature.properties.name, props: c.feature.properties, distKm: c.distKm };
  }
  if (lookups.cities) { const n = lookups.cities.near(lon, lat); out.city = n.any; out.big = n.big; }
  return out;
}

function computeRoute(snap) {
  // Everything is computed on the coastline resolution the point was snapped to, so a
  // shared link (which records that resolution) reproduces the same route.
  const g = snap.g, res = snap.res;
  const P = snap.xyz;
  const bearing = snap.bearing;
  const d = dirFromBearing(snap.lon, snap.lat, bearing);
  const hits = greatCircleHits(g, P, d);
  const eps = 0.15 / R_KM;
  let end = null, warning = null;
  for (const h of hits) {
    if (h.alpha <= eps) continue;
    if (!h.entry) {
      if (!end && h.alpha * R_KM > 3 && !warning) warning = `The seaward perpendicular runs over land for ${Math.round(h.alpha * R_KM)} km before reaching open water (the coast here is very irregular). Try a smaller smoothing window, or pick a spot nearby.`;
      continue;
    }
    end = h; break;
  }
  if (!end) return null;
  const alpha = end.alpha;
  const distKm = alpha * R_KM;
  const n = norm(cross(P, d));
  const endDir = norm(cross(n, end.xyz));
  const finalBearing = bearingOfDir(end.lonlat[0], end.lonlat[1], endDir);
  const coords = greatCirclePoints(P, d, alpha, 0.25 * DEG);
  const midLonlat = lonlat(pointAlong(P, d, alpha / 2));

  // latitude extremes and named-line crossings
  let maxLat = { lat: -91 }, minLat = { lat: 91 };
  const crossings = [];
  const lines = [[0, 'the equator'], [23.4366, 'the Tropic of Cancer'], [-23.4366, 'the Tropic of Capricorn'], [66.5634, 'the Arctic Circle'], [-66.5634, 'the Antarctic Circle']];
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (lat > maxLat.lat) maxLat = { lon, lat };
    if (lat < minLat.lat) minLat = { lon, lat };
    if (i > 0) {
      const [plon, plat] = coords[i - 1];
      for (const [L, name] of lines) if ((plat < L) !== (lat < L) && !crossings.includes(name)) crossings.push(name);
      if (Math.abs(lon - plon) > 180 && !crossings.includes('the antimeridian (180°)')) crossings.push('the antimeridian (180°)');
      if ((plon < 0) !== (lon < 0) && Math.abs(lon - plon) < 180 && !crossings.includes('the prime meridian')) crossings.push('the prime meridian');
    }
  }

  // waters along the way
  const waters = [];
  if (lookups.oceans) {
    const N = Math.min(80, Math.max(12, Math.round(distKm / 100)));
    for (let i = 1; i < N; i++) {
      const w = lookups.oceans.at(...lonlat(pointAlong(P, d, alpha * i / N)));
      if (w && !waters.includes(w.name)) waters.push(w.name);
    }
  }

  // closest approach to other land along the route (excluding the ends)
  let closest = null;
  const idx = data.index[res];
  if (idx && distKm > 120) {
    const stepKm = Math.max(10, distKm / 600);
    for (let km = 60; km < distKm - 60; km += stepKm) {
      const q = lonlat(pointAlong(P, d, km / R_KM));
      const near = nearestCoast(g, idx, q[0], q[1], 2);
      if (!near || (closest && near.distRad >= closest.rad)) continue;
      // ignore the shores we leave from and arrive at
      if (angle(near.xyz, P) * R_KM < 150 || angle(near.xyz, end.xyz) * R_KM < 150) continue;
      closest = { rad: near.distRad, lonlat: [near.lon, near.lat], alongKm: km };
    }
    if (closest) { closest.km = closest.rad * R_KM; Object.assign(closest, describePlace(closest.lonlat[0], closest.lonlat[1])); if (closest.km > 2000) closest = null; }
  }

  // the "same latitude" comparison
  const eastward = dot(d, [-Math.sin(snap.lon * DEG), Math.cos(snap.lon * DEG), 0]) >= 0;
  let parallel = null;
  const ph = parallelHits(g, snap.lon, snap.lat, eastward);
  for (const h of ph) {
    if (h.delta < 0.003 || !h.entry) continue;
    const pc = [];
    const steps = Math.max(2, Math.ceil(h.delta / 0.5));
    for (let i = 0; i <= steps; i++) { let lo = snap.lon + (eastward ? 1 : -1) * h.delta * i / steps; lo = ((lo + 540) % 360) - 180; pc.push([lo, snap.lat]); }
    const alongKm = h.delta * DEG * Math.cos(snap.lat * DEG) * R_KM;
    parallel = { eastward, lonlat: h.lonlat, coords: pc, alongKm, gcKm: angle(P, xyz(h.lonlat[0], h.lonlat[1])) * R_KM, ...describePlace(h.lonlat[0], h.lonlat[1]) };
    break;
  }

  const start = describePlace(snap.lon, snap.lat);
  start.coastBearing = snap.tangentBearing;
  if (lookups.oceans) { const w = lookups.oceans.at(...seaward(snap, 3)); if (w) start.water = w.name; }
  const endPlace = describePlace(end.lonlat[0], end.lonlat[1]);
  if (lookups.oceans) { const back = lonlat(pointAlong(P, d, alpha - 3 / R_KM)); const w = lookups.oceans.at(...back); if (w) endPlace.water = w.name; }

  return {
    start, end: endPlace, bearing, finalBearing, distKm, chordKm: 2 * R_KM * Math.sin(alpha / 2), coords, midLonlat,
    maxLat, minLat, crossings, waters, closest, parallel, warning, windowKm: options.windowKm, res,
  };
}

let computing = false;
function lookAcross() {
  const snap = globe.snap;
  if (!snap) { toast('Click a point on the coastline'); return; }
  if (computing) return;
  computing = true;
  // Paint the indicator first; the (synchronous) computation starts after the browser has had a chance to draw it.
  globe.setRoute(null);
  globe.setBusy([snap.lon, snap.lat]);
  status('Calculating the route…');
  const hint = document.querySelector('.click-hint');
  if (hint) hint.textContent = 'Calculating…';
  const go = $('go'); go.disabled = true; go.textContent = 'Calculating…';
  setTimeout(() => {
    const t0 = performance.now();
    let r = null;
    try { r = computeRoute(snap); }
    finally {
      globe.setBusy(null);
      status('');
      if (hint) hint.innerHTML = 'Click to look across (or press <kbd>Space</kbd>)';
      go.disabled = false; go.textContent = 'Look across';
      computing = false;
    }
    if (!r) { toast('Could not find land along that line'); return; }
    current = r;
    globe.setRoute(r);
    results.show(r);
    location.hash = `p=${snap.lat.toFixed(5)},${snap.lon.toFixed(5)}&w=${options.windowKm}&r=${snap.res}`;
    console.log(`route computed in ${(performance.now() - t0).toFixed(0)} ms`, r);
  }, 40);
}

// ---------- UI wiring ----------
$('go').addEventListener('click', lookAcross);
$('menu').addEventListener('click', () => {
  const open = $('options').classList.toggle('hidden') === false;
  $('menu').setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (e) => {
  if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
  if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); lookAcross(); }
  if (e.key === 'Escape' && current) results.hide();
});
$('window').addEventListener('input', (e) => {
  options.windowKm = +e.target.value;
  $('window-out').textContent = `${options.windowKm} km`;
  globe.refreshSnap();
});
$('opt-fill').addEventListener('change', (e) => { options.fill = e.target.checked; globe.invalidate('high'); });
$('opt-graticule').addEventListener('change', (e) => { options.graticule = e.target.checked; globe.invalidate('high'); });
$('opt-borders2').addEventListener('change', (e) => { options.borders2 = e.target.checked; globe.invalidate('high'); });
$('opt-rivers').addEventListener('change', (e) => { options.rivers = e.target.checked; if (options.rivers) loadRivers(); globe.invalidate('high'); });
$('opt-hires').addEventListener('change', (e) => { if (e.target.checked) loadHiRes(); });
$('north-up').addEventListener('click', () => globe.northUp());

// ---------- data loading ----------
async function loadJSON(url, name) {
  loading.set(name, { got: 0, total: 0 }); status(progressText());
  try { const r = await fetch(url); return await r.json(); }
  finally { loading.delete(name); status(progressText()); }
}

async function main() {
  await loadGSHB('coast', 'c');
  loadGSHB('borders', 'c');
  const pI = Promise.all([loadGSHB('coast', 'l'), loadGSHB('borders', 'l'), loadGSHB('coast', 'i'), loadGSHB('borders', 'i')]);
  const pL = Promise.all([
    loadJSON(`data/countries.json?v=${DATA_VERSION}`, 'countries').then(fc => { lookups.countries = new Countries(fc); }),
    loadJSON(`data/oceans.json?v=${DATA_VERSION}`, 'seas').then(fc => { lookups.oceans = new Oceans(fc); }),
    loadJSON(`data/cities.json?v=${DATA_VERSION}`, 'places').then(rows => { lookups.cities = new Cities(rows); }),
  ]);
  await Promise.all([pI, pL]);
  status('');
  const m = /p=(-?[\d.]+),(-?[\d.]+)(?:&w=(\d+))?(?:&r=([clih]))?/.exec(location.hash);
  if (m) {
    if (m[3]) { options.windowKm = +m[3]; $('window').value = m[3]; $('window-out').textContent = `${m[3]} km`; }
    const lat = +m[1], lon = +m[2];
    const res = m[4] || 'i';
    if (res === 'h') await loadHiRes();
    globe.flyTo(lon, lat, Math.max(globe.projection.scale(), 900), 10);
    setTimeout(() => { if (globe.snapTo(lon, lat, res)) lookAcross(); }, 80);
  }
}
window.ato = { globe, lookAcross, computeRoute, data, lookups, options, results };
main().catch(err => { console.error(err); status(`error: ${err.message}`); });
