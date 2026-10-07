/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

exports.up = (knex) =>
  knex.schema.alterTable('user_account', (table) => {
    table.text('true_achievements_username').nullable();
  });

exports.down = (knex) =>
  knex.schema.alterTable('user_account', (table) => {
    table.dropColumn('true_achievements_username');
  });
