/* eslint-disable no-console */
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

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

      // 1. Authenticate with Twitch
      const auth = await axios.post(
        `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      );
      const token = auth.data.access_token;

      // 2. Query IGDB for the best-matching game
      // Escape backslashes and double quotes so titles like `Tom Clancy's "Ghost Recon"`
      // don't break out of the Apicalypse string literal.
      const escapedTitle = cardTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const response = await axios({
        url: 'https://api.igdb.com/v4/games',
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        data: `search "${escapedTitle}"; fields name, cover.url; limit 1;`,
      });

      if (!response.data || response.data.length === 0) {
        console.log(`No matching game found on IGDB for: ${cardTitle}`);
        return;
      }

      const game = response.data[0];
      if (!game.cover || !game.cover.url) {
        console.log(`Game found for "${cardTitle}", but it has no cover art on IGDB.`);
        return;
      }

      let coverUrl = game.cover.url.startsWith('//') ? `https:${game.cover.url}` : game.cover.url;
      coverUrl = coverUrl.replace('t_thumb', 't_cover_big');

      // 3. Download the image into a buffer
      const imageResponse = await axios.get(coverUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(imageResponse.data, 'binary');

      // 4. Write it to Planka's configured uploads temp dir, mimicking a Skipper upload
      const safeGameName = (game.name || 'cover').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const filename = `${safeGameName}.jpg`;

      const tempDir = sails.config.custom.uploadsTempPath;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      tempFilePath = path.join(tempDir, `${crypto.randomUUID()}-${filename}`);
      await fsPromises.writeFile(tempFilePath, buffer);

      const stats = await fsPromises.stat(tempFilePath);

      // 5. Build a file object shaped like what Skipper would hand to processUploadedFile.
      //    NOTE: 'type' here mirrors the field Skipper sets on uploaded file descriptors.
      //    If fileManager.move() throws on this, check server/hooks/file-manager for what
      //    it expects 'type' to be (likely 'local' or the multipart field name 'file').
      const fakeFile = {
        fd: tempFilePath,
        filename,
        size: stats.size,
        type: 'file',
      };

      // 6. Run it through Planka's real attachment-processing pipeline.
      //    This handles UploadedFile row creation, moving the file into permanent
      //    storage, and generating thumbnails via sharp — identical to a native upload.
      const data = await sails.helpers.attachments.processUploadedFile(fakeFile);

      const card = await Card.findOne({ id: cardId }).populate('list').populate('board');
      if (!card) {
        console.warn(`Card ${cardId} not found when attaching IGDB cover; aborting.`);
        return;
      }

      const project = await Project.findOne({ id: card.board.projectId });

      // 7. Create the attachment through the real helper (handles broadcast + webhooks + cover-setting)
      const attachment = await sails.helpers.attachments.createOne.with({
        project,
        board: card.board,
        list: card.list,
        values: {
          type: Attachment.Types.FILE,
          name: game.name || 'Cover',
          data,
          card,
          creatorUser: { id: card.creatorUserId },
        },
      });

      console.log(`Successfully attached IGDB cover for: ${cardTitle} (attachment ${attachment.id})`);
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
