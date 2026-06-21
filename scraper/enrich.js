import axios from "axios";
import { readFile, writeFile } from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OMDB_API_KEY = "be336499";
const OMDB_BASE = "https://www.omdbapi.com";
const WIKI_BASE = "https://it.wikipedia.org/w/api.php";
const GEMINI_API_KEY = process.env.GCP_API_KEY;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Project root (parent of the scraper/ folder)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

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
// Translate English text to natural Italian using Gemini 2.5 Flash
// ---------------------------------------------------------------------------
async function translateToItalian(text) {
  if (!text) return null;

  const cacheKey = `translate:${text.slice(0, 80)}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { data } = await axios.post(
      `${GEMINI_BASE}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Traduci in italiano naturale (adatto a un pubblico italiano che legge la programmazione di un cinema). Restituisci SOLO la traduzione, senza prefissi o spiegazioni:\n\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2000,
        },
      },
      {
        timeout: 15000,
      },
    );

    const translation =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    cacheSet(cacheKey, translation);
    return translation;
  } catch (err) {
    console.warn(`  ⚠ Gemini translation failed: ${err.message}`);
    cacheSet(cacheKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalize title: lowercase, remove punctuation, collapse spaces,
// optionally strip subtitle after ":" or " - "
// ---------------------------------------------------------------------------
function normalizeTitle(title, stripSubtitle = true) {
  let t = title.toLowerCase().trim();

  if (stripSubtitle) {
    // Strip everything after " — " (em dash), " - " (hyphen with spaces), or " :"
    t = t.replace(/\s*[—–\-]\s.*/, "");
    t = t.replace(/\s*:.*/, "");
  }

  return t
    .replace(/[^\w\s]/g, "")      // remove punctuation
    .replace(/\s+/g, " ")          // collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Word overlap ratio between two strings (0–1)
// ---------------------------------------------------------------------------
function computeWordOverlap(a, b) {
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let common = 0;
  for (const w of setA) {
    if (setB.has(w)) common++;
  }
  return common / Math.max(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// Wikipedia (Italian) — return { title, url } or null
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
      const pageTitle = pages[0].title;
      const url = `https://it.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;
      const result = { title: pageTitle, url };
      cacheSet(cacheKey, result);
      return result;
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
// OMDb search — find best candidate by word overlap
// ---------------------------------------------------------------------------
async function searchOMDb(title) {
  const normal = normalizeTitle(title);
  const cacheKey = `omdb:search:${normal}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  if (!OMDB_API_KEY) {
    console.warn("  ⚠ OMDB_API_KEY not set — skipping OMDb search");
    cacheSet(cacheKey, null);
    return null;
  }

  try {
    // Phase 1: search
    const { data } = await axios.get(OMDB_BASE, {
      params: {
        apikey: OMDB_API_KEY,
        s: title,
        type: "movie",
      },
      timeout: 10000,
    });

    if (data.Response === "False" || !data.Search) {
      console.warn(`  ⚠ OMDb search returned no results for "${title}"`);
      cacheSet(cacheKey, null);
      return null;
    }

    // Score each result by word overlap against normalized title
    let bestCandidate = null;
    let bestScore = 0;

    for (const result of data.Search) {
      const resultNormal = normalizeTitle(result.Title);
      const overlap = computeWordOverlap(resultNormal, normal);

      // Penalise non-movie types
      const typePenalty = result.Type && result.Type !== "movie" ? 0.3 : 0;

      const score = overlap - typePenalty;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = { ...result, overlapScore: overlap };
      }
    }

    if (!bestCandidate || bestScore < 0.3) {
      console.warn(`  ⚠ No good OMDb candidate for "${title}" (best overlap: ${bestScore.toFixed(2)})`);
      cacheSet(cacheKey, null);
      return null;
    }

    // Phase 2: fetch full details by imdbID
    const { data: full } = await axios.get(OMDB_BASE, {
      params: {
        apikey: OMDB_API_KEY,
        i: bestCandidate.imdbID,
      },
      timeout: 10000,
    });

    if (full.Response === "False") {
      console.warn(`  ⚠ OMDb detail fetch failed for "${bestCandidate.imdbID}"`);
      cacheSet(cacheKey, null);
      return null;
    }

    const result = {
      imdbID: full.imdbID || null,
      title: full.Title || null,
      year: full.Year && full.Year !== "N/A" ? full.Year : null,
      imdbRating: full.imdbRating && full.imdbRating !== "N/A" ? full.imdbRating : null,
      plot: full.Plot && full.Plot !== "N/A" ? full.Plot : null,
      type: full.Type || null,
      rawOverlapScore: bestCandidate.overlapScore,
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`  ⚠ OMDb search failed for "${title}": ${err.message}`);
    cacheSet(cacheKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compute confidence score for OMDb match
// ---------------------------------------------------------------------------
function computeConfidenceScore(omdbTitle, inputTitle, wikipediaTitle, year, type) {
  let score = 0;

  const omdbNorm = normalizeTitle(omdbTitle || "");
  const inputNorm = normalizeTitle(inputTitle);
  const wikiNorm = wikipediaTitle ? normalizeTitle(wikipediaTitle) : null;

  // +40 if exact match
  if (omdbNorm === inputNorm) {
    score += 40;
  }

  // +25 if high word overlap (>80%)
  const overlap = computeWordOverlap(omdbNorm, inputNorm);
  if (overlap > 0.8) {
    score += 25;
  }

  // +15 if Wikipedia title matches OMDb title closely
  if (wikiNorm) {
    const wikiOverlap = computeWordOverlap(omdbNorm, wikiNorm);
    if (wikiOverlap > 0.8) {
      score += 15;
    }
  }

  // +10 if year is plausible
  if (year) {
    const y = parseInt(year, 10);
    if (!isNaN(y) && y >= 1900 && y <= 2030) {
      score += 10;
    }
  }

  // -30 if not a movie
  if (type && type !== "movie") {
    score -= 30;
  }

  // -20 if title mismatch is strong (low overlap)
  if (overlap < 0.3) {
    score -= 20;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Download poster image to project root using its original filename
// ---------------------------------------------------------------------------
async function downloadPoster(posterUrl, movieId) {
  if (!posterUrl) return posterUrl;

  try {
    // Extract original filename from URL
    const urlPath = new URL(posterUrl).pathname;
    const originalName = path.basename(urlPath);

    // Save to project root
    const localPath = path.join(PROJECT_ROOT, originalName);

    console.log(`  📥 Downloading poster: ${originalName}`);

    const response = await axios({
      method: "GET",
      url: posterUrl,
      responseType: "stream",
      timeout: 15000,
    });

    await new Promise((resolve, reject) => {
      const writer = createWriteStream(localPath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // Return the local relative path (just the filename, served from root)
    return originalName;
  } catch (err) {
    console.warn(`  ⚠ Failed to download poster for "${movieId}": ${err.message}`);
    return posterUrl; // fallback to original URL
  }
}

// ---------------------------------------------------------------------------
// Enrich a single movie using the consensus pipeline
// ---------------------------------------------------------------------------
async function enrichMovie(movie) {
  console.log(`  Enriching: ${movie.title}`);

  // Step 1 — Normalize title
  const normalizedTitle = normalizeTitle(movie.title);

  // Step 2 — Wikipedia (primary anchor, always included if found)
  const wiki = await fetchWikipedia(movie.title);

  // Step 5 note: Wikipedia is always included if found (no scoring needed)

  // Step 3 — OMDb candidate (secondary signal)
  const omdbCandidate = await searchOMDb(movie.title);

  let omdbResult = null;
  let omdbScore = 0;

  if (omdbCandidate) {
    // Step 4 — Cross-validation scoring
    omdbScore = computeConfidenceScore(
      omdbCandidate.title,
      movie.title,
      wiki ? wiki.title : null,
      omdbCandidate.year,
      omdbCandidate.type,
    );

    console.log(`    └ omdbScore=${omdbScore} (overlap=${(omdbCandidate.rawOverlapScore * 100).toFixed(0)}%)`);

    // Only accept OMDb data if score >= 50
    if (omdbScore >= 50) {
      // Translate the English plot to Italian
      const italianPlot = await translateToItalian(omdbCandidate.plot);

      omdbResult = {
        imdbID: omdbCandidate.imdbID,
        imdbRating: omdbCandidate.imdbRating,
        year: omdbCandidate.year,
        plot: italianPlot || omdbCandidate.plot,
      };
    } else {
      console.log(`    └ → OMDb discarded (score ${omdbScore} < 50)`);
    }
  }

  // Download poster
  const localPoster = await downloadPoster(movie.poster, movie.id);

  // Step 6 — Final merged output
  const description = omdbResult?.plot || null;

  return {
    id: movie.id,
    url: movie.url,
    title: movie.title,
    director: movie.director,
    schedule: movie.schedule,
    poster: localPoster,
    description,
    wikipedia: wiki ? { title: wiki.title, url: wiki.url } : null,
    omdb: omdbResult,
    confidence: {
      omdbScore,
      wikipediaFound: wiki !== null,
    },
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
  console.log(`\n✅ Done — wrote ${enriched.length} movies to movies.enriched.json`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});