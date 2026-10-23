/* eslint-disable no-console */
// server/api/services/XboxLiveService.js
//
// Looks up the games a gamertag has actually played (achievement progress)
// through OpenXBL (xbl.io), a hosted wrapper around the official Xbox Live
// API. One API key (generated once by the Planka admin at xbl.io, after
// signing in with their own Microsoft account) can read the public
// achievement/title data of ANY gamertag -- the friends never log in.
//
// What this CAN'T see, for anyone: Microsoft Store purchase history, owned-
// but-never-launched games, and the Store wishlist. Microsoft keeps those
// private to the owning account.
//
// UNVERIFIED against the live service (xbl.io's docs weren't reachable while
// this was written). Endpoints used, from OpenXBL's v2 API:
// (base URL https://api.xbl.io/v2, per OpenXBL's own curl example)
//   GET /search/{gamertag}            -> { people: [{ xuid, gamertag }] }
//   GET /achievements/player/{xuid}   -> { titles: [{ name, titleId,
//                                                  devices: [...], achievement: {...} }] }
// The code is written defensively and logs the raw response shape when
// something doesn't match, so a first real run shows exactly what to adjust.
//
// The key is read from the XBL_API_KEY environment variable (or
// sails.config.custom.xblApiKey) -- never hardcode it in this file.

// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');

const BASE_URL = 'https://api.xbl.io/v2';

function getApiKey() {
  return (
    process.env.XBL_API_KEY || (sails.config.custom ? sails.config.custom.xblApiKey : null) || null
  );
}

function isConfigured() {
  return Boolean(getApiKey());
}

async function xblGet(path) {
  const response = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      'X-Authorization': getApiKey(),
      Accept: 'application/json',
      'Accept-Language': 'en-US',
    },
    timeout: 20000,
  });

  // The real API wraps everything as { content: {...}, code }.
  const body = response.data;
  return body && body.content !== undefined ? body.content : body;
}

function previewShape(data) {
  try {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    return `top-level keys: [${keys}]; first 400 chars: ${JSON.stringify(data).substring(0, 400)}`;
  } catch (err) {
    return '(unprintable response)';
  }
}

async function resolveXuid(gamertag) {
  const data = await xblGet(`/search/${encodeURIComponent(gamertag.trim())}`);

  const people = (data && (data.people || data.profileUsers)) || [];

  if (!Array.isArray(people) || people.length === 0) {
    console.log(`[XboxLive] No search results for "${gamertag}". ${previewShape(data)}`);
    return null;
  }

  const wanted = gamertag.trim().toLowerCase();
  // displayName was null in the real response, so check every field that
  // could hold the gamertag.
  const exact = people.find((p) =>
    [p.gamertag, p.modernGamertag, p.uniqueModernGamertag, p.displayName]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase() === wanted),
  );

  if (!exact) {
    console.log(
      `[XboxLive] Gamertag fields seen for "${gamertag}": ${JSON.stringify(
        people.map((p) => ({
          gamertag: p.gamertag,
          modern: p.modernGamertag,
          unique: p.uniqueModernGamertag,
          display: p.displayName,
          real: p.realName,
        })),
      ).substring(0, 500)}`,
    );
  }

  if (!exact) {
    // Search is fuzzy -- a non-exact first hit is some OTHER player. Don't guess.
    console.log(
      `[XboxLive] Search for "${gamertag}" returned ${people.length} result(s) but none matched exactly -- not guessing.`,
    );
    return null;
  }

  return exact.xuid || exact.id || null;
}

// Xbox Live "devices" -> the same labels the rest of the sync uses.
function platformFromDevices(devices) {
  const list = (Array.isArray(devices) ? devices : []).map((d) => String(d).toLowerCase());

  if (list.length === 0) {
    return null;
  }

  const has360 = list.some((d) => /360/.test(d));
  const hasModern = list.some((d) => /(one|series|scarlett|durango)/.test(d));

  if (hasModern) {
    return 'oneOrSeries';
  }

  if (has360) {
    return '360';
  }

  // PC-only (or Mobile/other) -- not something this board tracks.
  return 'other';
}

module.exports = {
  isConfigured,

  // Returns [{ name, titleId, platformGuess, earned, progress }] or throws.
  async fetchPlayedGames(gamertag) {
    if (!isConfigured()) {
      throw new Error('XBL_API_KEY is not set');
    }

    const xuid = await resolveXuid(gamertag);
    if (!xuid) {
      return [];
    }

    const data = await xblGet(`/achievements/player/${xuid}`);
    const titles = data && data.titles;

    if (!Array.isArray(titles)) {
      console.log(
        `[XboxLive] Unexpected achievements response for "${gamertag}" (xuid ${xuid}). ${previewShape(data)}`,
      );
      return [];
    }

    // One-time look at the raw shape so platform detection can be checked.
    const platformCounts = {};
    titles.forEach((t) => {
      const key = JSON.stringify(t.devices || null);
      platformCounts[key] = (platformCounts[key] || 0) + 1;
    });
    console.log(`[XboxLive] "${gamertag}" device lists seen: ${JSON.stringify(platformCounts)}`);

    // Sample of "mixed" entries (360 + newer consoles) and the field names the
    // API gives, to see whether anything says which version was actually played.
    const mixedSamples = titles
      .filter((t) => {
        const d = (t.devices || []).map((x) => String(x).toLowerCase());
        return d.some((x) => /360/.test(x)) && d.some((x) => /(one|series)/.test(x));
      })
      .slice(0, 6)
      .map((t) => ({
        name: t.name,
        titleId: t.titleId,
        type: t.type,
        devices: t.devices,
        lastPlayed: (t.titleHistory && t.titleHistory.lastTimePlayed) || t.lastUnlock,
      }));
    console.log(`[XboxLive] "${gamertag}" title fields: ${Object.keys(titles[0] || {}).join(', ')}`);
    console.log(`[XboxLive] "${gamertag}" mixed 360+newer samples: ${JSON.stringify(mixedSamples)}`);

    return titles
      .filter((t) => t && t.name)
      .map((t) => {
        const ach = t.achievement || {};
        return {
          name: String(t.name).trim(),
          titleId: t.titleId,
          platformGuess: platformFromDevices(t.devices),
          earned: ach.currentAchievements,
          progress: ach.progressPercentage,
        };
      })
      .filter((g) => g.platformGuess !== 'other');
  },
};
