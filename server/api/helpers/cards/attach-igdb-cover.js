const axios = require('axios');

async function getTwitchToken() {
  const clientId = sails.config.custom.twitchClientId || process.env.TWITCH_CLIENT_ID;
  const clientSecret = sails.config.custom.twitchClientSecret || process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Twitch credentials globally inside container space');
  }

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');

  const res = await axios.post('https://twitch.tv', params, {
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

      const clientId = sails.config.custom.twitchClientId || process.env.TWITCH_CLIENT_ID;
      const token = await getTwitchToken();

      if (!clientId || !token) return;

      const gameRes = await axios({
        url: 'https://igdb.com',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'User-Agent': 'Planka-IGDB-CustomFork/1.0',
        },
        data: `search "${inputs.card.name}"; fields id; limit 1;`,
      });

      if (!gameRes.data || gameRes.data.length === 0 || !gameRes.data[0]) {
        return;
      }
      const gameId = gameRes.data[0].id;

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

      if (!coverRes.data || coverRes.data.length === 0 || !coverRes.data[0] || !coverRes.data[0].url) {
        return;
      }

      const highResUrl = `https:${coverRes.data[0].url.replace('t_thumb', 't_cover_big')}`;

      // Download the image as an arraybuffer instead of a streaming pipe to ensure compatibility
      const imgResponse = await axios({
        method: 'get',
        url: highResUrl,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Planka-IGDB-CustomFork/1.0',
        },
      });

      const bufferData = Buffer.from(imgResponse.data);

      const attachment = await sails.helpers.attachments.createOne.with({
        project: inputs.project,
        board: inputs.board,
        card: inputs.card,
        values: {
          filename: `${inputs.card.name}_cover.jpg`,
        },
        creatorUser: inputs.creatorUser,
      });

      // Pass the fully compiled image buffer straight to Planka's uploader
      await sails.helpers.attachments.uploadStream(bufferData, attachment);

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
