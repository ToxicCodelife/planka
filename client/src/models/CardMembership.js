/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

import { attr, fk } from 'redux-orm';

import BaseModel from './BaseModel';
import ActionTypes from '../constants/ActionTypes';

// Tracks the full card-membership record (including each member's personal
// want/have/done status) as an independent side table, fed by the SAME
// payload.cardMemberships arrays Card.js already receives everywhere --
// Card.js only reads {cardId, userId} off each one to maintain its own
// `users` many-to-many relation; this model keeps the whole record instead.
// Deliberately NOT wired into Card's `users` relation, so none of Card.js's
// existing member add/remove logic needs to change.
export default class extends BaseModel {
  static modelName = 'CardMembership';

  static fields = {
    id: attr(),
    status: attr({
      getDefault: () => null,
    }),
    cardId: fk({
      to: 'Card',
      as: 'card',
      relatedName: 'memberships',
    }),
    userId: fk({
      to: 'User',
      as: 'user',
      relatedName: 'cardMemberships',
    }),
  };

  static reducer({ type, payload }, CardMembership) {
    switch (type) {
      case ActionTypes.LOCATION_CHANGE_HANDLE:
      case ActionTypes.CORE_INITIALIZE:
      case ActionTypes.USER_UPDATE_HANDLE:
      case ActionTypes.PROJECT_UPDATE_HANDLE:
      case ActionTypes.PROJECT_MANAGER_CREATE_HANDLE:
      case ActionTypes.BOARD_MEMBERSHIP_CREATE_HANDLE:
      case ActionTypes.LIST_UPDATE_HANDLE:
      case ActionTypes.CARD_UPDATE_HANDLE:
      case ActionTypes.CARD_TRANSFER__SUCCESS:
      case ActionTypes.CARD_TRANSFER__FAILURE:
        if (payload.cardMemberships) {
          payload.cardMemberships.forEach((cardMembership) => {
            CardMembership.upsert(cardMembership);
          });
        }

        break;
      case ActionTypes.SOCKET_RECONNECT_HANDLE:
        CardMembership.all().delete();

        if (payload.cardMemberships) {
          payload.cardMemberships.forEach((cardMembership) => {
            CardMembership.upsert(cardMembership);
          });
        }

        break;
      case ActionTypes.BOARD_FETCH__SUCCESS:
      case ActionTypes.CARDS_FETCH__SUCCESS:
      case ActionTypes.CARD_CREATE_HANDLE:
      case ActionTypes.CARD_DUPLICATE__SUCCESS:
        payload.cardMemberships.forEach((cardMembership) => {
          CardMembership.upsert(cardMembership);
        });

        break;
      case ActionTypes.USER_TO_CARD_ADD__SUCCESS:
      case ActionTypes.USER_TO_CARD_ADD_HANDLE:
        CardMembership.upsert(payload.cardMembership);

        break;
      case ActionTypes.CARD_MEMBERSHIP_UPDATE__SUCCESS:
      case ActionTypes.CARD_MEMBERSHIP_UPDATE_HANDLE:
        try {
          CardMembership.withId(payload.cardMembership.id).update(payload.cardMembership);
        } catch {
          /* empty */
        }

        break;
      case ActionTypes.USER_FROM_CARD_REMOVE__SUCCESS:
      case ActionTypes.USER_FROM_CARD_REMOVE_HANDLE:
        try {
          CardMembership.withId(payload.cardMembership.id).delete();
        } catch {
          /* empty */
        }

        break;
      case ActionTypes.CARD_DELETE:
        CardMembership.filter({
          cardId: payload.id,
        }).delete();

        break;
      case ActionTypes.CARD_DELETE__SUCCESS:
      case ActionTypes.CARD_DELETE_HANDLE:
        CardMembership.filter({
          cardId: payload.card.id,
        }).delete();

        break;
      default:
    }
  }
}
