/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// eslint-disable-next-line import/no-extraneous-dependencies
const howlongtobeat = require('howlongtobeat-api'); // npm install howlongtobeat-api --save

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

async function fetchIgdbMultiplayerModes(gameId, clientId, token) {
  if (!gameId) {
    console.warn('IGDB multiplayer-modes lookup skipped: game.id was missing.');
    return null;
  }

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/multiplayer_modes',
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      data: `fields campaigncoop, dropin, lancoop, offlinecoop, offlinecoopmax, offlinemax, onlinecoop, onlinecoopmax, onlinemax, splitscreen, splitscreenonline; where game = ${gameId};`,
    });

    console.log(
      `[DEBUG] IGDB multiplayer-modes raw response for game ${gameId}:`,
      JSON.stringify(response.data),
    );

    const entries = response.data || [];

    if (entries.length === 0) {
      return null;
    }

    // A game can have multiple rows (one per platform). Take the highest
    // value IGDB reports for each field across all of them, so we show the
    // best-case group size regardless of which platform entry it came from.
    const maxField = (field) =>
      entries.reduce((max, entry) => {
        const value = entry[field];
        return typeof value === 'number' && value > max ? value : max;
      }, 0);

    const anyField = (field) => entries.some((entry) => entry[field] === true);

    const result = {
      hasCoop: anyField('onlinecoop') || anyField('offlinecoop') || anyField('campaigncoop'),
      coopMax: Math.max(maxField('onlinecoopmax'), maxField('offlinecoopmax')) || null,
      multiplayerMax: Math.max(maxField('onlinemax'), maxField('offlinemax')) || null,
      splitscreen: anyField('splitscreen') || anyField('splitscreenonline'),
    };

    // If IGDB didn't actually give us any useful numbers, don't bother
    if (!result.coopMax && !result.multiplayerMax && !result.hasCoop) {
      return null;
    }

    return result;
  } catch (err) {
    console.warn(
      'IGDB multiplayer-modes lookup failed:',
      err.response ? JSON.stringify(err.response.data) : err.message,
    );
    return null;
  }
}

async function fetchHowLongToBeatTime(gameName) {
  try {
    const response = await howlongtobeat.find({ search: gameName });
    const results = response && response.data;

    console.log(
      `[DEBUG] HowLongToBeat (howlongtobeat-api) search for "${gameName}" returned ${
        results ? results.length : 0
      } result(s).`,
    );

    if (!results || results.length === 0) {
      return null;
    }

    // This package doesn't return a similarity score like the old one did,
    // so prefer an exact case-insensitive name match; otherwise trust the
    // API's own result ordering and take the first one.
    const best =
      results.find((r) => (r.name || '').toLowerCase() === gameName.toLowerCase()) || results[0];

    console.log(`[DEBUG] HowLongToBeat best match: ${best.name}`);

    return {
      source: 'HowLongToBeat',
      mainHours: best.gameplayMain || null,
      mainExtraHours: best.gameplayExtended || null,
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

function buildMultiplayerText(mpData) {
  if (!mpData) {
    return null;
  }

  const parts = [];

  if (mpData.coopMax) {
    parts.push(`Co-op: up to ${mpData.coopMax} players`);
  } else if (mpData.hasCoop) {
    parts.push(`Co-op: supported`);
  }

  if (mpData.multiplayerMax) {
    parts.push(`Multiplayer: up to ${mpData.multiplayerMax} players`);
  }

  if (mpData.splitscreen) {
    parts.push('Splitscreen supported');
  }

  if (parts.length === 0) {
    return null;
  }

  return `**Group Size:** ${parts.join(' | ')}`;
}

async function fetchCoOptimusData(gameName) {
  try {
    const response = await axios.get('https://api.co-optimus.com/games.php', {
      params: { search: true, name: gameName },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      timeout: 10000,
    });

    const xml = String(response.data || '');

    console.log(
      `[DEBUG] Co-Optimus raw response for "${gameName}" (first 500 chars):`,
      xml.substring(0, 500),
    );

    const extractTag = (tag) => {
      const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
      return match ? match[1].trim() : null;
    };

    // NOTE: if a search-by-name returns multiple <game> blocks (e.g. the
    // same title on several platforms), this simple regex approach grabs
    // the FIRST one in the document -- a reasonable best-effort simplification.
    const title = extractTag('title');
    if (!title) {
      return null;
    }

    const online = extractTag('online');
    const splitscreen = extractTag('splitscreen');
    const dropindropout = extractTag('dropindropout');
    const campaign = extractTag('campaign');
    const modes = extractTag('modes');
    const featurelist = extractTag('featurelist');
    const url = extractTag('url');

    return {
      title,
      // NOTE: despite the separate params-legend page describing a similarly
      // named search FILTER as "minimum player count", the <online> tag
      // actually returned here is the game's max supported online co-op
      // players (verified against Terraria's known real-world co-op support).
      // We label it accordingly below -- do NOT present this as a minimum.
      onlineMax: online ? parseInt(online, 10) || null : null,
      splitscreenSupported: splitscreen === '1',
      dropInDropOut: dropindropout === '1',
      campaignCoop: campaign === '1',
      coopModes: modes === '1',
      featureList: featurelist,
      pageUrl: url,
    };
  } catch (err) {
    console.warn('Co-Optimus lookup failed:', err.response ? err.response.status : err.message);
    return null;
  }
}

function buildCoOptimusText(data) {
  if (!data) {
    return null;
  }

  const lines = [`**Co-Op Info for ${data.title}** (source: Co-Optimus)`];

  if (data.featureList) {
    lines.push(`- Features: ${data.featureList}`);
  }

  if (data.onlineMax) {
    lines.push(`- Online co-op: up to ${data.onlineMax} players`);
  }

  if (data.pageUrl) {
    lines.push(`- More info: ${data.pageUrl}`);
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

      // Fetch existing attachments/comments once so each section below can
      // check "have I already done this?" -- makes it safe to re-run this
      // function on a card that was already processed (e.g. a backfill).
      const existingAttachments = await Attachment.find({ cardId });
      const existingComments = await Comment.find({ cardId });

      const hasTrailerAttachment = existingAttachments.some((a) => /trailer/i.test(a.name || ''));
      const hasCompletionComment = existingComments.some((c) =>
        /Completion time for/i.test(c.text || ''),
      );
      const hasCoOptimusComment = existingComments.some((c) =>
        /Co-Op Info for/i.test(c.text || ''),
      );

      // -----------------------------------------------------------------
      // 1. Cover image -- skip if this card already has one (either from a
      //    previous run of this service, or one the user set manually).
      // -----------------------------------------------------------------
      if (card.coverAttachmentId) {
        console.log(`Card already has a cover set; skipping cover for: ${cardTitle}`);
      } else if (game.cover && game.cover.url) {
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
      // 2. Genres & Themes & Group Size -> card description
      // -----------------------------------------------------------------
      const genreNames = (game.genres || []).map((g) => g.name).filter(Boolean);
      const themeNames = (game.themes || []).map((t) => t.name).filter(Boolean);
      const multiplayerData = await fetchIgdbMultiplayerModes(game.id, clientId, token);
      const multiplayerText = buildMultiplayerText(multiplayerData);

      if (genreNames.length > 0 || themeNames.length > 0 || multiplayerText) {
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

        if (multiplayerText) {
          descriptionParts.push(multiplayerText);
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

          console.log(`Updated description with Genres/Themes/Group Size for: ${cardTitle}`);
        }
      }

      // -----------------------------------------------------------------
      // 3. Trailers -> link-type attachments (release + gameplay, when available)
      // -----------------------------------------------------------------
      if (hasTrailerAttachment) {
        console.log(`Card already has a trailer attachment; skipping trailers for: ${cardTitle}`);
      } else {
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
      }

      // -----------------------------------------------------------------
      // 4. Completion time: fetch BOTH sources, merge, but only post if
      //    we actually have a Completionist number from at least one of them.
      // -----------------------------------------------------------------
      if (hasCompletionComment) {
        console.log(`Card already has a completion-time comment; skipping for: ${cardTitle}`);
      } else {
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
      }

      // -----------------------------------------------------------------
      // 5. Co-Optimus -> its own independent comment. Wrapped in its own
      //    try/catch so a failure here NEVER blocks anything else (cover,
      //    description, trailers, completion-time comment all already done
      //    by this point regardless of what happens below).
      // -----------------------------------------------------------------
      if (hasCoOptimusComment) {
        console.log(`Card already has a Co-Optimus comment; skipping for: ${cardTitle}`);
      } else {
        try {
          const coOptimusData = await fetchCoOptimusData(game.name || cardTitle);
          const coOptimusText = buildCoOptimusText(coOptimusData);

          if (coOptimusText) {
            const creatorUser = await User.findOne({ id: card.creatorUserId });

            if (creatorUser) {
              await sails.helpers.comments.createOne.with({
                project,
                board,
                list,
                values: {
                  text: coOptimusText,
                  card,
                  user: creatorUser,
                },
              });

              console.log(`Posted Co-Optimus comment for: ${cardTitle}`);
            } else {
              console.warn(
                `Could not find creator user ${card.creatorUserId} to post Co-Optimus comment.`,
              );
            }
          } else {
            console.log(`No Co-Optimus data found for: ${cardTitle}`);
          }
        } catch (err) {
          console.warn(
            `Co-Optimus section failed safely for ${cardTitle}:`,
            err.message,
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
