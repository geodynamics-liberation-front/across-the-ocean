# Across the Ocean — see PUBLISHING.md in the glf repository for the site contract.
#
#   make dist     download the source data, build site/data, and assemble dist/
#   make data     download + build the data only (writes site/data/)
#   make build    convert sources/ into site/data/ without downloading
#   make fetch    download only (sources/, existing files are kept)
#   make serve    build dist/ and serve it on http://localhost:8000/
#   make check    verify the prerequisites (python3 with numpy and pyshp, curl, unzip)
#   make clean    remove dist/ and the generated site data (downloads are kept)

PYTHON ?= python3
PORT ?= 8000

.PHONY: dist check data build fetch clean serve

dist: data
	rm -rf dist
	cp -r site dist

data: check fetch build

check:
	@command -v $(PYTHON) >/dev/null || { echo "python3 is required" >&2; exit 1; }
	@command -v curl >/dev/null || { echo "curl is required (to download the datasets)" >&2; exit 1; }
	@command -v unzip >/dev/null || { echo "unzip is required (to unpack the datasets)" >&2; exit 1; }
	@$(PYTHON) -c 'import numpy, shapefile' 2>/dev/null || { echo "missing Python packages: pip install -r tools/requirements.txt" >&2; exit 1; }

build: check
	$(PYTHON) tools/build_data.py        # writes site/data/

fetch: check
	tools/fetch_data.sh                  # downloads into sources/, keeps existing files, verifies each download

clean:
	rm -rf dist site/data

serve: dist
	$(PYTHON) -m http.server $(PORT) --directory dist
