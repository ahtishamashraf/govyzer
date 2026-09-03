'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'project_payment_plans',
  'payment_plan_installments',
  'unit_payment_plans',
  'unit_holds',
  'reservations',
  'reservation_extensions',
  'reservation_status_history',
  'stock_import_batches',
  'stock_import_rows',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('project_payment_plans', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).nullable().index();
    table.string('developer_id', 26).nullable();
    table.string('name', 160).notNullable();
    table.string('code', 60).notNullable();
    table.string('plan_type', 40).notNullable().defaultTo('construction_linked');
    table.text('description').nullable();
    table.decimal('down_payment_percentage', 6, 3).nullable();
    table.decimal('on_handover_percentage', 6, 3).nullable();
    table.decimal('post_handover_percentage', 6, 3).nullable();
    table.integer('post_handover_months').nullable();
    money(table, 'booking_amount');
    table.decimal('dld_fee_percentage', 6, 3).nullable().defaultTo(4);
    money(table, 'admin_fee');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'project_id', 'code']);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });

  await knex.schema.createTable('payment_plan_installments', (table) => {
    pk(table);
    org(table);
    table.string('payment_plan_id', 26).notNullable().index();
    table.integer('position').notNullable();
    table.string('label', 160).notNullable();
    table.decimal('percentage', 8, 4).nullable();
    money(table, 'fixed_amount');
    table.string('trigger_type', 40).notNullable().defaultTo('milestone');
    table.string('milestone', 120).nullable();
    table.integer('months_after_booking').nullable();
    table.date('due_on').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['payment_plan_id', 'position']);
    orgFk(table);
    table
      .foreign('payment_plan_id')
      .references('id')
      .inTable('project_payment_plans')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('unit_payment_plans', (table) => {
    pk(table);
    org(table);
    table.string('unit_id', 26).notNullable().index();
    table.string('payment_plan_id', 26).notNullable().index();
    table.boolean('is_default').notNullable().defaultTo(false);
    timestamps(table, { softDelete: false });
    table.unique(['unit_id', 'payment_plan_id']);
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
    table
      .foreign('payment_plan_id')
      .references('id')
      .inTable('project_payment_plans')
      .onDelete('CASCADE');
  });

  // Expiring soft lock taken before a reservation. Released by the hold-expiry job.
  await knex.schema.createTable('unit_holds', (table) => {
    pk(table);
    org(table);
    table.string('unit_id', 26).notNullable().index();
    table.string('project_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable();
    table.string('held_by_membership_id', 26).notNullable().index();
    table.string('status', 24).notNullable().defaultTo('active').index();
    table.string('reason', 300).nullable();
    table.datetime('expires_at').notNullable().index();
    table.datetime('released_at').nullable();
    table.string('released_by_membership_id', 26).nullable();
    table.string('release_reason', 300).nullable();
    table.boolean('is_override').notNullable().defaultTo(false);
    table.string('override_by_membership_id', 26).nullable();
    timestamps(table, { softDelete: false });
    table.index(['organization_id', 'status', 'expires_at']);
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
  });

  await knex.schema.createTable('reservations', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('unit_id', 26).notNullable().index();
    table.string('project_id', 26).nullable().index();
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).notNullable().index();
    table.string('agent_membership_id', 26).nullable().index();
    table.string('manager_membership_id', 26).nullable();
    table.string('team_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('hold_id', 26).nullable();
    table.string('payment_plan_id', 26).nullable();
    money(table, 'unit_price');
    money(table, 'reservation_amount');
    money(table, 'discount_amount');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.datetime('reserved_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('expires_at').nullable().index();
    table.datetime('confirmed_at').nullable();
    table.datetime('cancelled_at').nullable();
    table.string('cancel_reason', 300).nullable();
    table.datetime('converted_at').nullable();
    table.string('deal_id', 26).nullable().index();
    table.integer('extension_count').notNullable().defaultTo(0);
    table.json('terms').nullable();
    table.string('idempotency_key', 190).nullable();
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.unique(['organization_id', 'idempotency_key']);
    table.index(['organization_id', 'status', 'expires_at']);
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('RESTRICT');
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('RESTRICT');
  });

  await knex.schema.createTable('reservation_extensions', (table) => {
    pk(table);
    org(table);
    table.string('reservation_id', 26).notNullable().index();
    table.datetime('previous_expires_at').notNullable();
    table.datetime('new_expires_at').notNullable();
    table.string('reason', 300).nullable();
    table.string('requested_by_membership_id', 26).nullable();
    table.string('approved_by_membership_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('approved');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table
      .foreign('reservation_id')
      .references('id')
      .inTable('reservations')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('reservation_status_history', (table) => {
    pk(table);
    org(table);
    table.string('reservation_id', 26).notNullable().index();
    table.string('from_status', 24).nullable();
    table.string('to_status', 24).notNullable();
    table.string('reason', 300).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.boolean('is_override').notNullable().defaultTo(false);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table
      .foreign('reservation_id')
      .references('id')
      .inTable('reservations')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('stock_import_batches', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).nullable().index();
    table.string('file_name', 255).nullable();
    table.string('storage_key', 512).nullable();
    table.string('status', 24).notNullable().defaultTo('uploaded').index();
    table.string('mode', 20).notNullable().defaultTo('validate');
    table.integer('total_rows').notNullable().defaultTo(0);
    table.integer('valid_rows').notNullable().defaultTo(0);
    table.integer('error_rows').notNullable().defaultTo(0);
    table.integer('created_units').notNullable().defaultTo(0);
    table.integer('updated_units').notNullable().defaultTo(0);
    table.integer('skipped_units').notNullable().defaultTo(0);
    table.string('idempotency_key', 190).nullable();
    table.json('summary').nullable();
    actors(table);
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'idempotency_key']);
    orgFk(table);
  });

  await knex.schema.createTable('stock_import_rows', (table) => {
    pk(table);
    org(table);
    table.string('batch_id', 26).notNullable().index();
    table.integer('row_number').notNullable();
    table.json('raw_row').notNullable();
    table.json('normalized_row').nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('unit_id', 26).nullable();
    table.string('row_hash', 64).nullable().index();
    table.json('errors').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table
      .foreign('batch_id')
      .references('id')
      .inTable('stock_import_batches')
      .onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
