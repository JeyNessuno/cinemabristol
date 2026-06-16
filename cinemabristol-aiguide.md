# Cinema Bristol Enrichment Pipeline

## Project Structure
- `/scraper/scraper3.js` — scrapes cinema website → `movies.json`
- `/scraper/enrich.js` — enriches movies with Wikipedia + OMDb data → `movies.enriched.json`, also downloads poster images to project root
- `/renderer.html` — frontend that reads `movies.enriched.json`

## Commands
- `npm run scrape` — runs scraper3.js, outputs to scraper/movies.json
- `npm run enrich` — runs enrich.js (writes files directly, no stdout redirect)

## Enrichment Pipeline
- Wikipedia (Italian): searches `title + " film"`, returns first result URL
- OMDb API: requires `OMDB_API_KEY` env var for IMDb rating + Rotten Tomatoes
- In-memory cache avoids duplicate API calls
- Title normalization: lowercase + remove punctuation before cache lookup
- **Poster download**: downloads images from original URLs, saves to project root using original filename (e.g. `image10961.png`). Falls back to original URL on failure.

## Frontend
- Reads `/scraper/movies.enriched.json`
- Poster `<img src>` uses the local filename (served from project root)
- Shows IMDb badge (yellow), RT badge (red), Wikipedia link (globe icon)
- Designed for GitHub Pages (static, no backend)

## GitHub Workflow (`.github/workflows/update-movies.yml`)
- Runs `node scraper/enrich.js` without stdout redirect
- Commits: `scraper/movies.json movies.enriched.json *.png *.jpg *.jpeg *.gif *.webp`