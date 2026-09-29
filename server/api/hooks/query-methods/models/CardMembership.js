/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const defaultFind = (criteria) => CardMembership.find(criteria).sort('id');

/* Query methods */

const create = (arrayOfValues) => CardMembership.createEach(arrayOfValues).fetch();

const createOne = (values) => CardMembership.create({ ...values }).fetch();

const getByIds = (ids) => defaultFind(ids);

const getOneById = (id) => CardMembership.findOne(id);

const getByCardId = (cardId, { userIdOrIds } = {}) => {
  const criteria = {
    cardId,
  };
  if (userIdOrIds) {
    criteria.userId = userIdOrIds;
  }

  return defaultFind(criteria);
};

const getByCardIds = (cardIds) =>
  defaultFind({
    cardId: cardIds,
  });

const getOneByCardIdAndUserId = (cardId, userId) =>
  CardMembership.findOne({
    cardId,
    userId,
  });

const updateOne = (id, values) => CardMembership.updateOne(id).set(values);

// eslint-disable-next-line no-underscore-dangle
const delete_ = (criteria) => CardMembership.destroy(criteria).fetch();

const deleteOne = (criteria) => CardMembership.destroyOne(criteria);

module.exports = {
  create,
  createOne,
  getByIds,
  getOneById,
  getByCardId,
  getByCardIds,
  getOneByCardIdAndUserId,
  updateOne,
  deleteOne,
  delete: delete_,
};
