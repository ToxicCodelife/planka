module.exports = {
  attributes: {
    list: {
      model: 'list',
      required: true,
    },
    creatorUser: {
      model: 'user',
      required: true,
    },
    coverAttachmentId: {
      type: 'string',
      allowNull: true,
    },
    name: {
      type: 'string',
      required: true,
    },
    description: {
      type: 'string',
      allowNull: true,
    },
    actions: {
      collection: 'action',
      via: 'cardId',
    },
  },

  afterCreate(newlyCreatedRecord, proceed) {
    Card.findOne({ id: newlyCreatedRecord.id })
      .populate('list')
      .then((card) => {
        if (!card || !card.list) {
          return proceed();
        }

        return Board.findOne({ id: card.list.boardId }).then((board) => {
          if (!board) {
            return proceed();
          }

          return Project.findOne({ id: board.projectId }).then((project) => {
            if (!project) {
              return proceed();
            }

            sails.helpers.cards.attachIgdbCover
              .with({
                card,
                project,
                board,
                list: card.list,
                creatorUser: newlyCreatedRecord.creatorUserId || 1,
              })
              .exec((err) => {
                if (err) {
                  sails.log.error(`[IGDB LINK ERROR] Hook failed: ${err.message}`);
                }
              });

            return proceed();
          });
        });
      })
      .catch((err) => {
        sails.log.error(`[IGDB LINK ERROR] Failed gathering model data: ${err.message}`);
        return proceed();
      });
  },
};
