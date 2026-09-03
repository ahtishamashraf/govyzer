'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'organizations',
  'organization_domains',
  'organization_branding',
  'subscription_plans',
  'organization_subscriptions',
  'feature_flags',
  'branches',
  'departments',
  'teams',
  'users',
  'organization_memberships',
  'roles',
  'permissions',
  'role_permissions',
  'membership_roles',
  'sessions',
  'password_reset_tokens',
  'email_verification_tokens',
  'invitations',
  'api_keys',
  'custom_field_definitions',
  'custom_field_values',
  'audit_logs',
  'notification_preferences',
  'notifications',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('organizations', (table) => {
    pk(table);
    table.string('name', 180).notNullable();
    table.string('legal_name', 180).nullable();
    table.string('slug', 63).notNullable().unique();
    table.string('status', 24).notNullable().defaultTo('trial').index();
    table.string('country', 2).notNullable().defaultTo('AE');
    table.string('default_locale', 5).notNullable().defaultTo('en');
    table.string('default_currency', 3).notNullable().defaultTo('AED');
    table.string('timezone', 64).notNullable().defaultTo('Asia/Dubai');
    table.string('date_format', 24).notNullable().defaultTo('dd/MM/yyyy');
    table.integer('fiscal_year_start_month').notNullable().defaultTo(1);
    table.string('reference_prefix', 12).notNullable().defaultTo('GVZ');
    money(table, 'vat_percentage', { precision: 5, scale: 2 }).defaultTo(5);
    table.string('commission_base', 24).notNullable().defaultTo('gross_before_vat');
    table.json('terminology').nullable();
    table.json('settings').nullable();
    table.datetime('trial_ends_at').nullable();
    actors(table);
    timestamps(table);
  });

  await knex.schema.createTable('organization_domains', (table) => {
    pk(table);
    org(table);
    table.string('hostname', 190).notNullable().unique();
    table.string('type', 16).notNullable().defaultTo('subdomain');
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.string('status', 24).notNullable().defaultTo('pending');
    table.string('verification_method', 24).notNullable().defaultTo('dns_txt');
    table.string('verification_token', 64).nullable();
    table.datetime('verified_at').nullable();
    timestamps(table);
    orgFk(table);
  });

  await knex.schema.createTable('organization_branding', (table) => {
    pk(table);
    org(table).unique();
    table.string('company_display_name', 180).nullable();
    table.string('logo_light_url', 512).nullable();
    table.string('logo_dark_url', 512).nullable();
    table.string('favicon_url', 512).nullable();
    table.string('primary_color', 16).notNullable().defaultTo('#0F5132');
    table.string('secondary_color', 16).notNullable().defaultTo('#111827');
    table.string('accent_color', 16).notNullable().defaultTo('#C6A15B');
    table.string('font_family', 120).notNullable().defaultTo('Inter');
    table.string('login_headline', 200).nullable();
    table.string('login_background_url', 512).nullable();
    table.text('email_header_html').nullable();
    table.text('email_footer_html').nullable();
    table.text('document_header_html').nullable();
    table.text('document_footer_html').nullable();
    table.string('sales_screen_theme', 40).notNullable().defaultTo('midnight');
    table.json('sales_screen_theme_overrides').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
  });

  await knex.schema.createTable('subscription_plans', (table) => {
    pk(table);
    table.string('code', 40).notNullable().unique();
    table.string('name', 120).notNullable();
    table.string('description', 400).nullable();
    money(table, 'price_monthly', { precision: 12, scale: 2 }).defaultTo(0);
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.json('limits').nullable();
    table.json('modules').nullable();
    table.boolean('is_public').notNullable().defaultTo(true);
    timestamps(table);
  });

  await knex.schema.createTable('organization_subscriptions', (table) => {
    pk(table);
    org(table);
    table.string('plan_id', 26).notNullable();
    table.string('status', 24).notNullable().defaultTo('trialing');
    table.integer('seats').notNullable().defaultTo(5);
    table.datetime('started_at').nullable();
    table.datetime('current_period_end').nullable();
    table.datetime('cancel_at').nullable();
    table.json('limits_override').nullable();
    table.json('modules_override').nullable();
    timestamps(table);
    orgFk(table);
    table.foreign('plan_id').references('id').inTable('subscription_plans');
  });

  await knex.schema.createTable('feature_flags', (table) => {
    pk(table);
    // Empty string means the flag is global rather than tenant scoped.
    table.string('organization_id', 26).notNullable().defaultTo('');
    table.string('flag_key', 80).notNullable();
    table.boolean('enabled').notNullable().defaultTo(false);
    table.json('conditions').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'flag_key']);
  });

  await knex.schema.createTable('branches', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('code', 40).notNullable();
    table.string('address_line', 240).nullable();
    table.string('city', 120).nullable();
    table.string('phone', 40).nullable();
    table.string('email', 190).nullable();
    table.string('timezone', 64).nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('departments', (table) => {
    pk(table);
    org(table);
    table.string('branch_id', 26).nullable().index();
    table.string('name', 160).notNullable();
    table.string('code', 40).notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
    table.foreign('branch_id').references('id').inTable('branches').onDelete('SET NULL');
  });

  await knex.schema.createTable('teams', (table) => {
    pk(table);
    org(table);
    table.string('branch_id', 26).nullable().index();
    table.string('department_id', 26).nullable().index();
    table.string('name', 160).notNullable();
    table.string('code', 40).notNullable();
    table.string('manager_membership_id', 26).nullable();
    table.string('leader_membership_id', 26).nullable();
    table.json('modules').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
    table.foreign('branch_id').references('id').inTable('branches').onDelete('SET NULL');
    table.foreign('department_id').references('id').inTable('departments').onDelete('SET NULL');
  });

  await knex.schema.createTable('users', (table) => {
    pk(table);
    table.string('email', 190).notNullable().unique();
    table.string('password_hash', 120).nullable();
    table.datetime('email_verified_at').nullable();
    table.string('first_name', 80).notNullable();
    table.string('last_name', 80).notNullable();
    table.string('phone', 40).nullable();
    table.string('avatar_url', 512).nullable();
    table.string('locale', 5).notNullable().defaultTo('en');
    table.string('timezone', 64).notNullable().defaultTo('Asia/Dubai');
    table.string('status', 24).notNullable().defaultTo('active').index();
    table.boolean('is_platform_admin').notNullable().defaultTo(false);
    table.boolean('mfa_enabled').notNullable().defaultTo(false);
    table.text('mfa_secret_encrypted').nullable();
    table.json('mfa_recovery_codes').nullable();
    table.datetime('last_login_at').nullable();
    table.integer('failed_login_attempts').notNullable().defaultTo(0);
    table.datetime('locked_until').nullable();
    timestamps(table);
  });

  await knex.schema.createTable('organization_memberships', (table) => {
    pk(table);
    org(table);
    table.string('user_id', 26).notNullable().index();
    table.string('branch_id', 26).nullable().index();
    table.string('department_id', 26).nullable().index();
    table.string('team_id', 26).nullable().index();
    table.string('manager_membership_id', 26).nullable().index();
    table.string('employee_code', 40).nullable();
    table.string('job_title', 120).nullable();
    table.string('status', 24).notNullable().defaultTo('active').index();
    table.string('record_scope', 24).notNullable().defaultTo('own');
    table.json('modules').nullable();
    table.integer('capacity_limit').nullable();
    table.json('working_hours').nullable();
    table.json('languages').nullable();
    table.json('specialities').nullable();
    table.boolean('is_lead_pool_eligible').notNullable().defaultTo(true);
    table.boolean('is_assignable').notNullable().defaultTo(true);
    table.string('invited_by', 26).nullable();
    table.datetime('invited_at').nullable();
    table.datetime('accepted_at').nullable();
    version(table);
    timestamps(table);
    table.unique(['organization_id', 'user_id']);
    orgFk(table);
    table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.foreign('branch_id').references('id').inTable('branches').onDelete('SET NULL');
    table.foreign('team_id').references('id').inTable('teams').onDelete('SET NULL');
  });

  await knex.schema.createTable('roles', (table) => {
    pk(table);
    // Empty string means a platform provided system role available to every tenant.
    table.string('organization_id', 26).notNullable().defaultTo('');
    table.string('code', 60).notNullable();
    table.string('name', 120).notNullable();
    table.string('description', 300).nullable();
    table.boolean('is_system').notNullable().defaultTo(false);
    table.integer('priority').notNullable().defaultTo(100);
    timestamps(table);
    table.unique(['organization_id', 'code']);
  });

  await knex.schema.createTable('permissions', (table) => {
    pk(table);
    table.string('code', 80).notNullable().unique();
    table.string('module', 40).notNullable().index();
    table.string('description', 240).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('role_permissions', (table) => {
    table.string('role_id', 26).notNullable();
    table.string('permission_id', 26).notNullable();
    table.primary(['role_id', 'permission_id']);
    table.foreign('role_id').references('id').inTable('roles').onDelete('CASCADE');
    table.foreign('permission_id').references('id').inTable('permissions').onDelete('CASCADE');
  });

  await knex.schema.createTable('membership_roles', (table) => {
    table.string('membership_id', 26).notNullable();
    table.string('role_id', 26).notNullable();
    table.primary(['membership_id', 'role_id']);
    table
      .foreign('membership_id')
      .references('id')
      .inTable('organization_memberships')
      .onDelete('CASCADE');
    table.foreign('role_id').references('id').inTable('roles').onDelete('CASCADE');
  });

  await knex.schema.createTable('sessions', (table) => {
    pk(table);
    table.string('user_id', 26).notNullable().index();
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('refresh_token_hash', 64).notNullable().unique();
    table.string('family_id', 26).notNullable().index();
    table.string('rotated_from', 26).nullable();
    table.string('user_agent', 300).nullable();
    table.string('ip_address', 64).nullable();
    table.datetime('expires_at').notNullable().index();
    table.datetime('last_used_at').nullable();
    table.datetime('revoked_at').nullable();
    table.string('revoked_reason', 60).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
  });

  await knex.schema.createTable('password_reset_tokens', (table) => {
    pk(table);
    table.string('user_id', 26).notNullable().index();
    table.string('token_hash', 64).notNullable().unique();
    table.datetime('expires_at').notNullable();
    table.datetime('used_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
  });

  await knex.schema.createTable('email_verification_tokens', (table) => {
    pk(table);
    table.string('user_id', 26).notNullable().index();
    table.string('token_hash', 64).notNullable().unique();
    table.datetime('expires_at').notNullable();
    table.datetime('used_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
  });

  await knex.schema.createTable('invitations', (table) => {
    pk(table);
    org(table);
    table.string('email', 190).notNullable().index();
    table.string('token_hash', 64).notNullable().unique();
    table.json('role_ids').nullable();
    table.json('modules').nullable();
    table.string('branch_id', 26).nullable();
    table.string('team_id', 26).nullable();
    table.string('job_title', 120).nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('invited_by', 26).nullable();
    table.datetime('expires_at').notNullable();
    table.datetime('accepted_at').nullable();
    table.datetime('revoked_at').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
  });

  await knex.schema.createTable('api_keys', (table) => {
    pk(table);
    org(table);
    table.string('name', 120).notNullable();
    table.string('prefix', 16).notNullable().index();
    table.string('key_hash', 64).notNullable().unique();
    table.json('scopes').nullable();
    table.string('created_by', 26).nullable();
    table.datetime('last_used_at').nullable();
    table.datetime('expires_at').nullable();
    table.datetime('revoked_at').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
  });

  await knex.schema.createTable('custom_field_definitions', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 40).notNullable().index();
    table.string('field_key', 60).notNullable();
    table.json('label').notNullable();
    table.string('field_type', 30).notNullable();
    table.json('options').nullable();
    table.boolean('is_required').notNullable().defaultTo(false);
    table.boolean('is_searchable').notNullable().defaultTo(false);
    table.boolean('is_sensitive').notNullable().defaultTo(false);
    table.integer('position').notNullable().defaultTo(0);
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table);
    table.unique(['organization_id', 'entity_type', 'field_key'], { indexName: 'cfd_org_entity_key_unique' });
    orgFk(table);
  });

  await knex.schema.createTable('custom_field_values', (table) => {
    pk(table);
    org(table);
    table.string('definition_id', 26).notNullable().index();
    table.string('entity_type', 40).notNullable();
    table.string('entity_id', 26).notNullable();
    table.text('value_text').nullable();
    table.decimal('value_number', 18, 4).nullable();
    table.datetime('value_date').nullable();
    table.json('value_json').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['definition_id', 'entity_id']);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
    table
      .foreign('definition_id')
      .references('id')
      .inTable('custom_field_definitions')
      .onDelete('CASCADE');
  });

  // Append only: no updated_at, no deleted_at, never mutated by application code.
  await knex.schema.createTable('audit_logs', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('actor_user_id', 26).nullable().index();
    table.string('actor_membership_id', 26).nullable();
    table.string('actor_type', 24).notNullable().defaultTo('user');
    table.string('action', 80).notNullable().index();
    table.string('entity_type', 60).notNullable();
    table.string('entity_id', 26).nullable();
    table.json('before_data').nullable();
    table.json('after_data').nullable();
    table.string('request_id', 40).nullable().index();
    table.string('ip_address', 64).nullable();
    table.string('user_agent', 300).nullable();
    table.string('source', 40).notNullable().defaultTo('api');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.index(['organization_id', 'entity_type', 'entity_id']);
  });

  await knex.schema.createTable('notification_preferences', (table) => {
    pk(table);
    org(table);
    table.string('membership_id', 26).notNullable().index();
    table.string('channel', 24).notNullable();
    table.string('event_key', 80).notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    table.unique(['membership_id', 'channel', 'event_key']);
    orgFk(table);
  });

  await knex.schema.createTable('notifications', (table) => {
    pk(table);
    org(table);
    table.string('membership_id', 26).notNullable().index();
    table.string('type', 60).notNullable();
    table.string('title', 200).notNullable();
    table.text('body').nullable();
    table.json('data').nullable();
    table.string('entity_type', 60).nullable();
    table.string('entity_id', 26).nullable();
    table.string('priority', 16).notNullable().defaultTo('normal');
    table.datetime('read_at').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.index(['membership_id', 'read_at']);
    orgFk(table);
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
