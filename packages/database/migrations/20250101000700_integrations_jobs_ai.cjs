'use strict';

const { pk, org, timestamps, actors, money, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'integration_connections',
  'integration_credentials',
  'oauth_states',
  'webhook_endpoints',
  'webhook_receipts',
  'webhook_deliveries',
  'outbox_events',
  'jobs',
  'job_attempts',
  'dead_letter_jobs',
  'idempotency_keys',
  'rate_limit_buckets',
  'workflow_definitions',
  'workflow_versions',
  'workflow_runs',
  'workflow_action_runs',
  'ai_requests',
  'ai_usage_ledger',
  'ai_artifacts',
  'ai_feedback',
  'saved_views',
  'report_definitions',
  'report_schedules',
  'data_exports',
  'data_deletion_requests',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('integration_connections', (table) => {
    pk(table);
    org(table);
    table.string('provider', 60).notNullable().index();
    table.string('category', 40).notNullable().defaultTo('portal');
    table.string('name', 160).notNullable();
    table.string('status', 24).notNullable().defaultTo('disconnected').index();
    table.string('health_status', 24).notNullable().defaultTo('unknown');
    table.string('health_message', 500).nullable();
    table.string('membership_id', 26).nullable().index();
    table.string('external_account_id', 190).nullable();
    table.json('settings').nullable();
    table.json('capabilities').nullable();
    table.json('scopes').nullable();
    table.datetime('connected_at').nullable();
    table.datetime('last_checked_at').nullable();
    table.datetime('last_success_at').nullable();
    table.datetime('last_error_at').nullable();
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.boolean('is_enabled').notNullable().defaultTo(false);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'provider', 'name']);
    orgFk(table);
  });

  // Ciphertext only: AES-256-GCM with a versioned key id, never a plaintext secret.
  await knex.schema.createTable('integration_credentials', (table) => {
    pk(table);
    org(table);
    table.string('connection_id', 26).notNullable().index();
    table.string('credential_type', 40).notNullable().defaultTo('api_key');
    table.string('key_version', 12).notNullable();
    table.text('ciphertext', 'longtext').notNullable();
    table.string('iv', 32).notNullable();
    table.string('auth_tag', 32).notNullable();
    table.datetime('expires_at').nullable();
    table.datetime('rotated_at').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['connection_id', 'credential_type']);
    orgFk(table);
    table
      .foreign('connection_id')
      .references('id')
      .inTable('integration_connections')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('oauth_states', (table) => {
    pk(table);
    org(table);
    table.string('provider', 60).notNullable();
    table.string('state_hash', 64).notNullable().unique();
    table.string('code_verifier_encrypted', 512).nullable();
    table.string('membership_id', 26).nullable();
    table.string('redirect_uri', 512).nullable();
    table.json('metadata').nullable();
    table.datetime('expires_at').notNullable();
    table.datetime('consumed_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
  });

  await knex.schema.createTable('webhook_endpoints', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('target_url', 512).notNullable();
    table.json('event_types').notNullable();
    table.string('secret_key_version', 12).nullable();
    table.text('secret_ciphertext').nullable();
    table.string('secret_iv', 32).nullable();
    table.string('secret_auth_tag', 32).nullable();
    table.string('status', 24).notNullable().defaultTo('active').index();
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.datetime('last_delivery_at').nullable();
    table.datetime('disabled_at').nullable();
    actors(table);
    timestamps(table);
    orgFk(table);
  });

  // Inbound webhook receipts: acknowledge fast, store raw, process asynchronously.
  await knex.schema.createTable('webhook_receipts', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('provider', 60).notNullable().index();
    table.string('event_type', 80).nullable();
    table.string('external_event_id', 190).nullable();
    table.string('idempotency_key', 190).notNullable();
    table.string('signature_status', 24).notNullable().defaultTo('unverified');
    table.json('headers').nullable();
    table.text('body', 'longtext').nullable();
    table.string('status', 24).notNullable().defaultTo('received').index();
    table.integer('attempts').notNullable().defaultTo(0);
    table.string('last_error', 1000).nullable();
    table.datetime('processed_at').nullable();
    table.string('request_id', 40).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.unique(['provider', 'idempotency_key']);
  });

  await knex.schema.createTable('webhook_deliveries', (table) => {
    pk(table);
    org(table);
    table.string('endpoint_id', 26).notNullable().index();
    table.string('outbox_event_id', 26).nullable().index();
    table.string('event_type', 80).notNullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.integer('attempts').notNullable().defaultTo(0);
    table.integer('max_attempts').notNullable().defaultTo(6);
    table.datetime('run_after').notNullable().defaultTo(knex.fn.now()).index();
    table.integer('response_status').nullable();
    table.string('response_body', 2000).nullable();
    table.integer('duration_ms').nullable();
    table.json('payload').notNullable();
    table.string('last_error', 1000).nullable();
    table.datetime('delivered_at').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table
      .foreign('endpoint_id')
      .references('id')
      .inTable('webhook_endpoints')
      .onDelete('CASCADE');
  });

  // Transactional outbox: written in the same transaction as the business change.
  await knex.schema.createTable('outbox_events', (table) => {
    pk(table);
    org(table);
    table.string('event_type', 80).notNullable().index();
    table.string('aggregate_type', 60).notNullable();
    table.string('aggregate_id', 26).notNullable();
    table.json('payload').notNullable();
    table.json('metadata').nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.integer('attempts').notNullable().defaultTo(0);
    table.datetime('available_at').notNullable().defaultTo(knex.fn.now()).index();
    table.datetime('processed_at').nullable();
    table.string('locked_by', 40).nullable();
    table.datetime('locked_until').nullable().index();
    table.string('last_error', 1000).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.index(['organization_id', 'aggregate_type', 'aggregate_id']);
    orgFk(table);
  });

  await knex.schema.createTable('jobs', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('queue', 40).notNullable().defaultTo('default').index();
    table.string('job_type', 80).notNullable().index();
    table.json('payload').notNullable();
    table.string('status', 24).notNullable().defaultTo('queued').index();
    table.integer('priority').notNullable().defaultTo(100);
    table.integer('attempts').notNullable().defaultTo(0);
    table.integer('max_attempts').notNullable().defaultTo(5);
    table.datetime('run_after').notNullable().defaultTo(knex.fn.now()).index();
    table.string('locked_by', 40).nullable();
    table.datetime('locked_until').nullable().index();
    table.datetime('started_at').nullable();
    table.datetime('finished_at').nullable();
    table.string('idempotency_key', 190).nullable();
    table.string('last_error', 1000).nullable();
    table.string('dedupe_key', 190).nullable();
    timestamps(table, { softDelete: false });
    table.unique(['queue', 'dedupe_key']);
    table.index(['status', 'run_after', 'priority']);
  });

  await knex.schema.createTable('job_attempts', (table) => {
    pk(table);
    table.string('job_id', 26).notNullable().index();
    table.integer('attempt_number').notNullable();
    table.string('status', 24).notNullable();
    table.integer('duration_ms').nullable();
    table.string('worker_id', 40).nullable();
    table.string('error_message', 1000).nullable();
    table.text('error_stack').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE');
  });

  await knex.schema.createTable('dead_letter_jobs', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('origin', 24).notNullable().defaultTo('job');
    table.string('origin_id', 26).nullable();
    table.string('queue', 40).nullable();
    table.string('job_type', 80).notNullable().index();
    table.json('payload').notNullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.string('last_error', 2000).nullable();
    table.string('status', 24).notNullable().defaultTo('open').index();
    table.string('resolved_by_membership_id', 26).nullable();
    table.datetime('resolved_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
  });

  await knex.schema.createTable('idempotency_keys', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('scope', 60).notNullable();
    table.string('idempotency_key', 190).notNullable();
    table.string('request_hash', 64).notNullable();
    table.string('status', 20).notNullable().defaultTo('in_progress');
    table.integer('response_status').nullable();
    table.json('response_body').nullable();
    table.datetime('expires_at').notNullable().index();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['organization_id', 'scope', 'idempotency_key']);
  });

  await knex.schema.createTable('rate_limit_buckets', (table) => {
    table.string('bucket_key', 190).notNullable().primary();
    table.integer('hits').notNullable().defaultTo(0);
    table.datetime('window_started_at').notNullable();
    table.datetime('expires_at').notNullable().index();
  });

  await knex.schema.createTable('workflow_definitions', (table) => {
    pk(table);
    org(table);
    table.string('name', 180).notNullable();
    table.string('code', 60).notNullable();
    table.text('description').nullable();
    table.string('trigger_type', 60).notNullable().index();
    table.string('entity_type', 40).nullable();
    table.string('status', 24).notNullable().defaultTo('draft').index();
    table.string('current_version_id', 26).nullable();
    table.integer('max_runs_per_entity_per_day').notNullable().defaultTo(20);
    table.boolean('is_enabled').notNullable().defaultTo(false);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('workflow_versions', (table) => {
    pk(table);
    org(table);
    table.string('workflow_id', 26).notNullable().index();
    table.integer('version_number').notNullable();
    table.json('trigger_config').notNullable();
    table.json('conditions').nullable();
    table.json('actions').notNullable();
    table.string('status', 24).notNullable().defaultTo('draft');
    table.string('published_by_membership_id', 26).nullable();
    table.datetime('published_at').nullable();
    table.string('change_note', 500).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['workflow_id', 'version_number']);
    orgFk(table);
    table
      .foreign('workflow_id')
      .references('id')
      .inTable('workflow_definitions')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('workflow_runs', (table) => {
    pk(table);
    org(table);
    table.string('workflow_id', 26).notNullable().index();
    table.string('workflow_version_id', 26).notNullable();
    table.integer('version_number').notNullable();
    table.string('trigger_type', 60).notNullable();
    table.string('entity_type', 40).nullable();
    table.string('entity_id', 26).nullable().index();
    table.string('status', 24).notNullable().defaultTo('running').index();
    table.string('idempotency_key', 190).nullable();
    table.integer('depth').notNullable().defaultTo(0);
    table.string('parent_run_id', 26).nullable();
    table.json('trigger_payload').nullable();
    table.json('condition_result').nullable();
    table.datetime('started_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('resume_at').nullable().index();
    table.datetime('finished_at').nullable();
    table.string('failure_reason', 1000).nullable();
    table.boolean('is_test_run').notNullable().defaultTo(false);
    table.unique(['organization_id', 'idempotency_key']);
    orgFk(table);
    table
      .foreign('workflow_id')
      .references('id')
      .inTable('workflow_definitions')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('workflow_action_runs', (table) => {
    pk(table);
    org(table);
    table.string('run_id', 26).notNullable().index();
    table.integer('position').notNullable();
    table.string('action_type', 60).notNullable();
    table.string('status', 24).notNullable().defaultTo('pending');
    table.json('input').nullable();
    table.json('output').nullable();
    table.string('error_message', 1000).nullable();
    table.integer('duration_ms').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table.foreign('run_id').references('id').inTable('workflow_runs').onDelete('CASCADE');
  });

  await knex.schema.createTable('ai_requests', (table) => {
    pk(table);
    org(table);
    table.string('feature', 60).notNullable().index();
    table.string('provider', 40).notNullable().defaultTo('openai');
    table.string('model', 80).notNullable();
    table.string('membership_id', 26).nullable().index();
    table.string('entity_type', 40).nullable();
    table.string('entity_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.integer('prompt_tokens').nullable();
    table.integer('completion_tokens').nullable();
    table.integer('total_tokens').nullable();
    table.integer('duration_ms').nullable();
    table.string('error_message', 1000).nullable();
    table.string('request_id', 40).nullable();
    table.json('input_summary').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
  });

  await knex.schema.createTable('ai_usage_ledger', (table) => {
    pk(table);
    org(table);
    table.string('period', 7).notNullable().index();
    table.string('feature', 60).notNullable();
    table.string('membership_id', 26).nullable();
    table.string('model', 80).notNullable();
    table.integer('request_count').notNullable().defaultTo(0);
    table.bigInteger('prompt_tokens').notNullable().defaultTo(0);
    table.bigInteger('completion_tokens').notNullable().defaultTo(0);
    money(table, 'estimated_cost', { precision: 12, scale: 4 }).defaultTo(0);
    table.string('currency', 3).notNullable().defaultTo('USD');
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'period', 'feature', 'membership_id', 'model'], { indexName: 'ai_usage_ledger_unique' });
    orgFk(table);
  });

  await knex.schema.createTable('ai_artifacts', (table) => {
    pk(table);
    org(table);
    table.string('request_id', 26).nullable().index();
    table.string('feature', 60).notNullable();
    table.string('entity_type', 40).nullable();
    table.string('entity_id', 26).nullable();
    table.string('artifact_type', 40).notNullable();
    table.json('content').notNullable();
    table.string('status', 24).notNullable().defaultTo('suggested').index();
    table.string('applied_by_membership_id', 26).nullable();
    table.datetime('applied_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('ai_feedback', (table) => {
    pk(table);
    org(table);
    table.string('artifact_id', 26).nullable().index();
    table.string('request_id', 26).nullable();
    table.string('membership_id', 26).nullable();
    table.string('rating', 16).notNullable();
    table.string('comment', 1000).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
  });

  await knex.schema.createTable('saved_views', (table) => {
    pk(table);
    org(table);
    table.string('membership_id', 26).nullable().index();
    table.string('entity_type', 40).notNullable().index();
    table.string('name', 160).notNullable();
    table.json('filters').notNullable();
    table.json('columns').nullable();
    table.json('sort').nullable();
    table.string('visibility', 20).notNullable().defaultTo('private');
    table.boolean('is_default').notNullable().defaultTo(false);
    timestamps(table);
    orgFk(table);
  });

  await knex.schema.createTable('report_definitions', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('code', 60).notNullable();
    table.string('name', 180).notNullable();
    table.string('category', 40).notNullable();
    table.string('module', 16).nullable();
    table.json('metrics').notNullable();
    table.json('dimensions').nullable();
    table.json('default_filters').nullable();
    table.string('required_permission', 80).nullable();
    table.boolean('is_system').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'code']);
  });

  await knex.schema.createTable('report_schedules', (table) => {
    pk(table);
    org(table);
    table.string('report_code', 60).notNullable();
    table.string('name', 180).notNullable();
    table.string('cron_expression', 60).notNullable();
    table.string('timezone', 64).notNullable().defaultTo('Asia/Dubai');
    table.json('filters').nullable();
    table.json('recipients').notNullable();
    table.string('format', 12).notNullable().defaultTo('csv');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.datetime('last_run_at').nullable();
    table.datetime('next_run_at').nullable().index();
    actors(table);
    timestamps(table);
    orgFk(table);
  });

  await knex.schema.createTable('data_exports', (table) => {
    pk(table);
    org(table);
    table.string('membership_id', 26).nullable().index();
    table.string('entity_type', 40).notNullable();
    table.string('format', 12).notNullable().defaultTo('csv');
    table.json('filters').nullable();
    table.string('status', 24).notNullable().defaultTo('queued').index();
    table.integer('row_count').nullable();
    table.string('storage_key', 512).nullable();
    table.datetime('expires_at').nullable();
    table.string('error_message', 1000).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.datetime('completed_at').nullable();
    orgFk(table);
  });

  await knex.schema.createTable('data_deletion_requests', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 40).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('reason', 500).nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('requested_by_membership_id', 26).nullable();
    table.string('approved_by_membership_id', 26).nullable();
    table.datetime('approved_at').nullable();
    table.datetime('executed_at').nullable();
    table.json('result').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
