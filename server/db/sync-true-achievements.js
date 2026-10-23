/* eslint-disable no-console */
// db/sync-true-achievements.js
//
// Syncs each linked friend's games into Planka:
//   - "have": every game they've played, from the Xbox Live API (xbl.io)
//   - "want": every game on their TrueAchievements wishlist
// Only games confirmed multiplayer/co-op/versus are CREATED. A game that
// already has a card anywhere on either board is never duplicated -- the
// friend is just added to (or updated on) the existing card.
//
// DRY RUN by default: prints exactly what it would do and changes nothing.
//   node db/sync-true-achievements.js
// Make the changes for real:
//   node db/sync-true-achievements.js --apply
// Options:
//   --user=<part of name>   only sync users whose name contains this
//   --limit=<n>             only handle the first n NEW games (good for a first real run)
//   --refresh               ignore cached multiplayer verdicts
//   --creator=<part of name> user shown as the card creator (default: first admin)
//
// Rules:
//   * Board: a game listing Xbox 360 goes to the Xbox 360 board; otherwise the
//     Xbox One board. Wishlist games (platform unknown) go to the Xbox One board.
//   * Existing member status is never downgraded. "want" is upgraded to "have"
//     when the Xbox API shows they've played it. "done" is never touched.
//   * Cards that are in the Archive/Trash are NOT touched or recreated -- they
//     are listed so you can decide.

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const fs = require('fs');
const path = require('path');
const sails = require('sails');

fs.mkdirSync(path.join(__dirname, '..', '.tmp', 'public', 'preloaded-favicons'), {
  recursive: true,
});

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const REFRESH = ARGS.includes('--refresh');
const argValue = (name) => {
  const found = ARGS.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
const USER_FILTER = argValue('user');
const CREATOR_FILTER = argValue('creator');
const NEW_GAME_LIMIT = argValue('limit') ? parseInt(argValue('limit'), 10) : Infinity;

const POSITION_GAP = 65536;
const DELAY_BETWEEN_GAMERS_MS = 4000;
const DELAY_BETWEEN_VERIFICATIONS_MS = 500;
const NEGATIVE_CACHE_DAYS = 14;
const CACHE_FILE = path.join(__dirname, '..', '.tmp', 'multiplayer-cache.json');

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
      console.error('Sync failed:', runErr);
    }

    sails.lower(() => process.exit(0));
  },
);

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// "Dead Space(TM) 3 for XBOX One" -> "Dead Space 3"
function cleanName(name) {
  return String(name)
    .replace(/[™®©]/g, '')
    .replace(/\s*[-–(]?\s*\bfor\s+xbox\s*(one|360|series\s*x\|?s?)?\)?\s*$/i, '')
    .replace(/\s*\((xbox\s*(one|360|series[^)]*)|digital|windows)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Looser key used only to decide "is this the same game as an existing card".
function normalizeKey(name) {
  return cleanName(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[:\-–—_.,!?'’"]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  } catch (e) {
    console.warn(`(could not write cache: ${e.message})`);
  }
}

function cacheIsFresh(entry) {
  if (!entry) {
    return false;
  }
  if (entry.isMultiplayer) {
    return true;
  }
  return Date.now() - entry.at < NEGATIVE_CACHE_DAYS * 24 * 3600 * 1000;
}

async function findBoardsAndLists() {
  const boards = await Board.find({});
  const oneBoards = boards.filter((b) => /xbox\s*one|series/i.test(b.name) && !/360/.test(b.name));
  const x360Boards = boards.filter((b) => /360/.test(b.name));

  if (oneBoards.length !== 1 || x360Boards.length !== 1) {
    console.log('Could not tell the two boards apart by name. Boards found:');
    boards.forEach((b) => console.log(`  - "${b.name}" (id ${b.id})`));
    throw new Error('Expected exactly one Xbox One board and one Xbox 360 board.');
  }

  const result = {};
  const targets = [
    ['oneOrSeries', oneBoards[0], 'xbox'],
    ['360', x360Boards[0], 'xbox 360'],
  ];

  // eslint-disable-next-line no-restricted-syntax
  for (const [key, board, listName] of targets) {
    // eslint-disable-next-line no-await-in-loop
    const lists = await List.find({ boardId: board.id });
    const list = lists.find(
      (l) => l.type === List.Types.ACTIVE && String(l.name || '').trim().toLowerCase() === listName,
    );
    if (!list) {
      console.log(`Lists on board "${board.name}":`);
      lists.forEach((l) => console.log(`  - "${l.name}" (${l.type})`));
      throw new Error(`No active list named "${listName}" on board "${board.name}".`);
    }
    // eslint-disable-next-line no-await-in-loop
    const project = await Project.findOne({ id: board.projectId });
    result[key] = { board, list, project };
  }

  return result;
}

async function buildExistingIndex(targets) {
  const index = new Map(); // key -> [{ card, board, list, project, isHidden }]

  // eslint-disable-next-line no-restricted-syntax
  for (const target of Object.values(targets)) {
    // eslint-disable-next-line no-await-in-loop
    const lists = await List.find({ boardId: target.board.id });
    const listById = new Map(lists.map((l) => [l.id, l]));
    // eslint-disable-next-line no-await-in-loop
    const cards = await Card.find({ boardId: target.board.id });

    cards.forEach((card) => {
      const list = listById.get(card.listId);
      const key = normalizeKey(card.name);
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key).push({
        card,
        board: target.board,
        list,
        project: target.project,
        isHidden: !list || list.type === List.Types.ARCHIVE || list.type === List.Types.TRASH,
      });
    });
  }

  return index;
}

async function run() {
  // eslint-disable-next-line global-require
  const TrueAchievementsCollectionService = require('../api/services/TrueAchievementsCollectionService');
  // eslint-disable-next-line global-require
  const XboxLiveService = require('../api/services/XboxLiveService');
  // eslint-disable-next-line global-require
  const MultiplayerVerificationService = require('../api/services/MultiplayerVerificationService');
  // eslint-disable-next-line global-require
  const IgdbService = require('../api/services/IgdbService');

  console.log(APPLY ? '*** APPLY MODE: changes WILL be made ***\n' : '--- DRY RUN: nothing will be changed (add --apply to make changes) ---\n');

  if (!XboxLiveService.isConfigured()) {
    throw new Error('XBL_API_KEY environment variable is not set');
  }

  const targets = await findBoardsAndLists();
  console.log(`Xbox One board: "${targets.oneOrSeries.board.name}" -> list "${targets.oneOrSeries.list.name}"`);
  console.log(`Xbox 360 board: "${targets['360'].board.name}" -> list "${targets['360'].list.name}"\n`);

  const existing = await buildExistingIndex(targets);

  let creator = null;
  const admins = await User.find({ role: 'admin' });
  if (CREATOR_FILTER) {
    creator = (await User.find({})).find((u) =>
      String(u.name).toLowerCase().includes(CREATOR_FILTER.toLowerCase()),
    );
  }
  creator = creator || admins[0];
  if (!creator) {
    throw new Error('No creator user found (need an admin, or pass --creator=<name>).');
  }

  let users = await User.find({ trueAchievementsUsername: { '!=': null } });
  if (USER_FILTER) {
    users = users.filter((u) => String(u.name).toLowerCase().includes(USER_FILTER.toLowerCase()));
  }
  if (users.length === 0) {
    console.log('No matching users with a TrueAchievements username. Nothing to do.');
    return;
  }

  // ---- 1. Gather wanted games from every user ---------------------------------
  // key -> { name, platform, entries: [{ user, status }] }
  const games = new Map();
  const addEntry = (rawName, platform, user, status) => {
    const name = cleanName(rawName);
    const key = normalizeKey(name);
    if (!key) {
      return;
    }
    if (!games.has(key)) {
      games.set(key, { name, platform: platform || null, entries: [] });
    }
    const game = games.get(key);
    if (!game.platform && platform) {
      game.platform = platform;
    }
    const prior = game.entries.find((e) => e.user.id === user.id);
    if (prior) {
      if (status === 'have') {
        prior.status = 'have';
      }
    } else {
      game.entries.push({ user, status });
    }
  };

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    console.log(`[${i + 1}/${users.length}] Reading ${user.name} ("${user.trueAchievementsUsername}")...`);

    try {
      // eslint-disable-next-line no-await-in-loop
      const played = await XboxLiveService.fetchPlayedGames(user.trueAchievementsUsername);
      played.forEach((g) => addEntry(g.name, g.platformGuess, user, 'have'));
      console.log(`    have: ${played.length} played game(s) from Xbox`);
    } catch (e) {
      console.warn(`    Xbox fetch failed: ${e.message}`);
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const wish = await TrueAchievementsCollectionService.fetchWishlistGames(
        user.trueAchievementsUsername,
      );
      wish.forEach((g) => addEntry(g.name, null, user, 'want'));
      console.log(`    want: ${wish.length} wishlist game(s) from TrueAchievements`);
    } catch (e) {
      console.warn(`    Wishlist fetch failed: ${e.message}`);
    }

    if (i < users.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(DELAY_BETWEEN_GAMERS_MS);
    }
  }

  console.log(`\n${games.size} distinct game(s) across ${users.length} user(s).\n`);

  // ---- 2. Decide + (optionally) apply ----------------------------------------
  const cache = REFRESH ? {} : loadCache();
  const stats = {
    created: 0,
    membershipsAdded: 0,
    statusUpgraded: 0,
    unchanged: 0,
    skippedSinglePlayer: 0,
    skippedArchived: [],
  };
  const nextPosition = {}; // listId -> next position
  let newGameCount = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const [key, game] of games) {
    const matches = existing.get(key) || [];
    const visible = matches.find((m) => !m.isHidden);

    // eslint-disable-next-line no-nested-ternary
    let host = visible;

    if (!host && matches.length > 0) {
      stats.skippedArchived.push(`${game.name} (${matches[0].list ? matches[0].list.type : 'no list'} on "${matches[0].board.name}")`);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!host) {
      // New game -- must be confirmed multiplayer before a card is made.
      if (newGameCount >= NEW_GAME_LIMIT) {
        // eslint-disable-next-line no-continue
        continue;
      }

      let verdict = cache[key];
      if (!cacheIsFresh(verdict)) {
        // eslint-disable-next-line no-await-in-loop
        const result = await MultiplayerVerificationService.verifyMultiplayer(game.name);
        const sources = [];
        if (result.igdb.isMultiplayer) sources.push('IGDB');
        if (result.coOptimus.isMultiplayer) sources.push('Co-Optimus');
        if (result.trueAchievements.isMultiplayer) sources.push('TA flags');
        verdict = { isMultiplayer: result.isMultiplayer, sources, at: Date.now() };
        cache[key] = verdict;
        saveCache(cache);
        // eslint-disable-next-line no-await-in-loop
        await sleep(DELAY_BETWEEN_VERIFICATIONS_MS);
      }

      if (!verdict.isMultiplayer) {
        stats.skippedSinglePlayer += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      newGameCount += 1;
      let platformKey = game.platform === '360' ? '360' : 'oneOrSeries';
      let platformNote = '';
      if (game.platform === '360+newer') {
        // Xbox lists identical devices for a backward-compatible 360 game and
        // a game truly released on both -- IGDB's release platforms decide.
        // eslint-disable-next-line no-await-in-loop
        const gens = await MultiplayerVerificationService.getReleasedXboxGenerations(game.name);
        if (gens && gens.has360 && !gens.hasModern) {
          platformKey = '360';
          platformNote = ' (backward-compatible 360 game per IGDB)';
        } else if (gens && gens.hasModern) {
          platformKey = 'oneOrSeries';
          platformNote = ' (released on Xbox One/Series too per IGDB -- check this one)';
        } else {
          platformKey = '360';
          platformNote = ' (IGDB unsure; defaulted to 360 -- check this one)';
        }
      }
      const target = targets[platformKey];
      const who = game.entries.map((e) => `${e.user.name}:${e.status}`).join(', ');
      console.log(
        `NEW  "${game.name}" -> ${target.board.name} / ${target.list.name}` +
          `${platformNote}${game.platform ? '' : ' (platform unknown, defaulted)'}  [multiplayer: ${verdict.sources.join('+')}]  members: ${who}`,
      );

      if (APPLY) {
        if (nextPosition[target.list.id] === undefined) {
          // eslint-disable-next-line no-await-in-loop
          const cardsInList = await Card.find({ listId: target.list.id });
          const maxPos = cardsInList.reduce((m, c) => Math.max(m, c.position || 0), 0);
          nextPosition[target.list.id] = maxPos + POSITION_GAP;
        }
        const position = nextPosition[target.list.id];
        nextPosition[target.list.id] += POSITION_GAP;

        // eslint-disable-next-line no-await-in-loop
        const card = await sails.helpers.cards.createOne.with({
          project: target.project,
          values: {
            type: Card.Types.PROJECT,
            name: game.name,
            position,
            board: target.board,
            list: target.list,
            creatorUser: creator,
          },
        });

        host = { card, board: target.board, list: target.list, project: target.project };
        existing.set(key, [{ ...host, isHidden: false }]);
        stats.created += 1;

        try {
          // eslint-disable-next-line no-await-in-loop
          await IgdbService.fetchAndAttachCover(card.id, card.name);
        } catch (e) {
          console.warn(`    (cover/info enrichment failed for "${game.name}": ${e.message})`);
        }
      } else {
        stats.created += 1; // counted as "would create"
        stats.membershipsAdded += game.entries.length;
        // eslint-disable-next-line no-continue
        continue;
      }
    }

    // ---- members for this card ----
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of game.entries) {
      // eslint-disable-next-line no-await-in-loop
      const membership = await CardMembership.qm.getOneByCardIdAndUserId(
        host.card.id,
        entry.user.id,
      );

      if (!membership) {
        console.log(
          `ADD  ${entry.user.name} to "${host.card.name}" (${host.board.name}) as ${entry.status}`,
        );
        if (APPLY) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await sails.helpers.cardMemberships.createOne.with({
              values: { card: host.card, user: entry.user, status: entry.status },
              project: host.project,
              board: host.board,
              list: host.list,
              actorUser: creator,
            });
          } catch (e) {
            if (e !== 'userAlreadyCardMember' && !(e && e.raw === 'userAlreadyCardMember')) {
              console.warn(`    failed to add ${entry.user.name}: ${e.message || e}`);
              // eslint-disable-next-line no-continue
              continue;
            }
          }
        }
        stats.membershipsAdded += 1;
      } else if (membership.status === 'want' && entry.status === 'have') {
        console.log(`UPG  ${entry.user.name} on "${host.card.name}": want -> have`);
        if (APPLY) {
          // eslint-disable-next-line no-await-in-loop
          await sails.helpers.cardMemberships.updateOne.with({
            record: membership,
            values: { status: 'have' },
            project: host.project,
            board: host.board,
            list: host.list,
            actorUser: creator,
          });
        }
        stats.statusUpgraded += 1;
      } else {
        stats.unchanged += 1;
      }
    }
  }

  // ---- 3. Summary -------------------------------------------------------------
  console.log('\n================ SUMMARY ================');
  console.log(`${APPLY ? 'Cards created' : 'Cards that WOULD be created'}: ${stats.created}`);
  console.log(`${APPLY ? 'Members added' : 'Members that WOULD be added'}: ${stats.membershipsAdded}`);
  console.log(`${APPLY ? 'Statuses upgraded' : 'Statuses that WOULD be upgraded'} (want -> have): ${stats.statusUpgraded}`);
  console.log(`Already correct (no change): ${stats.unchanged}`);
  console.log(`Skipped as single-player/unconfirmed: ${stats.skippedSinglePlayer}`);
  if (stats.skippedArchived.length > 0) {
    console.log(`In Archive/Trash (left alone, ${stats.skippedArchived.length}):`);
    stats.skippedArchived.forEach((s) => console.log(`  - ${s}`));
  }
  if (Number.isFinite(NEW_GAME_LIMIT)) {
    console.log(`(--limit=${NEW_GAME_LIMIT} applied to NEW games only)`);
  }
  console.log(APPLY ? '\nDone.' : '\nThis was a dry run. Re-run with --apply to make these changes.');
}
