// db/backfill-igdb-data.js
//
// One-time maintenance script: runs IgdbService.fetchAndAttachCover on every
// existing card, so cards created before this feature existed get cover
// art, genres/themes/group size, trailers, completion time, Co-Optimus, and
// TrueAchievements data too.
//
// Safe to re-run: every section inside fetchAndAttachCover already checks
// "do I already have this?" before doing anything, so a card that already
// has some or all of this data just gets whatever's missing filled in --
// nothing gets duplicated.
//
// Run with: npm run db:backfill-igdb
// (add "db:backfill-igdb": "node db/backfill-igdb-data.js" to package.json
// scripts first -- see the integration notes)

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const fs = require('fs');
const path = require('path');
const sails = require('sails');

// A Sails helper (is-preloaded-favicon-exists.js) scans this directory when
// the helpers hook loads, and normally it's created as part of the app's
// regular boot process (npm start / app.js) before that happens. Running
// this script standalone with sails.load() bypasses that, so the helpers
// hook fails to load with an ENOENT on this exact path unless we create it
// ourselves first.
fs.mkdirSync(path.join(__dirname, '..', '.tmp', 'public', 'preloaded-favicons'), {
  recursive: true,
});

// Small delay between cards -- each card can launch several headless
// Chromium instances in sequence (TrueAchievements, Co-Optimus, HowLongToBeat),
// so back-to-back with no pause at all is harder on the box than it needs
// to be for a background one-off job. Not required for correctness, just
// being a reasonable citizen toward your own server and the sites being scraped.
const DELAY_BETWEEN_CARDS_MS = 3000;

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
      console.error('Backfill failed:', runErr);
    }

    sails.lower(() => process.exit(0));
  },
);

async function run() {
  // eslint-disable-next-line global-require
  const IgdbService = require('../api/services/IgdbService');

  const cards = await Card.find({});
  console.log(`Found ${cards.length} card(s). Starting backfill...`);

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    console.log(`[${i + 1}/${cards.length}] Processing: ${card.name}`);

    try {
      // eslint-disable-next-line no-await-in-loop
      await IgdbService.fetchAndAttachCover(card.id, card.name);
    } catch (cardErr) {
      console.warn(`  Failed for "${card.name}":`, cardErr.message);
    }

    if (i < cards.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, DELAY_BETWEEN_CARDS_MS);
      });
    }
  }

  console.log('Backfill complete.');
}
