/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const puppeteerCore = require('puppeteer-core');
// eslint-disable-next-line import/no-extraneous-dependencies
const { addExtra } = require('puppeteer-extra');
// eslint-disable-next-line import/no-extraneous-dependencies
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// eslint-disable-next-line import/no-extraneous-dependencies
const cheerio = require('cheerio');
const fsPromises = require('fs').promises;
const path = require('path');

const puppeteerExtra = addExtra(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

// Same approach as IgdbService's TrueAchievements lookup: Cloudflare's
// interactive managed challenge blocks plain HTTP requests and vanilla
// headless Chromium alike, so this reuses the exact same stealth-plugin
// setup that's already proven to get through for the per-game pages.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Where debug HTML dumps go when a page comes back with zero games matched
// -- written to disk instead of dumped to the console because the
// gamecollection page's content area is deep in the markup (the first
// couple thousand chars are always header/nav boilerplate), so a short
// console snippet wasn't enough to diagnose it.
const DEBUG_DIR =
  process.env.TA_DEBUG_DIR ||
  (typeof sails !== 'undefined' && sails.config.custom ? sails.config.custom.taDebugDir : null) ||
  path.join(require('os').tmpdir(), 'ta-debug');

// TrueAchievements gamer URLs use a literal "+" for spaces in the gamertag
// (e.g. "Das Chocobo" -> ".../gamer/Das+Chocobo"), not %20.
function toTaSlug(username) {
  return encodeURIComponent(String(username || '').trim()).replace(/%20/g, '+');
}

function guessPlatformFromText(text) {
  if (/xbox\s*360/i.test(text)) {
    return '360';
  }

  if (/xbox\s*(one|series)/i.test(text)) {
    return 'oneOrSeries';
  }

  return null;
}

// Walks up from a game link to the nearest container that plausibly holds
// that row's platform text (table row, list item, or a div wrapping both),
// and guesses the platform from whatever text is in it. Unverified against
// the live markup -- if this keeps returning UNKNOWN in the dry-run output,
// it needs tuning from real logs.
function guessRowPlatform($, anchorEl) {
  let node = $(anchorEl);

  for (let depth = 0; depth < 6; depth += 1) {
    const guess = guessPlatformFromText(node.text());

    if (guess) {
      return guess;
    }

    const tagName = node.prop('tagName');
    if (tagName && /^(TR|LI)$/i.test(tagName)) {
      // Reached a natural row boundary with no platform match inside it --
      // climbing further risks picking up a neighboring row's platform.
      break;
    }

    const parent = node.parent();
    if (parent.length === 0) {
      break;
    }

    node = parent;
  }

  return null;
}

const GAME_LINK_SELECTOR = 'a[href^="/game/"]';

// The wishlist page renders its game list into the initial DOM shortly
// after load -- a plain waitForSelector is enough there (confirmed working).
// The gamecollection page came back with NO /game/ links at all even after
// that same wait: a dry run showed only 94852 bytes of HTML vs. the
// wishlist's 407339 for the same user, and the body was just
// TrueAchievements' nav chrome plus a data-pt="mygamecollection" marker --
// no game rows anywhere. TrueAchievements' own help docs describe this view
// as defaulting to an "Image View" grid, which points to the grid being
// populated by client-side JS after some additional trigger -- lazy-load on
// scroll is the most common pattern for that kind of grid. This scrolls the
// page in steps, re-checking for game links after each one, so it has a
// real chance of catching a scroll-triggered render without needing to know
// the exact JS/selectors TrueAchievements uses internally.
async function waitForGamesWithScroll(page, debugLabel, username) {
  const quickHit = await page
    .waitForSelector(GAME_LINK_SELECTOR, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (quickHit) {
    return true;
  }

  console.log(
    `[TrueAchievements:${debugLabel}] No /game/ links within 8s for "${username}" -- trying scroll-triggered lazy-load as a fallback.`,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });

    // eslint-disable-next-line no-await-in-loop
    const found = await page.$(GAME_LINK_SELECTOR);
    if (found) {
      console.log(
        `[TrueAchievements:${debugLabel}] Game links appeared for "${username}" after ${attempt + 1} scroll step(s).`,
      );
      return true;
    }
  }

  return false;
}

async function writeDebugHtml(debugLabel, username, html) {
  try {
    await fsPromises.mkdir(DEBUG_DIR, { recursive: true });
    const safeName = `${debugLabel}-${String(username).replace(/[^a-z0-9]/gi, '_')}.html`;
    const filePath = path.join(DEBUG_DIR, safeName);
    await fsPromises.writeFile(filePath, html, 'utf8');
    return filePath;
  } catch (err) {
    console.warn(`[TrueAchievements:${debugLabel}] Failed to write debug HTML to disk: ${err.message}`);
    return null;
  }
}

// Scans the raw HTML for a handful of keywords that would explain an empty
// result without needing to read the whole dump -- printed straight to the
// console alongside the debug-file path.
function scanForHints(html) {
  const hints = [];

  const checks = [
    [/captcha/i, 'mentions "captcha"'],
    [
      /cf-browser-verification|checking your browser|just a moment|challenge-platform|enable javascript and cookies|cf-chl/i,
      'looks like a Cloudflare challenge page',
    ],
    [/sign in|log in|you must be logged in/i, 'mentions signing in / logging in'],
    [/private|not public|has chosen to keep/i, 'mentions a privacy restriction'],
    [/no games (found|match)/i, 'explicitly says no games found/match'],
    [/this gamer('s| has) (achievements|games)/i, "mentions the gamer's achievements/games generically"],
    [/view and filter/i, 'has a "View and Filter" control (collection page UI)'],
    [/data-pt="mygamecollection"/i, 'confirmed on the My Game Collection page'],
    [/data-pt="gamerwishlist"/i, 'confirmed on the Wishlist page'],
    [/data-pt="gamerhome"|data-pt="gamergames"|data-pt="games"/i, 'confirmed on a gamer games/home page'],
    [/404|page not found/i, 'looks like a 404 / not found page'],
  ];

  checks.forEach(([regex, label]) => {
    if (regex.test(html)) {
      hints.push(label);
    }
  });

  return hints;
}

async function fetchGamerPageGames(username, pagePath, debugLabel) {
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (sails.config.custom ? sails.config.custom.chromiumPath : null) ||
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

    const url = `https://www.trueachievements.com/gamer/${toTaSlug(username)}/${pagePath}`;
    console.log(`[TrueAchievements:${debugLabel}] Navigating to: ${url}`);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    const gotLinks = await waitForGamesWithScroll(page, debugLabel, username);

    if (!gotLinks) {
      console.log(
        `[TrueAchievements:${debugLabel}] Still no /game/ links for "${username}" after scrolling.`,
      );
    }

    // Small settle delay even after links show up -- the list can still be
    // populating additional rows right after the first one appears.
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });

    const html = await page.content();
    const $ = cheerio.load(html);

    const seenSlugs = new Set();
    const games = [];
    let candidateCount = 0;

    $(GAME_LINK_SELECTOR).each((_, el) => {
      candidateCount += 1;

      const href = $(el).attr('href') || '';

      // Matches "/game/<slug>" with anything after it too (TA's own game
      // links elsewhere point to "/game/<slug>/achievements", so collection
      // and wishlist rows likely do the same) -- just take the slug itself.
      const slugMatch = /^\/game\/([^/]+)/.exec(href);
      if (!slugMatch) {
        return;
      }

      const slug = slugMatch[1];
      const name = $(el).text().trim();

      if (!name || seenSlugs.has(slug)) {
        return;
      }

      seenSlugs.add(slug);

      games.push({
        name,
        slug,
        platformGuess: guessRowPlatform($, el),
      });
    });

    if (games.length === 0) {
      const debugFilePath = await writeDebugHtml(debugLabel, username, html);
      const hints = scanForHints(html);

      console.log(
        `[TrueAchievements:${debugLabel}] No game links matched on the page for "${username}" ` +
          `(total HTML length: ${html.length}, raw /game/ anchors seen: ${candidateCount}).`,
      );
      console.log(
        `[TrueAchievements:${debugLabel}] Hints found in the page: ${
          hints.length > 0 ? hints.join('; ') : '(none of the known keywords matched)'
        }`,
      );
      if (debugFilePath) {
        console.log(
          `[TrueAchievements:${debugLabel}] Full page HTML written to: ${debugFilePath} -- ` +
            `open it and search for where this gamer's games should appear (look near ` +
            `"mygamecollection" or any element classed like a game grid/card), then paste ` +
            `back that section so the selector can be tuned to it.`,
        );
      }
    }

    return games;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  // NOTE: this hits /games (the gamer's public played-games / achievement
  // history list), not /gamecollection. A dry run confirmed /gamecollection
  // needs the viewer to be signed in (its page came back with a "sign in /
  // log in" hint and zero game links, even after the scroll-retry above) --
  // it's a manually-curated ownership list behind that wall, not something
  // this anonymous scraper can read. /games is TrueAchievements' actual
  // core feature (every game the gamer has Xbox Live achievement progress
  // on), is public with no sign-in wall, and renders as plain server-side
  // HTML with no lazy-load needed. The trade-off: this won't catch a game
  // someone owns but has 0% progress on yet (that's ONLY visible on the
  // sign-in-gated collection page) -- it covers "games they've actually
  // played," which is the main case.
  async fetchOwnedGames(username) {
    return fetchGamerPageGames(username, 'games', 'owned');
  },

  async fetchWishlistGames(username) {
    return fetchGamerPageGames(username, 'wishlist', 'wishlist');
  },

  // Exposed for the scan script / future tuning.
  toTaSlug,
  guessPlatformFromText,
};
