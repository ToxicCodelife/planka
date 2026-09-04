const fs = require('fs');

const fsPromises = fs.promises;
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

module.exports = {
  inputs: {
    stream: {
      type: 'ref',
      required: true,
    },
    filename: {
      type: 'string',
      defaultsTo: 'cover.jpg',
    },
    mimeType: {
      type: 'string',
      defaultsTo: 'image/jpeg',
    },
    size: {
      type: 'number',
      defaultsTo: 0,
    },
  },

  async fn(inputs) {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'planka-cover-'));
    const filePath = path.join(directory, inputs.filename);

    try {
      await pipeline(inputs.stream, fs.createWriteStream(filePath));

      return await sails.helpers.attachments.processUploadedFile.with({
        file: {
          fd: filePath,
          filename: inputs.filename,
          type: inputs.mimeType,
          size: inputs.size || (await fsPromises.stat(filePath)).size,
        },
      });
    } finally {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  },
};
