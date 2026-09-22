// Results panel: world map with selectable projection, route, markers and facts.
import { drawBaseMap, COLORS, drawLine, projectVisible, drawMarker, drawArrow } from './render.js';
import { fmtLatLon, fmtDist, fmtKm, compass, compassWord, R_KM, DEG } from './geo.js';
import { localTime, utcOffsetMinutes } from './lookup.js';

const PROJECTIONS = [
  { id: 'naturalearth', name: 'Natural Earth', make: () => d3.geoNaturalEarth1(), world: true },
  { id: 'equirect', name: 'Equirectangular (plate carrée)', make: () => d3.geoEquirectangular(), world: true, note: 'Lines of latitude are straight here, which is why the "same latitude" idea looks so tidy on this kind of map.' },
  { id: 'mercator', name: 'Mercator', make: () => d3.geoMercator(), world: true, note: 'Great circles bend on a Mercator map; the shortest route rarely looks like it.' },
  { id: 'equalearth', name: 'Equal Earth', make: () => d3.geoEqualEarth(), world: true },
  { id: 'robinson', name: 'Robinson', make: () => d3.geoRobinson(), world: true },
  { id: 'winkel3', name: 'Winkel tripel', make: () => d3.geoWinkel3(), world: true },
  { id: 'mollweide', name: 'Mollweide', make: () => d3.geoMollweide(), world: true },
  { id: 'ortho', name: 'Orthographic globe, centred on the route', make: () => d3.geoOrthographic(), center: 'mid', note: 'A globe seen from far above the middle of the route.' },
  { id: 'azeq', name: 'Azimuthal equidistant, centred on the start', make: () => d3.geoAzimuthalEquidistant(), center: 'start', note: 'From the centre point every direction and distance is true: the route is a straight line, and its length on the map is proportional to the distance.' },
  { id: 'gnomonic', name: 'Gnomonic, centred on the route', make: () => d3.geoGnomonic().clipAngle(75), center: 'mid', note: 'Every great circle is a straight line on a gnomonic map. Only the hemisphere around the route can be shown.' },
  { id: 'twopoint', name: 'Two-point equidistant (start and far shore)', make: (r) => r.bearing > 180 ? d3.geoTwoPointEquidistant(r.end.lonlat, r.start.lonlat) : d3.geoTwoPointEquidistant(r.start.lonlat, r.end.lonlat), note: 'Distances from both the start and the far shore are true everywhere on this map.' },
  { id: 'stereo', name: 'Stereographic, centred on the route', make: () => d3.geoStereographic().clipAngle(120), center: 'mid' },
];

export class Results {
  constructor(els, layers, hooks) {
    this.els = els;           // { panel, title, summary, body, canvas, select, note, fly, back, share, close, png }
    this.layers = layers;     // { coast, borders } for the world map (low resolution)
    this.hooks = hooks;       // { onFly, onBack, onShare, onClose }
    this.projId = 'naturalearth';
    this.result = null;
    for (const p of PROJECTIONS) {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; this.els.select.appendChild(o);
    }
    this.els.select.addEventListener('change', () => { this.projId = this.els.select.value; this.draw(); });
    this.els.fly.addEventListener('click', () => hooks.onFly());
    this.els.back.addEventListener('click', () => hooks.onBack());
    this.els.share.addEventListener('click', () => hooks.onShare());
    this.els.close.addEventListener('click', () => this.hide());
    this.els.collapse.addEventListener('click', () => this.setCollapsed(true));
    this.els.expand.addEventListener('click', () => this.setCollapsed(false));
    this.els.png.addEventListener('click', () => this.download());
    window.addEventListener('resize', () => { if (this.result) this.draw(); });
  }

  hide() {
    this.els.panel.classList.add('hidden');
    document.body.classList.remove('panel-open', 'panel-collapsed');
    this.hooks.onClose();
  }

  setCollapsed(collapsed) {
    document.body.classList.toggle('panel-collapsed', collapsed);
    if (!collapsed) setTimeout(() => this.draw(), 260);   // the map's width is known once the panel has re-expanded
  }

  show(result) {
    this.result = result;
    this.els.panel.classList.remove('hidden');
    document.body.classList.add('panel-open');
    document.body.classList.remove('panel-collapsed');
    this.els.panel.scrollTop = 0;
    this.renderText(result);
    this.draw();
  }

  projection() {
    const r = this.result;
    const def = PROJECTIONS.find(p => p.id === this.projId) || PROJECTIONS[0];
    const proj = def.make(r);
    const mid = r.midLonlat;
    if (def.world) proj.rotate([-mid[0], 0]);
    else if (def.center === 'mid') proj.rotate([-mid[0], -mid[1]]);
    else if (def.center === 'start') proj.rotate([-r.start.lonlat[0], -r.start.lonlat[1]]);
    return { proj, def };
  }

  draw() {
    const canvas = this.els.canvas, r = this.result;
    if (!r) return;
    const cssW = canvas.clientWidth || 560;
    const { proj, def } = this.projection();
    const cssH = Math.round(cssW * (def.world ? 0.62 : 0.85));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pad = 8;
    const routeDeg = r.distKm / R_KM / DEG;
    let fitTo = { type: 'Sphere' };
    if (def.center === 'start') fitTo = d3.geoCircle().center(r.start.lonlat).radius(Math.min(179, routeDeg + 25))();
    else if (def.center === 'mid' && def.id !== 'ortho') fitTo = d3.geoCircle().center(r.midLonlat).radius(Math.min(def.id === 'gnomonic' ? 72 : 110, routeDeg / 2 + 25))();
    proj.fitExtent([[pad, pad], [cssW - pad, cssH - pad]], fitTo);
    proj.precision(0.5);
    this.els.note.textContent = def.note || '';
    drawBaseMap(ctx, proj, this.layers, { fill: true, graticule: true, coarseGraticule: !!def.coarse, borders2: false, cap: null, lineWidth: 0.7, colors: COLORS });
    if (r.parallel) drawLine(ctx, proj, r.parallel.coords, { width: 1.6, color: COLORS.parallel, dash: [5, 4], halo: COLORS.routeHalo });
    drawLine(ctx, proj, r.coords, { width: 2.2, color: COLORS.route, halo: COLORS.routeHalo });
    // arrow head near the far shore, using the last visible stretch of the route
    const n = r.coords.length;
    let a = null, b = null;
    for (let i = n - 1; i >= Math.max(0, n - 12) && !(a && b); i--) { const p = projectVisible(proj, r.coords[i]); if (!p) break; if (!b) b = p; else a = p; }
    if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) drawArrow(ctx, a, b, COLORS.route, 9);
    if (r.parallel) { const pp = projectVisible(proj, r.parallel.lonlat); if (pp) drawMarker(ctx, pp, COLORS.parallel, 'same latitude', { r: 3.5, fontSize: 10.5 }); }
    const ps = projectVisible(proj, r.start.lonlat), pe = projectVisible(proj, r.end.lonlat);
    const left = ps && pe && pe[0] < ps[0];
    if (ps) drawMarker(ctx, ps, COLORS.start, 'Start', { r: 4.5, fontSize: 11, left });
    if (pe) drawMarker(ctx, pe, COLORS.end, r.end.country ? r.end.country.name : 'Across', { r: 4.5, fontSize: 11, left: !left });
  }

  download() {
    const r = this.result;
    if (!r) return;
    const a = document.createElement('a');
    a.download = `across-the-ocean-${r.start.lonlat[1].toFixed(2)}_${r.start.lonlat[0].toFixed(2)}.png`;
    a.href = this.els.canvas.toDataURL('image/png');
    a.click();
  }

  renderText(r) {
    const s = r.start, e = r.end;
    const cname = (c) => c ? c.name : 'unknown country';
    this.els.title.textContent = `${cname(s.country)} → ${cname(e.country)}`;
    this.els.summary.innerHTML =
      `Standing on the shore${s.city ? ` near <b>${esc(s.city.name)}</b>` : ''} in <b>${esc(cname(s.country))}</b> and looking straight out to sea (${compassWord(r.bearing)}, ${r.bearing.toFixed(0)}°), ` +
      `the first land you would reach is <b>${esc(cname(e.country))}</b>${e.city ? `, near <b>${esc(e.city.name)}</b>` : ''}, ` +
      `<b>${fmtKm(r.distKm)}</b> away across ${r.waters.length ? listNames(r.waters) : 'the sea'}.`;

    const groups = [];
    if (r.warning) groups.push(`<div class="warn">${esc(r.warning)}</div>`);

    groups.push(factGroup('The route', COLORS.route, [
      ['Great-circle distance', fmtDist(r.distKm)],
      ['Share of Earth\'s girth', `${(100 * r.distKm / (2 * Math.PI * R_KM)).toFixed(1)}% of the way around the world`],
      ['Direction at the start', `${compassWord(r.bearing)} (${r.bearing.toFixed(1)}°), perpendicular to the coast smoothed over ±${r.windowKm} km`],
      ['Direction on arrival', `${compassWord(r.finalBearing)} (${r.finalBearing.toFixed(1)}°): the same straight line, but the compass heading drifts as you follow a great circle`],
      ['Waters crossed', r.waters.length ? r.waters.map(esc).join(' → ') : '—'],
      ['Highest / lowest latitude', `${fmtLatLon(r.maxLat.lon, r.maxLat.lat)} and ${fmtLatLon(r.minLat.lon, r.minLat.lat)}`],
      ['Lines crossed', r.crossings.length ? r.crossings.join(', ') : 'none of the named ones'],
      r.closest ? ['Closest brush with other land', `${fmtKm(r.closest.km)} off ${r.closest.country ? esc(r.closest.country.name) : 'an unnamed shore'}${r.closest.city ? ` (near ${esc(r.closest.city.name)})` : ''}, ${fmtKm(r.closest.alongKm)} into the trip`] : null,
      ['Straight through the Earth', `${fmtKm(r.chordKm)} (a tunnel from shore to shore)`],
      ['Time to get there', travelTimes(r.distKm)],
    ]));

    groups.push(placeGroup('Where you are standing', COLORS.start, s, r));
    groups.push(placeGroup('The far shore', COLORS.end, e, r));

    if (s.city && e.city && s.city.tz && e.city.tz) {
      const o1 = utcOffsetMinutes(s.city.tz), o2 = utcOffsetMinutes(e.city.tz);
      if (o1 !== null && o2 !== null) {
        const dh = (o2 - o1) / 60;
        groups.push(factGroup('Clocks', null, [
          ['Local time now', `${localTime(s.city.tz)} at the start, ${localTime(e.city.tz)} across the water`],
          ['Time difference', dh === 0 ? 'none' : `${Math.abs(dh)} hour${Math.abs(dh) === 1 ? '' : 's'} ${dh > 0 ? 'ahead' : 'behind'} (${s.city.tz} → ${e.city.tz})`],
        ]));
      }
    }

    const p = r.parallel;
    groups.push(factGroup('The "same latitude" answer, for comparison', COLORS.parallel, p ? [
      ['Following the parallel', `${p.eastward ? 'east' : 'west'} along ${fmtLatLon(s.lonlat[0], s.lonlat[1]).split(' ')[0]}`],
      ['You reach', `${p.country ? esc(p.country.name) : 'land'}${p.city ? `, near ${esc(p.city.name)}` : ''} at ${fmtLatLon(p.lonlat[0], p.lonlat[1])}`],
      ['Distance along the parallel', `${fmtKm(p.alongKm)} (${fmtKm(p.gcKm)} as the crow flies)`],
      ['Verdict', p.country && e.country && p.country.name === e.country.name ? 'Same country either way.' : 'A different answer from looking straight out to sea.'],
    ] : [['Following the parallel', 'this line of latitude circles the globe without touching land']]));

    groups.push(`<p class="hint credits">Shorelines: GSHHG 2.3.7 (${r.res === 'h' ? 'high' : r.res === 'i' ? 'intermediate' : 'low'} resolution used for this route). Country and sea names: Natural Earth. Places: GeoNames. Distances use a sphere of radius 6371 km.</p>`);
    this.els.body.innerHTML = groups.join('');
  }
}

function placeGroup(title, color, pl, r) {
  const c = pl.country, p = c ? c.props : null;
  const rows = [
    ['Position', fmtLatLon(pl.lonlat[0], pl.lonlat[1])],
    ['Country', c ? `${wiki(c.name)}${p.formal && p.formal !== c.name ? ` <span class="muted">(${esc(p.formal)})</span>` : ''}${c.distKm > 5 ? ` <span class="muted">— nearest mapped country, ${fmtKm(c.distKm)} away</span>` : ''}` : 'no country found'],
    p && p.sov !== p.admin ? ['Sovereign state', esc(p.sov)] : null,
    p && p.type && p.type !== 'Sovereign country' && p.type !== 'Country' ? ['Status', esc(p.type)] : null,
    p ? ['Region', `${esc(p.subregion || '')}${p.continent ? `, ${esc(p.continent)}` : ''}`] : null,
    p && p.pop ? ['Population', `${fmtBig(p.pop)}${p.popYear ? ` (${p.popYear})` : ''}`] : null,
    p && p.gdp ? ['GDP', `US$ ${fmtBig(p.gdp * 1e6)}${p.gdpYear ? ` (${p.gdpYear})` : ''}${p.income ? `, ${esc(p.income.replace(/^\d+\.\s*/, ''))}` : ''}`] : null,
    pl.city ? ['Nearest town', `${wikiCity(pl.city)} (${pl.city.capital ? 'capital, ' : ''}pop. ${fmtBig(pl.city.pop)}), ${fmtKm(pl.city.km)} to the ${compassWord(pl.city.bearing)}`] : null,
    pl.big && (!pl.city || pl.big.name !== pl.city.name) ? ['Nearest big city', `${wikiCity(pl.big)} (pop. ${fmtBig(pl.big.pop)}), ${fmtKm(pl.big.km)} to the ${compassWord(pl.big.bearing)}`] : null,
    pl.water ? ['Water at your feet', esc(pl.water)] : null,
    pl.coastBearing !== undefined ? ['Coast runs', `${compass(pl.coastBearing)}–${compass(pl.coastBearing + 180)}`] : null,
  ];
  return factGroup(title, color, rows);
}

function factGroup(title, color, rows) {
  const items = rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<section class="fact-group"><h3>${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(title)}</h3><dl class="facts">${items}</dl></section>`;
}

function travelTimes(km) {
  const fmt = (h) => h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : h < 24 * 60 ? `${(h / 24).toFixed(1)} days` : `${(h / 24 / 30.44).toFixed(1)} months`;
  return `${fmt(km / 900)} by airliner, ${fmt(km / (20 * 1.852))} by container ship, ${fmt(km / (6 * 1.852))} under sail, ${fmt(km / 3)} swimming non-stop`;
}

function listNames(a) {
  if (a.length === 1) return `the ${esc(a[0])}`;
  return `the ${a.slice(0, -1).map(esc).join(', the ')} and the ${esc(a[a.length - 1])}`;
}
function fmtBig(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} trillion`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  return Math.round(n).toLocaleString();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function wiki(name) { return `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}" target="_blank" rel="noopener">${esc(name)}</a>`; }
function wikiCity(c) { return `<a href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">${esc(c.name)}</a>`; }
