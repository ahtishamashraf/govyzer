'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'sales_displays',
  'display_pairing_codes',
  'display_sessions',
  'display_playlists',
  'display_slides',
  'display_widgets',
  'display_filters',
  'sales_events',
  'sales_event_approvals',
  'points_rules',
  'points_ledger',
  'targets',
  'announcements',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('sales_displays', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('location', 200).nullable();
    table.string('branch_id', 26).nullable().index();
    table.string('team_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('unpaired').index();
    table.string('playlist_id', 26).nullable().index();
    table.string('theme', 40).notNullable().defaultTo('midnight');
    table.json('theme_overrides').nullable();
    table.json('privacy_settings').nullable();
    table.json('filters').nullable();
    table.integer('slide_duration_seconds').notNullable().defaultTo(15);
    table.string('transition', 24).notNullable().defaultTo('fade');
    table.boolean('auto_approve_events').notNullable().defaultTo(false);
    table.string('orientation', 16).notNullable().defaultTo('landscape');
    table.datetime('paired_at').nullable();
    table.datetime('last_seen_at').nullable().index();
    table.string('app_version', 40).nullable();
    table.string('device_fingerprint', 120).nullable();
    table.datetime('revoked_at').nullable();
    table.string('revoked_by_membership_id', 26).nullable();
    table.bigInteger('feed_version').notNullable().defaultTo(1);
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'name']);
    orgFk(table);
  });

  // One-time pairing codes: hashed at rest, short lived, single use.
  await knex.schema.createTable('display_pairing_codes', (table) => {
    pk(table);
    org(table);
    table.string('display_id', 26).notNullable().index();
    table.string('code_hash', 64).notNullable().unique();
    table.string('code_prefix', 4).notNullable();
    table.datetime('expires_at').notNullable().index();
    table.datetime('consumed_at').nullable();
    table.string('consumed_by_display_session_id', 26).nullable();
    table.string('created_by_membership_id', 26).nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table.foreign('display_id').references('id').inTable('sales_displays').onDelete('CASCADE');
  });

  await knex.schema.createTable('display_sessions', (table) => {
    pk(table);
    org(table);
    table.string('display_id', 26).notNullable().index();
    table.string('token_hash', 64).notNullable().unique();
    table.string('previous_token_hash', 64).nullable();
    table.datetime('expires_at').notNullable().index();
    table.datetime('rotated_at').nullable();
    table.datetime('last_seen_at').nullable();
    table.string('ip_address', 64).nullable();
    table.string('user_agent', 300).nullable();
    table.datetime('revoked_at').nullable();
    table.string('revoked_reason', 120).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table.foreign('display_id').references('id').inTable('sales_displays').onDelete('CASCADE');
  });

  await knex.schema.createTable('display_playlists', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.text('description').nullable();
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'name']);
    orgFk(table);
  });

  await knex.schema.createTable('display_slides', (table) => {
    pk(table);
    org(table);
    table.string('playlist_id', 26).notNullable().index();
    table.string('slide_type', 40).notNullable();
    table.string('title', 200).nullable();
    table.integer('position').notNullable().defaultTo(0);
    table.integer('duration_seconds').nullable();
    table.boolean('is_enabled').notNullable().defaultTo(true);
    table.json('config').nullable();
    table.json('filters').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['playlist_id', 'position']);
    orgFk(table);
    table
      .foreign('playlist_id')
      .references('id')
      .inTable('display_playlists')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('display_widgets', (table) => {
    pk(table);
    org(table);
    table.string('slide_id', 26).notNullable().index();
    table.string('widget_type', 40).notNullable();
    table.integer('position').notNullable().defaultTo(0);
    table.json('config').nullable();
    table.boolean('is_enabled').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('slide_id').references('id').inTable('display_slides').onDelete('CASCADE');
  });

  await knex.schema.createTable('display_filters', (table) => {
    pk(table);
    org(table);
    table.string('display_id', 26).nullable().index();
    table.string('playlist_id', 26).nullable().index();
    table.string('filter_type', 40).notNullable();
    table.json('value').notNullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
  });

  await knex.schema.createTable('sales_events', (table) => {
    pk(table);
    org(table);
    table.string('event_type', 40).notNullable().index();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('source_entity_type', 40).notNullable();
    table.string('source_entity_id', 26).notNullable();
    table.string('idempotency_key', 190).notNullable();
    table.string('branch_id', 26).nullable().index();
    table.string('team_id', 26).nullable().index();
    table.string('project_id', 26).nullable();
    table.string('membership_id', 26).nullable().index();
    // Display safe projection only: never contains client PII.
    table.json('display_payload').notNullable();
    money(table, 'amount');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.integer('points_awarded').notNullable().defaultTo(0);
    table.datetime('occurred_at').notNullable().index();
    table.datetime('approved_at').nullable();
    table.string('approved_by_membership_id', 26).nullable();
    table.datetime('expires_at').nullable();
    table.datetime('reversed_at').nullable();
    table.string('reverses_event_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.unique(['organization_id', 'idempotency_key']);
    table.index(['organization_id', 'status', 'occurred_at']);
    orgFk(table);
  });

  await knex.schema.createTable('sales_event_approvals', (table) => {
    pk(table);
    org(table);
    table.string('sales_event_id', 26).notNullable().index();
    table.string('status', 24).notNullable().defaultTo('pending');
    table.string('decided_by_membership_id', 26).nullable();
    table.datetime('decided_at').nullable();
    table.string('decision_reason', 500).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table
      .foreign('sales_event_id')
      .references('id')
      .inTable('sales_events')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('points_rules', (table) => {
    pk(table);
    org(table);
    table.string('code', 60).notNullable();
    table.string('name', 160).notNullable();
    table.string('event_type', 40).notNullable().index();
    table.integer('points').notNullable().defaultTo(0);
    table.string('calculation', 24).notNullable().defaultTo('fixed');
    table.decimal('points_per_amount', 12, 4).nullable();
    table.json('conditions').nullable();
    table.integer('version_number').notNullable().defaultTo(1);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.date('effective_from').nullable();
    table.date('effective_to').nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  // Append-only ledger. Leaderboards are always recomputed from these rows.
  await knex.schema.createTable('points_ledger', (table) => {
    pk(table);
    org(table);
    table.string('membership_id', 26).notNullable().index();
    table.string('team_id', 26).nullable().index();
    table.string('branch_id', 26).nullable().index();
    table.string('rule_id', 26).nullable();
    table.string('rule_code', 60).nullable();
    table.integer('rule_version').nullable();
    table.string('event_type', 40).notNullable();
    table.string('source_entity_type', 40).notNullable();
    table.string('source_entity_id', 26).notNullable();
    table.string('sales_event_id', 26).nullable();
    table.integer('points').notNullable();
    table.string('idempotency_key', 190).notNullable();
    table.string('reverses_entry_id', 26).nullable();
    table.datetime('occurred_at').notNullable().index();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['organization_id', 'idempotency_key']);
    table.index(['organization_id', 'membership_id', 'occurred_at']);
    orgFk(table);
  });

  await knex.schema.createTable('targets', (table) => {
    pk(table);
    org(table);
    table.string('target_type', 30).notNullable();
    table.string('scope_type', 24).notNullable();
    table.string('scope_id', 26).nullable().index();
    table.string('period_type', 16).notNullable().defaultTo('month');
    table.date('period_start').notNullable().index();
    table.date('period_end').notNullable();
    money(table, 'target_value', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('module', 16).nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'target_type', 'scope_type', 'scope_id', 'period_start'], { indexName: 'targets_scope_period_unique' });
    orgFk(table);
  });

  await knex.schema.createTable('announcements', (table) => {
    pk(table);
    org(table);
    table.string('title', 200).notNullable();
    table.text('body').nullable();
    table.string('announcement_type', 24).notNullable().defaultTo('message');
    table.string('media_asset_id', 26).nullable();
    table.string('media_url', 512).nullable();
    table.json('display_ids').nullable();
    table.string('status', 24).notNullable().defaultTo('scheduled').index();
    table.integer('priority').notNullable().defaultTo(100);
    table.datetime('starts_at').notNullable().index();
    table.datetime('ends_at').nullable();
    table.integer('duration_seconds').notNullable().defaultTo(12);
    actors(table);
    timestamps(table);
    orgFk(table);
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
