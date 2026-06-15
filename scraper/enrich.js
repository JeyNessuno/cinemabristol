import axios from "axios";
import { readFile, writeFile } from "fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OMDB_API_KEY = "be336499";
const OMDB_BASE = "https://www.omdbapi.com";
const WIKI_BASE = "https://it.wikipedia.org/w/api.php";

// ---------------------------------------------------------------------------
// Simple in-memory cache
// ---------------------------------------------------------------------------
const cache = new Map();

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value) {
  cache.set(key, value);
}

// ---------------------------------------------------------------------------
// Normalize title: lowercase + remove punctuation
// ---------------------------------------------------------------------------
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")      // remove punctuation
    .replace(/\s+/g, " ")          // collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Wikipedia (Italian) — return URL of first search result
// ---------------------------------------------------------------------------
async function fetchWikipedia(title) {
  const normal = normalizeTitle(title);
  const cacheKey = `wiki:${normal}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { data } = await axios.get(WIKI_BASE, {
      params: {
        action: "query",
        list: "search",
        srsearch: `${title} film`,
        format: "json",
        srlimit: 1,
      },
      headers: { "User-Agent": "CinemabristolEnricher/1.0" },
      timeout: 10000,
    });

    const pages = data?.query?.search;
    if (pages && pages.length > 0) {
      const pageTitle = encodeURIComponent(pages[0].title);
      const url = `https://it.wikipedia.org/wiki/${pageTitle}`;
      cacheSet(cacheKey, url);
      return url;
    }

    cacheSet(cacheKey, null);
    return null;
  } catch (err) {
    console.warn(`  ⚠ Wikipedia lookup failed for "${title}": ${err.message}`);
    cacheSet(cacheKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// OMDb API — return imdbRating + Rotten Tomatoes
// ---------------------------------------------------------------------------
async function fetchOMDb(title) {
  const normal = normalizeTitle(title);
  const cacheKey = `omdb:${normal}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  if (!OMDB_API_KEY) {
    console.warn("  ⚠ OMDB_API_KEY not set — skipping OMDb lookup");
    cacheSet(cacheKey, { imdbRating: null, rottenTomatoes: null });
    return { imdbRating: null, rottenTomatoes: null };
  }

  try {
    const { data } = await axios.get(OMDB_BASE, {
      params: {
        apikey: OMDB_API_KEY,
        t: title,
        type: "movie",
      },
      timeout: 10000,
    });

    if (data.Response === "False") {
      console.warn(`  ⚠ OMDb no result for "${title}"`);
      cacheSet(cacheKey, { imdbRating: null, rottenTomatoes: null });
      return { imdbRating: null, rottenTomatoes: null };
    }

    let rottenTomatoes = null;
    if (data.Ratings) {
      const rt = data.Ratings.find((r) => r.Source === "Rotten Tomatoes");
      if (rt) rottenTomatoes = rt.Value;
    }

    const result = {
      imdbRating: data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null,
      rottenTomatoes,
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`  ⚠ OMDb lookup failed for "${title}": ${err.message}`);
    cacheSet(cacheKey, { imdbRating: null, rottenTomatoes: null });
    return { imdbRating: null, rottenTomatoes: null };
  }
}

// ---------------------------------------------------------------------------
// Enrich a single movie
// ---------------------------------------------------------------------------
async function enrichMovie(movie) {
  console.log(`  Enriching: ${movie.title}`);

  const [wikiUrl, omdb] = await Promise.all([
    fetchWikipedia(movie.title),
    fetchOMDb(movie.title),
  ]);

  return {
    id: movie.id,
    title: movie.title,
    director: movie.director,
    schedule: movie.schedule,
    poster: movie.poster,
    wikipedia: wikiUrl,
    imdbRating: omdb.imdbRating,
    rottenTomatoes: omdb.rottenTomatoes,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main() {
  const inputPath = new URL("movies.json", import.meta.url).pathname;
  const outputPath = new URL("movies.enriched.json", import.meta.url).pathname;

  console.log("📖 Reading movies.json...");
  const raw = await readFile(inputPath, "utf-8");
  const movies = JSON.parse(raw);

  console.log(`🎬 Enriching ${movies.length} movies...\n`);

  const enriched = [];
  for (const movie of movies) {
    const result = await enrichMovie(movie);
    enriched.push(result);
    // Small delay to be kind to APIs
    await new Promise((r) => setTimeout(r, 500));
  }

  await writeFile(outputPath, JSON.stringify(enriched, null, 2), "utf-8");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});