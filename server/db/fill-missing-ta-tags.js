// db/fill-missing-ta-tags.js
//
// One-off: for every existing card, looks the game up on TrueAchievements and
// adds any Genres/Themes TA has that the description doesn't already list.
// Existing entries are never removed or reordered; new ones are appended.
// Safe to re-run -- a second pass finds nothing new and changes nothing.
//
// Tip: run cleanup-duplicate-descriptions.js first if any descriptions still
// have repeated Genres/Themes blocks.
//
// Run with: node db/fill-missing-ta-tags.js

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const fs = require('fs');
const path = require('path');
const sails = require('sails');

fs.mkdirSync(path.join(__dirname, '..', '.tmp', 'public', 'preloaded-favicons'), {
  recursive: true,
});

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
      console.error('Fill-missing-tags run failed:', runErr);
    }

    sails.lower(() => process.exit(0));
  },
);

// Pulls the comma-separated values out of a "**Label:** a, b, c" line.
function parseLine(description, label) {
  const match = new RegExp(`^\\*\\*${label}:\\*\\*(.*)$`, 'm').exec(description || '');
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Replaces the existing "**Label:** ..." line, or appends one if absent.
function setLine(description, label, values) {
  const newLine = `**${label}:** ${values.join(', ')}`;
  const lineRegex = new RegExp(`^\\*\\*${label}:\\*\\*.*$`, 'm');

  if (lineRegex.test(description || '')) {
    return description.replace(lineRegex, newLine);
  }

  return [description, newLine].filter(Boolean).join('\n\n');
}

async function run() {
  // eslint-disable-next-line global-require
  const IgdbService = require('../api/services/IgdbService');

  const cards = await Card.find({});
  console.log(`Found ${cards.length} card(s). Checking TrueAchievements for missing tags...`);

  let updatedCount = 0;

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    console.log(`[${i + 1}/${cards.length}] ${card.name}`);

    try {
      // eslint-disable-next-line no-await-in-loop
      const taResult = await IgdbService.fetchTrueAchievementsFlags(card.name);

      let description = card.description || '';

      // Repair: drop panel-text junk that an earlier version of this script
      // wrote into the Genres/Themes lines (e.g. "PublisherCurve Games...").
      const existingGenres = parseLine(description, 'Genres').filter(
        (t) => !IgdbService.isJunkTag(t),
      );
      const existingThemes = parseLine(description, 'Themes').filter(
        (t) => !IgdbService.isJunkTag(t),
      );

      if (existingGenres.length > 0) {
        description = setLine(description, 'Genres', existingGenres);
      }
      if (existingThemes.length > 0) {
        description = setLine(description, 'Themes', existingThemes);
      }

      let addedGenres = 0;
      let addedThemes = 0;

      if (taResult) {
        // combineGenreLists keeps existing entries first and only adds TA
        // values that aren't already there (ignoring case/punctuation).
        const mergedGenres = IgdbService.combineGenreLists(existingGenres, taResult.genres);
        const mergedThemes = IgdbService.combineGenreLists(existingThemes, taResult.themes);

        addedGenres = mergedGenres.length - existingGenres.length;
        addedThemes = mergedThemes.length - existingThemes.length;

        if (addedGenres > 0) {
          description = setLine(description, 'Genres', mergedGenres);
        }

        if (addedThemes > 0) {
          description = setLine(description, 'Themes', mergedThemes);
        }
      } else {
        console.log('  No TrueAchievements data found.');
      }

      if (description !== (card.description || '')) {
        // eslint-disable-next-line no-await-in-loop
        await Card.updateOne({ id: card.id }).set({ description });
        updatedCount += 1;
        console.log(`  Updated (genres +${addedGenres}, themes +${addedThemes}, junk repaired if any).`);
      } else {
        console.log('  Nothing to change.');
      }
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

  console.log(`Done. Updated ${updatedCount} of ${cards.length} card(s).`);
  console.log('Open boards will show the changes after a page refresh.');
}
