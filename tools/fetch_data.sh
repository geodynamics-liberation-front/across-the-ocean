#!/usr/bin/env bash
# Download the source datasets into sources/ and verify them. Never installs anything.
#
#   GSHHG 2.3.7 binary distribution (shorelines, WDBII borders and rivers), ~118 MB, LGPL v3.
#       Primary: GenericMappingTools GitHub release. Mirror: soest.hawaii.edu.
#   Natural Earth v5.1.2 (public domain): 50m admin-0 countries, 50m marine polygons,
#       10m populated places, fetched file by file from the tagged GitHub repository.
#   GeoNames cities5000 (CC BY 4.0): places with population >= 5000.
#
# Stable downloads are checked against tools/SHA256SUMS before use; a file that fails is deleted
# and the build stops. GeoNames regenerates cities5000.zip daily, so it has no fixed checksum and
# is checked for size, archive integrity and row count instead. Existing files are kept, so a
# rebuild does not download again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/sources"
SUMS="$ROOT/tools/SHA256SUMS"
mkdir -p "$SRC" "$SRC/ne"

die() { echo "fetch_data.sh: $*" >&2; exit 1; }

expected_sum() { awk -v f="$1" '$2 == f { print $1 }' "$SUMS"; }

# verify <relative path>: compare with SHA256SUMS; delete the file and fail on mismatch
verify() {
  local rel=$1 want have
  want=$(expected_sum "$rel")
  [ -n "$want" ] || die "no checksum recorded for $rel in tools/SHA256SUMS"
  have=$(sha256sum "$SRC/$rel" | awk '{ print $1 }')
  if [ "$have" != "$want" ]; then
    rm -f "$SRC/$rel"
    die "$rel failed its SHA-256 check (got $have, expected $want); the file was deleted, re-run make to download it again"
  fi
}

# download <url> <destination>: retried, written to a temporary name first
download() {
  local url=$1 dest=$2
  echo "fetching  $url"
  if curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 --progress-bar -o "$dest.part" "$url"; then
    mv "$dest.part" "$dest"
  else
    rm -f "$dest.part"; return 1
  fi
}

# fetch_verified <relative path> <url> [mirror url]: keep an existing verified copy, else download
fetch_verified() {
  local rel=$1 url=$2 mirror=${3:-}
  if [ -s "$SRC/$rel" ]; then
    verify "$rel"; echo "have      $rel (verified)"; return 0
  fi
  download "$url" "$SRC/$rel" || { [ -n "$mirror" ] && echo "primary failed, trying the mirror" >&2 && download "$mirror" "$SRC/$rel"; } \
    || die "could not download $rel from $url${mirror:+ or $mirror}; check the network and re-run make"
  verify "$rel"
}

# --- GSHHG 2.3.7 (Wessel & Smith) ---
GSHHG=gshhg-bin-2.3.7.zip
fetch_verified "$GSHHG" \
  "https://github.com/GenericMappingTools/gshhg-gmt/releases/download/2.3.7/$GSHHG" \
  "https://www.soest.hawaii.edu/pwessel/gshhg/$GSHHG"
if [ ! -s "$SRC/gshhg237/gshhs_h.b" ] || [ ! -s "$SRC/gshhg237/wdb_rivers_h.b" ]; then
  mkdir -p "$SRC/gshhg237"
  unzip -oq "$SRC/$GSHHG" -d "$SRC/gshhg237" || die "could not unpack $GSHHG (is unzip installed? is the file complete?)"
  echo "unpacked  $GSHHG -> gshhg237/"
fi

# --- Natural Earth v5.1.2, tagged files from github.com/nvkelso/natural-earth-vector ---
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2
for ds in 50m_cultural/ne_50m_admin_0_countries 50m_physical/ne_50m_geography_marine_polys 10m_cultural/ne_10m_populated_places_simple; do
  name=$(basename "$ds")
  for ext in shp dbf shx prj cpg; do
    fetch_verified "ne/$name.$ext" "$NE/$ds.$ext"
  done
done

# --- GeoNames cities5000 (regenerated daily upstream, so verified structurally) ---
CITIES=cities5000.zip
if [ ! -s "$SRC/$CITIES" ]; then
  download "https://download.geonames.org/export/dump/$CITIES" "$SRC/$CITIES" \
    || die "could not download $CITIES from download.geonames.org; check the network and re-run make"
fi
size=$(stat -c %s "$SRC/$CITIES")
if [ "$size" -lt 4000000 ] || ! unzip -tq "$SRC/$CITIES" >/dev/null 2>&1; then
  rm -f "$SRC/$CITIES"
  die "$CITIES is truncated or corrupt ($size bytes); the file was deleted, re-run make to download it again"
fi
echo "have      $CITIES ($size bytes, archive verified)"
if [ ! -s "$SRC/cities/cities5000.txt" ]; then
  mkdir -p "$SRC/cities"
  unzip -oq "$SRC/$CITIES" -d "$SRC/cities" || die "could not unpack $CITIES"
  echo "unpacked  $CITIES -> cities/"
fi
rows=$(wc -l < "$SRC/cities/cities5000.txt")
[ "$rows" -ge 50000 ] || { rm -f "$SRC/cities/cities5000.txt" "$SRC/$CITIES"; die "cities5000.txt has only $rows rows (expected at least 50000); files deleted, re-run make"; }

echo "done: sources are in $SRC"
