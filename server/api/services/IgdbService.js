/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
const axios = require('axios');

module.exports = {
  async fetchAndAttachCover(cardId, cardTitle) {
    try {
      if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) {
        console.warn('IGDB credentials missing in Docker variables.');
        return;
      }

      // 1. Authenticate with Twitch
      const auth = await axios.post(
        `https://id.twitch.tv/oauth2/token?client_id=${process.env.IGDB_CLIENT_ID}&client_secret=${process.env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
      );

      const token = auth.data.access_token;
      // 2. Query IGDB for the game matching the card title
      const response = await axios({
        url: 'https://igdb.com',
        method: 'POST',
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        data: `search "${cardTitle}"; fields name, cover.url; limit 1;`,
      });

      // 3. Process image if game is found
      if (response.data && response.data.length > 0) {
        const game = response.data[0];
        if (game.cover && game.cover.url) {
          // Clean up the protocol relative URL structure
          let coverUrl = game.cover.url.startsWith('//')
            ? `https:${game.cover.url}`
            : game.cover.url;
          coverUrl = coverUrl.replace('t_thumb', 't_cover_big');

          // 4. Download and Attach to Planka
          const imageResponse = await axios.get(coverUrl, { responseType: 'stream' });

          await sails.helpers.cards.createOneAttachment.with({
            cardId,
            file: imageResponse.data,
            filename: `${game.name || 'cover'}.jpg`,
          });

          console.log(`Successfully attached IGDB cover for: ${cardTitle}`);
        } else {
          console.log(`Game found for "${cardTitle}", but it has no cover art on IGDB.`);
        }
      } else {
        console.log(`No matching game found on IGDB for: ${cardTitle}`);
      }
    } catch (err) {
      console.error('Background IGDB processing failed safely:', err.message);
    }
  },
};
