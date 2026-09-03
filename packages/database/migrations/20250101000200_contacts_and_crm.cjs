'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'contacts',
  'contact_identifiers',
  'contact_roles',
  'contact_addresses',
  'contact_consents',
  'lead_sources',
  'campaigns',
  'tags',
  'leads',
  'lead_requirements',
  'lead_tags',
  'lead_stage_definitions',
  'lead_stage_history',
  'lead_assignment_rules',
  'lead_assignments',
  'lead_assignment_history',
  'lead_sla_rules',
  'lead_sla_events',
  'lead_pool_entries',
  'notes',
  'tasks',
  'meetings',
  'meeting_attendees',
  'viewings',
  'communication_threads',
  'messages',
  'email_messages',
  'call_logs',
  'contact_merge_history',
  'lead_merge_history',
  'external_lead_receipts',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('contacts', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('contact_type', 20).notNullable().defaultTo('individual');
    table.string('first_name', 80).nullable();
    table.string('last_name', 80).nullable();
    table.string('display_name', 180).notNullable().index();
    table.string('company_name', 180).nullable();
    table.string('nationality', 2).nullable();
    table.string('preferred_language', 5).notNullable().defaultTo('en');
    table.string('preferred_contact_method', 20).notNullable().defaultTo('phone');
    table.string('owner_membership_id', 26).nullable().index();
    table.string('source_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('active').index();
    table.boolean('do_not_contact').notNullable().defaultTo(false);
    table.boolean('is_sensitive').notNullable().defaultTo(false);
    table.integer('score').nullable();
    table.string('avatar_url', 512).nullable();
    table.text('summary').nullable();
    table.string('merged_into_contact_id', 26).nullable().index();
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.index(['organization_id', 'display_name']);
    orgFk(table);
  });

  await knex.schema.createTable('contact_identifiers', (table) => {
    pk(table);
    org(table);
    table.string('contact_id', 26).notNullable().index();
    table.string('identifier_type', 24).notNullable();
    table.string('value_raw', 190).notNullable();
    table.string('value_normalized', 190).notNullable();
    table.string('label', 60).nullable();
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.datetime('verified_at').nullable();
    timestamps(table);
    // One identity value resolves to exactly one contact inside a tenant.
    table.unique(['organization_id', 'identifier_type', 'value_normalized'], { indexName: 'contact_identifiers_org_type_value_unique' });
    orgFk(table);
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
  });

  await knex.schema.createTable('contact_roles', (table) => {
    pk(table);
    org(table);
    table.string('contact_id', 26).notNullable().index();
    table.string('role', 40).notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.date('started_on').nullable();
    table.date('ended_on').nullable();
    table.json('metadata').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'contact_id', 'role']);
    orgFk(table);
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
  });

  await knex.schema.createTable('contact_addresses', (table) => {
    pk(table);
    org(table);
    table.string('contact_id', 26).notNullable().index();
    table.string('address_type', 24).notNullable().defaultTo('home');
    table.string('line1', 240).nullable();
    table.string('line2', 240).nullable();
    table.string('city', 120).nullable();
    table.string('area', 120).nullable();
    table.string('country', 2).notNullable().defaultTo('AE');
    table.string('postal_code', 24).nullable();
    table.boolean('is_primary').notNullable().defaultTo(false);
    timestamps(table);
    orgFk(table);
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
  });

  await knex.schema.createTable('contact_consents', (table) => {
    pk(table);
    org(table);
    table.string('contact_id', 26).notNullable().index();
    table.string('channel', 24).notNullable();
    table.string('status', 16).notNullable().defaultTo('unknown');
    table.string('basis', 40).nullable();
    table.string('source', 80).nullable();
    table.json('evidence').nullable();
    table.datetime('captured_at').nullable();
    table.datetime('revoked_at').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'contact_id', 'channel']);
    orgFk(table);
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_sources', (table) => {
    pk(table);
    org(table);
    table.string('code', 60).notNullable();
    table.string('name', 120).notNullable();
    table.string('category', 40).notNullable().defaultTo('other');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.boolean('is_system').notNullable().defaultTo(false);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('campaigns', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('code', 60).notNullable();
    table.string('channel', 40).nullable();
    table.string('source_id', 26).nullable();
    table.string('project_id', 26).nullable().index();
    table.date('starts_on').nullable();
    table.date('ends_on').nullable();
    money(table, 'budget');
    table.json('utm_defaults').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
    table.foreign('source_id').references('id').inTable('lead_sources').onDelete('SET NULL');
  });

  await knex.schema.createTable('tags', (table) => {
    pk(table);
    org(table);
    table.string('name', 80).notNullable();
    table.string('slug', 80).notNullable();
    table.string('color', 16).nullable();
    table.string('entity_type', 40).notNullable().defaultTo('lead');
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'entity_type', 'slug']);
    orgFk(table);
  });

  await knex.schema.createTable('lead_stage_definitions', (table) => {
    pk(table);
    org(table);
    table.string('pipeline', 24).notNullable().defaultTo('ready');
    table.string('code', 60).notNullable();
    table.json('name').notNullable();
    table.integer('position').notNullable().defaultTo(0);
    table.string('category', 20).notNullable().defaultTo('open');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.boolean('is_default_entry').notNullable().defaultTo(false);
    table.json('required_fields').nullable();
    table.integer('sla_minutes').nullable();
    table.json('automations').nullable();
    table.string('color', 16).nullable();
    timestamps(table);
    table.unique(['organization_id', 'pipeline', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('leads', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('contact_id', 26).notNullable().index();
    table.string('module', 16).notNullable().defaultTo('ready').index();
    table.string('purpose', 24).notNullable().defaultTo('buy');
    table.string('pipeline', 24).notNullable().defaultTo('ready');
    table.string('stage_code', 60).notNullable().defaultTo('new_inquiry').index();
    table.string('substage', 60).nullable();
    table.string('status', 24).notNullable().defaultTo('open').index();
    table.string('priority', 16).notNullable().defaultTo('normal');
    table.integer('score').nullable();
    table.text('score_explanation').nullable();
    table.string('source_id', 26).nullable().index();
    table.string('campaign_id', 26).nullable().index();
    table.string('portal_code', 40).nullable();
    table.string('external_lead_id', 120).nullable();
    table.json('utm').nullable();
    table.string('listing_id', 26).nullable().index();
    table.string('project_id', 26).nullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('property_reference', 80).nullable();
    table.string('language', 5).notNullable().defaultTo('en');
    money(table, 'estimated_value');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('financing', 24).nullable();
    table.string('timeframe', 24).nullable();
    table.text('notes').nullable();
    table.string('referred_by_contact_id', 26).nullable();
    table.string('referred_to_membership_id', 26).nullable();
    table.string('assigned_membership_id', 26).nullable().index();
    table.string('manager_membership_id', 26).nullable().index();
    table.string('team_id', 26).nullable().index();
    table.string('branch_id', 26).nullable().index();
    table.datetime('assigned_at').nullable();
    table.datetime('first_response_at').nullable();
    table.datetime('acknowledged_at').nullable();
    table.datetime('next_action_at').nullable().index();
    table.string('next_action', 200).nullable();
    table.datetime('last_activity_at').nullable().index();
    table.datetime('sla_due_at').nullable().index();
    table.string('sla_status', 24).notNullable().defaultTo('pending');
    table.datetime('won_at').nullable();
    table.datetime('lost_at').nullable();
    table.string('loss_reason', 120).nullable();
    table.string('deal_id', 26).nullable().index();
    table.boolean('is_in_pool').notNullable().defaultTo(false).index();
    table.string('merged_into_lead_id', 26).nullable();
    table.json('provider_payload').nullable();
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.index(['organization_id', 'module', 'stage_code']);
    table.index(['organization_id', 'assigned_membership_id', 'status']);
    orgFk(table);
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
    table.foreign('source_id').references('id').inTable('lead_sources').onDelete('SET NULL');
    table.foreign('campaign_id').references('id').inTable('campaigns').onDelete('SET NULL');
  });

  await knex.schema.createTable('lead_requirements', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('purpose', 24).notNullable().defaultTo('buy');
    table.string('module', 16).notNullable().defaultTo('ready');
    table.json('property_types').nullable();
    table.integer('bedrooms_min').nullable();
    table.integer('bedrooms_max').nullable();
    table.integer('bathrooms_min').nullable();
    money(table, 'budget_min');
    money(table, 'budget_max');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.decimal('size_min', 12, 2).nullable();
    table.decimal('size_max', 12, 2).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.json('community_ids').nullable();
    table.json('city_ids').nullable();
    table.json('amenities').nullable();
    table.json('views').nullable();
    table.date('handover_from').nullable();
    table.date('handover_to').nullable();
    table.date('move_in_from').nullable();
    table.string('payment_plan_preference', 60).nullable();
    table.string('furnishing', 24).nullable();
    table.string('rent_frequency', 24).nullable();
    table.text('notes').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table);
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_tags', (table) => {
    table.string('lead_id', 26).notNullable();
    table.string('tag_id', 26).notNullable();
    table.string('organization_id', 26).notNullable();
    table.primary(['lead_id', 'tag_id']);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
    table.foreign('tag_id').references('id').inTable('tags').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_stage_history', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('from_stage_code', 60).nullable();
    table.string('to_stage_code', 60).notNullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.string('reason', 240).nullable();
    table.integer('duration_seconds').nullable();
    table.string('source', 40).notNullable().defaultTo('user');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_assignment_rules', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('module', 16).notNullable().defaultTo('ready');
    table.integer('priority').notNullable().defaultTo(100).index();
    table.json('conditions').nullable();
    table.string('strategy', 40).notNullable().defaultTo('round_robin');
    table.json('targets').nullable();
    table.json('fallback').nullable();
    table.json('working_hours').nullable();
    table.boolean('respect_capacity').notNullable().defaultTo(true);
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    orgFk(table);
  });

  await knex.schema.createTable('lead_assignments', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('membership_id', 26).notNullable().index();
    table.string('assignment_role', 24).notNullable().defaultTo('primary');
    table.datetime('assigned_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('unassigned_at').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    table.index(['organization_id', 'membership_id', 'is_active']);
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_assignment_history', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('rule_id', 26).nullable();
    table.string('strategy', 40).nullable();
    table.json('evaluated_rules').nullable();
    table.json('candidates').nullable();
    table.string('previous_membership_id', 26).nullable();
    table.string('selected_membership_id', 26).nullable();
    table.string('reason', 240).notNullable();
    table.string('decided_by_membership_id', 26).nullable();
    table.boolean('is_manual_override').notNullable().defaultTo(false);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_sla_rules', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('module', 16).notNullable().defaultTo('ready');
    table.string('stage_code', 60).nullable();
    table.json('applies_to').nullable();
    table.integer('acknowledge_minutes').nullable().defaultTo(5);
    table.integer('manager_alert_minutes').nullable().defaultTo(15);
    table.integer('pool_release_minutes').nullable().defaultTo(30);
    table.boolean('working_hours_only').notNullable().defaultTo(false);
    table.json('working_hours').nullable();
    table.json('actions').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table);
    orgFk(table);
  });

  await knex.schema.createTable('lead_sla_events', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('rule_id', 26).nullable();
    table.string('event_type', 40).notNullable();
    table.datetime('due_at').notNullable().index();
    table.datetime('triggered_at').nullable();
    table.datetime('resolved_at').nullable();
    table.string('status', 24).notNullable().defaultTo('scheduled').index();
    table.json('result').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('lead_pool_entries', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).notNullable().index();
    table.string('status', 20).notNullable().defaultTo('available').index();
    table.string('released_by_membership_id', 26).nullable();
    table.string('release_reason', 240).nullable();
    table.datetime('released_at').notNullable().defaultTo(knex.fn.now());
    table.string('claimed_by_membership_id', 26).nullable();
    table.datetime('claimed_at').nullable();
    table.datetime('expires_at').nullable();
    table.json('eligible_membership_ids').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('CASCADE');
  });

  await knex.schema.createTable('notes', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 40).notNullable();
    table.string('entity_id', 26).notNullable();
    table.text('body').notNullable();
    table.boolean('is_private').notNullable().defaultTo(false);
    table.string('visibility', 24).notNullable().defaultTo('team');
    table.json('mentions').nullable();
    actors(table);
    timestamps(table);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('tasks', (table) => {
    pk(table);
    org(table);
    table.string('title', 200).notNullable();
    table.text('description').nullable();
    table.string('entity_type', 40).nullable();
    table.string('entity_id', 26).nullable();
    table.string('assigned_membership_id', 26).nullable().index();
    table.string('status', 24).notNullable().defaultTo('open').index();
    table.string('priority', 16).notNullable().defaultTo('normal');
    table.string('task_type', 40).notNullable().defaultTo('follow_up');
    table.datetime('due_at').nullable().index();
    table.datetime('completed_at').nullable();
    table.string('completed_by_membership_id', 26).nullable();
    table.string('created_by_workflow_run_id', 26).nullable();
    actors(table);
    timestamps(table);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('meetings', (table) => {
    pk(table);
    org(table);
    table.string('title', 200).notNullable();
    table.string('meeting_type', 40).notNullable().defaultTo('client_meeting');
    table.string('module', 16).notNullable().defaultTo('ready');
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('project_id', 26).nullable().index();
    table.string('unit_id', 26).nullable();
    table.string('listing_id', 26).nullable();
    table.string('location', 240).nullable();
    table.string('location_type', 24).notNullable().defaultTo('office');
    table.string('meeting_url', 512).nullable();
    table.datetime('starts_at').notNullable().index();
    table.datetime('ends_at').notNullable();
    table.string('timezone', 64).notNullable().defaultTo('Asia/Dubai');
    table.string('status', 24).notNullable().defaultTo('scheduled').index();
    table.string('outcome', 40).nullable();
    table.text('notes').nullable();
    table.text('ai_summary').nullable();
    table.string('organizer_membership_id', 26).nullable().index();
    table.string('external_calendar_id', 190).nullable();
    table.string('external_provider', 40).nullable();
    table.datetime('reminder_at').nullable();
    version(table);
    actors(table);
    timestamps(table);
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
  });

  await knex.schema.createTable('meeting_attendees', (table) => {
    pk(table);
    org(table);
    table.string('meeting_id', 26).notNullable().index();
    table.string('attendee_type', 24).notNullable().defaultTo('membership');
    table.string('membership_id', 26).nullable();
    table.string('contact_id', 26).nullable();
    table.string('email', 190).nullable();
    table.string('response_status', 24).notNullable().defaultTo('needs_action');
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('meeting_id').references('id').inTable('meetings').onDelete('CASCADE');
  });

  await knex.schema.createTable('viewings', (table) => {
    pk(table);
    org(table);
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('listing_id', 26).nullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('meeting_id', 26).nullable();
    table.datetime('scheduled_at').notNullable().index();
    table.datetime('completed_at').nullable();
    table.string('status', 24).notNullable().defaultTo('scheduled').index();
    table.string('agent_membership_id', 26).nullable().index();
    table.string('feedback', 2000).nullable();
    table.integer('interest_level').nullable();
    table.string('outcome', 40).nullable();
    actors(table);
    timestamps(table);
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('SET NULL');
  });

  await knex.schema.createTable('communication_threads', (table) => {
    pk(table);
    org(table);
    table.string('channel', 24).notNullable().index();
    table.string('provider', 40).notNullable();
    table.string('external_thread_id', 190).nullable();
    table.string('contact_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.string('membership_id', 26).nullable().index();
    table.string('subject', 300).nullable();
    table.string('status', 24).notNullable().defaultTo('open');
    table.datetime('last_message_at').nullable().index();
    table.integer('unread_count').notNullable().defaultTo(0);
    timestamps(table);
    table.unique(['organization_id', 'provider', 'external_thread_id'], { indexName: 'threads_org_provider_external_unique' });
    orgFk(table);
  });

  await knex.schema.createTable('messages', (table) => {
    pk(table);
    org(table);
    table.string('thread_id', 26).notNullable().index();
    table.string('channel', 24).notNullable();
    table.string('provider', 40).notNullable();
    table.string('external_message_id', 190).nullable();
    table.string('direction', 12).notNullable();
    table.string('from_identifier', 190).nullable();
    table.string('to_identifier', 190).nullable();
    table.string('contact_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.string('membership_id', 26).nullable();
    table.string('message_type', 24).notNullable().defaultTo('text');
    table.text('body').nullable();
    table.json('attachments').nullable();
    table.string('status', 24).notNullable().defaultTo('received');
    table.datetime('sent_at').nullable();
    table.datetime('delivered_at').nullable();
    table.datetime('read_at').nullable();
    table.json('provider_metadata').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.unique(['organization_id', 'provider', 'external_message_id']);
    orgFk(table);
    table
      .foreign('thread_id')
      .references('id')
      .inTable('communication_threads')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('email_messages', (table) => {
    pk(table);
    org(table);
    table.string('thread_id', 26).nullable().index();
    table.string('message_id', 26).nullable();
    table.string('provider', 40).notNullable();
    table.string('external_id', 190).nullable();
    table.string('direction', 12).notNullable();
    table.string('from_email', 190).notNullable();
    table.json('to_emails').nullable();
    table.json('cc_emails').nullable();
    table.string('subject', 400).nullable();
    table.text('body_text').nullable();
    table.text('body_html').nullable();
    table.json('attachments').nullable();
    table.datetime('sent_at').nullable();
    table.string('contact_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['organization_id', 'provider', 'external_id']);
    orgFk(table);
  });

  await knex.schema.createTable('call_logs', (table) => {
    pk(table);
    org(table);
    table.string('provider', 40).notNullable().defaultTo('manual');
    table.string('external_id', 190).nullable();
    table.string('direction', 12).notNullable();
    table.string('from_number', 40).nullable();
    table.string('to_number', 40).nullable();
    table.string('contact_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.string('membership_id', 26).nullable().index();
    table.integer('duration_seconds').nullable();
    table.string('status', 24).notNullable().defaultTo('completed');
    table.string('recording_url', 512).nullable();
    table.text('notes').nullable();
    table.datetime('started_at').notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['organization_id', 'provider', 'external_id']);
    orgFk(table);
  });

  await knex.schema.createTable('contact_merge_history', (table) => {
    pk(table);
    org(table);
    table.string('source_contact_id', 26).notNullable();
    table.string('target_contact_id', 26).notNullable().index();
    table.json('merged_fields').nullable();
    table.json('source_snapshot').nullable();
    table.string('merged_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
  });

  await knex.schema.createTable('lead_merge_history', (table) => {
    pk(table);
    org(table);
    table.string('source_lead_id', 26).notNullable();
    table.string('target_lead_id', 26).notNullable().index();
    table.json('source_snapshot').nullable();
    table.string('merged_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
  });

  // Idempotency ledger for inbound leads from portals, webhooks and imports.
  await knex.schema.createTable('external_lead_receipts', (table) => {
    pk(table);
    org(table);
    table.string('provider', 40).notNullable();
    table.string('external_id', 190).notNullable();
    table.string('idempotency_key', 190).notNullable();
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('received').index();
    table.json('raw_payload').nullable();
    table.json('normalized_payload').nullable();
    table.string('error_message', 500).nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.datetime('processed_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.unique(['organization_id', 'provider', 'idempotency_key'], { indexName: 'lead_receipts_org_provider_key_unique' });
    orgFk(table);
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
