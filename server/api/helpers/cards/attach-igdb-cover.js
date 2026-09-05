const axios = require('axios');

async function getTwitchToken() {
  // Use a fallback fail-safe: Check custom config first, then try raw environment variables
  const clientId = sails.config.custom.twitchClientId || process.env.TWITCH_CLIENT_ID;
  const clientSecret = sails.config.custom.twitchClientSecret || process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Twitch credentials globally inside container space');
  }

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');

  const res = await axios.post('https://id.twitch.tv/oauth2/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.data.access_token;
}

module.exports = {
  friendlyName: 'Attach IGDB cover',

  inputs: {
    card: { type: 'ref', required: true },
    project: { type: 'ref', required: true },
    board: { type: 'ref', required: true },
    list: { type: 'ref', required: true },
    creatorUser: { type: 'ref', required: true },
  },

  async fn(inputs) {
    try {
      if (inputs.card.coverAttachmentId) {
        return;
      }

      // Safe fallback variables for the main loop
      const clientId = sails.config.custom.twitchClientId || process.env.TWITCH_CLIENT_ID;
      const token = await getTwitchToken();

      if (!clientId || !token) return;

      const gameRes = await axios({
        url: 'https://api.igdb.com/v4/games',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'User-Agent': 'Planka-IGDB-CustomFork/1.0',
        },
        data: `search "${inputs.card.name}"; fields id; limit 1;`,
      });

      if (!gameRes.data || gameRes.data.length === 0) {
        return;
      }
      const gameId = gameRes.data[0].id; // Re-added proper array indexing for IGDB matching

      const coverRes = await axios({
        url: 'https://igdb.com',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'User-Agent': 'Planka-IGDB-CustomFork/1.0',
        },
        data: `fields url; where game = ${gameId};`,
      });

      if (!coverRes.data || coverRes.data.length === 0 || !coverRes.data[0].url) {
        return;
      }
      const highResUrl = `https:${coverRes.data[0].url.replace('t_thumb', 't_cover_big')}`;

      const imgStream = await axios({
        method: 'get',
        url: highResUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Planka-IGDB-CustomFork/1.0',
        },
      });

      const attachment = await sails.helpers.attachments.createOne.with({
        project: inputs.project,
        board: inputs.board,
        card: inputs.card,
        values: {
          filename: `${inputs.card.name}_cover.jpg`,
        },
        creatorUser: inputs.creatorUser,
      });

      await sails.helpers.attachments.uploadStream(imgStream.data, attachment);

      const updatedCard = await Card.updateOne({ id: inputs.card.id }).set({
        coverAttachmentId: attachment.id,
      });

      sails.sockets.broadcast(`board:${inputs.board.id}`, 'cardUpdate', {
        item: updatedCard,
      });
    } catch (err) {
      sails.log.warn(`Failed to process cover background data: ${err.message}`);
    }
  },
};
