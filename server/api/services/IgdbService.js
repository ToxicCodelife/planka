/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// eslint-disable-next-line import/no-extraneous-dependencies
const puppeteerCore = require('puppeteer-core'); // npm install puppeteer-core --save
// eslint-disable-next-line import/no-extraneous-dependencies
const { addExtra } = require('puppeteer-extra'); // npm install puppeteer-extra --save
// eslint-disable-next-line import/no-extraneous-dependencies
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // npm install puppeteer-extra-plugin-stealth --save
// eslint-disable-next-line import/no-extraneous-dependencies
const cheerio = require('cheerio');
const CoOptimusIndex = require('./CoOptimusIndex');
const CoOptimusService = require('./CoOptimusService');
const HowLongToBeatService = require('./HowLongToBeatService');

const puppeteerExtra = addExtra(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getIgdbToken(clientId, clientSecret) {
  const auth = await axios.post(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
  );

  return auth.data.access_token;
}

let xboxPlatformIdsCache = null;

async function getXboxPlatformIds(clientId, token) {
  if (xboxPlatformIdsCache) {
    return xboxPlatformIdsCache;
  }

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/platforms',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      // Looked up by name rather than hardcoded IDs -- IGDB's own platform
      // IDs for these are stable in practice, but resolving them live means
      // this doesn't silently break if that ever changes.
      data: 'fields id, name; where name = ("Xbox", "Xbox 360", "Xbox One", "Xbox Series X|S"); limit 10;',
    });

    console.log('[DEBUG] Resolved Xbox platforms from IGDB:', JSON.stringify(response.data));

    const ids = (response.data || []).map((p) => p.id);

    if (ids.length === 0) {
      console.warn(
        'IGDB Xbox platform lookup returned no results; game search will not be platform-filtered.',
      );
      return null;
    }

    xboxPlatformIdsCache = ids;
    return ids;
  } catch (err) {
    console.warn(
      'IGDB Xbox platform lookup failed:',
      err.response ? JSON.stringify(err.response.data) : err.message,
    );
    return null;
  }
}

async function searchIgdbGame(cardTitle, clientId, token) {
  // Escape backslashes and double quotes so titles with punctuation don't
  // break out of the Apicalypse string literal.
  const escapedTitle = cardTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const fieldsClause =
    'fields id, name, cover.url, genres.name, themes.name, videos.video_id, videos.name; limit 10;';

  // IGDB's `search` ranks by its own relevance/popularity, which can put a
  // well-known franchise with an overlapping word (e.g. "The King of
  // Fighters XV" for a query of "For The King") ahead of the actual game
  // typed on the card. Pulling back several candidates and preferring an
  // exact (normalized) title match fixes that; only fall back to IGDB's own
  // top-ranked result when nothing matches exactly.
  const pickBestMatch = (results) => {
    if (!results || results.length === 0) {
      return null;
    }

    const normalizedTitle = normalizeForMatch(cardTitle);
    const exactMatch = results.find((g) => normalizeForMatch(g.name) === normalizedTitle);

    return exactMatch || results[0];
  };

  const xboxPlatformIds = await getXboxPlatformIds(clientId, token);

  if (xboxPlatformIds) {
    const filteredResponse = await axios({
      url: 'https://api.igdb.com/v4/games',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `search "${escapedTitle}"; where platforms = (${xboxPlatformIds.join(
        ',',
      )}); ${fieldsClause}`,
    });

    const filteredGame = pickBestMatch(filteredResponse.data);
    if (filteredGame) {
      return filteredGame;
    }

    // Nothing came back restricted to Xbox platforms -- IGDB's platform
    // tagging has real gaps for older/obscure titles, so fall back to an
    // unrestricted search rather than losing the card's data entirely.
    console.log(
      `No Xbox-platform match on IGDB for "${cardTitle}"; retrying without the platform filter.`,
    );
  }

  const response = await axios({
    url: 'https://api.igdb.com/v4/games',
    method: 'POST',
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: `search "${escapedTitle}"; ${fieldsClause}`,
  });

  const fuzzyGame = pickBestMatch(response.data);
  if (fuzzyGame) {
    return fuzzyGame;
  }

  // IGDB's fuzzy `search` can return zero results for titles made up
  // entirely of common English words -- e.g. "We Were Here" -- its search
  // backend appears to treat them as stopwords, leaving nothing to match
  // on, even though the game is definitely in IGDB's database (confirmed:
  // "We Were Here" and "We Were Here Too" both exist there). An exact name
  // lookup sidesteps that: no fuzzy ranking involved, just a direct
  // equality check against the game's actual title field.
  console.log(`No fuzzy-search match on IGDB for "${cardTitle}"; trying an exact name match.`);

  const exactResponse = await axios({
    url: 'https://api.igdb.com/v4/games',
    method: 'POST',
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: `where name = "${escapedTitle}"; ${fieldsClause}`,
  });

  return pickBestMatch(exactResponse.data);
}

async function fetchIgdbTimeToBeat(gameId, clientId, token) {
  if (!gameId) {
    console.warn('IGDB time-to-beat lookup skipped: game.id was missing.');
    return null;
  }

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/game_time_to_beats',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `fields game_id, hastily, normally, completely; where game_id = ${gameId}; limit 1;`,
    });

    console.log(
      `[DEBUG] IGDB time-to-beat raw response for game ${gameId}:`,
      JSON.stringify(response.data),
    );

    const entry = response.data && response.data[0];

    // IGDB gives seconds; only useful if it has at least ONE of these values
    if (!entry || (!entry.normally && !entry.completely && !entry.hastily)) {
      return null;
    }

    const toHours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

    return {
      source: 'IGDB',
      mainHours: entry.normally ? toHours(entry.normally) : null,
      mainExtraHours: null,
      completionistHours: entry.completely ? toHours(entry.completely) : null,
    };
  } catch (err) {
    console.warn(
      'IGDB time-to-beat lookup failed:',
      err.response ? JSON.stringify(err.response.data) : err.message,
    );
    return null;
  }
}

async function fetchIgdbMultiplayerModes(gameId, clientId, token) {
  if (!gameId) {
    console.warn('IGDB multiplayer-modes lookup skipped: game.id was missing.');
    return null;
  }

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/multiplayer_modes',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `fields campaigncoop, dropin, lancoop, offlinecoop, offlinecoopmax, offlinemax, onlinecoop, onlinecoopmax, onlinemax, splitscreen, splitscreenonline; where game = ${gameId};`,
    });

    console.log(
      `[DEBUG] IGDB multiplayer-modes raw response for game ${gameId}:`,
      JSON.stringify(response.data),
    );

    const entries = response.data || [];

    if (entries.length === 0) {
      return null;
    }

    // A game can have multiple rows (one per platform). Take the highest
    // value IGDB reports for each field across all of them, so we show the
    // best-case group size regardless of which platform entry it came from.
    const maxField = (field) =>
      entries.reduce((max, entry) => {
        const value = entry[field];
        return typeof value === 'number' && value > max ? value : max;
      }, 0);

    const anyField = (field) => entries.some((entry) => entry[field] === true);

    const result = {
      hasCoop: anyField('onlinecoop') || anyField('offlinecoop') || anyField('campaigncoop'),
      coopMax: Math.max(maxField('onlinecoopmax'), maxField('offlinecoopmax')) || null,
      multiplayerMax: Math.max(maxField('onlinemax'), maxField('offlinemax')) || null,
      splitscreen: anyField('splitscreen') || anyField('splitscreenonline'),
    };

    // If IGDB didn't actually give us any useful numbers, don't bother
    if (!result.coopMax && !result.multiplayerMax && !result.hasCoop) {
      return null;
    }

    return result;
  } catch (err) {
    console.warn(
      'IGDB multiplayer-modes lookup failed:',
      err.response ? JSON.stringify(err.response.data) : err.message,
    );
    return null;
  }
}

function mergeTimeData(hltbData, igdbData) {
  if (!hltbData && !igdbData) {
    return null;
  }

  const sources = [];
  if (hltbData) {
    sources.push('HowLongToBeat');
  }
  if (igdbData) {
    sources.push('IGDB');
  }

  return {
    source: sources.join(' + '),
    // Prefer HLTB's numbers when both have them (generally more granular),
    // but fall back to IGDB for whichever field HLTB is missing.
    mainHours: (hltbData && hltbData.mainHours) || (igdbData && igdbData.mainHours) || null,
    mainExtraHours:
      (hltbData && hltbData.mainExtraHours) || (igdbData && igdbData.mainExtraHours) || null,
    completionistHours:
      (hltbData && hltbData.completionistHours) ||
      (igdbData && igdbData.completionistHours) ||
      null,
  };
}

function buildCompletionTimeText(timeData, gameName) {
  if (!timeData) {
    return null;
  }

  const lines = [`**Completion time for ${gameName}** (source: ${timeData.source})`];

  if (timeData.mainHours) {
    lines.push(`- Main story: ~${timeData.mainHours}h`);
  }

  if (timeData.mainExtraHours) {
    lines.push(`- Main + extras: ~${timeData.mainExtraHours}h`);
  }

  if (timeData.completionistHours) {
    lines.push(`- Completionist: ~${timeData.completionistHours}h`);
  }

  return lines.join('\n');
}

function buildMultiplayerText(mpData) {
  if (!mpData) {
    return null;
  }

  const parts = [];

  if (mpData.coopMax) {
    parts.push(`Co-op: up to ${mpData.coopMax} players`);
  } else if (mpData.hasCoop) {
    parts.push(`Co-op: supported`);
  }

  if (mpData.multiplayerMax) {
    parts.push(`Multiplayer: up to ${mpData.multiplayerMax} players`);
  }

  if (mpData.splitscreen) {
    parts.push('Splitscreen supported');
  }

  if (parts.length === 0) {
    return null;
  }

  return `**Group Size:** ${parts.join(' | ')}`;
}

// ---------------------------------------------------------------------------
// TrueAchievements (Puppeteer + stealth plugin -- see conversation history for
// why: Cloudflare's interactive managed challenge blocks plain HTTP requests
// and vanilla headless Chromium alike; the stealth plugin patches enough
// headless-detection signals to get through).
// ---------------------------------------------------------------------------

function parseTrueAchievementsFlags(html) {
  const flagRegex =
    /<label class="checkboxcaption" for="chkFlag_[^"]*"><i[^>]*><\/i>\s*<b>(\d+)<\/b>\s*([^<]+)<\/label>/g;

  const flags = [];
  let match = flagRegex.exec(html);
  while (match !== null) {
    flags.push({
      count: parseInt(match[1], 10),
      name: match[2].trim(),
    });
    match = flagRegex.exec(html);
  }

  if (flags.length === 0) {
    return null;
  }

  // Pull out the "xN Players Required" flags specifically -- this is the
  // literal "how many people do we need" data.
  const playerReqs = flags
    .map((f) => {
      const m = /^x(\d+)\s+Players Required$/i.exec(f.name);
      return m ? { players: parseInt(m[1], 10), count: f.count } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.players - b.players);

  const cooperative = flags.find((f) => /^cooperative$/i.test(f.name));
  const versus = flags.find((f) => /^versus$/i.test(f.name));

  return {
    allFlags: flags,
    playerRequirements: playerReqs,
    maxPlayersRequired:
      playerReqs.length > 0 ? Math.max(...playerReqs.map((p) => p.players)) : null,
    cooperativeCount: cooperative ? cooperative.count : null,
    versusCount: versus ? versus.count : null,
  };
}

function buildTrueAchievementsText(data, gameName) {
  if (!data) {
    return null;
  }

  const lines = [`**Achievement Flags for ${gameName}** (source: TrueAchievements)`];

  if (data.cooperativeCount) {
    lines.push(`- Cooperative achievements: ${data.cooperativeCount}`);
  }

  if (data.versusCount) {
    lines.push(`- Versus achievements: ${data.versusCount}`);
  }

  if (data.playerRequirements.length > 0) {
    const breakdown = data.playerRequirements
      .map((p) => `${p.count} need ${p.players} players`)
      .join(', ');
    lines.push(`- Player requirements: ${breakdown}`);
    lines.push(`- **Max players needed for any single achievement: ${data.maxPlayersRequired}**`);
  } else {
    lines.push('- No explicit "players required" flags found for this game.');
  }

  return lines.join('\n');
}

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// UNVERIFIED against the live page markup (same caveat as the Co-Optimus and
// HowLongToBeat selectors -- TrueAchievements' Cloudflare wall blocks direct
// inspection from here too). Looks for an element whose own text is exactly
// "Genre" or "Genres" and reads the comma-separated tags from its container.
// Logs a debug note (not a crash) if it can't find one, so a real run's logs
// will show whether this needs tuning.
// Labels in TrueAchievements' "Game Information" panel. Values follow their
// label as siblings, so a value list ends at the next one of these.
const TA_INFO_LABELS =
  /^(Publisher|Developer|Release|Platform|Genres?|Themes?|Features|Hardware|Notes|Medium|Size|Completion est\.?)$/i;

// True for entries that are clearly panel text rather than a genre/theme
// (e.g. "PublisherCurve GamesDeveloper..."). "Platform" is deliberately not
// treated as junk since it's a legitimate IGDB genre.
function isJunkTag(tag) {
  return (
    tag.length > 30 ||
    /\d{4}/.test(tag) ||
    /^(Publisher|Developer|Release|Features|Hardware|Notes|Medium|Size|Completion)/i.test(tag)
  );
}

function extractTrueAchievementsTags(html, labelRegex, labelName) {
  const $ = cheerio.load(html);
  let tags = [];

  $('*').each((_, el) => {
    if (tags.length > 0) {
      return;
    }

    const ownText = $(el).clone().children().remove().end().text().trim();
    if (!labelRegex.test(ownText)) {
      return;
    }

    // Collect values from the siblings after the label, stopping at the
    // next label. Links are read individually so "Action" and "Comedy"
    // don't get glued together.
    const collected = [];
    let sibling = $(el).next();
    let guard = 0;

    while (sibling.length && guard < 10) {
      const text = sibling.text().trim();

      if (!sibling.is('a') && TA_INFO_LABELS.test(text)) {
        break;
      }

      const links = sibling.is('a') ? sibling : sibling.find('a');
      if (links.length > 0) {
        links.each((__, a) => {
          collected.push($(a).text().trim());
        });
      } else if (text) {
        text.split(',').forEach((t) => collected.push(t.trim()));
      }

      sibling = sibling.next();
      guard += 1;
    }

    tags = collected.filter((t) => t && !isJunkTag(t)).slice(0, 8);
  });

  if (tags.length === 0) {
    console.log(
      `[TrueAchievements] Couldn't find a ${labelName} field on the page (selector is unverified against the live site -- may need tuning).`,
    );
  }

  return tags;
}

function extractTrueAchievementsGenres(html) {
  return extractTrueAchievementsTags(html, /^Genres?$/i, 'Genre');
}

function extractTrueAchievementsThemes(html) {
  return extractTrueAchievementsTags(html, /^Themes?$/i, 'Theme');
}

// Merges genre lists from multiple sources, deduplicating case-insensitively
// while keeping first-seen casing and order.
function combineGenreLists(...lists) {
  const seen = new Set();
  const combined = [];

  lists.forEach((list) => {
    (list || []).forEach((genre) => {
      const key = normalizeForMatch(genre);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      combined.push(genre.trim());
    });
  });

  return combined;
}

async function fetchTrueAchievementsFlags(gameTitle, { strict = false } = {}) {
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

    // 1. Search for the game via TrueAchievements' own (non-Google) search page
    const searchUrl = `https://www.trueachievements.com/searchresults.aspx?search=${encodeURIComponent(
      gameTitle,
    )}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise((r) => setTimeout(r, 1500));

    const searchHtml = await page.content();
    const gameLinkRegex = /href="(\/game\/[^"]+)\/achievements"/g;
    const candidates = new Set();
    let m = gameLinkRegex.exec(searchHtml);
    while (m !== null) {
      candidates.add(m[1]);
      m = gameLinkRegex.exec(searchHtml);
    }

    if (candidates.size === 0) {
      console.log(`[TrueAchievements] No search results found for: ${gameTitle}`);
      return null;
    }

    // Prefer an exact normalized match (handles apostrophes/periods/hyphens
    // differing between our title and TA's slug) over sequels/spinoffs that
    // also matched the fuzzy site search.
    const normalizedTitle = normalizeForMatch(gameTitle);
    let bestSlug = null;
    // eslint-disable-next-line no-restricted-syntax
    for (const slug of candidates) {
      const slugName = slug.replace('/game/', '');
      if (normalizeForMatch(slugName) === normalizedTitle) {
        bestSlug = slug;
        break;
      }
    }

    if (!bestSlug) {
      if (strict) {
        // Used by MultiplayerVerificationService, where a wrong guess is
        // actively harmful (it can report flags for a completely different
        // game). The site search's "candidates" set can include stray
        // sidebar/trending links even when there's no real match for an
        // unusual or DLC-style title (confirmed: searching "Pinball FX -
        // Bethesda Pinball" consistently returned an unrelated game as the
        // only candidate) -- without an exact normalized-name match, there's
        // nothing trustworthy to fall back to, so this bails out instead of
        // guessing.
        console.log(
          `[TrueAchievements] No exact match for "${gameTitle}" (strict mode) -- not guessing from ${candidates.size} unrelated candidate(s).`,
        );
        return null;
      }

      [bestSlug] = candidates;
    }

    console.log(`[TrueAchievements] Matched "${gameTitle}" -> ${bestSlug}`);

    // 2. Load the achievements page and extract the Flag Filter panel
    const achievementsUrl = `https://www.trueachievements.com${bestSlug}/achievements`;
    await page.goto(achievementsUrl, { waitUntil: 'networkidle2', timeout: 25000 });

    // The Flag Filter checkboxes populate async after the initial page load
    // -- wait for one specifically instead of a fixed delay, which was
    // sometimes running ahead of the panel finishing on some games.
    await page.waitForSelector('label.checkboxcaption', { timeout: 8000 }).catch(() => {
      console.log(`[TrueAchievements] Flag Filter checkboxes never appeared for: ${gameTitle}`);
    });

    const html = await page.content();

    if (!/checkboxcaption/i.test(html)) {
      console.log(
        `[DEBUG] TrueAchievements page HTML for "${gameTitle}" had no checkboxcaption labels at all (first 1000 chars):`,
        html.substring(0, 1000),
      );
    }

    return {
      flags: parseTrueAchievementsFlags(html),
      genres: extractTrueAchievementsGenres(html),
      themes: extractTrueAchievementsThemes(html),
    };
  } catch (err) {
    console.warn('TrueAchievements lookup failed:', err.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

module.exports = {
  async fetchAndAttachCover(cardId, cardTitle) {
    const clientId =
      process.env.IGDB_CLIENT_ID || (sails.config.custom ? sails.config.custom.igdbClientId : null);
    const clientSecret =
      process.env.IGDB_CLIENT_SECRET ||
      (sails.config.custom ? sails.config.custom.igdbClientSecret : null);

    let tempFilePath;

    try {
      if (!clientId || !clientSecret) {
        console.warn('IGDB credentials missing in environment variables.');
        return;
      }

      const token = await getIgdbToken(clientId, clientSecret);
      const game = await searchIgdbGame(cardTitle, clientId, token);

      if (!game) {
        console.log(`No matching game found on IGDB for: ${cardTitle}`);
        return;
      }

      const { card, list, board, project } = await sails.helpers.cards.getPathToProjectById(cardId);
      if (!card) {
        console.warn(`Card ${cardId} not found when processing IGDB data; aborting.`);
        return;
      }

      // Fetch existing attachments/comments once so each section below can
      // check "have I already done this?" -- makes it safe to re-run this
      // function on a card that was already processed (e.g. a backfill).
      const existingAttachments = await Attachment.find({ cardId });
      const existingComments = await Comment.find({ cardId });

      const hasTrailerAttachment = existingAttachments.some((a) => /trailer/i.test(a.name || ''));
      const hasCompletionComment = existingComments.some((c) =>
        /Completion time for/i.test(c.text || ''),
      );
      const hasCoOptimusComment = existingComments.some((c) =>
        /Co-Op Info for/i.test(c.text || ''),
      );
      const hasTrueAchievementsComment = existingComments.some((c) =>
        /Achievement Flags for/i.test(c.text || ''),
      );
      const hasGenresThemesSection = /\*\*Genres:\*\*/i.test(card.description || '');

      // Shared TrueAchievements fetch -- used both to merge genre tags into
      // the card description below and to post the achievement-flags
      // comment further down. Fetched at most once per card, and only if
      // at least one of those two things is still actually needed, so a
      // fully-processed card doesn't launch Chromium again for nothing.
      let taResult = null;
      if (!hasTrueAchievementsComment || !hasGenresThemesSection) {
        try {
          taResult = await fetchTrueAchievementsFlags(game.name || cardTitle);
        } catch (err) {
          console.warn(`TrueAchievements fetch failed safely for ${cardTitle}:`, err.message);
        }
      }

      // -----------------------------------------------------------------
      // 1. Cover image -- skip if this card already has one (either from a
      //    previous run of this service, or one the user set manually).
      // -----------------------------------------------------------------
      if (card.coverAttachmentId) {
        console.log(`Card already has a cover set; skipping cover for: ${cardTitle}`);
      } else if (game.cover && game.cover.url) {
        let coverUrl = game.cover.url.startsWith('//')
          ? `https:${game.cover.url}`
          : game.cover.url;
        coverUrl = coverUrl.replace('t_thumb', 't_cover_big');

        const imageResponse = await axios.get(coverUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data, 'binary');

        const safeGameName = (game.name || 'cover').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filename = `${safeGameName}.jpg`;

        const tempDir = sails.config.custom.uploadsTempPath || require('os').tmpdir();
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        tempFilePath = path.join(tempDir, `${crypto.randomUUID()}-${filename}`);
        await fsPromises.writeFile(tempFilePath, buffer);

        const stats = await fsPromises.stat(tempFilePath);

        const fakeFile = {
          fd: tempFilePath,
          filename,
          size: stats.size,
          type: 'file',
        };

        const coverData = await sails.helpers.attachments.processUploadedFile(fakeFile);

        await sails.helpers.attachments.createOne.with({
          project,
          board,
          list,
          values: {
            type: Attachment.Types.FILE,
            name: game.name || 'Cover',
            data: coverData,
            card,
            creatorUser: { id: card.creatorUserId },
          },
        });

        console.log(`Attached IGDB cover for: ${cardTitle}`);
      } else {
        console.log(`Game found for "${cardTitle}", but it has no cover art on IGDB.`);
      }

      // -----------------------------------------------------------------
      // 2. Genres & Themes & Group Size -> card description. Skipped if the
      //    description already has a Genres/Themes/Group Size section --
      //    this was previously unguarded and re-appended a duplicate block
      //    on every re-run (e.g. the backfill script).
      // -----------------------------------------------------------------
      if (hasGenresThemesSection) {
        console.log(
          `Card description already has a Genres/Themes section; skipping for: ${cardTitle}`,
        );
      } else {
        const genreNames = combineGenreLists(
          (game.genres || []).map((g) => g.name).filter(Boolean),
          taResult && taResult.genres,
        );
        const themeNames = combineGenreLists(
          (game.themes || []).map((t) => t.name).filter(Boolean),
          taResult && taResult.themes,
        );
        const multiplayerData = await fetchIgdbMultiplayerModes(game.id, clientId, token);
        const multiplayerText = buildMultiplayerText(multiplayerData);

        if (genreNames.length > 0 || themeNames.length > 0 || multiplayerText) {
          const descriptionParts = [];

          if (card.description) {
            descriptionParts.push(card.description);
          }

          if (genreNames.length > 0) {
            descriptionParts.push(`**Genres:** ${genreNames.join(', ')}`);
          }

          if (themeNames.length > 0) {
            descriptionParts.push(`**Themes:** ${themeNames.join(', ')}`);
          }

          if (multiplayerText) {
            descriptionParts.push(multiplayerText);
          }

          const newDescription = descriptionParts.join('\n\n');

          if (newDescription !== card.description) {
            const updatedCard = await Card.updateOne({ id: cardId }).set({
              description: newDescription,
            });

            if (updatedCard) {
              sails.sockets.broadcast(`board:${board.id}`, 'cardUpdate', {
                item: updatedCard,
              });
            }

            console.log(`Updated description with Genres/Themes/Group Size for: ${cardTitle}`);
          }
        }
      }

      // -----------------------------------------------------------------
      // 3. Trailers -> link-type attachments (release + gameplay, when available)
      // -----------------------------------------------------------------
      if (hasTrailerAttachment) {
        console.log(`Card already has a trailer attachment; skipping trailers for: ${cardTitle}`);
      } else {
        const videos = game.videos || [];

        const gameplayVideo = videos.find((v) => /gameplay/i.test(v.name || ''));
        const releaseVideo = videos.find(
          (v) => /release|launch|announce/i.test(v.name || '') && v !== gameplayVideo,
        );

        const videosToAttach = [];
        if (releaseVideo) {
          videosToAttach.push({ video: releaseVideo, label: 'Release Trailer' });
        }
        if (gameplayVideo) {
          videosToAttach.push({ video: gameplayVideo, label: 'Gameplay Trailer' });
        }

        // Neither specific category matched -- fall back to whatever's first,
        // generically labeled, so we still attach SOMETHING if videos exist.
        if (videosToAttach.length === 0 && videos.length > 0) {
          videosToAttach.push({ video: videos[0], label: 'Trailer' });
        }

        if (videosToAttach.length > 0) {
          // eslint-disable-next-line no-restricted-syntax
          for (const { video, label } of videosToAttach) {
            if (!video.video_id) {
              // eslint-disable-next-line no-continue
              continue;
            }

            const youtubeUrl = `https://www.youtube.com/watch?v=${video.video_id}`;

            try {
              // eslint-disable-next-line no-await-in-loop
              const linkData = await sails.helpers.attachments.processLink(youtubeUrl);

              // eslint-disable-next-line no-await-in-loop
              await sails.helpers.attachments.createOne.with({
                project,
                board,
                list,
                values: {
                  type: Attachment.Types.LINK,
                  name: `${game.name || cardTitle} - ${label}`,
                  data: linkData,
                  card,
                  creatorUser: { id: card.creatorUserId },
                },
              });

              console.log(`Attached ${label} for: ${cardTitle}`);
            } catch (err) {
              console.warn(`Failed to attach ${label}:`, err.message);
            }
          }
        } else {
          console.log(`No trailer video found on IGDB for: ${cardTitle}`);
        }
      }

      // -----------------------------------------------------------------
      // 4. Completion time: fetch BOTH sources, merge, but only post if
      //    we actually have a Completionist number from at least one of them.
      // -----------------------------------------------------------------
      if (hasCompletionComment) {
        console.log(`Card already has a completion-time comment; skipping for: ${cardTitle}`);
      } else {
        const [hltbData, igdbTimeData] = await Promise.all([
          HowLongToBeatService.searchHowLongToBeat(game.name || cardTitle),
          fetchIgdbTimeToBeat(game.id, clientId, token),
        ]);

        const mergedTimeData = mergeTimeData(hltbData, igdbTimeData);

        if (!mergedTimeData || !mergedTimeData.completionistHours) {
          console.log(
            `No Completionist time available from either source for: ${cardTitle} -- skipping comment (Completionist time is required).`,
          );
        } else {
          const completionText = buildCompletionTimeText(mergedTimeData, game.name || cardTitle);

          // The comment helper needs the FULL creator user record (it reads
          // .name for notification text and .subscribeToCardWhenCommenting),
          // not just an { id } stub like the attachment helper needed.
          const creatorUser = await User.findOne({ id: card.creatorUserId });

          if (creatorUser) {
            await sails.helpers.comments.createOne.with({
              project,
              board,
              list,
              values: {
                text: completionText,
                card,
                user: creatorUser,
              },
            });

            console.log(`Posted completion-time comment for: ${cardTitle}`);
          } else {
            console.warn(
              `Could not find creator user ${card.creatorUserId} to post completion-time comment.`,
            );
          }
        }
      }

      // -----------------------------------------------------------------
      // 5. Co-Optimus -> its own independent comment. Wrapped in its own
      //    try/catch so a failure here NEVER blocks anything else.
      // -----------------------------------------------------------------
      if (hasCoOptimusComment) {
        console.log(`Card already has a Co-Optimus comment; skipping for: ${cardTitle}`);
      } else {
        try {
          const gameEntry = await CoOptimusIndex.findGameEntry(game.name || cardTitle);

          if (!gameEntry) {
            console.log(`No Co-Optimus entry found in index for: ${cardTitle}`);
          } else {
            const coOpInfo = await CoOptimusService.fetchCoOptimusCoOpInfo(
              gameEntry.url,
              game.name || cardTitle,
            );
            const coOptimusText = CoOptimusService.buildCoOptimusText(
              coOpInfo,
              game.name || cardTitle,
            );

            if (coOptimusText) {
              const creatorUser = await User.findOne({ id: card.creatorUserId });

              if (creatorUser) {
                await sails.helpers.comments.createOne.with({
                  project,
                  board,
                  list,
                  values: {
                    text: coOptimusText,
                    card,
                    user: creatorUser,
                  },
                });

                console.log(`Posted Co-Optimus comment for: ${cardTitle}`);
              } else {
                console.warn(
                  `Could not find creator user ${card.creatorUserId} to post Co-Optimus comment.`,
                );
              }
            } else {
              console.log(`No Co-Optimus co-op data found for: ${cardTitle}`);
            }
          }
        } catch (err) {
          console.warn(`Co-Optimus section failed safely for ${cardTitle}:`, err.message);
        }
      }

      // -----------------------------------------------------------------
      // 6. TrueAchievements -> its own independent comment, from the shared
      //    fetch done earlier (Section 2 also reads its genre data from
      //    that same fetch, so this doesn't hit the site a second time).
      // -----------------------------------------------------------------
      if (hasTrueAchievementsComment) {
        console.log(`Card already has a TrueAchievements comment; skipping for: ${cardTitle}`);
      } else if (!taResult) {
        console.log(`No TrueAchievements data available for: ${cardTitle}`);
      } else {
        try {
          const taText = buildTrueAchievementsText(taResult.flags, game.name || cardTitle);

          if (taText) {
            const creatorUser = await User.findOne({ id: card.creatorUserId });

            if (creatorUser) {
              await sails.helpers.comments.createOne.with({
                project,
                board,
                list,
                values: {
                  text: taText,
                  card,
                  user: creatorUser,
                },
              });

              console.log(`Posted TrueAchievements comment for: ${cardTitle}`);
            } else {
              console.warn(
                `Could not find creator user ${card.creatorUserId} to post TrueAchievements comment.`,
              );
            }
          } else {
            console.log(`No TrueAchievements flag data found for: ${cardTitle}`);
          }
        } catch (err) {
          console.warn(`TrueAchievements section failed safely for ${cardTitle}:`, err.message);
        }
      }
    } catch (err) {
      console.error(
        'Background IGDB processing failed safely:',
        err.response ? JSON.stringify(err.response.data) : err.stack || err.message,
      );

      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          await fsPromises.unlink(tempFilePath);
        } catch (cleanupErr) {
          /* empty */
        }
      }
    }
  },
};

// Exposed for one-off maintenance scripts (db/fill-missing-ta-tags.js).
module.exports.fetchTrueAchievementsFlags = fetchTrueAchievementsFlags;
module.exports.combineGenreLists = combineGenreLists;
module.exports.isJunkTag = isJunkTag;

// Exposed for MultiplayerVerificationService.js (TrueAchievements sync
// feature) -- these were previously only used internally by
// fetchAndAttachCover above.
module.exports.getIgdbToken = getIgdbToken;
module.exports.searchIgdbGame = searchIgdbGame;
module.exports.fetchIgdbMultiplayerModes = fetchIgdbMultiplayerModes;
