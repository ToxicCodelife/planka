/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const puppeteerCore = require('puppeteer-core');
// eslint-disable-next-line import/no-extraneous-dependencies
const { addExtra } = require('puppeteer-extra');
// eslint-disable-next-line import/no-extraneous-dependencies
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// eslint-disable-next-line import/no-extraneous-dependencies
const cheerio = require('cheerio');

const puppeteerExtra = addExtra(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

// Same approach as IgdbService's TrueAchievements lookup: Cloudflare's
// interactive managed challenge blocks plain HTTP requests and vanilla
// headless Chromium alike, so this reuses the exact same stealth-plugin
// setup that's already proven to get through for the per-game pages.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });

    const html = await page.content();
    const $ = cheerio.load(html);

    const seenSlugs = new Set();
    const games = [];

    $('a[href^="/game/"]').each((_, el) => {
      const href = $(el).attr('href') || '';

      // Skip sub-page links (achievements, forum, etc.) -- those share the
      // same /game/<slug>/... prefix as the plain game-page link.
      const slugMatch = /^\/game\/([^/]+)\/?$/.exec(href);
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
      console.log(
        `[TrueAchievements:${debugLabel}] No game links matched on the page for "${username}". First 1500 chars of HTML for debugging:`,
      );
      console.log(html.substring(0, 1500));
    }

    return games;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  async fetchOwnedGames(username) {
    return fetchGamerPageGames(username, 'gamecollection', 'owned');
  },

  async fetchWishlistGames(username) {
    return fetchGamerPageGames(username, 'wishlist', 'wishlist');
  },

  // Exposed for the scan script / future tuning.
  toTaSlug,
  guessPlatformFromText,
};
