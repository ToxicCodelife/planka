// db/scan-true-achievements.js
//
// PHASE 2 / DRY RUN -- does not touch Planka data. For every user with a
// TrueAchievements username set, scrapes their public "Game Collection" page
// (-> have) and "Wishlist" page (-> want), prints a best-guess platform
// (Xbox 360 vs Xbox One/Series) for each game, and cross-checks each one
// against IGDB's multiplayer_modes data and Co-Optimus to confirm it's
// actually a multiplayer/co-op game before it would ever be treated as a
// sync candidate for this board (which is specifically for games played
// together with friends -- a single-player game should never auto-create a
// card here, even if it's genuinely in someone's collection or wishlist).
//
// The exact markup of these two TrueAchievements pages hasn't been fully
// verified from here (same Cloudflare wall that blocks everything else
// TrueAchievements-related) -- this is a best-effort pass with heavy debug
// logging, same approach as the original TrueAchievements genre/theme
// scraping needed tuning from real logs. Run it, paste the output back, and
// selectors get adjusted from there.
//
// Run with: node db/scan-true-achievements.js

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const fs = require('fs');
const path = require('path');
const sails = require('sails');

fs.mkdirSync(path.join(__dirname, '..', '.tmp', 'public', 'preloaded-favicons'), {
  recursive: true,
});

const DELAY_BETWEEN_GAMERS_MS = 4000;
const DELAY_BETWEEN_VERIFICATIONS_MS = 500;

sails.load(
  {
    hooks: { grunt: false },
    log: { level: 'warn' },
  },
  async (err) => {
    if (err) {
      console.error('Failed to lift Sails app:', err);
      process.exit(1);
    }

    try {
      await run();
    } catch (runErr) {
      console.error('TrueAchievements scan failed:', runErr);
    }

    sails.lower(() => process.exit(0));
  },
);

// Verifies one game and logs the verdict + both sources' reasoning. Returns
// true if it should count as a sync candidate.
async function verifyAndLog(MultiplayerVerificationService, game) {
  const verdict = await MultiplayerVerificationService.verifyMultiplayer(game.name);

  const tag = verdict.isMultiplayer ? 'MULTIPLAYER -> sync candidate' : 'single-player/unconfirmed -> SKIPPED';

  console.log(
    `    - "${game.name}" [platform guess: ${game.platformGuess || 'UNKNOWN'}] -> ${tag}`,
  );
  console.log(`        IGDB: ${verdict.igdb.reason}`);
  console.log(`        Co-Optimus: ${verdict.coOptimus.reason}`);
  console.log(`        TrueAchievements flags: ${verdict.trueAchievements.reason}`);

  await new Promise((resolve) => {
    setTimeout(resolve, DELAY_BETWEEN_VERIFICATIONS_MS);
  });

  return verdict.isMultiplayer;
}

async function run() {
  // eslint-disable-next-line global-require
  const TrueAchievementsCollectionService = require('../api/services/TrueAchievementsCollectionService');
  // eslint-disable-next-line global-require
  const MultiplayerVerificationService = require('../api/services/MultiplayerVerificationService');

  const users = await User.find({
    trueAchievementsUsername: { '!=': null },
  });

  if (users.length === 0) {
    console.log('No users have a TrueAchievements username set yet. Nothing to do.');
    return;
  }

  console.log(`Found ${users.length} user(s) with a TrueAchievements username set.\n`);

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    console.log(`[${i + 1}/${users.length}] ${user.name} -> TA username: "${user.trueAchievementsUsername}"`);

    try {
      // eslint-disable-next-line no-await-in-loop
      const owned = await TrueAchievementsCollectionService.fetchOwnedGames(
        user.trueAchievementsUsername,
      );

      console.log(`  Owned (have): ${owned.length} game(s) found on TrueAchievements`);

      let ownedCandidateCount = 0;
      // eslint-disable-next-line no-restricted-syntax
      for (const g of owned) {
        // eslint-disable-next-line no-await-in-loop
        const isCandidate = await verifyAndLog(MultiplayerVerificationService, g);
        if (isCandidate) {
          ownedCandidateCount += 1;
        }
      }

      console.log(
        `  -> ${ownedCandidateCount}/${owned.length} owned game(s) confirmed multiplayer (would sync as "have")`,
      );
    } catch (ownedErr) {
      console.warn(`  Owned-games fetch failed: ${ownedErr.message}`);
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const wishlist = await TrueAchievementsCollectionService.fetchWishlistGames(
        user.trueAchievementsUsername,
      );

      console.log(`  Wishlist (want): ${wishlist.length} game(s) found on TrueAchievements`);

      let wishlistCandidateCount = 0;
      // eslint-disable-next-line no-restricted-syntax
      for (const g of wishlist) {
        // eslint-disable-next-line no-await-in-loop
        const isCandidate = await verifyAndLog(MultiplayerVerificationService, g);
        if (isCandidate) {
          wishlistCandidateCount += 1;
        }
      }

      console.log(
        `  -> ${wishlistCandidateCount}/${wishlist.length} wishlist game(s) confirmed multiplayer (would sync as "want")`,
      );
    } catch (wishlistErr) {
      console.warn(`  Wishlist fetch failed: ${wishlistErr.message}`);
    }

    console.log('');

    if (i < users.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, DELAY_BETWEEN_GAMERS_MS);
      });
    }
  }

  console.log('Done. This was a dry run -- nothing in Planka was changed.');
}
