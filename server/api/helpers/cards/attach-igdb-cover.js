const axios = require('axios');

async function getTwitchToken() {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing IGDB credentials');
  }

  const url = `https://twitch.tv{clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const res = await axios.post(url);
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

      const token = await getTwitchToken();

      // Step 1: Query game database ID from title with strict text body formatting
      const gameRes = await axios({
        url: 'https://api.igdb.com/v4/games',
        method: 'POST',
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        data: String(`search "${inputs.card.name}"; fields id; limit 1;`),
      });

      if (!gameRes.data || gameRes.data.length === 0) {
        return;
      }
      const gameId = gameRes.data[0].id;

      // Step 2: Use ID to query cover image URL
      const coverRes = await axios({
        url: 'https://igdb.com',
        method: 'POST',
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        data: String(`fields url; where game = ${gameId};`),
      });

      if (!coverRes.data || coverRes.data.length === 0 || !coverRes.data[0].url) {
        return;
      }
      const highResUrl = `https:${coverRes.data[0].url.replace('t_thumb', 't_cover_big')}`;

      // Step 3: Stream download image file data
      const imgStream = await axios({
        method: 'get',
        url: highResUrl,
        responseType: 'stream',
      });

      // Step 4: Inject into Planka's native attachment upload handler natively
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
