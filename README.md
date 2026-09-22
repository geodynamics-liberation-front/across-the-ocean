# Across the Ocean

Stand on any shore, look straight out to sea, and find out what land is really
"across the ocean": not the country that happens to share your latitude, but the
first coast a great circle meets when it leaves your beach at right angles to
the shoreline.

The site is static: an orthographic globe rendered with **WebGL2** (drag to
turn, scroll or pinch to zoom, zooming keeps the point under the pointer
fixed), a cursor that snaps to the nearest coastline, and a results panel with
a world map drawn by **d3-geo** in a projection of your choice plus a page of
facts.

## Layout

```
site/            the website (serve this directory)
  index.html
  style.css
  js/
    app.js       loading, the route computation, UI wiring
    globe.js     the interactive globe (versor drag/zoom, snapping cursor)
    results.js   results panel: projections, world map, facts
    glrenderer.js WebGL2 globe renderer (instanced lines, land mesh, graticule)
    fillworker.js Web Worker that triangulates the coast polygons for the land fill
    render.js    2D-canvas renderers (results map, and the globe fallback without WebGL2)
    gshb.js      GSHB binary loader and the coast grid index
    geo.js       spherical geometry: normals, great-circle and parallel intersections
    lookup.js    countries, seas and cities lookups
  data/          built, not in git (about 32 MB; the 19 MB high-res coastline is
                 only fetched by the browser when you zoom in or tick the option)
tools/
  fetch_data.sh  downloads the source datasets into sources/ (not in git)
  build_data.py  converts sources/ into site/data/
  requirements.txt
Makefile         make data | fetch | build | serve | clean
```

The data directories (`sources/`, `site/data/`) are ignored by git and
regenerated with the commands below.

## Getting the data

```
pip install -r tools/requirements.txt   # numpy, pyshp
make data                               # = make fetch && make build
```

`make fetch` downloads about 130 MB into `sources/`: the GSHHG 2.3.7 binary
distribution (shorelines, borders and the rivers used by the optional "Major rivers" layer; from the GenericMappingTools GitHub release, falling back to
soest.hawaii.edu), three Natural Earth zips and GeoNames `cities5000`. It is
safe to re-run; existing files are kept. `make build` writes `site/data/`.

## Running it

```
make serve          # python3 -m http.server 8765 --directory site
```

then open http://localhost:8765/. The JavaScript libraries (d3 v7,
d3-geo-projection v4, versor) are loaded from cdn.jsdelivr.net, and the fonts
from Google Fonts. If you host this somewhere, serve `site/data` with gzip or
brotli compression: the binary coastlines shrink by roughly half.

Results have shareable URLs (`#p=lat,lon&w=<smoothing km>&r=<coast resolution>`; a link made with the high-resolution coast loaded carries `r=h` and reloads it, so the route reproduces exactly). Click a point
on the shore to compute a route (Space or Enter also work), Escape closes the
panel.

## Rendering

The globe keeps every coastline vertex on the GPU as a unit vector. The vertex
shaders apply d3's rotation and the orthographic projection (the same matrix
d3-geo uses, so the 2D overlay of cursor, route and markers lines up exactly),
clip segments at the horizon, and extrude each segment into a screen-space
quad with instanced drawing, so nothing is rebuilt on the CPU when you drag or
zoom. Land is a triangle mesh built in a Web Worker with earcut (long edges are
subdivided so chords stay on the sphere); the fragment shader discards the far
hemisphere. Resolution switches with zoom (low → intermediate → high), and the
high-resolution coastline, borders and rivers are fetched on demand. Browsers
without WebGL2 fall back to the slower 2D-canvas renderer in `render.js`.

## Data format

The shorelines are written in a small binary format ("GSHB", documented at the
top of `tools/build_data.py`): a header, one 24-byte record per polygon, then
all vertices as int32 micro-degrees. Rings are re-oriented to d3-geo's
convention (clockwise, land on the right), which is what lets the site tell
"entering land" from "leaving land" when it intersects a great circle with the
coast. The Antarctic ice front (GSHHG level 5) is used as the Antarctic coast.

When `site/data` changes, bump `DATA_VERSION` in `site/js/app.js` so browsers
refetch the files.

## How the answer is computed

1. The cursor snaps to the nearest point on a coastline segment (ocean coasts
   only, GSHHG levels 1 and 5) using a 1° grid index over the vertices.
2. The direction of the coast is the principal axis of the shoreline vertices
   within ±W km along the ring (W is the "smoothing window", 20 km by default).
   The seaward normal is that direction turned 90° toward the sea side.
3. The great circle through the start point in that direction is intersected
   with every coastline segment in 3-D (plane/chord intersection). Crossings
   are sorted by distance; the first one that *enters* land (segment crossing
   from the sea side to the land side) is the far shore. Because the rings are
   consistently oriented, no point-in-polygon test is needed, and routes longer
   than half the globe work.
4. Countries come from Natural Earth admin-0 polygons (containment, falling
   back to the nearest polygon since GSHHG and Natural Earth coasts differ
   slightly), seas from the Natural Earth marine polygons sampled along the
   route, and nearest towns from GeoNames.
5. For comparison the site also follows the parallel east or west, the way
   the "what is across the ocean from you" maps do, and reports where that
   lands instead.

## Data credits

* Wessel, P. and W. H. F. Smith (1996), A global, self-consistent,
  hierarchical, high-resolution shoreline database, J. Geophys. Res., 101,
  8741–8743. GSHHG 2.3.7, LGPL v3.
* Natural Earth (public domain): admin-0 countries, marine polygons,
  populated places.
* GeoNames (CC BY 4.0): cities5000.
* d3, d3-geo-projection (ISC), versor (BSD).
* Inspired by the Washington Post's 2014 "what's across the ocean" map and the
  r/MapPorn follow-ups, which follow lines of latitude instead of great circles.
