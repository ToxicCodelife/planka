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
    data: `search "${escapedTitle}"; fields id, name, cover.url, genres.name, themes.name, videos.video_id, videos.name; limit 1;`,
  });

  return response.data && response.data[0];
}

async function fetchIgdbTimeToBeat(gameId, clientId, token) {
  if (!gameId) {
    console.warn('IGDB time-to-beat lookup skipped: game.id was missing.');
    return null;
  }

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/game_time_to_beats',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `fields game_id, hastily, normally, completely; where game_id = ${gameId}; limit 1;`,
    });

    console.log(
      `[DEBUG] IGDB time-to-beat raw response for game ${gameId}:`,
      JSON.stringify(response.data),
    );

    const entry = response.data && response.data[0];

    // IGDB gives seconds; only useful if it has at least ONE of these values
    if (!entry || (!entry.normally && !entry.completely && !entry.hastily)) {
      return null;
    }

    const toHours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

    return {
      source: 'IGDB',
      mainHours: entry.normally ? toHours(entry.normally) : null,
      mainExtraHours: null,
      completionistHours: entry.completely ? toHours(entry.completely) : null,
    };
  } catch (err) {
    console.warn(
      'IGDB time-to-beat lookup failed:',
      err.response ? JSON.stringify(err.response.data) : err.message,
    );
    return null;
  }
}

async function fetchHowLongToBeatTime(gameName) {
  try {
    const results = await hltbService.search(gameName);

    console.log(
      `[DEBUG] HowLongToBeat search for "${gameName}" returned ${
        results ? results.length : 0
      } result(s).`,
    );

    if (!results || results.length === 0) {
      return null;
    }

    // The package ranks results by relevance via `similarity` (1 = best match).
    // Sort defensively rather than assuming search() always returns them pre-sorted.
    const best = [...results].sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0];

    console.log(`[DEBUG] HowLongToBeat best match: ${best.name} (similarity ${best.similarity})`);

    return {
      source: 'HowLongToBeat',
      mainHours: best.gameplayMain || null,
      mainExtraHours: best.gameplayMainExtra || null,
      completionistHours: best.gameplayCompletionist || null,
    };
  } catch (err) {
    console.warn('HowLongToBeat lookup failed:', err.stack || err.message);
    return null;
  }
}

function mergeTimeData(hltbData, igdbData) {
  if (!hltbData && !igdbData) {
    return null;
  }

  const sources = [];
  if (hltbData) {
    sources.push('HowLongToBeat');
  }
  if (igdbData) {
    sources.push('IGDB');
  }

  return {
    source: sources.join(' + '),
    // Prefer HLTB's numbers when both have them (generally more granular),
    // but fall back to IGDB for whichever field HLTB is missing.
    mainHours: (hltbData && hltbData.mainHours) || (igdbData && igdbData.mainHours) || null,
    mainExtraHours:
      (hltbData && hltbData.mainExtraHours) || (igdbData && igdbData.mainExtraHours) || null,
    completionistHours:
      (hltbData && hltbData.completionistHours) ||
      (igdbData && igdbData.completionistHours) ||
      null,
  };
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
            sails.sockets.broadcast(`board:${board.id}`, 'cardUpdate', {
              item: updatedCard,
            });
          }

          console.log(`Updated description with Genres/Themes for: ${cardTitle}`);
        }
      }

      // -----------------------------------------------------------------
      // 3. Trailers -> link-type attachments (release + gameplay, when available)
      // -----------------------------------------------------------------
      const videos = game.videos || [];

      const gameplayVideo = videos.find((v) => /gameplay/i.test(v.name || ''));
      const releaseVideo = videos.find(
        (v) => /release|launch|announce/i.test(v.name || '') && v !== gameplayVideo,
      );

      const videosToAttach = [];
      if (releaseVideo) {
        videosToAttach.push({ video: releaseVideo, label: 'Release Trailer' });
      }
      if (gameplayVideo) {
        videosToAttach.push({ video: gameplayVideo, label: 'Gameplay Trailer' });
      }

      // Neither specific category matched -- fall back to whatever's first,
      // generically labeled, so we still attach SOMETHING if videos exist.
      if (videosToAttach.length === 0 && videos.length > 0) {
        videosToAttach.push({ video: videos[0], label: 'Trailer' });
      }

      if (videosToAttach.length > 0) {
        // eslint-disable-next-line no-restricted-syntax
        for (const { video, label } of videosToAttach) {
          if (!video.video_id) {
            // eslint-disable-next-line no-continue
            continue;
          }

          const youtubeUrl = `https://www.youtube.com/watch?v=${video.video_id}`;

          try {
            // eslint-disable-next-line no-await-in-loop
            const linkData = await sails.helpers.attachments.processLink(youtubeUrl);

            // eslint-disable-next-line no-await-in-loop
            await sails.helpers.attachments.createOne.with({
              project,
              board,
              list,
              values: {
                type: Attachment.Types.LINK,
                name: `${game.name || cardTitle} - ${label}`,
                data: linkData,
                card,
                creatorUser: { id: card.creatorUserId },
              },
            });

            console.log(`Attached ${label} for: ${cardTitle}`);
          } catch (err) {
            console.warn(`Failed to attach ${label}:`, err.message);
          }
        }
      } else {
        console.log(`No trailer video found on IGDB for: ${cardTitle}`);
      }

      // -----------------------------------------------------------------
      // 4. Completion time: fetch BOTH sources, merge, but only post if
      //    we actually have a Completionist number from at least one of them.
      // -----------------------------------------------------------------
      const [hltbData, igdbTimeData] = await Promise.all([
        fetchHowLongToBeatTime(game.name || cardTitle),
        fetchIgdbTimeToBeat(game.id, clientId, token),
      ]);

      const mergedTimeData = mergeTimeData(hltbData, igdbTimeData);

      if (!mergedTimeData || !mergedTimeData.completionistHours) {
        console.log(
          `No Completionist time available from either source for: ${cardTitle} -- skipping comment (Completionist time is required).`,
        );
      } else {
        const completionText = buildCompletionTimeText(mergedTimeData, game.name || cardTitle);

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
