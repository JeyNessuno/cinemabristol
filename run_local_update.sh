#!/bin/bash

set -e

echo "Installing dependencies..."
npm install

echo "Running scraper..."
node scraper/scraper3.js > scraper/movies.json

echo "Running enrichment..."
node scraper/enrich.js

echo "Moving final file..."
mv scraper/movies.enriched.json movies.enriched.json

echo "Done. Output ready:"
ls -lah movies.enriched.json