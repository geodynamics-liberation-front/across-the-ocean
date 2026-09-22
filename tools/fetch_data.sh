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

# Every download is verified before it is kept: it must be at least <min-bytes>,
# it must be a sound zip archive, and, when a checksum is given, its SHA-256
# must match. A file that fails is deleted so the next run fetches it again.
verify() { # verify <file> <min-bytes> [sha256]
  local file=$1 min=$2 sha=${3:-}
  local size; size=$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file")
  if [ "$size" -lt "$min" ]; then echo "error: $(basename "$file") is only $size bytes (expected at least $min): truncated download" >&2; return 1; fi
  if ! unzip -tqq "$file" >/dev/null 2>&1; then echo "error: $(basename "$file") is not a valid zip archive" >&2; return 1; fi
  if [ -n "$sha" ]; then
    local got; got=$(sha256sum "$file" | cut -d' ' -f1)
    if [ "$got" != "$sha" ]; then echo "error: $(basename "$file") SHA-256 is $got, expected $sha" >&2; return 1; fi
  fi
}

fetch() { # fetch <url> <destination> <min-bytes> [sha256]
  local url=$1 dest=$2 min=$3 sha=${4:-}
  if [ -s "$dest" ]; then echo "have      $(basename "$dest")"; return 0; fi
  echo "fetching  $url"
  if ! curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 --progress-bar -o "$dest.part" "$url"; then
    rm -f "$dest.part"; echo "error: could not download $url" >&2; return 1
  fi
  if ! verify "$dest.part" "$min" "$sha"; then rm -f "$dest.part"; return 1; fi
  mv "$dest.part" "$dest"
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
GSHHG_SHA=28600e8f7a08645aab43079326df6504212ec5ccb2b4bcf3b5f4f12ed60e82bc
fetch "https://github.com/GenericMappingTools/gshhg-gmt/releases/download/2.3.7/$GSHHG" "$SRC/$GSHHG" 100000000 "$GSHHG_SHA" \
  || fetch "https://www.soest.hawaii.edu/pwessel/gshhg/$GSHHG" "$SRC/$GSHHG" 100000000 "$GSHHG_SHA"
unpack "$SRC/$GSHHG" "$SRC/gshhg237"

# --- Natural Earth ---
NE=https://naciscdn.org/naturalearth
for f in 50m/cultural/ne_50m_admin_0_countries 50m/physical/ne_50m_geography_marine_polys 10m/cultural/ne_10m_populated_places_simple; do
  name=$(basename "$f")
  fetch "$NE/$f.zip" "$SRC/$name.zip" 400000   # Natural Earth revises these, so no checksum
  if [ ! -s "$SRC/ne/$name.shp" ]; then mkdir -p "$SRC/ne"; unzip -oq "$SRC/$name.zip" -d "$SRC/ne"; echo "unpacked  $name"; fi
done

# --- GeoNames places with population >= 5000 (CC BY 4.0) ---
fetch "https://download.geonames.org/export/dump/cities5000.zip" "$SRC/cities5000.zip" 4000000   # updated daily, so no checksum
unpack "$SRC/cities5000.zip" "$SRC/cities"

echo "done: sources are in $SRC"
