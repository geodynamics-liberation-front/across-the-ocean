# Across the Ocean — see PUBLISHING.md in the glf repository for the site contract.
#
#   make dist     download the source data, build site/data, and assemble dist/
#   make data     download + build the data only (writes site/data/)
#   make build    convert sources/ into site/data/ without downloading
#   make fetch    download only (sources/, existing files are kept)
#   make serve    build dist/ and serve it on http://localhost:8000/
#   make clean    remove dist/ and the generated site data (downloads are kept)

PYTHON ?= python3
PORT ?= 8000

.PHONY: dist data build fetch clean serve

dist: data
	rm -rf dist
	cp -r site dist

data: fetch build

build:
	$(PYTHON) tools/build_data.py        # writes site/data/

fetch:
	tools/fetch_data.sh                  # downloads into sources/, keeps existing files

clean:
	rm -rf dist site/data

serve: dist
	$(PYTHON) -m http.server $(PORT) --directory dist
