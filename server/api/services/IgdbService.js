/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const path = require('path');

module.exports = {
  async fetchAndAttachCover(cardId, cardTitle) {
    // 1. Gather variables inside the function block safely
    const clientId =
      process.env.IGDB_CLIENT_ID || (sails.config.custom ? sails.config.custom.igdbClientId : null);
    const clientSecret =
      process.env.IGDB_CLIENT_SECRET ||
      (sails.config.custom ? sails.config.custom.igdbClientSecret : null);

    try {
      if (!clientId || !clientSecret) {
        console.warn('IGDB credentials missing.');
        return;
      }

      // 2. Authenticate with Twitch using local variables
      const auth = await axios.post(
        `https://twitch.tv{clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      );

      const token = auth.data.access_token;

      // 3. Query IGDB for the game matching the card title
      const response = await axios({
        url: 'https://igdb.com',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
        data: `search "${cardTitle}"; fields name, cover.url; limit 1;`,
      });

      // 4. Process image if game is found
      if (response.data && response.data.length > 0) {
        const game = response.data[0];
        if (game.cover && game.cover.url) {
          // Clean up the protocol relative URL structure
          let coverUrl = game.cover.url.startsWith('//')
            ? `https:${game.cover.url}`
            : game.cover.url;
          coverUrl = coverUrl.replace('t_thumb', 't_cover_big');

          // 5. Download and Attach to Planka using Native File System Modules
          const imageResponse = await axios.get(coverUrl, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(imageResponse.data, 'binary');

          const filename = `${game.name || 'cover'}.jpg`;
          const uniqueFilename = `${Date.now()}-${filename}`;

          // Define target path local to Planka execution context
          const uploadDir = path.join(process.cwd(), 'private/attachments');

          // Confirm or create target folder structure
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          // Commit binary stream payload directly to host storage layer
          const fullFilePath = path.join(uploadDir, uniqueFilename);
          fs.writeFileSync(fullFilePath, buffer);

          // Construct the database entry referencing the generated physical file path
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

          // 6. Force the card to display this brand new attachment as its front cover art
          await Card.updateOne({ id: cardId }).set({ coverAttachmentId: attachment.id });

          // 7. Broadcast the change instantly to your friends' screens via WebSockets
          Card.publish([cardId], {
            verb: 'updated',
            id: cardId,
            data: { coverAttachmentId: attachment.id },
          });

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
