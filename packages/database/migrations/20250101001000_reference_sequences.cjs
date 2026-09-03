'use strict';

exports.up = async function up(knex) {
  await knex.schema.createTable('reference_sequences', (table) => {
    table.string('organization_id', 26).notNullable();
    table.string('entity', 40).notNullable();
    table.string('period', 8).notNullable().defaultTo('');
    table.bigInteger('current_value').notNullable().defaultTo(0);
    table.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['organization_id', 'entity', 'period']);
    table
      .foreign('organization_id')
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reference_sequences');
};
