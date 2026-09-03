const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { request } = require('undici');

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
      required: true,
    },
  },

  async fn(inputs) {
    const coverUrl = await IgdbService.getCoverUrl(inputs.card.name);
    if (!coverUrl) {
      return;
    }

    const response = await request(coverUrl);
    if (response.statusCode >= 400) {
      throw new Error(`IGDB cover download failed with status ${response.statusCode}`);
    }

    const temporaryPath = path.join(
      sails.config.custom.uploadsTempPath,
      `igdb-cover-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      await fsPromises.mkdir(sails.config.custom.uploadsTempPath, {
        recursive: true,
      });
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath));

      const { size } = await fsPromises.stat(temporaryPath);
      const file = {
        fd: temporaryPath,
        filename: `${inputs.card.name}.jpg`,
        type: response.headers['content-type'] || 'application/octet-stream',
        size,
      };
      const data = await sails.helpers.attachments.processUploadedFile(file);

      await sails.helpers.attachments.createOne.with({
        project: inputs.project,
        board: inputs.board,
        list: inputs.list,
        values: {
          type: Attachment.Types.FILE,
          name: inputs.card.name,
          data,
          card: inputs.card,
          creatorUser: inputs.creatorUser,
        },
      });
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  },
};
