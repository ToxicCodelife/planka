// db/cleanup-duplicate-descriptions.js
//
// One-time fix for descriptions that got a Genres/Themes/Group Size block
// appended more than once (from re-running the backfill before Section 2
// had a proper idempotency guard). Keeps whatever original text was above
// the first metadata line, dedupes the repeated **Genres:**/**Themes:**/
// **Group Size:** lines down to one copy each, and rewrites the description.
//
// Run with: node db/cleanup-duplicate-descriptions.js

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const fs = require('fs');
const path = require('path');
const sails = require('sails');

// Same fix as the backfill script needed -- see its comments for why.
fs.mkdirSync(path.join(__dirname, '..', '.tmp', 'public', 'preloaded-favicons'), {
  recursive: true,
});

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
      console.error('Cleanup failed:', runErr);
    }

    sails.lower(() => process.exit(0));
  },
);

function cleanDescription(description) {
  if (!description) {
    return description;
  }

  const metadataLineRegex = /^\*\*(?:Genres|Themes|Group Size):\*\*.*$/gm;
  const matches = description.match(metadataLineRegex);

  if (!matches || matches.length === 0) {
    return description;
  }

  const firstMetadataIndex = description.search(metadataLineRegex);
  const originalPart = description.slice(0, firstMetadataIndex).trim();

  // Dedupe, keeping first-seen order -- duplicates from the old bug are
  // exact repeats of the same line.
  const seen = new Set();
  const uniqueLines = [];
  matches.forEach((line) => {
    if (!seen.has(line)) {
      seen.add(line);
      uniqueLines.push(line);
    }
  });

  return [originalPart, uniqueLines.join('\n\n')].filter(Boolean).join('\n\n');
}

async function run() {
  const cards = await Card.find({});
  console.log(
    `Checking ${cards.length} card(s) for duplicate Genres/Themes/Group Size blocks...`,
  );

  let cleanedCount = 0;

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    const cleaned = cleanDescription(card.description);

    if (cleaned !== card.description) {
      // eslint-disable-next-line no-await-in-loop
      await Card.updateOne({ id: card.id }).set({ description: cleaned });
      cleanedCount += 1;
      console.log(`Cleaned: ${card.name}`);
    }
  }

  console.log(`Done. Cleaned ${cleanedCount} of ${cards.length} card(s).`);
  console.log(
    'Note: this does not broadcast live socket updates -- open boards will show the cleaned description after a page refresh.',
  );
}
