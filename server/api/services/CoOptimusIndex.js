/* eslint-disable no-console */
// server/api/services/CoOptimusIndex.js
//
// Builds and caches a local index of every game on co-optimus.com by
// crawling their static gamesMap.php sitemap (18 pages, ~17.6k games as of
// this writing, https://www.co-optimus.com/gamesMap.php). This replaces the
// old approach of hitting api.co-optimus.com's XML endpoint (its backing
// database is stale/incomplete) or search.php (that's just a Google Custom
// Search widget -- can't be queried programmatically, same dead end as
// plain Google search).
//
// gamesMap.php and individual /game/{id}/{platform}/{slug}.html pages are
// NOT behind the same Cloudflare interactive challenge api.co-optimus.com
// is -- a plain axios GET worked in testing. We still fall back to the
// existing Puppeteer+stealth setup (same one used for TrueAchievements) in
// case that ever changes, or if a given deployment's IP gets treated
// differently.
//
// Usage:
//   const CoOptimusIndex = require('./CoOptimusIndex');
//   const entry = await CoOptimusIndex.findGameEntry('A Way Out');
//   // -> { name, normalizedName, id, platform, url } or null

const axios = require('axios');
const fsPromises = require('fs').promises;
const path = require('path');
// eslint-disable-next-line import/no-extraneous-dependencies
const cheerio = require('cheerio'); // npm install cheerio --save
// eslint-disable-next-line import/no-extraneous-dependencies
const puppeteerCore = require('puppeteer-core');
// eslint-disable-next-line import/no-extraneous-dependencies
const { addExtra } = require('puppeteer-extra');
// eslint-disable-next-line import/no-extraneous-dependencies
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const puppeteerExtra = addExtra(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SITEMAP_BASE_URL = 'https://www.co-optimus.com/gamesMap.php';
const INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days -- Co-Optimus adds new games gradually, no need to re-crawl often
const INDEX_FILE_PATH =
  process.env.CO_OPTIMUS_INDEX_PATH ||
  (typeof sails !== 'undefined' && sails.config.custom && sails.config.custom.coOptimusIndexPath) ||
  path.join(require('os').tmpdir(), 'co-optimus-index.json');

// Xbox platform slugs as they appear in Co-Optimus game URLs, in the order
// we prefer to match against (most current console first).
const XBOX_PLATFORM_PRIORITY = ['xbox-series', 'xbox-one', 'xbox-360', 'xbox'];

let memoryIndex = null; // { builtAt, entries: [{ name, normalizedName, id, platform, url }] }

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchHtml(url) {
  // 1. Try plain axios first -- fast, no browser overhead, and this part of
  //    the site doesn't appear to be behind Cloudflare's challenge.
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 200 && typeof response.data === 'string' && response.data.length > 0) {
      return response.data;
    }

    console.warn(
      `[CoOptimusIndex] axios got an unexpected response (status ${response.status}) for ${url}, falling back to Puppeteer.`,
    );
  } catch (err) {
    console.warn(`[CoOptimusIndex] axios request failed for ${url}, falling back to Puppeteer:`, err.message);
  }

  // 2. Fall back to the same Puppeteer+stealth setup used for
  //    TrueAchievements, in case axios gets blocked here too.
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (typeof sails !== 'undefined' && sails.config.custom ? sails.config.custom.chromiumPath : null) ||
    '/usr/bin/chromium-browser';

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_UA);

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    return await response.text();
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function parseSitemapPage(html) {
  const $ = cheerio.load(html);
  const entries = [];

  // Every game link on gamesMap.php points at /game/{id}/{platform}/{slug}.html
  $('a[href*="/game/"]').each((_, el) => {
    const href = $(el).attr('href');
    const match = /\/game\/(\d+)\/([a-z0-9-]+)\//i.exec(href || '');
    if (!match) {
      return;
    }

    const name = $(el).text().trim();
    if (!name) {
      return;
    }

    entries.push({
      name,
      normalizedName: normalizeForMatch(name),
      id: match[1],
      platform: match[2],
      url: href.startsWith('http') ? href : `https://www.co-optimus.com${href}`,
    });
  });

  return entries;
}

function findLastPageNumber(html) {
  const $ = cheerio.load(html);
  let lastPage = 1;

  $('a[href*="gamesMap.php?page="]').each((_, el) => {
    const match = /page=(\d+)/.exec($(el).attr('href') || '');
    if (match) {
      lastPage = Math.max(lastPage, parseInt(match[1], 10));
    }
  });

  return lastPage;
}

async function buildIndex() {
  console.log('[CoOptimusIndex] Building fresh index from gamesMap.php...');

  const firstPageHtml = await fetchHtml(SITEMAP_BASE_URL);
  const lastPage = findLastPageNumber(firstPageHtml);
  const entries = parseSitemapPage(firstPageHtml);

  console.log(`[CoOptimusIndex] Sitemap reports ${lastPage} pages. Fetching the rest...`);

  for (let pageNum = 2; pageNum <= lastPage; pageNum += 1) {
    // eslint-disable-next-line no-await-in-loop
    const html = await fetchHtml(`${SITEMAP_BASE_URL}?page=${pageNum}`);
    entries.push(...parseSitemapPage(html));

    // Be a reasonable citizen -- small delay between pages.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  console.log(`[CoOptimusIndex] Indexed ${entries.length} game/platform entries.`);

  const index = { builtAt: Date.now(), entries };

  try {
    await fsPromises.writeFile(INDEX_FILE_PATH, JSON.stringify(index), 'utf8');
  } catch (err) {
    console.warn('[CoOptimusIndex] Failed to write index cache to disk:', err.message);
  }

  memoryIndex = index;
  return index;
}

async function loadIndex() {
  if (memoryIndex && Date.now() - memoryIndex.builtAt < INDEX_MAX_AGE_MS) {
    return memoryIndex;
  }

  try {
    const raw = await fsPromises.readFile(INDEX_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed && parsed.builtAt && Date.now() - parsed.builtAt < INDEX_MAX_AGE_MS) {
      memoryIndex = parsed;
      return memoryIndex;
    }
  } catch (err) {
    // No cache file yet, or it's corrupt/unreadable -- fall through to a rebuild.
  }

  return buildIndex();
}

async function findGameEntry(gameName) {
  const index = await loadIndex();
  const normalizedTitle = normalizeForMatch(gameName);

  const matches = index.entries.filter((entry) => entry.normalizedName === normalizedTitle);
  if (matches.length === 0) {
    return null;
  }

  // Prefer the most current Xbox platform page we have.
  // eslint-disable-next-line no-restricted-syntax
  for (const platform of XBOX_PLATFORM_PRIORITY) {
    const match = matches.find((entry) => entry.platform === platform);
    if (match) {
      return match;
    }
  }

  // No Xbox entry -- fall back to whatever platform matched first, so we
  // still surface co-op info even if it's technically for another platform's page.
  return matches[0];
}

module.exports = {
  findGameEntry,
  buildIndex, // exported so a scheduled job / admin route can force a refresh
};
