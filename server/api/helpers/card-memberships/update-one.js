/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

// Modeled on card-memberships/create-one.js's broadcast (a single
// board-room broadcast is enough here, unlike board-memberships/update-one.js's
// dual-room trick, which exists specifically because THAT update can change
// whether the target user still belongs in the board room at all -- a card
// membership's status never affects board access).

module.exports = {
  inputs: {
    record: {
      type: 'ref',
      required: true,
    },
    values: {
      type: 'json',
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
    actorUser: {
      type: 'ref',
      required: true,
    },
    request: {
      type: 'ref',
    },
  },

  async fn(inputs) {
    const { values } = inputs;

    const cardMembership = await CardMembership.qm.updateOne(inputs.record.id, values);

    if (cardMembership) {
      sails.sockets.broadcast(
        `board:${inputs.board.id}`,
        'cardMembershipUpdate',
        {
          item: cardMembership,
        },
        inputs.request,
      );

      // No CARD_MEMBERSHIP_UPDATE webhook event exists yet in this fork
      // (create-one.js sends CARD_MEMBERSHIP_CREATE; there is no update
      // counterpart) -- left out rather than guessing at an event name that
      // doesn't exist.
    }

    return cardMembership;
  },
};
