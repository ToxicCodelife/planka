const axios = require('axios');

const IgdbService = require('../../services/IgdbService');

module.exports = {
  inputs: {
    card: {
      type: 'ref',
      required: true,
    },
    project: {
      type: 'ref',
      required: true,
    },
    board: {
      type: 'ref',
      required: true,
    },
    list: {
      type: 'ref',
      required: true,
    },
    creatorUser: {
      type: 'ref',
    },
  },

  async fn(inputs) {
    if (inputs.card.coverAttachmentId) {
      return null;
    }

    const coverUrl = await IgdbService.getCoverUrl(inputs.card.name);
    if (!coverUrl) {
      return null;
    }

    const response = await axios.get(coverUrl, { responseType: 'stream' });

    const data = await sails.helpers.attachments.uploadStream.with({
      stream: response.data,
      filename: `${inputs.card.name}.jpg`,
      mimeType: response.headers['content-type'] || 'image/jpeg',
      size: Number(response.headers['content-length']) || 0,
    });

    const attachment = await Attachment.qm.createOne({
      type: Attachment.Types.FILE,
      data,
      name: `${inputs.card.name} cover`,
      cardId: inputs.card.id,
      creatorUserId: inputs.creatorUser && inputs.creatorUser.id,
    });

    const card = await Card.qm.updateOne(
      {
        id: inputs.card.id,
        or: [{ coverAttachmentId: null }, { coverAttachmentId: '' }],
      },
      { coverAttachmentId: attachment.id },
    );

    if (!card) {
      return attachment;
    }

    sails.sockets.broadcast(`board:${card.boardId}`, 'cardUpdate', {
      item: card,
    });

    return attachment;
  },
};
