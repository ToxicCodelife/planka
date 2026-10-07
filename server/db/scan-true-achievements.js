// db/scan-true-achievements.js
//
// PHASE 2 / DRY RUN -- does not touch Planka data. For every user with a
// TrueAchievements username set, scrapes their public "Game Collection" page
// (-> have) and "Wishlist" page (-> want), and prints what it found,
// including a best-guess platform (Xbox 360 vs Xbox One/Series) for each
// game.
//
// The exact markup of these two pages hasn't been verified from here (same
// Cloudflare wall that blocks everything else TrueAchievements-related) --
// this is a best-effort first pass with heavy debug logging, same approach
// as the original TrueAchievements genre/theme scraping needed tuning from
// real logs. Run it, paste the output back, and selectors get adjusted from
// there.
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

async function run() {
  // eslint-disable-next-line global-require
  const TrueAchievementsCollectionService = require('../api/services/TrueAchievementsCollectionService');

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

      console.log(`  Owned (have): ${owned.length} game(s)`);
      owned.forEach((g) => {
        console.log(`    - "${g.name}" [platform guess: ${g.platformGuess || 'UNKNOWN'}]`);
      });
    } catch (ownedErr) {
      console.warn(`  Owned-games fetch failed: ${ownedErr.message}`);
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const wishlist = await TrueAchievementsCollectionService.fetchWishlistGames(
        user.trueAchievementsUsername,
      );

      console.log(`  Wishlist (want): ${wishlist.length} game(s)`);
      wishlist.forEach((g) => {
        console.log(`    - "${g.name}" [platform guess: ${g.platformGuess || 'UNKNOWN'}]`);
      });
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
