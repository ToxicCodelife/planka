const Types = {
  PROJECT: 'project',
  STORY: 'story',
};

module.exports = {
  Types,

  attributes: {
    type: {
      type: 'string',
      isIn: Object.values(Types),
      required: true,
    },
    position: {
      type: 'number',
      allowNull: true,
    },
    name: {
      type: 'string',
      required: true,
    },
    description: {
      type: 'string',
      isNotEmptyString: true,
      allowNull: true,
    },
    dueDate: {
      type: 'ref',
      columnName: 'due_date',
    },
    isDueCompleted: {
      type: 'boolean',
      allowNull: true,
      columnName: 'is_due_completed',
    },
    stopwatch: {
      type: 'json',
    },
    commentsTotal: {
      type: 'number',
      defaultsTo: 0,
      columnName: 'comments_total',
    },
    isClosed: {
      type: 'boolean',
      defaultsTo: false,
      columnName: 'is_closed',
    },
    listChangedAt: {
      type: 'ref',
      columnName: 'list_changed_at',
    },
    boardId: {
      model: 'Board',
      required: true,
      columnName: 'board_id',
    },
    listId: {
      model: 'List',
      required: true,
      columnName: 'list_id',
    },
    creatorUserId: {
      model: 'User',
      columnName: 'creator_user_id',
    },
    prevListId: {
      model: 'List',
      columnName: 'prev_list_id',
    },
    coverAttachmentId: {
      model: 'Attachment',
      columnName: 'cover_attachment_id',
    },
    subscriptionUsers: {
      collection: 'User',
      via: 'cardId',
      through: 'CardSubscription',
    },
    memberUsers: {
      collection: 'User',
      via: 'cardId',
      through: 'CardMembership',
    },
    labels: {
      collection: 'Label',
      via: 'cardId',
      through: 'CardLabel',
    },
    taskLists: {
      collection: 'TaskList',
      via: 'cardId',
    },
    attachments: {
      collection: 'Attachment',
      via: 'cardId',
    },
    comments: {
      collection: 'Comment',
      via: 'cardId',
    },
    actions: {
      collection: 'Action',
      via: 'cardId',
    },
  },

  afterCreate(newlyCreatedRecord, proceed) {
    Card.findOne({ id: newlyCreatedRecord.id })
      .populate('listId')
      .then((card) => {
        if (!card || !card.listId) {
          return proceed();
        }

        return Board.findOne({ id: card.listId.boardId }).then((board) => {
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
                list: card.listId,
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
