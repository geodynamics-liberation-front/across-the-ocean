// Interactive orthographic globe: versor drag/zoom, coast-snapping cursor, route overlay.
import { nearestCoast } from './gshb.js';
import { coastNormal, xyz, dirFromBearing, pointAlong, DEG } from './geo.js';
import { drawBaseMap, viewCap, COLORS, drawLine, projectVisible, drawMarker, drawArrow } from './render.js';
import { GLRenderer, parseColor } from './glrenderer.js';

const GLC = {
  bg: parseColor('#b9d0e2'), ocean: parseColor(COLORS.ocean), land: parseColor(COLORS.land),
  coast: parseColor(COLORS.coast), lakeCoast: parseColor(COLORS.lakeCoast), border: parseColor(COLORS.border),
  graticule: parseColor(COLORS.graticule), river: parseColor('#7ea3c2'),
};
const coastClass = (l) => (l === 1 || l === 5) ? 'coast' : 'lake';
const borderClass = (l) => l === 1 ? 'national' : 'internal';
const riverClass = () => 'river';

const ORDER = ['c', 'l', 'i', 'h'];
const ROUTE_ANIM_MS = 900;
const TOUCH_OFFSET = 44;        // px: the coast probe sits this far above the fingertip so it stays visible

export class Globe {
  constructor(opts) {
    this.baseCanvas = opts.baseCanvas;
    this.overlayCanvas = opts.overlayCanvas;
    this.data = opts.data;           // { coast: {c,l,i,h}, borders: {c,l,i,h}, index: {i,h} }
    this.options = opts.options;     // { fill, graticule, borders2, windowKm }
    this.onSnap = opts.onSnap || (() => {});
    this.onNeedHiRes = opts.onNeedHiRes || (() => {});
    this.onClick = opts.onClick || (() => {});
    this.onStats = opts.onStats || (() => {});
    try { this.glr = new GLRenderer(this.baseCanvas); }
    catch (err) { console.warn('WebGL2 unavailable, using the canvas renderer:', err.message); this.glr = null; this.baseCtx = this.baseCanvas.getContext('2d'); }
    this.ovCtx = this.overlayCanvas.getContext('2d');
    this.projection = d3.geoOrthographic().clipAngle(90).precision(0.7).rotate([30, -25, 0]);
    this.route = null;
    this.routeStart = 0;      // time the current route was set, for the grow-in animation
    this.busy = null;         // { lonlat, t0 } while a route is being computed
    this.lastTouch = -Infinity;        // time of the last touch, to ignore the click a tap produces
    this.snap = null;
    this.pointer = null;
    this.interacting = false;
    this.flying = false;
    this.needBase = 'high';
    this.needOverlay = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // the globe's container shrinks when the results panel is open; keep the globe centred in it
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(this.baseCanvas.parentElement);
    this.setupZoom();
    this.setupPointer();
    this.setupTouch();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.baseCanvas.clientWidth, h = this.baseCanvas.clientHeight;
    this.overlayCanvas.width = Math.round(w * dpr); this.overlayCanvas.height = Math.round(h * dpr);
    this.ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.glr) { this.baseCanvas.width = Math.round(w * dpr); this.baseCanvas.height = Math.round(h * dpr); this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    this.w = w; this.h = h;
    this.baseScale = Math.min(w, h) / 2.3;
    if (!this.scaleInit) { this.projection.scale(this.baseScale); this.scaleInit = true; }
    this.projection.translate([w / 2, h / 2]).clipExtent([[0, 0], [w, h]]);
    if (this.zoom) this.zoom.scaleExtent([this.baseScale * 0.45, 8e5]);
    this.invalidate('high');
  }

  invalidate(level = 'high') {
    if (level === 'high' || this.needBase !== 'high') this.needBase = level;
    this.needOverlay = true;
  }

  bestRes() { for (let i = ORDER.length - 1; i >= 0; i--) if (this.data.coast[ORDER[i]] && (i < 2 || this.data.index[ORDER[i]])) return ORDER[i]; return null; }

  displayRes(interacting) {
    const s = this.projection.scale();
    let want;
    if (this.glr) want = s < 600 ? 'l' : s < 9000 ? 'i' : 'h';
    else want = interacting ? (s < 2500 ? 'l' : s < 40000 ? 'i' : 'h') : (s < 1000 ? 'l' : s < 12000 ? 'i' : 'h');
    if (want === 'h' && !this.data.coast.h) this.onNeedHiRes();
    let i = ORDER.indexOf(want);
    while (i >= 0 && !this.data.coast[ORDER[i]]) i--;
    return i >= 0 ? ORDER[i] : null;
  }

  // ---------- rendering ----------
  loop() {
    if (this.needBase) {
      const quality = this.needBase;
      this.needBase = null;
      this.renderBase(quality === 'low');
      this.needOverlay = true;
    }
    if (this.needOverlay) { this.needOverlay = false; this.renderOverlay(); }
    if (this.busy || (this.route && performance.now() - this.routeStart < ROUTE_ANIM_MS)) this.needOverlay = true;
    requestAnimationFrame(this.loop);
  }

  renderBase(low) {
    if (this.glr) return this.renderGL();
    const res = this.displayRes(low);
    const ctx = this.baseCtx;
    ctx.clearRect(0, 0, this.w, this.h);
    const t0 = performance.now();
    const cap = viewCap(this.projection, this.w, this.h);
    drawBaseMap(ctx, this.projection, { coast: res && this.data.coast[res], borders: res && (this.data.borders[res] || this.data.borders.l || this.data.borders.c) }, {
      fill: this.options.fill, graticule: this.options.graticule, borders2: this.options.borders2, cap,
      lineWidth: 1, colors: COLORS,
    });
    this.onStats({ res, ms: performance.now() - t0, low, scale: this.projection.scale() });
  }

  /** Fill mesh from the triangulation worker for a coast dataset. */
  setFillMesh(g, mesh) { if (this.glr) { this.glr.layerFor(g, coastClass); this.glr.setFill(g, mesh); this.invalidate('high'); } }

  renderGL() {
    const glr = this.glr, proj = this.projection, o = this.options;
    const t0 = performance.now();
    const s = proj.scale();
    const view = { rotate: proj.rotate(), scale: s, translate: proj.translate(), width: this.w, height: this.h, dpr: window.devicePixelRatio || 1 };
    glr.begin(view, GLC.bg);
    glr.drawDisc(GLC.ocean, GLC.coast, 0.6);
    if (o.graticule) { const G = this.graticuleLayer(); if (G) glr.drawLines(G, 'all', GLC.graticule, 0.8); }
    const res = this.displayRes(false);
    if (!res) return;
    const g = this.data.coast[res];
    const L = glr.layerFor(g, coastClass);
    // land fill: the displayed resolution if its mesh is ready, else the best lower one that is
    let Lf = null;
    for (let i = ORDER.indexOf(res); i >= 0 && !Lf; i--) { const gg = this.data.coast[ORDER[i]]; if (gg) { const ll = glr.layerFor(gg, coastClass); if (ll.fill) Lf = ll; } }
    this.lastFillRes = Lf ? ORDER.find(r => this.data.coast[r] && glr.layers.get(this.data.coast[r]) === Lf) : null;
    if (o.fill && Lf) {
      glr.drawFill(Lf, [1, 5], GLC.land); glr.drawFill(Lf, [2], GLC.ocean); glr.drawFill(Lf, [3], GLC.land); glr.drawFill(Lf, [4], GLC.ocean);
    }
    if (o.rivers) { const r = this.data.rivers[res] || this.data.rivers.i || this.data.rivers.l; if (r) glr.drawLines(glr.layerFor(r, riverClass), 'river', GLC.river, 0.8); }
    glr.drawLines(L, 'lake', GLC.lakeCoast, 0.8);
    glr.drawLines(L, 'coast', GLC.coast, 1.1);
    const b = this.data.borders[res] || this.data.borders.i || this.data.borders.l || this.data.borders.c;
    if (b) {
      const Lb = glr.layerFor(b, borderClass);
      if (o.borders2) glr.drawLines(Lb, 'internal', [...GLC.border.slice(0, 3), 0.55], 0.7);
      glr.drawLines(Lb, 'national', [...GLC.border.slice(0, 3), 0.9], 1.0);
    }
    this.onStats({ res, ms: performance.now() - t0, low: false, scale: s, gl: true });
  }

  /** Graticule lines: a global 10° net, or a finer local net when zoomed in. */
  graticuleLayer() {
    const s = this.projection.scale();
    const glr = this.glr;
    if (s < 5000) {
      if (!this.grat10) this.grat10 = glr.lineLayer(...polylinesToBuffers(globalGraticule(10, 0.5)));
      return this.grat10;
    }
    const cap = viewCap(this.projection, this.w, this.h);
    const c = [Math.atan2(cap.c[1], cap.c[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, cap.c[2]))) / DEG];
    const rad = Math.min(60, cap.rad / DEG * 1.2 + 0.5);
    const step = rad > 20 ? 10 : rad > 4 ? 1 : rad > 0.8 ? 0.25 : 0.05;
    const key = [Math.round(c[0] / step), Math.round(c[1] / step), Math.round(rad / step), step].join('|');
    if (this.gratLocal && this.gratLocal.key === key) return this.gratLocal.layer;
    const lat0 = Math.max(-90, c[1] - rad), lat1 = Math.min(90, c[1] + rad);
    const cosl = Math.max(0.05, Math.cos(c[1] * DEG));
    const dlon = Math.min(180, rad / cosl);
    const lon0 = c[0] - dlon, lon1 = c[0] + dlon;
    const prec = step / 8;
    const lines = [];
    for (let lo = Math.ceil(lon0 / step) * step; lo <= lon1; lo += step) {
      const l = []; for (let la = lat0; la <= lat1 + 1e-9; la += prec) l.push([lo, Math.min(90, la)]); lines.push(l);
    }
    for (let la = Math.ceil(lat0 / step) * step; la <= lat1; la += step) {
      const l = []; for (let lo = lon0; lo <= lon1 + 1e-9; lo += prec) l.push([lo, la]); lines.push(l);
    }
    if (this.gratLocal) { glr.gl.deleteBuffer(this.gratLocal.layer.pos); glr.gl.deleteBuffer(this.gratLocal.layer.flags); }
    this.gratLocal = { key, layer: glr.lineLayer(...polylinesToBuffers(lines)) };
    return this.gratLocal.layer;
  }

  renderOverlay() {
    const ctx = this.ovCtx, proj = this.projection;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.route) {
      const r = this.route;
      const progress = Math.min(1, d3.easeCubicOut(Math.min(1, (performance.now() - this.routeStart) / ROUTE_ANIM_MS)));
      const shown = progress >= 1 ? r.coords : r.coords.slice(0, Math.max(2, Math.round(r.coords.length * progress)));
      if (r.parallel && progress >= 1) drawLine(ctx, proj, r.parallel.coords, { width: 2, color: COLORS.parallel, dash: [6, 5], halo: COLORS.routeHalo });
      drawLine(ctx, proj, shown, { width: 2.5, color: COLORS.route, halo: COLORS.routeHalo });
      const ps = projectVisible(proj, r.start.lonlat), pe = projectVisible(proj, r.end.lonlat);
      if (r.parallel && progress >= 1) { const pp = projectVisible(proj, r.parallel.lonlat); if (pp) drawMarker(ctx, pp, COLORS.parallel, 'same latitude', { r: 4, fontSize: 11 }); }
      if (ps) drawMarker(ctx, ps, COLORS.start, 'Start');
      if (pe && progress >= 1) drawMarker(ctx, pe, COLORS.end, 'Across the ocean');
    }
    if (this.busy) {
      // pulsing rings around the clicked point while the route is computed
      const pt = projectVisible(proj, this.busy.lonlat);
      if (pt) {
        const t = performance.now() - this.busy.t0;
        for (const phase of [0, 450]) {
          const u = ((t + phase) % 900) / 900;
          ctx.beginPath(); ctx.arc(pt[0], pt[1], 8 + 34 * u, 0, Math.PI * 2);
          ctx.lineWidth = 2.5 * (1 - u) + 0.5; ctx.strokeStyle = `rgba(209,73,31,${(1 - u) * 0.9})`; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 6, 0, Math.PI * 2); ctx.fillStyle = COLORS.route; ctx.fill();
        ctx.font = `600 12px 'IBM Plex Sans', system-ui, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText('calculating…', pt[0] + 14, pt[1]);
        ctx.fillStyle = COLORS.route; ctx.fillText('calculating…', pt[0] + 14, pt[1]);
      }
    }
    if (this.snap && !this.interacting) {
      const s = this.snap;
      const pt = projectVisible(proj, [s.lon, s.lat]);
      if (pt) {
        const d = dirFromBearing(s.lon, s.lat, s.bearing);
        const len = 34;
        const q = pointAlong(s.xyz, d, len / proj.scale());
        const p2 = proj([Math.atan2(q[1], q[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, q[2]))) / DEG]);
        if (p2) {
          ctx.beginPath(); ctx.moveTo(pt[0], pt[1]); ctx.lineTo(p2[0], p2[1]);
          ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
          ctx.lineWidth = 2.2; ctx.strokeStyle = COLORS.route; ctx.stroke();
          drawArrow(ctx, pt, p2, COLORS.route, 10);
        }
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); ctx.fillStyle = COLORS.route; ctx.fill();
      }
    }
  }

  // ---------- interaction ----------
  clampToGlobe(pt) {
    const [tx, ty] = this.projection.translate();
    const R = this.projection.scale() * 0.995;
    const dx = pt[0] - tx, dy = pt[1] - ty, r = Math.hypot(dx, dy);
    return r > R ? [tx + dx * R / r, ty + dy * R / r] : pt;
  }

  setupZoom() {
    const proj = this.projection;
    const self = this;
    let v0, q0, r0, a0, tl;
    const point = (event, that) => {
      const t = d3.pointers(event, that);
      if (t.length !== tl) {
        tl = t.length;
        if (tl > 1) a0 = Math.atan2(t[1][1] - t[0][1], t[1][0] - t[0][0]);
        zoomstarted.call(that, event);
      }
      return tl > 1 ? [d3.mean(t, p => p[0]), d3.mean(t, p => p[1]), Math.atan2(t[1][1] - t[0][1], t[1][0] - t[0][0])] : t[0];
    };
    function zoomstarted(event) {
      const pt = self.clampToGlobe(point(event, this));
      v0 = versor.cartesian(proj.invert(pt));
      q0 = versor((r0 = proj.rotate()));
    }
    function zoomed(event) {
      proj.scale(event.transform.k);
      const pt = self.clampToGlobe(point(event, this));
      const v1 = versor.cartesian(proj.rotate(r0).invert(pt));
      const delta = versor.delta(v0, v1);
      let q1 = versor.multiply(q0, delta);
      if (pt[2] !== undefined) {
        const d = (pt[2] - a0) / 2, s = -Math.sin(d), c = Math.sign(Math.cos(d));
        q1 = versor.multiply([Math.sqrt(1 - s * s), 0, 0, c * s], q1);
      }
      proj.rotate(versor.rotation(q1));
      if (delta[0] < 0.7) zoomstarted.call(this, event);
      self.interacting = true;
      self.invalidate('low');
    }
    this.zoom = d3.zoom()
      .scaleExtent([this.baseScale * 0.45, 8e5])
      .touchable(() => false)   // touch gestures are handled in setupTouch()
      .clickDistance(4)   // a click that wobbles a few pixels is still a click, not a drag
      .filter(e => !e.ctrlKey || e.type === 'wheel')
      .on('start', function (e) { tl = 0; zoomstarted.call(this, e); self.overlayCanvas.classList.add('grabbing'); })
      .on('zoom', zoomed)
      .on('end', () => { self.interacting = false; self.overlayCanvas.classList.remove('grabbing'); self.invalidate('high'); self.updateSnap(); });
    d3.select(this.overlayCanvas)
      .property('__zoom', d3.zoomIdentity.scale(proj.scale()))
      .call(this.zoom)
      .on('dblclick.zoom', null);
  }

  syncZoom() { d3.select(this.overlayCanvas).property('__zoom', d3.zoomIdentity.scale(this.projection.scale())); }

  setupPointer() {
    const c = this.overlayCanvas;
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer = [e.offsetX, e.offsetY];
      if (!this.interacting) this.scheduleSnap();
    });
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; this.pointer = null; this.setSnap(null); });
    c.addEventListener('click', (e) => {
      // a tap still produces a click even when its pointerdown was cancelled: touch has its own gestures
      if (e.pointerType === 'touch' || performance.now() - this.lastTouch < 800) return;
      this.pointer = [e.offsetX, e.offsetY];
      this.updateSnap(true);
      if (this.snap) this.onClick(this.snap);
    });
  }

  /**
   * Touch: one finger places the coast point (probe just above the fingertip; the HUD's button
   * computes the route); two fingers turn the globe, pinch to zoom and twist.
   */
  setupTouch() {
    const c = this.overlayCanvas;
    const proj = this.projection;
    const touches = new Map();          // pointerId -> [x, y]
    let gesture = null;                 // two-finger state
    const pts = () => [...touches.values()];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

    const place = (x, y) => { this.pointer = [x, y - TOUCH_OFFSET]; this.updateSnap(true); };
    const beginGesture = () => {
      const [a, b] = pts();
      const m = this.clampToGlobe(mid(a, b));
      gesture = { v0: versor.cartesian(proj.invert(m)), r0: proj.rotate(), q0: versor(proj.rotate()), d0: dist(a, b), s0: proj.scale(), a0: ang(a, b) };
      this.interacting = true;
      this.setSnap(null);
      c.classList.add('grabbing');
    };
    const moveGesture = () => {
      const [a, b] = pts();
      const ext = this.zoom.scaleExtent();
      proj.scale(Math.max(ext[0], Math.min(ext[1], gesture.s0 * dist(a, b) / gesture.d0)));
      const m = this.clampToGlobe(mid(a, b));
      const v1 = versor.cartesian(proj.rotate(gesture.r0).invert(m));
      const delta = versor.delta(gesture.v0, v1);
      let q1 = versor.multiply(gesture.q0, delta);
      const d = (ang(a, b) - gesture.a0) / 2, sn = -Math.sin(d), cs = Math.sign(Math.cos(d));
      q1 = versor.multiply([Math.sqrt(1 - sn * sn), 0, 0, cs * sn], q1);
      proj.rotate(versor.rotation(q1));
      if (delta[0] < 0.7) beginGesture();
      this.invalidate('low');
    };
    const endGesture = () => {
      gesture = null;
      this.interacting = false;
      c.classList.remove('grabbing');
      this.syncZoom();
      this.invalidate('high');
    };

    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.lastTouch = performance.now();
      e.preventDefault();                       // no compatibility mouse events
      c.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (touches.size === 1) place(e.offsetX, e.offsetY);
      else if (touches.size === 2) beginGesture();
      else if (gesture) endGesture();
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (touches.size === 2 && gesture) moveGesture();
      else if (touches.size === 1) place(e.offsetX, e.offsetY);
    });
    const up = (e) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      this.lastTouch = performance.now();
      touches.delete(e.pointerId);
      if (gesture && touches.size < 2) endGesture();
      if (touches.size === 1 && !gesture) { const [x, y] = pts()[0]; place(x, y); }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  scheduleSnap() {
    if (this.snapPending) return;
    this.snapPending = true;
    requestAnimationFrame(() => { this.snapPending = false; this.updateSnap(); });
  }

  /** Snap the pointer to the nearest coast of the best loaded resolution. */
  updateSnap(force = false) {
    if (!this.pointer || this.flying) return;
    const res = this.bestRes();
    if (!res || !this.data.index[res]) return;
    const g = this.data.coast[res];
    const ll = this.projection.invert(this.pointer);
    if (!ll || !projectVisible(this.projection, ll)) { this.setSnap(null); return; }
    // search out to roughly 160 screen pixels from the pointer
    const rings = Math.min(30, Math.max(1, Math.ceil(160 / this.projection.scale() / DEG / this.data.index[res].cell)));
    const snap = nearestCoast(g, this.data.index[res], ll[0], ll[1], rings);
    if (!snap) { this.setSnap(null); return; }
    this.setSnap(this.describe(snap, g, res), force);
  }

  describe(snap, g, res) {
    const n = coastNormal(g, snap, this.options.windowKm);
    return { ...snap, bearing: n.bearing, tangentBearing: n.tangentBearing, res, g };
  }

  /** Recompute the seaward direction (e.g. after the smoothing window changed). */
  refreshSnap() { if (this.snap) this.setSnap(this.describe(this.snap, this.snap.g, this.snap.res), true); }

  setSnap(snap, force = false) {
    const changed = force || (!!snap !== !!this.snap) || (snap && (snap.k !== this.snap.k || Math.abs(snap.t - this.snap.t) > 1e-9 || snap.bearing !== this.snap.bearing));
    this.snap = snap;
    this.needOverlay = true;
    if (changed) this.onSnap(snap);
  }

  /** Snap to a given coordinate (used for shared links). */
  snapTo(lon, lat, res) {
    if (!res || !this.data.coast[res] || !this.data.index[res]) res = this.bestRes();
    if (!res) return null;
    const g = this.data.coast[res];
    const snap = nearestCoast(g, this.data.index[res], lon, lat, 8);
    if (!snap) return null;
    this.setSnap(this.describe(snap, g, res), true);
    return this.snap;
  }

  setRoute(route) { this.route = route; this.routeStart = performance.now(); this.needOverlay = true; }

  /** Show (or clear) the "calculating" indicator at a point, and paint it right away. */
  setBusy(lonlat) {
    this.busy = lonlat ? { lonlat, t0: performance.now() } : null;
    this.overlayCanvas.classList.toggle('busy', !!lonlat);
    this.renderOverlay();
  }

  /** Animate to centre a point at a given scale. */
  flyTo(lon, lat, scale, duration = 1400) {
    const proj = this.projection;
    const r0 = proj.rotate(), q0 = versor(r0), q1 = versor([-lon, -lat, 0]);
    const s0 = proj.scale(), s1 = scale || s0;
    const t0 = performance.now();
    const id = this.beginFlight();
    const step = (now) => {
      if (this.flightId !== id) return;
      const t = Math.min(1, (now - t0) / duration), e = d3.easeCubicInOut(t);
      proj.rotate(versor.rotation(slerp(q0, q1, e)));
      proj.scale(Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * e));
      this.invalidate(t < 1 ? 'low' : 'high');
      if (t < 1) requestAnimationFrame(step);
      else this.endFlight();
    };
    requestAnimationFrame(step);
  }

  /**
   * Fly along a lon/lat path (the computed route), keeping north up: first a short hop from the
   * current view to the path's first point, then the camera travels the path, zooming out over
   * long stretches and back in on arrival.
   */
  flyAlong(coords, { scale, duration } = {}) {
    if (!coords || coords.length < 2) return;
    const proj = this.projection;
    const r0 = proj.rotate(), c0 = [-r0[0], -r0[1]];
    let routeRad = 0;
    for (let i = 1; i < coords.length; i++) routeRad += d3.geoDistance(coords[i - 1], coords[i]);
    const routeDeg = routeRad / DEG;
    const gapDeg = d3.geoDistance(c0, coords[0]) / DEG;
    const preMs = gapDeg > 0.3 ? Math.min(1200, 250 + gapDeg * 10) : 0;
    const mainMs = duration || Math.max(1600, Math.min(6000, 1200 + routeDeg * 35));
    const s0 = proj.scale(), s1 = scale || s0;
    // zoom out enough to see the stretch being flown (the whole globe for long routes)
    const fit = Math.min(this.w, this.h) * 0.42 / Math.max(0.15, Math.sin(Math.min(routeRad / 2, Math.PI / 2)));
    const sMid = routeDeg > 3 ? Math.min(s0, s1, Math.max(this.baseScale * 0.8, fit)) : Math.min(s0, s1);
    const L0 = Math.log(s0), LM = Math.log(sMid), L1 = Math.log(s1);
    const pre = d3.geoInterpolate(c0, coords[0]);
    const t0 = performance.now();
    const id = this.beginFlight();
    const step = (now) => {
      if (this.flightId !== id) return;
      const el = now - t0;
      let center, sc, done = false, roll = 0;
      if (el < preMs) {
        const u = d3.easeCubicInOut(el / preMs);
        center = pre(u); sc = s0; roll = r0[2] * (1 - u);
      } else {
        const t = Math.min(1, (el - preMs) / mainMs);
        const u = d3.easeCubicInOut(t);
        center = pointAlongPath(coords, u);
        sc = Math.exp((1 - u) * (1 - u) * L0 + 2 * (1 - u) * u * LM + u * u * L1);
        done = t >= 1;
      }
      proj.rotate([-center[0], -center[1], roll]);
      proj.scale(sc);
      this.invalidate(done ? 'high' : 'low');
      if (!done) requestAnimationFrame(step);
      else this.endFlight();
    };
    requestAnimationFrame(step);
  }

  beginFlight() {
    this.flightId = (this.flightId || 0) + 1;
    this.flying = true; this.interacting = true;
    this.setSnap(null);
    return this.flightId;
  }

  endFlight() {
    this.flying = false; this.interacting = false;
    this.syncZoom();
    this.invalidate('high');
  }

  northUp() { const r = this.projection.rotate(); this.flyTo(-r[0], -r[1], this.projection.scale(), 700); }
}

/** A 10°-style graticule as densely sampled polylines (d3's graticule leaves meridians as 90° chords). */
function globalGraticule(step, prec) {
  const lines = [];
  for (let lo = -180; lo < 180; lo += step) {
    const major = lo % 90 === 0, l = [];
    const lim = major ? 90 : 80;
    for (let la = -lim; la <= lim + 1e-9; la += prec) l.push([lo, la]);
    lines.push(l);
  }
  for (let la = -80; la <= 80; la += step) {
    const l = []; for (let lo = -180; lo <= 180 + 1e-9; lo += prec) l.push([lo, la]); lines.push(l);
  }
  return lines;
}

/** Point at fraction u (0..1) of the length of a densely sampled lon/lat path. */
function pointAlongPath(coords, u) {
  const n = coords.length - 1;
  const x = Math.max(0, Math.min(n, u * n));
  const i = Math.min(n - 1, Math.floor(x)), f = x - i;
  if (f <= 0) return coords[i];
  return d3.geoInterpolate(coords[i], coords[i + 1])(f);
}

/** Flatten lon/lat polylines into xyz Float32 positions and end flags for the line pipeline. */
function polylinesToBuffers(lines) {
  let n = 0; for (const l of lines) n += l.length;
  const pos = new Float32Array(n * 3), flags = new Float32Array(n);
  let k = 0;
  for (const l of lines) {
    for (const [lon, lat] of l) { const v = xyz(lon, lat); pos[3 * k] = v[0]; pos[3 * k + 1] = v[1]; pos[3 * k + 2] = v[2]; k++; }
    flags[k - 1] = 1;
  }
  return [pos, flags];
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map(x => -x); d = -d; }
  if (d > 0.9995) { const r = a.map((x, i) => x + (b[i] - x) * t); const n = Math.hypot(...r); return r.map(x => x / n); }
  const θ = Math.acos(d), s = Math.sin(θ);
  const wa = Math.sin((1 - t) * θ) / s, wb = Math.sin(t * θ) / s;
  return a.map((x, i) => x * wa + b[i] * wb);
}
