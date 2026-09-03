'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'listings',
  'listing_versions',
  'listing_agents',
  'listing_approvals',
  'listing_permits',
  'listing_price_history',
  'listing_availability_history',
  'portal_providers',
  'portal_accounts',
  'portal_field_mappings',
  'portal_publications',
  'portal_sync_jobs',
  'portal_sync_logs',
  'portal_raw_payloads',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('listings', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('unit_id', 26).nullable().index();
    table.string('module', 16).notNullable().defaultTo('ready');
    table.string('offering_type', 16).notNullable().defaultTo('sale').index();
    table.string('property_category', 16).notNullable().defaultTo('residential');
    table.string('property_type', 40).notNullable().defaultTo('apartment').index();
    table.string('title', 250).notNullable();
    table.string('title_ar', 250).nullable();
    table.text('description').nullable();
    table.text('description_ar').nullable();
    table.string('status', 30).notNullable().defaultTo('draft').index();
    table.string('previous_status', 30).nullable();

    table.string('city_id', 26).nullable().index();
    table.string('community_id', 26).nullable().index();
    table.string('subcommunity_id', 26).nullable();
    table.string('building_id', 26).nullable().index();
    table.string('address_line', 300).nullable();
    table.boolean('hide_exact_address').notNullable().defaultTo(false);
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();

    money(table, 'price');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('rent_frequency', 20).nullable();
    money(table, 'service_charge');
    table.integer('cheques_allowed').nullable();
    table.boolean('price_on_application').notNullable().defaultTo(false);

    table.integer('bedrooms').nullable().index();
    table.decimal('bathrooms', 4, 1).nullable();
    table.decimal('built_up_area', 12, 2).nullable();
    table.decimal('plot_area', 12, 2).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.integer('parking_spaces').nullable();
    table.string('furnishing', 24).nullable();
    table.string('view', 120).nullable();
    table.integer('floor_number').nullable();
    table.integer('total_floors').nullable();
    table.integer('completion_year').nullable();

    table.string('occupancy_status', 24).notNullable().defaultTo('vacant');
    table.date('available_from').nullable();
    table.boolean('is_exclusive').notNullable().defaultTo(false);
    table.date('exclusive_until').nullable();
    table.string('owner_contact_id', 26).nullable().index();
    table.string('landlord_contact_id', 26).nullable();
    table.string('listing_admin_membership_id', 26).nullable();
    table.string('primary_agent_membership_id', 26).nullable().index();
    table.string('fallback_membership_id', 26).nullable();
    table.string('fallback_team_id', 26).nullable();
    table.string('manager_membership_id', 26).nullable();
    table.string('branch_id', 26).nullable().index();

    table.string('permit_number', 80).nullable().index();
    table.date('permit_issued_on').nullable();
    table.date('permit_expires_on').nullable().index();
    table.string('dld_permit_qr_url', 512).nullable();

    table.boolean('is_featured').notNullable().defaultTo(false);
    table.boolean('is_verified').notNullable().defaultTo(false);
    table.datetime('verified_at').nullable();
    table.datetime('published_at').nullable();
    table.datetime('expires_at').nullable().index();
    table.datetime('last_portal_sync_at').nullable();
    table.string('duplicate_of_listing_id', 26).nullable().index();
    table.string('duplicate_signature', 64).nullable().index();
    table.integer('view_count').notNullable().defaultTo(0);
    table.integer('lead_count').notNullable().defaultTo(0);
    table.json('portal_settings').nullable();
    table.json('attributes').nullable();

    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.index(['organization_id', 'status', 'offering_type']);
    table.index(['organization_id', 'community_id', 'property_type']);
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('SET NULL');
    table.foreign('owner_contact_id').references('id').inTable('contacts').onDelete('SET NULL');
  });

  await knex.schema.createTable('listing_versions', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.integer('version_number').notNullable();
    table.json('snapshot').notNullable();
    table.string('change_summary', 400).nullable();
    table.string('created_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['listing_id', 'version_number']);
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  await knex.schema.createTable('listing_agents', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.string('membership_id', 26).notNullable().index();
    table.string('agent_role', 24).notNullable().defaultTo('primary');
    table.decimal('commission_share', 6, 3).nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    table.unique(['listing_id', 'membership_id', 'agent_role']);
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  await knex.schema.createTable('listing_approvals', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.string('step', 40).notNullable().defaultTo('internal_review');
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('requested_by_membership_id', 26).nullable();
    table.string('decided_by_membership_id', 26).nullable();
    table.datetime('decided_at').nullable();
    table.string('decision_reason', 500).nullable();
    table.json('checklist').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  await knex.schema.createTable('listing_permits', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.string('authority', 40).notNullable().defaultTo('dld');
    table.string('permit_type', 40).notNullable().defaultTo('trakheesi');
    table.string('permit_number', 80).notNullable();
    table.date('issued_on').nullable();
    table.date('expires_on').nullable().index();
    table.string('status', 24).notNullable().defaultTo('active');
    table.string('document_media_id', 26).nullable();
    timestamps(table);
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  await knex.schema.createTable('listing_price_history', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    money(table, 'old_price');
    money(table, 'new_price', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('rent_frequency', 20).nullable();
    table.string('reason', 240).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  await knex.schema.createTable('listing_availability_history', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.string('from_status', 30).nullable();
    table.string('to_status', 30).notNullable();
    table.string('reason', 240).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
  });

  // Portal catalogue is platform data; accounts and mappings are tenant data.
  await knex.schema.createTable('portal_providers', (table) => {
    pk(table);
    table.string('code', 40).notNullable().unique();
    table.string('name', 120).notNullable();
    table.string('country', 2).notNullable().defaultTo('AE');
    table.string('transport', 24).notNullable().defaultTo('feed');
    table.string('status', 24).notNullable().defaultTo('available');
    table.json('capabilities').nullable();
    table.json('credential_schema').nullable();
    table.json('required_fields').nullable();
    table.string('documentation_url', 512).nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
  });

  await knex.schema.createTable('portal_accounts', (table) => {
    pk(table);
    org(table);
    table.string('provider_code', 40).notNullable().index();
    table.string('name', 160).notNullable();
    table.string('external_account_id', 190).nullable();
    table.string('status', 24).notNullable().defaultTo('disconnected').index();
    table.string('health_status', 24).notNullable().defaultTo('unknown');
    table.string('health_message', 500).nullable();
    table.datetime('last_checked_at').nullable();
    table.datetime('last_success_at').nullable();
    table.string('integration_connection_id', 26).nullable();
    table.json('settings').nullable();
    table.json('capabilities_snapshot').nullable();
    table.integer('listing_quota').nullable();
    table.integer('listing_used').notNullable().defaultTo(0);
    table.boolean('auto_publish').notNullable().defaultTo(false);
    table.boolean('is_enabled').notNullable().defaultTo(false);
    table.string('feed_token', 64).nullable().index();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'provider_code', 'name']);
    orgFk(table);
  });

  await knex.schema.createTable('portal_field_mappings', (table) => {
    pk(table);
    org(table);
    table.string('portal_account_id', 26).notNullable().index();
    table.string('mapping_type', 40).notNullable();
    table.string('internal_value', 190).notNullable();
    table.string('provider_value', 190).notNullable();
    table.json('metadata').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['portal_account_id', 'mapping_type', 'internal_value'], { indexName: 'portal_mappings_account_type_value_unique' });
    orgFk(table);
    table
      .foreign('portal_account_id')
      .references('id')
      .inTable('portal_accounts')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('portal_publications', (table) => {
    pk(table);
    org(table);
    table.string('listing_id', 26).notNullable().index();
    table.string('portal_account_id', 26).notNullable().index();
    table.string('provider_code', 40).notNullable().index();
    table.string('status', 30).notNullable().defaultTo('pending').index();
    table.string('external_listing_id', 190).nullable();
    table.string('external_url', 512).nullable();
    table.string('last_error_code', 80).nullable();
    table.string('last_error_message', 1000).nullable();
    table.json('validation_errors').nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.datetime('requested_at').nullable();
    table.datetime('published_at').nullable();
    table.datetime('unpublished_at').nullable();
    table.datetime('last_synced_at').nullable();
    table.string('content_hash', 64).nullable();
    table.json('provider_payload_snapshot').nullable();
    version(table);
    timestamps(table);
    table.unique(['listing_id', 'portal_account_id']);
    orgFk(table);
    table.foreign('listing_id').references('id').inTable('listings').onDelete('CASCADE');
    table
      .foreign('portal_account_id')
      .references('id')
      .inTable('portal_accounts')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('portal_sync_jobs', (table) => {
    pk(table);
    org(table);
    table.string('portal_account_id', 26).notNullable().index();
    table.string('publication_id', 26).nullable().index();
    table.string('operation', 40).notNullable();
    table.string('status', 24).notNullable().defaultTo('queued').index();
    table.integer('attempts').notNullable().defaultTo(0);
    table.integer('max_attempts').notNullable().defaultTo(5);
    table.datetime('run_after').notNullable().defaultTo(knex.fn.now()).index();
    table.datetime('started_at').nullable();
    table.datetime('finished_at').nullable();
    table.string('idempotency_key', 190).nullable();
    table.json('payload').nullable();
    table.string('last_error', 1000).nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'idempotency_key']);
    orgFk(table);
  });

  await knex.schema.createTable('portal_sync_logs', (table) => {
    pk(table);
    org(table);
    table.string('portal_account_id', 26).notNullable().index();
    table.string('publication_id', 26).nullable().index();
    table.string('operation', 40).notNullable();
    table.string('result', 24).notNullable();
    table.integer('http_status').nullable();
    table.string('provider_correlation_id', 190).nullable();
    table.string('request_id', 40).nullable();
    table.integer('duration_ms').nullable();
    table.string('message', 1000).nullable();
    table.json('normalized_errors').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
  });

  await knex.schema.createTable('portal_raw_payloads', (table) => {
    pk(table);
    org(table);
    table.string('portal_account_id', 26).nullable().index();
    table.string('provider_code', 40).notNullable();
    table.string('direction', 12).notNullable();
    table.string('operation', 40).nullable();
    table.string('reference_type', 40).nullable();
    table.string('reference_id', 26).nullable();
    table.json('headers').nullable();
    table.text('body', 'longtext').nullable();
    table.string('content_type', 120).nullable();
    table.datetime('expires_at').nullable().index();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
