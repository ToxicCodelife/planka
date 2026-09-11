/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const path = require('path');

module.exports = {
  async fetchAndAttachCover(cardId, cardTitle) {
    const clientId =
      process.env.IGDB_CLIENT_ID || (sails.config.custom ? sails.config.custom.igdbClientId : null);
    const clientSecret =
      process.env.IGDB_CLIENT_SECRET ||
      (sails.config.custom ? sails.config.custom.igdbClientSecret : null);

    try {
      if (!clientId || !clientSecret) {
        console.warn('IGDB credentials missing in environment variables.');
        return;
      }

      // 1. Authenticate with Twitch
      const auth = await axios.post(
        `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      );

      const token = auth.data.access_token;

      // 2. Query IGDB Endpoint with correct v4 route
      const response = await axios({
        url: 'https://api.igdb.com/v4/games',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        data: `search "${cardTitle}"; fields name, cover.url; limit 1;`,
      });

      // 3. Process image if game is found
      if (response.data && response.data.length > 0) {
        const game = response.data[0];
        if (game.cover && game.cover.url) {
          let coverUrl = game.cover.url.startsWith('//')
            ? `https:${game.cover.url}`
            : game.cover.url;

          // Upgrade thumbnail to large cover size
          coverUrl = coverUrl.replace('t_thumb', 't_cover_big');

          // 4. Download image buffer
          const imageResponse = await axios.get(coverUrl, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(imageResponse.data, 'binary');

          const safeGameName = (game.name || 'cover').replace(/[^a-z0-9]/gi, '_').toLowerCase();
          const filename = `${safeGameName}.jpg`;
          const uniqueFilename = `${Date.now()}-${filename}`;

          // Save directly to the Planka attachments directory
          const uploadDir = path.join(process.cwd(), 'private/attachments');

          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          const fullFilePath = path.join(uploadDir, uniqueFilename);
          fs.writeFileSync(fullFilePath, buffer);

          // Create the attachment row in PostgreSQL
          const attachment = await Attachment.create({
            cardId,
            type: 'file',
            name: game.name || 'Cover',
            filename,
            dirname: 'private/attachments',
            extra: {
              path: uniqueFilename,
              size: buffer.length,
            },
          }).fetch();

          // 5. Explicitly update the card's front cover image ID
          const updatedCard = await Card.updateOne({ id: cardId }).set({
            coverAttachmentId: attachment.id,
          });

          // 6. Safely broadcast full update payload structures to active users
          if (updatedCard) {
            Card.publish([cardId], {
              verb: 'updated',
              id: cardId,
              data: updatedCard,
            });
          }

          console.log(`Successfully attached IGDB cover for: ${cardTitle}`);
        } else {
          console.log(`Game found for "${cardTitle}", but it has no cover art on IGDB.`);
        }
      } else {
        console.log(`No matching game found on IGDB for: ${cardTitle}`);
      }
    } catch (err) {
      console.error(
        'Background IGDB processing failed safely:',
        err.response ? JSON.stringify(err.response.data) : err.message,
      );
    }
  },
};
