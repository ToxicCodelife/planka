/**
 * Seed Function
 * (sails.config.bootstrap)
 *
 * A function that runs just before your Sails app gets lifted.
 */

// The value our own example compose file ships. Anyone who copied that file
// and never read the paragraph next to it is running with a signing key that
// is published in our documentation — which means anyone can mint a token for
// any account on their instance.
const EXAMPLE_SECRET_KEY = 'notsecretkey';

// What the documentation asks for, and what `openssl rand -hex 32` produces.
const MIN_SECRET_KEY_LENGTH = 32;

const RULE = '─'.repeat(72);

// Loud on purpose. This is not a misconfiguration that degrades a feature; it
// is the difference between sessions that can be forged and sessions that
// cannot, and it is invisible from inside a working instance.
const warn = (headline, detail) => {
  sails.log.warn(RULE);
  sails.log.warn(`SECURITY: ${headline}`);
  detail.forEach((line) => sails.log.warn(`  ${line}`));
  sails.log.warn(RULE);
};

module.exports.bootstrap = async () => {
  setImmediate(async () => {
    try {
      const cards = await Card.find({
        or: [{ coverAttachmentId: null }, { coverAttachmentId: '' }],
      });

      await cards.reduce(
        (promise, card) =>
          promise.then(async () => {
            try {
              const { list, board, project } = await sails.helpers.lists.getPathToProjectById(
                card.listId,
              );
              await sails.helpers.cards.attachIgdbCover.with({
                card,
                project,
                board,
                list,
                creatorUser: card.creatorUserId ? await User.findOne(card.creatorUserId) : null,
              });
            } catch (error) {
              sails.log.warn(`IGDB cover scan failed for card ${card.id}: ${error.message}`);
            }
          }),
        Promise.resolve(),
      );
    } catch (error) {
      sails.log.warn(`IGDB cover scan failed: ${error.message}`);
    }
  });

  const secretKey = sails.config.session.secret;

  if (!secretKey) {
    warn('SECRET_KEY is not set.', [
      'Every access token is signed with it. Without one, sessions cannot be',
      'trusted. Generate a key with:  openssl rand -hex 32',
    ]);

    return;
  }

  if (secretKey === EXAMPLE_SECRET_KEY) {
    warn('SECRET_KEY is still the value from the example configuration.', [
      'It is published in our documentation, so anyone can sign a token for any',
      'account on this instance. Replace it now:  openssl rand -hex 32',
      '',
      'Changing it invalidates every token already issued — everyone signs in',
      'again once, and that is the whole cost.',
    ]);

    return;
  }

  if (secretKey.length < MIN_SECRET_KEY_LENGTH) {
    warn(`SECRET_KEY is shorter than ${MIN_SECRET_KEY_LENGTH} characters.`, [
      `It is ${secretKey.length}. A short key is a guessable key, and guessing it`,
      'means forging sessions. Generate a proper one:  openssl rand -hex 32',
    ]);
  }
};
