/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// eslint-disable-next-line import/no-extraneous-dependencies
const { HowLongToBeatService } = require('howlongtobeat'); // npm install howlongtobeat --save

const hltbService = new HowLongToBeatService();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getIgdbToken(clientId, clientSecret) {
  const auth = await axios.post(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
  );

  return auth.data.access_token;
}

async function searchIgdbGame(cardTitle, clientId, token) {
  // Escape backslashes and double quotes so titles with punctuation don't
  // break out of the Apicalypse string literal.
  const escapedTitle = cardTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const response = await axios({
    url: 'https://api.igdb.com/v4/games',
    method: 'POST',
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: `search "${escapedTitle}"; fields name, cover.url, genres.name, themes.name, videos.video_id, videos.name; limit 1;`,
  });

  return response.data && response.data[0];
}

async function fetchIgdbTimeToBeat(gameId, clientId, token) {
  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/game_time_to_beat',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `fields game_id, hastily, normally, completely; where game_id = ${gameId}; limit 1;`,
    });

    const entry = response.data && response.data[0];

    // IGDB gives seconds; only useful if it actually has a "normally" value
    if (!entry || !entry.normally) {
      return null;
    }

    const toHours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

    return {
      source: 'IGDB',
      mainHours: toHours(entry.normally),
      mainExtraHours: null,
      completionistHours: entry.completely ? toHours(entry.completely) : null,
    };
  } catch (err) {
    console.warn('IGDB time-to-beat lookup failed:', err.message);
    return null;
  }
}

async function fetchHowLongToBeatTime(gameName) {
  try {
    const results = await hltbService.search(gameName);

    if (!results || results.length === 0) {
      return null;
    }

    // The package ranks results by relevance via `similarity` (1 = best match).
    // Sort defensively rather than assuming search() always returns them pre-sorted.
    const best = [...results].sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0];

    return {
      source: 'HowLongToBeat',
      mainHours: best.gameplayMain || null,
      mainExtraHours: best.gameplayMainExtra || null,
      completionistHours: best.gameplayCompletionist || null,
    };
  } catch (err) {
    console.warn('HowLongToBeat lookup failed:', err.message);
    return null;
  }
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

      // -----------------------------------------------------------------
      // 1. Cover image (unchanged from before)
      // -----------------------------------------------------------------
      if (game.cover && game.cover.url) {
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
      // 2. Genres & Themes -> card description
      // -----------------------------------------------------------------
      const genreNames = (game.genres || []).map((g) => g.name).filter(Boolean);
      const themeNames = (game.themes || []).map((t) => t.name).filter(Boolean);

      if (genreNames.length > 0 || themeNames.length > 0) {
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

        const newDescription = descriptionParts.join('\n\n');

        if (newDescription !== card.description) {
          const updatedCard = await Card.updateOne({ id: cardId }).set({
            description: newDescription,
          });

          if (updatedCard) {
            Card.publish([cardId], {
              verb: 'updated',
              id: cardId,
              data: updatedCard,
            });
          }

          console.log(`Updated description with Genres/Themes for: ${cardTitle}`);
        }
      }

      // -----------------------------------------------------------------
      // 3. Trailer -> link-type attachment
      // -----------------------------------------------------------------
      const videos = game.videos || [];
      const trailerVideo = videos.find((v) => /trailer/i.test(v.name || '')) || videos[0];

      if (trailerVideo && trailerVideo.video_id) {
        const youtubeUrl = `https://www.youtube.com/watch?v=${trailerVideo.video_id}`;

        try {
          const linkData = await sails.helpers.attachments.processLink(youtubeUrl);

          await sails.helpers.attachments.createOne.with({
            project,
            board,
            list,
            values: {
              type: Attachment.Types.LINK,
              name: trailerVideo.name || `${game.name} - Trailer`,
              data: linkData,
              card,
              creatorUser: { id: card.creatorUserId },
            },
          });

          console.log(`Attached trailer link for: ${cardTitle}`);
        } catch (err) {
          console.warn('Failed to attach trailer link:', err.message);
        }
      } else {
        console.log(`No trailer video found on IGDB for: ${cardTitle}`);
      }

      // -----------------------------------------------------------------
      // 4. Completion time (IGDB first, HowLongToBeat fallback) -> comment
      // -----------------------------------------------------------------
      let timeData = await fetchIgdbTimeToBeat(game.id, clientId, token);

      if (!timeData) {
        timeData = await fetchHowLongToBeatTime(game.name || cardTitle);
      }

      const completionText = buildCompletionTimeText(timeData, game.name || cardTitle);

      if (completionText) {
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
      } else {
        console.log(`No completion time found (IGDB or HowLongToBeat) for: ${cardTitle}`);
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
