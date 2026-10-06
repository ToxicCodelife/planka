/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

/**
 * @swagger
 * /card-memberships/{id}:
 *   patch:
 *     summary: Update card membership
 *     description: Updates a card membership's personal status. A member may only update their own.
 *     tags:
 *       - Card Memberships
 *     operationId: updateCardMembership
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: ID of the card membership to update
 *         schema:
 *           type: string
 *           example: "1357158568008091264"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [want, have, done]
 *                 nullable: true
 *                 description: This member's personal status for the card's game
 *                 example: want
 *     responses:
 *       200:
 *         description: Card membership updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - item
 *               properties:
 *                 item:
 *                   $ref: '#/components/schemas/CardMembership'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */

const { idInput } = require('../../../utils/inputs');

const Errors = {
  NOT_ENOUGH_RIGHTS: {
    notEnoughRights: 'Not enough rights',
  },
  CARD_MEMBERSHIP_NOT_FOUND: {
    cardMembershipNotFound: 'Card membership not found',
  },
};

module.exports = {
  inputs: {
    id: {
      ...idInput,
      required: true,
    },
    status: {
      type: 'string',
      isIn: Object.values(CardMembership.Statuses),
      allowNull: true,
    },
  },

  exits: {
    notEnoughRights: {
      responseType: 'forbidden',
    },
    cardMembershipNotFound: {
      responseType: 'notFound',
    },
  },

  async fn(inputs) {
    const { currentUser } = this.req;

    const cardMembership = await CardMembership.qm.getOneById(inputs.id);

    if (!cardMembership) {
      throw Errors.CARD_MEMBERSHIP_NOT_FOUND;
    }

    const { card, list, board, project } = await sails.helpers.cards
      .getPathToProjectById(cardMembership.cardId)
      .intercept('pathNotFound', () => Errors.CARD_MEMBERSHIP_NOT_FOUND);

    const boardMembership = await BoardMembership.qm.getOneByBoardIdAndUserId(
      board.id,
      currentUser.id,
    );

    if (!boardMembership) {
      throw Errors.CARD_MEMBERSHIP_NOT_FOUND; // Forbidden
    }

    // Each member's status is personal -- only that member, or a global
    // admin, may change it. Not any other board member who happens to
    // click their label.
    const isAdmin = currentUser.role === User.Roles.ADMIN;

    if (cardMembership.userId !== currentUser.id && !isAdmin) {
      throw Errors.NOT_ENOUGH_RIGHTS;
    }

    const values = _.pick(inputs, ['status']);

    const updatedCardMembership = await sails.helpers.cardMemberships.updateOne.with({
      values,
      project,
      board,
      list,
      record: cardMembership,
      actorUser: currentUser,
      request: this.req,
    });

    if (!updatedCardMembership) {
      throw Errors.CARD_MEMBERSHIP_NOT_FOUND;
    }

    // If this update just marked the last remaining member as "done", move
    // the card into the board's Archive list automatically.
    if (
      updatedCardMembership.status === CardMembership.Statuses.DONE &&
      list.type !== List.Types.ARCHIVE
    ) {
      const allMemberships = await CardMembership.qm.getByCardId(card.id);

      const allDone =
        allMemberships.length > 0 &&
        allMemberships.every((membership) => membership.status === CardMembership.Statuses.DONE);

      if (allDone) {
        const archiveList = await List.qm.getOneArchiveByBoardId(board.id);

        if (archiveList) {
          // NOTICE: 'request' is intentionally left out here. Passing it
          // would exclude the current browser from the real-time broadcast
          // (normally fine, since that browser gets the result straight
          // back from its own request) -- but this move is a side effect of
          // the status-update request, not a move request, so the response
          // to this call never mentions it. Leaving 'request' out makes
          // sure everyone, including whoever just finished the card,
          // actually sees it jump to Archive without needing a refresh.
          await sails.helpers.cards.updateOne.with({
            project,
            board,
            list,
            record: card,
            values: {
              list: archiveList,
            },
            actorUser: currentUser,
          });
        }
      }
    }

    return {
      item: updatedCardMembership,
    };
  },
};
