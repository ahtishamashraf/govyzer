'use strict';

const { pk, org, timestamps, actors, money, version, orgFk, dropAll } = require('../migration-support/helpers.cjs');

const TABLES = [
  'countries',
  'administrative_areas',
  'cities',
  'communities',
  'subcommunities',
  'buildings',
  'developers',
  'projects',
  'project_phases',
  'project_buildings',
  'floors',
  'unit_types',
  'units',
  'unit_owners',
  'unit_status_history',
  'amenities',
  'entity_amenities',
  'media_assets',
  'floor_plans',
  'brochures',
  'price_lists',
  'price_list_items',
  'unit_price_history',
  'stock_releases',
  'inventory_allocations',
];

exports.up = async function up(knex) {
  // Geography is shared reference data. organization_id = '' means platform provided,
  // a tenant id means the tenant added the entry itself.
  await knex.schema.createTable('countries', (table) => {
    pk(table);
    table.string('iso2', 2).notNullable().unique();
    table.string('iso3', 3).notNullable();
    table.string('name', 120).notNullable();
    table.string('name_ar', 120).nullable();
    table.string('default_currency', 3).notNullable();
    table.string('default_timezone', 64).notNullable();
    table.string('phone_code', 8).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.boolean('is_active').notNullable().defaultTo(true);
    timestamps(table, { softDelete: false });
  });

  await knex.schema.createTable('administrative_areas', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('country_id', 26).notNullable().index();
    table.string('name', 160).notNullable();
    table.string('name_ar', 160).nullable();
    table.string('code', 40).nullable();
    timestamps(table, { softDelete: false });
    table.foreign('country_id').references('id').inTable('countries').onDelete('CASCADE');
  });

  await knex.schema.createTable('cities', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('country_id', 26).notNullable().index();
    table.string('administrative_area_id', 26).nullable().index();
    table.string('name', 160).notNullable();
    table.string('name_ar', 160).nullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    timestamps(table, { softDelete: false });
    table.foreign('country_id').references('id').inTable('countries').onDelete('CASCADE');
  });

  await knex.schema.createTable('communities', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('city_id', 26).notNullable().index();
    table.string('name', 160).notNullable();
    table.string('name_ar', 160).nullable();
    table.string('slug', 180).nullable().index();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.json('portal_codes').nullable();
    timestamps(table, { softDelete: false });
    table.foreign('city_id').references('id').inTable('cities').onDelete('CASCADE');
  });

  await knex.schema.createTable('subcommunities', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('community_id', 26).notNullable().index();
    table.string('name', 160).notNullable();
    table.string('name_ar', 160).nullable();
    table.json('portal_codes').nullable();
    timestamps(table, { softDelete: false });
    table.foreign('community_id').references('id').inTable('communities').onDelete('CASCADE');
  });

  await knex.schema.createTable('buildings', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('community_id', 26).nullable().index();
    table.string('subcommunity_id', 26).nullable().index();
    table.string('name', 180).notNullable();
    table.string('name_ar', 180).nullable();
    table.integer('total_floors').nullable();
    table.integer('completion_year').nullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.json('portal_codes').nullable();
    timestamps(table, { softDelete: false });
  });

  await knex.schema.createTable('developers', (table) => {
    pk(table);
    org(table);
    table.string('name', 180).notNullable();
    table.string('name_ar', 180).nullable();
    table.string('slug', 190).notNullable();
    table.string('logo_url', 512).nullable();
    table.text('description').nullable();
    table.string('website', 255).nullable();
    table.string('contact_email', 190).nullable();
    table.string('contact_phone', 40).nullable();
    table.string('license_number', 80).nullable();
    money(table, 'default_commission_percentage', { precision: 6, scale: 3 });
    table.boolean('is_active').notNullable().defaultTo(true);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'slug']);
    orgFk(table);
  });

  await knex.schema.createTable('projects', (table) => {
    pk(table);
    org(table);
    table.string('developer_id', 26).notNullable().index();
    table.string('name', 200).notNullable();
    table.string('name_ar', 200).nullable();
    table.string('reference', 40).notNullable();
    table.string('slug', 210).notNullable();
    table.string('project_type', 40).notNullable().defaultTo('residential');
    table.string('status', 30).notNullable().defaultTo('announced').index();
    table.string('construction_status', 30).nullable();
    table.integer('construction_percentage').nullable();
    table.string('city_id', 26).nullable().index();
    table.string('community_id', 26).nullable().index();
    table.string('subcommunity_id', 26).nullable();
    table.string('address_line', 300).nullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.text('description').nullable();
    table.text('description_ar').nullable();
    table.date('launch_date').nullable();
    table.date('handover_date').nullable().index();
    table.string('escrow_account', 120).nullable();
    table.string('permit_number', 80).nullable();
    money(table, 'starting_price');
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.integer('total_units').nullable();
    table.json('unit_type_summary').nullable();
    table.json('assignment_policy').nullable();
    table.string('default_manager_membership_id', 26).nullable();
    table.json('specialist_membership_ids').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.unique(['organization_id', 'slug']);
    orgFk(table);
    table.foreign('developer_id').references('id').inTable('developers').onDelete('CASCADE');
  });

  await knex.schema.createTable('project_phases', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).notNullable().index();
    table.string('name', 160).notNullable();
    table.string('code', 40).notNullable();
    table.string('status', 30).notNullable().defaultTo('planned');
    table.date('launch_date').nullable();
    table.date('handover_date').nullable();
    table.integer('total_units').nullable();
    table.integer('position').notNullable().defaultTo(0);
    timestamps(table);
    table.unique(['organization_id', 'project_id', 'code']);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });

  await knex.schema.createTable('project_buildings', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).notNullable().index();
    table.string('phase_id', 26).nullable().index();
    table.string('building_id', 26).nullable();
    table.string('name', 160).notNullable();
    table.string('code', 40).notNullable();
    table.integer('total_floors').nullable();
    table.integer('total_units').nullable();
    table.string('status', 30).nullable();
    table.date('handover_date').nullable();
    timestamps(table);
    table.unique(['organization_id', 'project_id', 'code']);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
    table.foreign('phase_id').references('id').inTable('project_phases').onDelete('SET NULL');
  });

  await knex.schema.createTable('floors', (table) => {
    pk(table);
    org(table);
    table.string('project_building_id', 26).notNullable().index();
    table.string('label', 40).notNullable();
    table.integer('level').notNullable();
    table.integer('total_units').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'project_building_id', 'level']);
    orgFk(table);
    table
      .foreign('project_building_id')
      .references('id')
      .inTable('project_buildings')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('unit_types', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).nullable().index();
    table.string('code', 60).notNullable();
    table.string('name', 160).notNullable();
    table.string('name_ar', 160).nullable();
    table.string('property_type', 40).notNullable().defaultTo('apartment');
    table.integer('bedrooms').nullable();
    table.decimal('bathrooms', 4, 1).nullable();
    table.decimal('suite_area', 12, 2).nullable();
    table.decimal('balcony_area', 12, 2).nullable();
    table.decimal('total_area', 12, 2).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.text('description').nullable();
    table.json('layout').nullable();
    timestamps(table);
    table.unique(['organization_id', 'project_id', 'code']);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });

  // A unit is permanent inventory. Listings and portal publications reference it but never
  // replace it.
  await knex.schema.createTable('units', (table) => {
    pk(table);
    org(table);
    table.string('module', 16).notNullable().defaultTo('offplan').index();
    table.string('project_id', 26).nullable().index();
    table.string('phase_id', 26).nullable().index();
    table.string('project_building_id', 26).nullable().index();
    table.string('floor_id', 26).nullable();
    table.string('unit_type_id', 26).nullable().index();
    table.string('building_id', 26).nullable().index();
    table.string('community_id', 26).nullable().index();
    table.string('city_id', 26).nullable().index();
    table.string('unit_number', 60).notNullable();
    table.string('reference', 60).notNullable();
    table.string('floor_label', 40).nullable();
    table.string('property_type', 40).notNullable().defaultTo('apartment');
    table.integer('bedrooms').nullable().index();
    table.decimal('bathrooms', 4, 1).nullable();
    table.decimal('built_up_area', 12, 2).nullable();
    table.decimal('plot_area', 12, 2).nullable();
    table.decimal('balcony_area', 12, 2).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.integer('parking_spaces').nullable();
    table.string('view', 120).nullable();
    table.string('orientation', 40).nullable();
    table.string('furnishing', 24).nullable();
    money(table, 'base_price');
    money(table, 'current_price');
    table.decimal('price_per_area', 14, 2).nullable();
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('stock_status', 24).notNullable().defaultTo('draft').index();
    table.string('availability_status', 24).notNullable().defaultTo('available');
    table.string('hold_id', 26).nullable();
    table.string('reservation_id', 26).nullable();
    table.string('deal_id', 26).nullable();
    table.date('handover_date').nullable();
    table.string('title_deed_number', 80).nullable();
    table.string('plot_number', 80).nullable();
    table.string('dld_reference', 80).nullable();
    table.json('attributes').nullable();
    table.string('payment_plan_id', 26).nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    version(table);
    actors(table);
    timestamps(table);
    table.unique(['organization_id', 'reference']);
    table.unique(['organization_id', 'project_id', 'unit_number']);
    table.index(['organization_id', 'project_id', 'stock_status']);
    table.index(['organization_id', 'stock_status', 'bedrooms']);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
    table.foreign('unit_type_id').references('id').inTable('unit_types').onDelete('SET NULL');
  });

  await knex.schema.createTable('unit_owners', (table) => {
    pk(table);
    org(table);
    table.string('unit_id', 26).notNullable().index();
    table.string('contact_id', 26).notNullable().index();
    table.string('ownership_type', 24).notNullable().defaultTo('owner');
    table.decimal('ownership_percentage', 6, 3).nullable();
    table.date('started_on').nullable();
    table.date('ended_on').nullable();
    table.boolean('is_primary').notNullable().defaultTo(true);
    table.json('documents').nullable();
    timestamps(table);
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
    table.foreign('contact_id').references('id').inTable('contacts').onDelete('CASCADE');
  });

  await knex.schema.createTable('unit_status_history', (table) => {
    pk(table);
    org(table);
    table.string('unit_id', 26).notNullable().index();
    table.string('from_status', 24).nullable();
    table.string('to_status', 24).notNullable();
    table.string('reason', 240).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.string('related_entity_type', 40).nullable();
    table.string('related_entity_id', 26).nullable();
    table.boolean('is_override').notNullable().defaultTo(false);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
  });

  await knex.schema.createTable('amenities', (table) => {
    pk(table);
    table.string('organization_id', 26).notNullable().defaultTo('').index();
    table.string('code', 60).notNullable();
    table.string('name', 120).notNullable();
    table.string('name_ar', 120).nullable();
    table.string('category', 40).notNullable().defaultTo('general');
    table.string('icon', 60).nullable();
    table.json('portal_codes').nullable();
    timestamps(table, { softDelete: false });
    table.unique(['organization_id', 'code']);
  });

  await knex.schema.createTable('entity_amenities', (table) => {
    table.string('organization_id', 26).notNullable();
    table.string('entity_type', 30).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('amenity_id', 26).notNullable();
    table.primary(['entity_type', 'entity_id', 'amenity_id']);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    table.foreign('amenity_id').references('id').inTable('amenities').onDelete('CASCADE');
  });

  await knex.schema.createTable('media_assets', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 30).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('asset_type', 24).notNullable().defaultTo('image');
    table.string('storage_key', 512).notNullable();
    table.string('bucket', 120).nullable();
    table.string('file_name', 255).notNullable();
    table.string('mime_type', 120).notNullable();
    table.bigInteger('size_bytes').notNullable();
    table.integer('width').nullable();
    table.integer('height').nullable();
    table.integer('duration_seconds').nullable();
    table.string('checksum', 64).nullable();
    table.string('caption', 300).nullable();
    table.string('caption_ar', 300).nullable();
    table.integer('position').notNullable().defaultTo(0);
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.boolean('is_public').notNullable().defaultTo(false);
    table.string('status', 24).notNullable().defaultTo('ready');
    table.string('watermark_status', 24).nullable();
    actors(table);
    timestamps(table);
    table.index(['organization_id', 'entity_type', 'entity_id', 'position'], 'media_assets_org_entity_position_index');
    orgFk(table);
  });

  await knex.schema.createTable('floor_plans', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 30).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('media_asset_id', 26).nullable();
    table.string('title', 200).notNullable();
    table.integer('bedrooms').nullable();
    table.decimal('area', 12, 2).nullable();
    table.string('size_unit', 10).notNullable().defaultTo('sqft');
    table.integer('position').notNullable().defaultTo(0);
    timestamps(table);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('brochures', (table) => {
    pk(table);
    org(table);
    table.string('entity_type', 30).notNullable();
    table.string('entity_id', 26).notNullable();
    table.string('media_asset_id', 26).nullable();
    table.string('title', 200).notNullable();
    table.string('language', 5).notNullable().defaultTo('en');
    table.boolean('is_public').notNullable().defaultTo(false);
    timestamps(table);
    table.index(['organization_id', 'entity_type', 'entity_id']);
    orgFk(table);
  });

  await knex.schema.createTable('price_lists', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).nullable().index();
    table.string('name', 160).notNullable();
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.date('effective_from').notNullable();
    table.date('effective_to').nullable();
    table.string('status', 24).notNullable().defaultTo('draft').index();
    table.string('approved_by_membership_id', 26).nullable();
    table.datetime('approved_at').nullable();
    actors(table);
    timestamps(table);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });

  await knex.schema.createTable('price_list_items', (table) => {
    pk(table);
    org(table);
    table.string('price_list_id', 26).notNullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('unit_type_id', 26).nullable().index();
    money(table, 'price', { nullable: false });
    table.decimal('price_per_area', 14, 2).nullable();
    table.decimal('discount_percentage', 6, 3).nullable();
    table.string('payment_plan_id', 26).nullable();
    timestamps(table, { softDelete: false });
    orgFk(table);
    table.foreign('price_list_id').references('id').inTable('price_lists').onDelete('CASCADE');
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
  });

  await knex.schema.createTable('unit_price_history', (table) => {
    pk(table);
    org(table);
    table.string('unit_id', 26).notNullable().index();
    money(table, 'old_price');
    money(table, 'new_price', { nullable: false });
    table.string('currency', 3).notNullable().defaultTo('AED');
    table.string('reason', 240).nullable();
    table.string('price_list_id', 26).nullable();
    table.string('changed_by_membership_id', 26).nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now()).index();
    orgFk(table);
    table.foreign('unit_id').references('id').inTable('units').onDelete('CASCADE');
  });

  await knex.schema.createTable('stock_releases', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).notNullable().index();
    table.string('phase_id', 26).nullable();
    table.string('name', 160).notNullable();
    table.string('status', 24).notNullable().defaultTo('draft').index();
    table.datetime('release_at').nullable();
    table.datetime('released_at').nullable();
    table.integer('unit_count').notNullable().defaultTo(0);
    table.json('unit_ids').nullable();
    table.json('eligibility').nullable();
    actors(table);
    timestamps(table);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });

  await knex.schema.createTable('inventory_allocations', (table) => {
    pk(table);
    org(table);
    table.string('project_id', 26).notNullable().index();
    table.string('unit_id', 26).nullable().index();
    table.string('allocated_to_type', 24).notNullable().defaultTo('team');
    table.string('allocated_to_id', 26).nullable();
    table.integer('quota').nullable();
    table.datetime('starts_at').nullable();
    table.datetime('ends_at').nullable();
    table.string('status', 24).notNullable().defaultTo('active');
    timestamps(table);
    orgFk(table);
    table.foreign('project_id').references('id').inTable('projects').onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  await dropAll(knex, TABLES);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
};
