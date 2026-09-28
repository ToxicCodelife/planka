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

      if (taResult) {
        let description = card.description || '';

        const existingGenres = parseLine(description, 'Genres');
        const existingThemes = parseLine(description, 'Themes');

        // combineGenreLists keeps existing entries first and only adds TA
        // values that aren't already there (ignoring case/punctuation).
        const mergedGenres = IgdbService.combineGenreLists(existingGenres, taResult.genres);
        const mergedThemes = IgdbService.combineGenreLists(existingThemes, taResult.themes);

        if (mergedGenres.length > existingGenres.length) {
          description = setLine(description, 'Genres', mergedGenres);
        }

        if (mergedThemes.length > existingThemes.length) {
          description = setLine(description, 'Themes', mergedThemes);
        }

        if (description !== (card.description || '')) {
          // eslint-disable-next-line no-await-in-loop
          await Card.updateOne({ id: card.id }).set({ description });
          updatedCount += 1;
          console.log(
            `  Added: genres +${mergedGenres.length - existingGenres.length}, themes +${
              mergedThemes.length - existingThemes.length
            }`,
          );
        } else {
          console.log('  Nothing new to add.');
        }
      } else {
        console.log('  No TrueAchievements data found.');
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
