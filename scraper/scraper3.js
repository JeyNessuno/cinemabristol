import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL = "http://www.cinemabristol.it/inproiezione.htm";

/**
 * STEP 1: scrape index page (poster + movie links)
 */
async function scrapeIndex() {
  try {
    const { data } = await axios.get(BASE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(data);

    const movies = [];

    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const img = $(el).find("img").attr("src");

      if (!href || !img) return;

      const fullUrl = new URL(href, BASE_URL).href;

      const blocked = [
        "contatti",
        "prezzi",
        "rassegna",
        "prossimamente",
        "webtic",
        "inproiezione",
      ];

      if (blocked.some((b) => fullUrl.toLowerCase().includes(b))) return;
      if (!fullUrl.includes("cinemabristol.it")) return;
      if (!fullUrl.match(/\.htm(l)?$/)) return;

      movies.push({
        url: fullUrl, // ✅ keep page URL explicitly
        poster: new URL(img, BASE_URL).href,
      });
    });

    return movies;
  } catch (error) {
    console.error("Error scraping index:", error.message);
    return [];
  }
}

/**
 * Helper: Extract movie id from URL
 */
function extractId(url) {
  return url
    .split("/")
    .pop()
    .replace(".htm", "")
    .replace(".html", "")
    .trim();
}

/**
 * Helper: Check if text is an address
 */
const isAddress = (t) =>
  /\b(via|viale|corso|piazza|strada|fraz\.|loc\.)\b/i.test(t) ||
  (/\d{1,5}/.test(t) && /,\s*[A-Z]{2}\b/.test(t));

/**
 * Helper: Parse movie line
 */
const parseMovieLine = (t) => {
  if (!t || isAddress(t)) return null;
  if (!t.includes(" di ")) return null;

  const [title, director] = t.split(" di ");

  if (!title || !director) return null;
  if (title !== title.toUpperCase()) return null;
  if (title.length > 60 || director.length > 60) return null;

  return {
    title: title.trim(),
    director: director.trim(),
  };
};

/**
 * Schedule parsing (unchanged logic)
 */
function parseScheduleFromVML($) {
  const schedule = {};
  const rowsByTop = new Map();

  $("span[style*=\"position:absolute\"]").each((_, el) => {
    const $span = $(el);
    const style = $span.attr("style") || "";

    const topMatch = style.match(/top:\s*(\d+)px/);
    if (!topMatch) return;

    const top = parseInt(topMatch[1]);

    const $cell = $span.find('td[style*="border:.9997pt solid black"]');
    if ($cell.length === 0) return;

    const text = $cell.text().trim();
    if (!text) return;

    const widthMatch = $cell.attr("width")?.match(/(\d+)/);
    const width = widthMatch ? parseInt(widthMatch[1]) : 0;

    if (!rowsByTop.has(top)) rowsByTop.set(top, []);

    rowsByTop.get(top).push({ text, width });
  });

  const sortedTops = [...rowsByTop.keys()].sort((a, b) => a - b);

  for (const top of sortedTops) {
    const cells = rowsByTop.get(top);

    const dayCell = cells.find((c) =>
      /^(Gio\.|Ven\.|Sab\.|Dom|Lun\.|Mar\.|Mer\.)$/.test(c.text)
    );

    if (!dayCell) continue;

    const day = dayCell.text.trim();
    if (!schedule[day]) schedule[day] = [];

    const timesCell = cells.find(
      (c) => c.width === 645 || /\d{1,2},\d{2}/.test(c.text)
    );

    if (timesCell) {
      const text = timesCell.text.trim();

      if (text.toLowerCase().includes("riposo")) {
        schedule[day] = ["closed"];
        continue;
      }

      const times =
        text
          .replace(/\s*-\s*/g, ",")
          .replace(/\s+e\s+/g, ",")
          .match(/\d{1,2},\d{2}/g) || [];

      schedule[day].push(...times);
    }
  }

  for (const day of Object.keys(schedule)) {
    if (schedule[day].includes("closed")) {
      schedule[day] = ["closed"];
    } else {
      schedule[day] = [...new Set(schedule[day])];
    }
  }

  return schedule;
}

function parseScheduleFromParagraphs($) {
  const days = ["Mer.", "Gio.", "Ven.", "Sab.", "Dom", "Lun.", "Mar."];
  const schedule = {};
  let currentDay = null;

  const pTags = $("p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  for (const text of pTags) {
    const matchedDay = days.find((d) => text.includes(d));
    if (matchedDay) {
      currentDay = matchedDay;
      if (!schedule[currentDay]) schedule[currentDay] = [];
      continue;
    }

    if (!currentDay) continue;

    if (/\d{1,2},\d{2}/.test(text)) {
      schedule[currentDay].push(...(text.match(/\d{1,2},\d{2}/g) || []));
    }

    if (text.toLowerCase().includes("riposo")) {
      schedule[currentDay] = ["closed"];
      currentDay = null;
    }
  }

  for (const day of Object.keys(schedule)) {
    if (schedule[day].includes("closed")) {
      schedule[day] = ["closed"];
    } else {
      schedule[day] = [...new Set(schedule[day])];
    }
  }

  return schedule;
}

/**
 * STEP 2: scrape movie page
 */
async function parseMoviePage(url) {
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  let schedule = parseScheduleFromVML($);
  if (Object.keys(schedule).length === 0) {
    schedule = parseScheduleFromParagraphs($);
  }

  const pTags = $("p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const parsed = pTags.map(parseMovieLine).find(Boolean);

  if (!parsed) return null;

  return {
    id: extractId(url),
    url, // ✅ preserved
    title: parsed.title,
    director: parsed.director,
    schedule,
  };
}

/**
 * STEP 3: merge everything
 */
async function run() {
  const indexItems = await scrapeIndex();

  const movies = [];

  for (const item of indexItems) {
    const movieData = await parseMoviePage(item.url);

    if (!movieData) continue;

    movies.push({
      ...movieData,
      poster: item.poster,
    });
  }

  console.log(JSON.stringify(movies, null, 2));
}

run();