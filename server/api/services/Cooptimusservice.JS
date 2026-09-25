/* eslint-disable no-console */
// server/api/services/CoOptimusService.js
//
// Fetches a single Co-Optimus game page (found via CoOptimusIndex.js) and
// pulls out just the two fields we actually want: the Online Co-Op player
// count, and the Co-Op Extras tags (e.g. "Co-Op Campaign", "Splitscreen").
// Uses the same axios-first, Puppeteer+stealth-fallback strategy as
// CoOptimusIndex.js.
//
// IMPORTANT: the selectors below were written against the page's rendered
// text content (confirmed live, e.g. co-optimus.com/game/4654/xbox-one/
// a-way-out.html shows "Online Co-Op ... 2 Players" and a "Co-Op Extras"
// section listing "Co-Op Campaign" / "Splitscreen"), but not against the
// raw HTML source directly. They're written defensively (matching on
// visible text rather than assuming exact tag/class names) to be resilient
// to markup details we couldn't verify. If fetchCoOptimusCoOpInfo logs the
// "couldn't find" warning below on a game you know has co-op, view-source
// that page and adjust extractPlayerCountNear / extractCoOpExtras.

const axios = require('axios');
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

async function fetchHtml(url) {
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
      `[CoOptimusService] axios got an unexpected response (status ${response.status}) for ${url}, falling back to Puppeteer.`,
    );
  } catch (err) {
    console.warn(`[CoOptimusService] axios request failed for ${url}, falling back to Puppeteer:`, err.message);
  }

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

// Finds an element whose own (non-descendant) text is exactly `labelText`,
// then looks at its immediate container for "N Players" or "Not Supported".
function extractPlayerCountNear($, labelText) {
  let result = null;

  $('*').each((_, el) => {
    if (result) {
      return;
    }

    const ownText = $(el).clone().children().remove().end().text().trim();
    if (ownText !== labelText) {
      return;
    }

    const container = $(el).parent();
    const searchText = container.text();

    const playersMatch = /(\d+)\s*Players?/i.exec(searchText);
    if (playersMatch) {
      result = { supported: true, maxPlayers: parseInt(playersMatch[1], 10) };
      return;
    }

    if (/Not Supported/i.test(searchText)) {
      result = { supported: false, maxPlayers: null };
    }
  });

  return result;
}

// Finds the "Co-Op Extras" heading and collects the list items (or plain
// text lines) that follow it, stopping at the next section-like heading.
function extractCoOpExtras($) {
  const extras = [];

  $('*').each((_, el) => {
    const ownText = $(el).clone().children().remove().end().text().trim();
    if (ownText !== 'Co-Op Extras') {
      return;
    }

    let sibling = $(el).next();
    let guard = 0;

    while (sibling.length && guard < 10) {
      const text = sibling.text().trim();

      if (!text) {
        sibling = sibling.next();
        guard += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      if (/^(The Co-Op Experience|Description|Splitscreen Layout)$/i.test(text)) {
        break;
      }

      sibling.find('li').each((__, li) => {
        const itemText = $(li).text().trim();
        if (itemText) {
          extras.push(itemText);
        }
      });

      if (sibling.is('li')) {
        extras.push(text);
      }

      sibling = sibling.next();
      guard += 1;
    }
  });

  return [...new Set(extras)];
}

async function fetchCoOptimusCoOpInfo(gameUrl, gameNameForLogging) {
  const html = await fetchHtml(gameUrl);
  const $ = cheerio.load(html);

  const onlineCoop = extractPlayerCountNear($, 'Online Co-Op');
  const extras = extractCoOpExtras($);

  if (!onlineCoop && extras.length === 0) {
    console.warn(
      `[CoOptimusService] Couldn't find Online Co-Op or Co-Op Extras on the page for "${gameNameForLogging}" (${gameUrl}). Check the raw HTML and adjust the selectors in this file.`,
    );
    return null;
  }

  return { onlineCoop, extras };
}

function buildCoOptimusText(data, gameName) {
  if (!data || (!data.onlineCoop && data.extras.length === 0)) {
    return null;
  }

  const lines = [`**Co-Op Info for ${gameName}** (source: Co-Optimus)`];

  if (data.onlineCoop) {
    lines.push(
      data.onlineCoop.supported
        ? `- Online co-op: up to ${data.onlineCoop.maxPlayers} players`
        : '- Online co-op: not supported',
    );
  }

  if (data.extras.length > 0) {
    lines.push(`- Extras: ${data.extras.join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = {
  fetchCoOptimusCoOpInfo,
  buildCoOptimusText,
};
