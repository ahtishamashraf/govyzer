'use strict';

/**
 * Foreign keys that could not be declared earlier because the referenced tables are
 * created by later migrations (leads -> listings/projects/units/deals and friends).
 */
const FOREIGN_KEYS = [
  ['leads', 'listing_id', 'listings', 'SET NULL'],
  ['leads', 'project_id', 'projects', 'SET NULL'],
  ['leads', 'unit_id', 'units', 'SET NULL'],
  ['leads', 'deal_id', 'deals', 'SET NULL'],
  ['contacts', 'source_id', 'lead_sources', 'SET NULL'],
  ['campaigns', 'project_id', 'projects', 'SET NULL'],
  ['meetings', 'project_id', 'projects', 'SET NULL'],
  ['viewings', 'listing_id', 'listings', 'SET NULL'],
  ['viewings', 'unit_id', 'units', 'SET NULL'],
  ['units', 'payment_plan_id', 'project_payment_plans', 'SET NULL'],
  ['reservations', 'payment_plan_id', 'project_payment_plans', 'SET NULL'],
  ['reservations', 'deal_id', 'deals', 'SET NULL'],
  ['reservations', 'lead_id', 'leads', 'SET NULL'],
  ['sales_displays', 'playlist_id', 'display_playlists', 'SET NULL'],
  ['sales_events', 'project_id', 'projects', 'SET NULL'],
];

exports.up = async function up(knex) {
  for (const [table, column, referenced, onDelete] of FOREIGN_KEYS) {
    await knex.schema.alterTable(table, (builder) => {
      builder
        .foreign(column, `${table}_${column}_fk`)
        .references('id')
        .inTable(referenced)
        .onDelete(onDelete);
    });
  }
};

exports.down = async function down(knex) {
  for (const [table, column] of FOREIGN_KEYS) {
    await knex.schema.alterTable(table, (builder) => {
      builder.dropForeign(column, `${table}_${column}_fk`);
    });
  }
};
