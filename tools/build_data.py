#!/usr/bin/env python3
"""Build the data files used by the Across-the-Ocean site.

Inputs (see sources/):
  * GSHHG 2.3.7 binary shorelines + WDBII borders (gshhg-bin-2.3.7.zip)
  * Natural Earth 50m admin-0 countries, 50m marine polygons, 10m populated places
  * GeoNames cities5000

Outputs (site/data/):
  coast_{c,l,i,h}.bin   shoreline polygons, GSHB binary (see format below)
  borders_{c,l,i,h}.bin WDBII political boundaries (levels 1 national, 2 internal)
  rivers_{c,l,i,h}.bin  WDBII rivers, classes 1-4 (major rivers)
  countries.json        GeoJSON, Natural Earth admin-0 countries with a few properties
  oceans.json           GeoJSON, Natural Earth marine polygons (name + class)
  cities.json           compact array of GeoNames places with population >= 5000

GSHB binary format (little endian):
  u32 magic 0x42485347 ('GSHB')   u32 version=1   u32 npoly   u32 npts
  npoly records of 6 x i32: level, npts, west, east, south, north (micro-degrees)
  npts pairs of i32: lon, lat in micro-degrees, lon in [-180e6, 180e6]

Polygons are re-oriented to d3-geo's convention: rings are clockwise in lon/lat,
so land is on the RIGHT when walking along a level 1/3/5 ring (lakes, level 2/4,
are also clockwise rings of their own).
"""
import json, os, struct, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'sources')
OUT = os.path.join(ROOT, 'site', 'data')
os.makedirs(OUT, exist_ok=True)

HDR = '>IIIiiiiIIii'
HS = struct.calcsize(HDR)
MAGIC = 0x42485347


def read_gshhg(path):
    data = open(path, 'rb').read()
    off = 0
    while off < len(data):
        h = struct.unpack_from(HDR, data, off)
        off += HS
        n = h[1]
        pts = np.frombuffer(data, dtype='>i4', count=2 * n, offset=off).reshape(n, 2).astype(np.int64)
        off += 8 * n
        yield dict(id=h[0], level=h[2] & 255, west=h[3], east=h[4], south=h[5], north=h[6]), pts


def planar_signed_area(pts):
    """Signed area in the unwrapped lon/lat plane (positive = counter-clockwise)."""
    lon = np.degrees(np.unwrap(np.radians(pts[:, 0] * 1e-6)))
    lat = pts[:, 1] * 1e-6
    x0, y0 = lon, lat
    x1, y1 = np.roll(lon, -1), np.roll(lat, -1)
    return 0.5 * np.sum(x0 * y1 - x1 * y0)


def normalize_lon(pts):
    lon = pts[:, 0].copy()
    lon[lon > 180_000_000] -= 360_000_000
    lon[lon < -180_000_000] += 360_000_000
    out = pts.copy()
    out[:, 0] = lon
    return out


def densify(pts, max_deg=0.1):
    """Insert points along long segments (straight in lon/lat) so the renderer's straight chords
    follow the intended line. A border along the 60th parallel stored as one 39-degree segment
    would otherwise bow more than a degree north of the parallel on the globe."""
    lon = pts[:, 0].astype(np.float64) * 1e-6
    lat = pts[:, 1].astype(np.float64) * 1e-6
    dlon = np.diff(lon)
    dlon = (dlon + 180) % 360 - 180          # shortest way round
    dlat = np.diff(lat)
    coslat = np.cos(np.radians((lat[:-1] + lat[1:]) / 2))
    steps = np.maximum(1, np.ceil(np.maximum(np.abs(dlon) * coslat, np.abs(dlat)) / max_deg).astype(int))
    if steps.max() <= 1:
        return pts
    out = []
    for i in range(len(pts) - 1):
        n = steps[i]
        t = np.arange(n) / n
        seg_lon = lon[i] + dlon[i] * t
        seg_lat = lat[i] + dlat[i] * t
        seg_lon = (seg_lon + 180) % 360 - 180
        out.append(np.column_stack([np.round(seg_lon * 1e6), np.round(seg_lat * 1e6)]))
    out.append(pts[-1:].astype(np.float64))
    return np.vstack(out).astype(np.int64)


def write_gshb(path, polys):
    """polys: list of (level, pts[int64 n x 2] in microdegrees)."""
    npts = sum(len(p) for _, p in polys)
    with open(path, 'wb') as f:
        f.write(struct.pack('<IIII', MAGIC, 1, len(polys), npts))
        for level, p in polys:
            f.write(struct.pack('<iiiiii', level, len(p),
                                int(p[:, 0].min()), int(p[:, 0].max()),
                                int(p[:, 1].min()), int(p[:, 1].max())))
        for _, p in polys:
            f.write(p.astype('<i4').tobytes())
    return npts


def build_coast(res):
    polys = []
    stats = {}
    for h, pts in read_gshhg(os.path.join(SRC, 'gshhg237', f'gshhs_{res}.b')):
        level = h['level']
        if level == 6:          # Antarctic grounding line: use the ice front (5) instead
            continue
        area = planar_signed_area(pts)
        if area > 0:            # counter-clockwise -> reverse to clockwise (d3 exterior ring)
            pts = pts[::-1]
        pts = normalize_lon(pts)
        polys.append((level, pts))
        stats[level] = stats.get(level, 0) + 1
    n = write_gshb(os.path.join(OUT, f'coast_{res}.bin'), polys)
    print(f'coast_{res}: {len(polys)} polygons, {n} points, levels {stats}')


def build_borders(res):
    lines = []
    for h, pts in read_gshhg(os.path.join(SRC, 'gshhg237', f'wdb_borders_{res}.b')):
        if h['level'] not in (1, 2):
            continue
        lines.append((h['level'], densify(normalize_lon(pts))))
    n = write_gshb(os.path.join(OUT, f'borders_{res}.bin'), lines)
    print(f'borders_{res}: {len(lines)} lines, {n} points')


def build_rivers(res):
    # WDBII river classes: 1 double-lined rivers, 2 permanent major, 3 additional major, 4 additional, 5+ minor/intermittent
    lines = []
    for h, pts in read_gshhg(os.path.join(SRC, 'gshhg237', f'wdb_rivers_{res}.b')):
        if h['level'] > 4:
            continue
        lines.append((h['level'], densify(normalize_lon(pts))))
    n = write_gshb(os.path.join(OUT, f'rivers_{res}.bin'), lines)
    print(f'rivers_{res}: {len(lines)} lines, {n} points')


def ring_area(ring):
    x = np.array([p[0] for p in ring]); y = np.array([p[1] for p in ring])
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


def orient_geojson(geom, nd):
    """Round coordinates and enforce exterior clockwise / holes counter-clockwise."""
    def fix_poly(rings):
        out = []
        for i, ring in enumerate(rings):
            ring = [[round(x, nd), round(y, nd)] for x, y in ring]
            a = ring_area(ring)
            if (i == 0 and a > 0) or (i > 0 and a < 0):
                ring = ring[::-1]
            out.append(ring)
        return out
    if geom['type'] == 'Polygon':
        return {'type': 'Polygon', 'coordinates': fix_poly(geom['coordinates'])}
    if geom['type'] == 'MultiPolygon':
        return {'type': 'MultiPolygon', 'coordinates': [fix_poly(p) for p in geom['coordinates']]}
    raise ValueError(geom['type'])


def clean(v):
    if v in (-99, -99.0, '-99', ''):
        return None
    return v


def build_countries():
    import shapefile
    r = shapefile.Reader(os.path.join(SRC, 'ne', 'ne_50m_admin_0_countries'), encoding='utf-8')
    feats = []
    for sr in r.iterShapeRecords():
        d = sr.record.as_dict()
        props = {
            'name': d['NAME'], 'long': d['NAME_LONG'], 'formal': clean(d['FORMAL_EN']),
            'admin': d['ADMIN'], 'sov': d['SOVEREIGNT'], 'type': d['TYPE'],
            'iso2': clean(d['ISO_A2_EH']), 'iso3': clean(d['ISO_A3_EH']),
            'continent': d['CONTINENT'], 'region': d['REGION_UN'], 'subregion': d['SUBREGION'],
            'pop': clean(d['POP_EST']), 'popYear': clean(d['POP_YEAR']),
            'gdp': clean(d['GDP_MD']), 'gdpYear': clean(d['GDP_YEAR']),
            'economy': clean(d['ECONOMY']), 'income': clean(d['INCOME_GRP']),
            'wiki': clean(d['WIKIDATAID']),
        }
        feats.append({'type': 'Feature', 'properties': props,
                      'geometry': orient_geojson(sr.shape.__geo_interface__, 4)})
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(os.path.join(OUT, 'countries.json'), 'w') as f:
        json.dump(fc, f, separators=(',', ':'), ensure_ascii=False)
    print(f'countries: {len(feats)} features')


def build_oceans():
    import shapefile
    r = shapefile.Reader(os.path.join(SRC, 'ne', 'ne_50m_geography_marine_polys'), encoding='utf-8')
    feats = []
    for sr in r.iterShapeRecords():
        d = sr.record.as_dict()
        if d['featurecla'] in ('river', 'reef'):
            continue
        name = d['name']
        if name.isupper():
            name = name.title()
        feats.append({'type': 'Feature',
                      'properties': {'name': name, 'class': d['featurecla'], 'rank': d['scalerank']},
                      'geometry': orient_geojson(sr.shape.__geo_interface__, 3)})
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(os.path.join(OUT, 'oceans.json'), 'w') as f:
        json.dump(fc, f, separators=(',', ':'), ensure_ascii=False)
    print(f'oceans: {len(feats)} features')


def build_cities():
    rows = []
    with open(os.path.join(SRC, 'cities', 'cities5000.txt'), encoding='utf-8') as f:
        for line in f:
            c = line.rstrip('\n').split('\t')
            # geonameid name asciiname alternatenames lat lon fclass fcode cc cc2 adm1 adm2 adm3 adm4 pop elev dem tz moddate
            name, lat, lon, fcode, cc, pop, tz = c[1], float(c[4]), float(c[5]), c[7], c[8], int(c[14] or 0), c[17]
            cap = 1 if fcode == 'PPLC' else 0
            rows.append([name, round(lat, 4), round(lon, 4), pop, cc, cap, tz])
    rows.sort(key=lambda r: -r[3])
    with open(os.path.join(OUT, 'cities.json'), 'w') as f:
        json.dump(rows, f, separators=(',', ':'), ensure_ascii=False)
    print(f'cities: {len(rows)} places')


REQUIRED_SOURCES = {
    'coast': ['gshhg237/gshhs_c.b', 'gshhg237/gshhs_l.b', 'gshhg237/gshhs_i.b', 'gshhg237/gshhs_h.b'],
    'borders': ['gshhg237/wdb_borders_c.b', 'gshhg237/wdb_borders_l.b', 'gshhg237/wdb_borders_i.b', 'gshhg237/wdb_borders_h.b'],
    'rivers': ['gshhg237/wdb_rivers_c.b', 'gshhg237/wdb_rivers_l.b', 'gshhg237/wdb_rivers_i.b', 'gshhg237/wdb_rivers_h.b'],
    'countries': ['ne/ne_50m_admin_0_countries.shp', 'ne/ne_50m_admin_0_countries.dbf'],
    'oceans': ['ne/ne_50m_geography_marine_polys.shp', 'ne/ne_50m_geography_marine_polys.dbf'],
    'cities': ['cities/cities5000.txt'],
}


def fail(msg):
    print(f'build_data.py: {msg}', file=sys.stderr)
    sys.exit(1)


def main(what):
    for step in what:
        for rel in REQUIRED_SOURCES.get(step, []):
            path = os.path.join(SRC, rel)
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                fail(f'missing source file sources/{rel}; run tools/fetch_data.sh (or make fetch) first')
    if 'coast' in what:
        for res in 'clih':
            build_coast(res)
    if 'borders' in what:
        for res in 'clih':
            build_borders(res)
    if 'rivers' in what:
        for res in 'clih':
            build_rivers(res)
    if 'countries' in what:
        build_countries()
    if 'oceans' in what:
        build_oceans()
    if 'cities' in what:
        build_cities()


if __name__ == '__main__':
    steps = sys.argv[1:] or ['coast', 'borders', 'rivers', 'countries', 'oceans', 'cities']
    unknown = [s for s in steps if s not in REQUIRED_SOURCES]
    if unknown:
        fail(f'unknown step(s) {unknown}; choose from {list(REQUIRED_SOURCES)}')
    try:
        main(steps)
    except ImportError as e:
        fail(f'missing Python package ({e}); pip install -r tools/requirements.txt')
    except Exception as e:  # noqa: BLE001 - one loud line for the site build, details on request
        if os.environ.get('BUILD_DATA_TRACEBACK'):
            raise
        fail(f'{type(e).__name__}: {e} (set BUILD_DATA_TRACEBACK=1 for the traceback)')
