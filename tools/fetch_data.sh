#!/usr/bin/env bash
# Download the source datasets into sources/. Safe to re-run: existing files are kept.
#
#   GSHHG 2.3.7 binary distribution (shorelines + WDBII borders), ~118 MB
#   Natural Earth 50m admin-0 countries, 50m marine polygons, 10m populated places
#   GeoNames cities5000
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/sources"
mkdir -p "$SRC"

fetch() { # fetch <url> <destination>
  local url=$1 dest=$2
  if [ -s "$dest" ]; then echo "have      $(basename "$dest")"; return 0; fi
  echo "fetching  $url"
  if curl -fL --retry 3 --connect-timeout 30 --progress-bar -o "$dest.part" "$url"; then
    mv "$dest.part" "$dest"
  else
    rm -f "$dest.part"; return 1
  fi
}

unpack() { # unpack <zip> <directory>
  local zip=$1 dir=$2
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then echo "unpacked  $(basename "$dir")"; return 0; fi
  mkdir -p "$dir"
  unzip -oq "$zip" -d "$dir"
  echo "unpacked  $(basename "$zip") -> $(basename "$dir")"
}

# --- GSHHG 2.3.7 (Wessel & Smith). The GitHub release is a mirror of the SOEST distribution. ---
GSHHG=gshhg-bin-2.3.7.zip
fetch "https://github.com/GenericMappingTools/gshhg-gmt/releases/download/2.3.7/$GSHHG" "$SRC/$GSHHG" \
  || fetch "https://www.soest.hawaii.edu/pwessel/gshhg/$GSHHG" "$SRC/$GSHHG"
unpack "$SRC/$GSHHG" "$SRC/gshhg237"

# --- Natural Earth ---
NE=https://naciscdn.org/naturalearth
for f in 50m/cultural/ne_50m_admin_0_countries 50m/physical/ne_50m_geography_marine_polys 10m/cultural/ne_10m_populated_places_simple; do
  name=$(basename "$f")
  fetch "$NE/$f.zip" "$SRC/$name.zip"
  if [ ! -s "$SRC/ne/$name.shp" ]; then mkdir -p "$SRC/ne"; unzip -oq "$SRC/$name.zip" -d "$SRC/ne"; echo "unpacked  $name"; fi
done

# --- GeoNames places with population >= 5000 (CC BY 4.0) ---
fetch "https://download.geonames.org/export/dump/cities5000.zip" "$SRC/cities5000.zip"
unpack "$SRC/cities5000.zip" "$SRC/cities"

echo "done: sources are in $SRC"
