# Across the Ocean
#
#   make data     download the source datasets and build site/data
#   make fetch    download only (sources/)
#   make build    convert sources/ into site/data (needs numpy and pyshp)
#   make serve    serve the site locally on http://localhost:8765/
#   make clean    remove the built site data (sources are kept)

PYTHON ?= python3
PORT ?= 8765

.PHONY: data fetch build serve clean

data: fetch build

fetch:
	tools/fetch_data.sh

build:
	$(PYTHON) tools/build_data.py

serve:
	$(PYTHON) -m http.server $(PORT) --directory site

clean:
	rm -rf site/data
