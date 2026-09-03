'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'deals',
  'deal_parties',
  'deal_stage_history',
  'deal_approvals',
  'offers',
  'bookings',
  'cancellations',
  'document_templates',
  'document_template_versions',
  'generated_documents',
  'signature_requests',
  'invoices',
  'invoice_items',
  'payments',
  'payment_allocations',
  'receipts',
  'refunds',
  'commission_plans',
  'commission_rules',
  'commission_plan_assignments',
  'commission_snapshots',
  'commission_lines',
  'commission_disbursements',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('deals', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('deal_type', 24).notNullable().defaultTo('ready_sale').index();
    table.string('module', 16).notNullable().defaultTo('ready').index();
    table.string('stage', 30).notNullable().defaultTo('draft').index();
    table.string('status', 24).notNullable().defaultTo('open').index();
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('listing_id', 26).nullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('project_id', 26).nullable().index();
    table.string('reservation_id', 26).nullable().index();
    table.string('branch_id', 26).nullable().index();
    table.string('team_id', 26).nullable().index();
    table.string('agent_membership_id', 26).nullable().index();
    table.string('manager_membership_id', 26).nullable();
    money(table, 'property_value');
    money(table, 'gross_commission');
    money(table, 'commission_vat');
    money(table, 'net_commission');
    table.decimal('commission_percentage', 8, 4).nullable();
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('rent_frequency', 20).nullable();
    table.date('contract_date').nullable();
    table.date('handover_date').nullable();
    table.date('expected_close_date').nullable();
    table.datetime('won_at').nullable().index();
    table.datetime('lost_at').nullable();
    table.string('loss_reason', 240).nullable();
    table.datetime('cancelled_at').nullable();
    table.string('cancel_reason', 300).nullable();
    table.string('commission_plan_id', 26).nullable();
    table.string('commission_snapshot_id', 26).nullable();
    table.string('commission_status', 24).notNullable().defaultTo('pending');
    table.boolean('is_sales_screen_eligible').notNullable().defaultTo(true);
    table.json('attributes').nullable();
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.index(['organization_id', 'status', 'won_at']);
    orgFk(table);
    table.foreign('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
    table.foreign('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    table.foreign('unit_id').references('id').inTable('units').onDelete('SET NULL');
    table.foreign('reservation_id').references('id').inTable('reservations').onDelete('SET NULL');
  });

  await knex.schema.createTable('deal_parties', (table) => {
    pk(table);
    org(table);
    table.string('deal_id', 26).notNullable().index();
    table.string('party_role', 30).notNullable();
    table.string('party_type', 24).notNullable().defaultTo('contact');
    table.string('contact_id', 26).nullable().index();
    table.string('membership_id', 26).nullable().index();
    table.string('developer_id', 26).nullable();
    table.string('company_name', 180).nullable();
    table.decimal('share_percentage', 8, 4).nullable();
    table.json('metadata').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['deal_id', 'party_role', 'contact_id', 'membership_id']);
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('CASCADE');
  });

  await knex.schema.createTable('deal_stage_history', (table) => {
    pk(table);
    org(table);
    table.string('deal_id', 26).notNullable().index();
    table.string('from_stage', 30).nullable();
    table.string('to_stage', 30).notNullable();
    table.string('reason', 300).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('CASCADE');
  });

  await knex.schema.createTable('deal_approvals', (table) => {
    pk(table);
    org(table);
    table.string('deal_id', 26).notNullable().index();
    table.string('approval_type', 40).notNullable().defaultTo('commission_override');
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.string('requested_by_membership_id', 26).nullable();
    table.string('decided_by_membership_id', 26).nullable();
    table.datetime('decided_at').nullable();
    table.string('decision_reason', 500).nullable();
    table.json('payload').nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('CASCADE');
  });

  await knex.schema.createTable('offers', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('lead_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('listing_id', 26).nullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('deal_id', 26).nullable().index();
    table.string('offer_type', 20).notNullable().defaultTo('purchase');
    money(table, 'amount', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('rent_frequency', 20).nullable();
    table.integer('cheques').nullable();
    table.string('status', 24).notNullable().defaultTo('submitted').index();
    table.date('valid_until').nullable();
    table.text('conditions').nullable();
    table.string('agent_membership_id', 26).nullable();
    table.datetime('responded_at').nullable();
    table.string('response_note', 500).nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('SET NULL');
  });

  await knex.schema.createTable('bookings', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('reservation_id', 26).nullable().index();
    table.string('deal_id', 26).nullable().index();
    table.string('unit_id', 26).notNullable().index();
    table.string('contact_id', 26).notNullable();
    table.string('payment_plan_id', 26).nullable();
    table.string('status', 24).notNullable().defaultTo('active').index();
    money(table, 'total_price');
    money(table, 'paid_amount');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.date('booking_date').notNullable();
    table.date('spa_date').nullable();
    table.datetime('cancelled_at').nullable();
    table.string('cancel_reason', 300).nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('SET NULL');
    table.foreign('unit_id').references('id').inTable('units').onDelete('RESTRICT');
  });

  await knex.schema.createTable('cancellations', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 30).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('reason_code', 60).notNullable();
    table.string('reason', 500).nullable();
    money(table, 'refund_amount');
    table.string('status', 24).notNullable().defaultTo('recorded');
    table.string('requested_by_membership_id', 26).nullable();
    table.string('approved_by_membership_id', 26).nullable();
    table.datetime('approved_at').nullable();
    table.boolean('reverses_commission').notNullable().defaultTo(true);
    table.boolean('reverses_points').notNullable().defaultTo(true);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('document_templates', (table) => {
    pk(table);
    org(table);
    table.string('code', 60).notNullable();
    table.string('name', 180).notNullable();
    table.string('category', 40).notNullable().defaultTo('general');
    table.string('document_type', 60).notNullable();
    table.string('language', 5).notNullable().defaultTo('en');
    table.string('current_version_id', 26).nullable();
    table.boolean('requires_approval').notNullable().defaultTo(true);
    table.boolean('is_sample').notNullable().defaultTo(true);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.json('access_policy').nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('document_template_versions', (table) => {
    pk(table);
    org(table);
    table.string('template_id', 26).notNullable().index();
    table.integer('version_number').notNullable();
    table.text('body_html', 'longtext').nullable();
    table.string('source_media_id', 26).nullable();
    table.json('variables').nullable();
    table.json('conditional_sections').nullable();
    table.string('status', 24).notNullable().defaultTo('draft').index();
    table.string('approved_by_membership_id', 26).nullable();
    table.datetime('approved_at').nullable();
    table.string('change_note', 500).nullable();
    actors(table);
    timestamps(table, { softDelete: false });
    table.unique(['template_id', 'version_number']);
    orgFk(table);
    table
      .foreign('template_id')
      .references('id')
      .inTable('document_templates')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('generated_documents', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('template_id', 26).nullable().index();
    table.string('template_version_id', 26).nullable();
    table.integer('template_version_number').nullable();
    table.string('document_type', 60).notNullable().index();
    table.string('entity_type', 40).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('title', 250).notNullable();
    table.string('language', 5).notNullable().defaultTo('en');
    table.string('storage_key', 512).nullable();
    table.string('mime_type', 120).notNullable().defaultTo('application/pdf');
    table.bigInteger('size_bytes').nullable();
    table.string('checksum', 64).nullable();
    table.json('input_snapshot').nullable();
    table.string('status', 24).notNullable().defaultTo('generated').index();
    table.string('signature_status', 24).notNullable().defaultTo('not_required');
    table.date('expires_on').nullable();
    table.boolean('is_uploaded').notNullable().defaultTo(false);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('signature_requests', (table) => {
    pk(table);
    org(table);
    table.string('document_id', 26).notNullable().index();
    table.string('provider', 40).notNullable().defaultTo('manual');
    table.string('external_id', 190).nullable();
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.json('signers').nullable();
    table.datetime('sent_at').nullable();
    table.datetime('completed_at').nullable();
    table.string('signed_document_storage_key', 512).nullable();
    table.string('decline_reason', 500).nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'provider', 'external_id']);
    orgFk(table);
    table
      .foreign('document_id')
      .references('id')
      .inTable('generated_documents')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('invoices', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('deal_id', 26).nullable().index();
    table.string('booking_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('invoice_type', 30).notNullable().defaultTo('commission');
    table.string('status', 24).notNullable().defaultTo('draft').index();
    table.date('issue_date').notNullable();
    table.date('due_date').nullable().index();
    money(table, 'subtotal', { nullable: false }).defaultTo(0);
    money(table, 'vat_amount', { nullable: false }).defaultTo(0);
    money(table, 'total', { nullable: false }).defaultTo(0);
    money(table, 'paid_amount', { nullable: false }).defaultTo(0);
    money(table, 'balance', { nullable: false }).defaultTo(0);
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('trn', 40).nullable();
    table.text('notes').nullable();
    table.string('document_id', 26).nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('SET NULL');
  });

  await knex.schema.createTable('invoice_items', (table) => {
    pk(table);
    org(table);
    table.string('invoice_id', 26).notNullable().index();
    table.integer('position').notNullable().defaultTo(0);
    table.string('description', 400).notNullable();
    table.decimal('quantity', 12, 3).notNullable().defaultTo(1);
    money(table, 'unit_price', { nullable: false });
    table.decimal('vat_percentage', 6, 3).notNullable().defaultTo(5);
    money(table, 'vat_amount', { nullable: false }).defaultTo(0);
    money(table, 'line_total', { nullable: false });
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('invoice_id').references('id').inTable('invoices').onDelete('CASCADE');
  });

  await knex.schema.createTable('payments', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('deal_id', 26).nullable().index();
    table.string('booking_id', 26).nullable().index();
    table.string('contact_id', 26).nullable().index();
    table.string('payment_type', 30).notNullable().defaultTo('commission');
    table.string('direction', 12).notNullable().defaultTo('inbound');
    table.string('method', 30).notNullable().defaultTo('bank_transfer');
    money(table, 'amount', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('status', 24).notNullable().defaultTo('received').index();
    table.date('paid_on').notNullable();
    table.string('cheque_number', 60).nullable();
    table.date('cheque_due_on').nullable();
    table.string('bank_name', 120).nullable();
    table.string('transaction_reference', 120).nullable();
    table.string('idempotency_key', 190).nullable();
    table.text('notes').nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.unique(['organization_id', 'idempotency_key']);
    orgFk(table);
  });

  await knex.schema.createTable('payment_allocations', (table) => {
    pk(table);
    org(table);
    table.string('payment_id', 26).notNullable().index();
    table.string('invoice_id', 26).notNullable().index();
    money(table, 'amount', { nullable: false });
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['payment_id', 'invoice_id']);
    orgFk(table);
    table.foreign('payment_id').references('id').inTable('payments').onDelete('CASCADE');
    table.foreign('invoice_id').references('id').inTable('invoices').onDelete('CASCADE');
  });

  await knex.schema.createTable('receipts', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('payment_id', 26).notNullable().index();
    table.string('document_id', 26).nullable();
    table.date('issued_on').notNullable();
    money(table, 'amount', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('issued_by_membership_id', 26).nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'reference']);
    orgFk(table);
    table.foreign('payment_id').references('id').inTable('payments').onDelete('CASCADE');
  });

  await knex.schema.createTable('refunds', (table) => {
    pk(table);
    org(table);
    table.string('reference', 40).notNullable();
    table.string('payment_id', 26).nullable().index();
    table.string('deal_id', 26).nullable().index();
    money(table, 'amount', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('status', 24).notNullable().defaultTo('pending');
    table.string('reason', 500).nullable();
    table.date('refunded_on').nullable();
    table.string('approved_by_membership_id', 26).nullable();
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    orgFk(table);
  });

  await knex.schema.createTable('commission_plans', (table) => {
    pk(table);
    org(table);
    table.string('name', 160).notNullable();
    table.string('code', 60).notNullable();
    table.text('description').nullable();
    table.string('commission_base', 30).notNullable().defaultTo('gross_before_vat');
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.date('effective_from').nullable();
    table.date('effective_to').nullable();
    table.integer('priority').notNullable().defaultTo(100);
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'code']);
    orgFk(table);
  });

  await knex.schema.createTable('commission_rules', (table) => {
    pk(table);
    org(table);
    table.string('plan_id', 26).notNullable().index();
    table.integer('position').notNullable().defaultTo(0);
    table.string('recipient_type', 30).notNullable();
    table.string('recipient_ref', 26).nullable();
    table.string('calculation_type', 20).notNullable().defaultTo('percentage');
    table.decimal('percentage', 8, 4).nullable();
    money(table, 'fixed_amount');
    table.string('applies_to', 30).notNullable().defaultTo('gross');
    table.json('conditions').nullable();
    table.json('tiers').nullable();
    money(table, 'cap_amount');
    table.boolean('requires_approval').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('plan_id').references('id').inTable('commission_plans').onDelete('CASCADE');
  });

  await knex.schema.createTable('commission_plan_assignments', (table) => {
    pk(table);
    org(table);
    table.string('plan_id', 26).notNullable().index();
    table.string('scope_type', 30).notNullable();
    table.string('scope_id', 26).nullable();
    table.string('deal_type', 24).nullable();
    table.string('source_id', 26).nullable();
    table.string('project_id', 26).nullable();
    table.integer('priority').notNullable().defaultTo(100);
    table.date('effective_from').nullable();
    table.date('effective_to').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
    table.index(['organization_id', 'scope_type', 'scope_id'], 'commission_assignments_scope_index');
    orgFk(table);
    table.foreign('plan_id').references('id').inTable('commission_plans').onDelete('CASCADE');
  });

  // Immutable record of the rules and inputs used when a deal was finalized.
  await knex.schema.createTable('commission_snapshots', (table) => {
    pk(table);
    org(table);
    table.string('deal_id', 26).notNullable().index();
    table.string('plan_id', 26).nullable();
    table.string('plan_code', 60).nullable();
    table.integer('plan_version').nullable();
    table.string('commission_base', 30).notNullable();
    money(table, 'base_amount', { nullable: false });
    money(table, 'gross_commission', { nullable: false });
    money(table, 'vat_amount', { nullable: false }).defaultTo(0);
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.json('rules_snapshot').notNullable();
    table.json('inputs_snapshot').notNullable();
    table.string('status', 24).notNullable().defaultTo('final').index();
    table.string('reverses_snapshot_id', 26).nullable();
    table.string('created_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('deal_id').references('id').inTable('deals').onDelete('CASCADE');
  });

  await knex.schema.createTable('commission_lines', (table) => {
    pk(table);
    org(table);
    table.string('snapshot_id', 26).notNullable().index();
    table.string('deal_id', 26).notNullable().index();
    table.string('recipient_type', 30).notNullable();
    table.string('membership_id', 26).nullable().index();
    table.string('contact_id', 26).nullable();
    table.string('label', 160).notNullable();
    table.string('calculation_type', 20).notNullable();
    table.decimal('percentage', 8, 4).nullable();
    money(table, 'amount', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('status', 24).notNullable().defaultTo('calculated').index();
    table.boolean('is_manual_override').notNullable().defaultTo(false);
    table.string('approved_by_membership_id', 26).nullable();
    table.json('calculation_trace').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    orgFk(table);
    table
      .foreign('snapshot_id')
      .references('id')
      .inTable('commission_snapshots')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('commission_disbursements', (table) => {
    pk(table);
    org(table);
    table.string('commission_line_id', 26).notNullable().index();
    table.string('payment_id', 26).nullable();
    money(table, 'amount', { nullable: false });
    table.string('status', 24).notNullable().defaultTo('pending').index();
    table.date('scheduled_on').nullable();
    table.date('paid_on').nullable();
    table.string('approved_by_membership_id', 26).nullable();
    table.string('notes', 500).nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table
      .foreign('commission_line_id')
      .references('id')
      .inTable('commission_lines')
      .onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
