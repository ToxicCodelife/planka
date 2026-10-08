/* eslint-disable no-console */
// server/api/services/MultiplayerVerificationService.js
//
// Cross-checks a game name against IGDB's multiplayer_modes data and the
// Co-Optimus index/game page to decide whether it's actually a
// multiplayer/co-op game, before it's ever treated as a sync candidate for
// this board (which is specifically for games played together with
// friends -- a single-player game like the Pinball FX wishlist entries
// should never auto-create a card here).
//
// A game only needs ONE of the two sources to confirm multiplayer/co-op
// support to pass. Relying on just one source would create false
// negatives both ways: IGDB's multiplayer_modes table has real gaps for
// older/obscure titles (same caveat as IgdbService's other IGDB lookups),
// and Co-Optimus only covers cooperative play, not competitive-only
// multiplayer.

const IgdbService = require('./IgdbService');
const CoOptimusIndex = require('./CoOptimusIndex');
const CoOptimusService = require('./CoOptimusService');

// fetchTrueAchievementsFlags already exists on IgdbService.js (built for the
// card-enrichment feature's "Achievement Flags" comment) -- it searches
// TrueAchievements for the game, loads its achievements page, and parses
// out the Cooperative/Versus flag counts and "xN Players Required" flags.
// Reused here as a third confirmation source.

let igdbTokenPromise = null;

async function getIgdbCreds() {
  const clientId =
    process.env.IGDB_CLIENT_ID || (sails.config.custom ? sails.config.custom.igdbClientId : null);
  const clientSecret =
    process.env.IGDB_CLIENT_SECRET ||
    (sails.config.custom ? sails.config.custom.igdbClientSecret : null);

  if (!clientId || !clientSecret) {
    return null;
  }

  // Cached across calls within a single process -- a scan run touches many
  // games and there's no reason to re-authenticate with Twitch for each one.
  if (!igdbTokenPromise) {
    igdbTokenPromise = IgdbService.getIgdbToken(clientId, clientSecret).catch((err) => {
      igdbTokenPromise = null; // let the next call retry instead of caching a failure
      throw err;
    });
  }

  return { clientId, token: await igdbTokenPromise };
}

async function checkIgdb(gameName) {
  try {
    const creds = await getIgdbCreds();
    if (!creds) {
      return { checked: false, isMultiplayer: false, reason: 'IGDB credentials not configured' };
    }

    const game = await IgdbService.searchIgdbGame(gameName, creds.clientId, creds.token);
    if (!game) {
      return { checked: true, isMultiplayer: false, reason: 'no IGDB match found' };
    }

    const modes = await IgdbService.fetchIgdbMultiplayerModes(game.id, creds.clientId, creds.token);
    if (!modes) {
      return { checked: true, isMultiplayer: false, reason: 'IGDB has no multiplayer_modes data for this game' };
    }

    const isMultiplayer = Boolean(
      modes.hasCoop || modes.splitscreen || (modes.multiplayerMax && modes.multiplayerMax > 1),
    );

    return {
      checked: true,
      isMultiplayer,
      reason: isMultiplayer
        ? `IGDB confirms: coop=${modes.hasCoop}, multiplayerMax=${modes.multiplayerMax || '?'}, splitscreen=${modes.splitscreen}`
        : 'IGDB has multiplayer_modes data but every flag on it is single-player',
    };
  } catch (err) {
    console.warn(`[MultiplayerVerification] IGDB check failed for "${gameName}": ${err.message}`);
    return { checked: false, isMultiplayer: false, reason: `IGDB check errored: ${err.message}` };
  }
}

async function checkTrueAchievementsFlags(gameName) {
  try {
    const taResult = await IgdbService.fetchTrueAchievementsFlags(gameName);
    if (!taResult || !taResult.flags) {
      return { checked: true, isMultiplayer: false, reason: 'no TrueAchievements Flag Filter data found' };
    }

    const { flags } = taResult;
    const isMultiplayer = Boolean(
      flags.cooperativeCount || flags.versusCount || (flags.maxPlayersRequired && flags.maxPlayersRequired > 1),
    );

    return {
      checked: true,
      isMultiplayer,
      reason: isMultiplayer
        ? `TrueAchievements flags confirm: cooperative=${flags.cooperativeCount || 0}, versus=${flags.versusCount || 0}, maxPlayersRequired=${flags.maxPlayersRequired || '?'}`
        : 'TrueAchievements has Flag Filter data but no Cooperative/Versus/multi-player-required flags',
    };
  } catch (err) {
    console.warn(`[MultiplayerVerification] TrueAchievements flags check failed for "${gameName}": ${err.message}`);
    return { checked: false, isMultiplayer: false, reason: `TrueAchievements flags check errored: ${err.message}` };
  }
}

async function checkCoOptimus(gameName) {
  try {
    const entry = await CoOptimusIndex.findGameEntry(gameName);
    if (!entry) {
      return { checked: true, isMultiplayer: false, reason: 'not found in Co-Optimus index' };
    }

    const info = await CoOptimusService.fetchCoOptimusCoOpInfo(entry.url, gameName);
    if (!info) {
      return { checked: true, isMultiplayer: false, reason: 'Co-Optimus page had no readable co-op data' };
    }

    const isMultiplayer = Boolean((info.onlineCoop && info.onlineCoop.supported) || info.extras.length > 0);

    return {
      checked: true,
      isMultiplayer,
      reason: isMultiplayer
        ? `Co-Optimus confirms: onlineCoop=${JSON.stringify(info.onlineCoop)}, extras=[${info.extras.join(', ')}]`
        : 'Co-Optimus has an entry for this game but lists no co-op support',
    };
  } catch (err) {
    console.warn(`[MultiplayerVerification] Co-Optimus check failed for "${gameName}": ${err.message}`);
    return { checked: false, isMultiplayer: false, reason: `Co-Optimus check errored: ${err.message}` };
  }
}

module.exports = {
  // Returns { isMultiplayer, igdb, coOptimus, trueAchievements }.
  // isMultiplayer is true only if at least one of the three sources
  // POSITIVELY confirms co-op/versus/multiplayer support -- a game none of
  // them could check comes back false rather than defaulting to "pass",
  // since the whole point is to keep single-player games off this board.
  // The TrueAchievements flags check launches its own Chromium instance
  // (via IgdbService's fetchTrueAchievementsFlags), same as the IGDB and
  // Co-Optimus checks each do their own network calls -- all three run in
  // parallel rather than one after another.
  async verifyMultiplayer(gameName) {
    const [igdb, coOptimus, trueAchievements] = await Promise.all([
      checkIgdb(gameName),
      checkCoOptimus(gameName),
      checkTrueAchievementsFlags(gameName),
    ]);

    return {
      isMultiplayer: Boolean(igdb.isMultiplayer || coOptimus.isMultiplayer || trueAchievements.isMultiplayer),
      igdb,
      coOptimus,
      trueAchievements,
    };
  },
};
