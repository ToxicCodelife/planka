/* eslint-disable no-console */
// server/api/services/HowLongToBeatService.js
//
// Replaces the `howlongtobeat-api` npm package, which throws internally on
// every call ("Cannot read properties of undefined (reading 'load')" inside
// its own dist/parsers.js -- a bug in that package, not our code).
//
// Rather than swap to a different wrapper package, this drives the real
// howlongtobeat.com search page directly with the same Puppeteer+stealth
// setup already proven against this exact site (see project history --
// HowLongToBeat, Co-Optimus, and TrueAchievements were all originally
// confirmed to need it, same as Cloudflare's interactive challenge blocking
// plain axios). Driving the actual page also sidesteps a chronic problem
// with every third-party HLTB wrapper: howlongtobeat.com periodically
// rotates an obfuscated key their internal search API requires, which
// breaks every wrapper library until someone patches it. Since the browser
// runs the site's own JS to perform the search, that key rotation is
// invisible to us -- nothing to reverse-engineer or keep up to date.
//
// CAVEAT: howlongtobeat.com's Cloudflare wall blocks this environment's own
// fetch tooling, so the selectors below could not be verified against the
// live page the way Co-Optimus's were. They're written from the result
// shape every major HLTB wrapper library converges on (game name, Main
// Story / Main + Extra / Completionist hours), with defensive text-based
// matching and debug logging on a miss -- expect to possibly need one round
// of tuning from real logs, same as the TrueAchievements fix alongside this.

// eslint-disable-next-line import/no-extraneous-dependencies
const cheerio = require('cheerio');
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

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Converts HLTB's hour text (e.g. "34½ Hours", "12 Hours", "--") to a
// number of hours, or null if there's no real value.
function parseHoursText(text) {
  if (!text) {
    return null;
  }

  const cleaned = text.replace(/Hours?/i, '').trim();
  if (!cleaned || /^-+$/.test(cleaned)) {
    return null;
  }

  const fractionMap = { '¼': 0.25, '½': 0.5, '¾': 0.75 };
  const fractionChar = Object.keys(fractionMap).find((f) => cleaned.includes(f));

  const wholePart = parseFloat(cleaned.replace(/[¼½¾]/g, '').trim());
  if (Number.isNaN(wholePart)) {
    return null;
  }

  return fractionChar ? wholePart + fractionMap[fractionChar] : wholePart;
}

async function searchHowLongToBeat(gameName) {
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

    const searchUrl = `https://howlongtobeat.com/?q=${encodeURIComponent(gameName)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });

    // Results load in via client-side JS after the initial page render --
    // wait for an actual game link rather than a fixed delay.
    await page.waitForSelector('a[href*="/game/"]', { timeout: 10000 }).catch(() => {
      console.log(`[HowLongToBeat] No game links appeared for search: "${gameName}"`);
    });

    const html = await page.content();
    const $ = cheerio.load(html);

    const normalizedTitle = normalizeForMatch(gameName);
    let best = null;

    $('a[href*="/game/"]').each((_, el) => {
      if (best) {
        return;
      }

      const href = $(el).attr('href');
      const idMatch = /\/game\/(\d+)/.exec(href || '');
      if (!idMatch) {
        return;
      }

      // The result card is usually a shared ancestor a few levels up from
      // the title link, containing both the name and the three hour
      // columns -- walk up until we find a container that also has
      // "Main Story" text, capped so we don't walk all the way to <body>.
      let container = $(el);
      for (let i = 0; i < 5; i += 1) {
        if (/Main Story/i.test(container.text())) {
          break;
        }
        container = container.parent();
      }

      const cardText = container.text();
      const cardName = $(el).text().trim();

      if (!cardName) {
        return;
      }

      // Prefer an exact normalized-name match; otherwise take the first
      // result card as HLTB's own search ranking's best guess.
      const isExactMatch = normalizeForMatch(cardName) === normalizedTitle;
      if (!best || isExactMatch) {
        best = { id: idMatch[1], name: cardName, cardText, isExactMatch };
      }

      if (isExactMatch) {
        return;
      }
    });

    if (!best) {
      console.log(`[HowLongToBeat] No search results found for: "${gameName}"`);
      return null;
    }

    const mainMatch = /Main Story\s*([\d½¼¾.]+\s*Hours?|--)/i.exec(best.cardText);
    const extraMatch = /Main \+ Extra\s*([\d½¼¾.]+\s*Hours?|--)/i.exec(best.cardText);
    const completionistMatch = /Completionist\s*([\d½¼¾.]+\s*Hours?|--)/i.exec(best.cardText);

    const result = {
      source: 'HowLongToBeat',
      mainHours: mainMatch ? parseHoursText(mainMatch[1]) : null,
      mainExtraHours: extraMatch ? parseHoursText(extraMatch[1]) : null,
      completionistHours: completionistMatch ? parseHoursText(completionistMatch[1]) : null,
    };

    if (!result.mainHours && !result.mainExtraHours && !result.completionistHours) {
      console.warn(
        `[HowLongToBeat] Matched "${best.name}" for "${gameName}" but couldn't parse any hour values from the card. Raw card text:`,
        best.cardText.substring(0, 500),
      );
      return null;
    }

    console.log(`[HowLongToBeat] Matched "${gameName}" -> "${best.name}" (id ${best.id})`);
    return result;
  } catch (err) {
    console.warn('[HowLongToBeat] lookup failed:', err.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  searchHowLongToBeat,
};
