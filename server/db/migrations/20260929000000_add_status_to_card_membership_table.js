/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

exports.up = (knex) =>
  knex.schema.alterTable('card_membership', (table) => {
    table.text('status').nullable();
  });

exports.down = (knex) =>
  knex.schema.alterTable('card_membership', (table) => {
    table.dropColumn('status');
  });
