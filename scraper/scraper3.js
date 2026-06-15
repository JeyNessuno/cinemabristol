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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    const $ = cheerio.load(data);

    const movies = [];

    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const img = $(el).find("img").attr("src");

      if (!href || !img) return;

      const fullPage = new URL(href, BASE_URL).href;

      const blocked = [
        "contatti",
        "prezzi",
        "rassegna",
        "prossimamente",
        "webtic",
        "inproiezione"
      ];

      if (blocked.some(b => fullPage.toLowerCase().includes(b))) return;
      if (!fullPage.includes("cinemabristol.it")) return;
      if (!fullPage.match(/\.htm(l)?$/)) return;

      movies.push({
        page: fullPage,
        poster: new URL(img, BASE_URL).href
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
  /\d{1,5}/.test(t) && /,\s*[A-Z]{2}\b/.test(t);

/**
 * Helper: Parse movie title and director from text
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
    director: director.trim()
  };
}

/**
 * Parse schedule from VML-based HTML (like disclosure-source.html)
 * The schedule is stored in absolutely positioned table cells
 * Each row: Day (left, width=81) | Date (middle, width=53) | Times (right, width=645)
 * All cells in the same row share the same "top" value in their positioning
 */
function parseScheduleFromVML($) {
  const schedule = {};
  const rowsByTop = new Map(); // key = top position, value = array of cells
  
  // Find all spans with absolute positioning that contain schedule cells
  // These are the elements that wrap the table cells with border
  $('span[style*="position:absolute"]').each((_, el) => {
    const $span = $(el);
    const style = $span.attr('style') || '';
    
    // Extract top position
    const topMatch = style.match(/top:\s*(\d+)px/);
    if (!topMatch) return;
    
    const top = parseInt(topMatch[1]);
    
    // Check if this span contains a table cell with border (schedule cell)
    const $cell = $span.find('td[style*="border:.9997pt solid black"]');
    if ($cell.length === 0) return;
    
    const text = $cell.text().trim();
    if (!text) return;
    
    // Get cell width to help classify it
    const widthMatch = $cell.attr('width')?.match(/(\d+)/);
    const width = widthMatch ? parseInt(widthMatch[1]) : 0;
    
    // Initialize row if not exists
    if (!rowsByTop.has(top)) {
      rowsByTop.set(top, []);
    }
    
    // Add this cell to the row
    rowsByTop.get(top).push({
      text,
      width
    });
  });
  
  // Process each row (sorted by vertical position)
  const sortedTops = Array.from(rowsByTop.keys()).sort((a, b) => a - b);
  
  for (const top of sortedTops) {
    const cells = rowsByTop.get(top);
    
    // Find the day cell (should contain day abbreviation)
    const dayCell = cells.find(c => 
      c.text.match(/^(Gio\.|Ven\.|Sab\.|Dom|Lun\.|Mar\.|Mer\.)$/)
    );
    
    if (!dayCell) continue;
    
    const day = dayCell.text.trim();
    
    // Initialize schedule for this day
    if (!schedule[day]) {
      schedule[day] = [];
    }
    
    // Find the times cell (should be the widest cell with time data)
    const timesCell = cells.find(c => 
      c.width === 645 || c.text.match(/\d{1,2},\d{2}/)
    );
    
    if (timesCell) {
      const timesText = timesCell.text.trim();
      
      // Check for closed day
      if (timesText.toLowerCase().includes('riposo')) {
        schedule[day] = ['closed'];
        continue;
      }
      
      // Extract times from formats like:
      // "15,30 - 18,30 e 21,15"
      // "18,30 e 21,15"
      // "21,15"
      const times = timesText
        .replace(/\s*-\s*/g, ',')  // Replace " - " with ","
        .replace(/\s+e\s+/g, ',')   // Replace " e " with ","
        .match(/\d{1,2},\d{2}/g) || [];
      
      schedule[day].push(...times);
    }
  }
  
  // Remove duplicates and normalize
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
 * Fallback: Parse schedule from paragraph tags
 * Used when VML structure is not found
 */
function parseScheduleFromParagraphs($) {
  const days = ["Mer.", "Gio.", "Ven.", "Sab.", "Dom", "Lun.", "Mar."];
  const schedule = {};
  let currentDay = null;
  
  // Get all paragraph texts
  const pTags = $("p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  
  for (const text of pTags) {
    // Check if this is a day
    const matchedDay = days.find(d => text.includes(d));
    if (matchedDay) {
      currentDay = matchedDay;
      if (!schedule[currentDay]) schedule[currentDay] = [];
      continue;
    }
    
    if (!currentDay) continue;
    
    // Check for times
    if (/\d{1,2},\d{2}/.test(text)) {
      const times = text.match(/\d{1,2},\d{2}/g) || [];
      schedule[currentDay].push(...times);
    }
    
    // Check for closed day
    if (text.toLowerCase().includes("riposo")) {
      schedule[currentDay] = ["closed"];
      currentDay = null;
    }
  }
  
  // Remove duplicates
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
 * Alternative approach: Parse schedule by looking at the actual table structure
 * The VML HTML has a pattern where schedule info is in specific table cells
 */
async function parseMoviePage(url) {
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Try VML-based schedule parsing first, fallback to paragraph parsing
  let schedule = parseScheduleFromVML($);
  if (Object.keys(schedule).length === 0) {
    schedule = parseScheduleFromParagraphs($);
  }
  
  // TITLE + DIRECTOR PARSING
  const pTags = $("p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  
  const parsed =
    pTags.map(parseMovieLine).find(Boolean) || null;

  // If no valid movie title/director found, skip this page (false positive)
  if (!parsed) return null;

  return {
    id: extractId(url),
    title: parsed.title,
    director: parsed.director,
    schedule
  };
}

/**
 * STEP 3: merge everything
 */
async function run() {
  const indexItems = await scrapeIndex();

  const movies = [];

  for (const item of indexItems) {
    const movieData = await parseMoviePage(item.page);

    if (!movieData) continue; // skip false positives (404 pages, non-movies)

    movies.push({
      ...movieData,
      poster: item.poster
    });
  }

  console.log(JSON.stringify(movies, null, 2));
}

run();
