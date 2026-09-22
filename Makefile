# Across the Ocean
#
#   make dist     build the data and assemble the publishable site in dist/
#   make data     download the source datasets and build site/data
#   make fetch    download only (sources/)
#   make build    convert sources/ into site/data (needs numpy and pyshp)
#   make serve    serve the site locally on http://localhost:8765/
#   make clean    remove the built site data (sources are kept)

PYTHON ?= python3
PORT ?= 8765

.PHONY: dist data fetch build serve clean

dist: data
	rm -rf dist
	cp -r site dist

data: fetch build

fetch:
	tools/fetch_data.sh

build:
	$(PYTHON) tools/build_data.py

serve:
	$(PYTHON) -m http.server $(PORT) --directory site

clean:
	rm -rf dist site/data
