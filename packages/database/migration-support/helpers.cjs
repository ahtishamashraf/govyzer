'use strict';

/** Primary key shared by every table: application generated ULID (26 chars). */
function pk(table) {
  table.string('id', 26).primary();
}

/** Tenant column. Every tenant-owned business table carries and indexes it. */
function org(table, { index = true } = {}) {
  const column = table.string('organization_id', 26).notNullable();
  if (index) column.index();
  return column;
}

/** created_at/updated_at as DATETIME plus an optional soft-delete marker. */
function timestamps(table, { softDelete = true } = {}) {
  table.timestamps(false, true);
  if (softDelete) table.datetime('deleted_at').nullable().index();
}

function actors(table) {
  table.string('created_by', 26).nullable();
  table.string('updated_by', 26).nullable();
}

function money(table, name, { precision = 18, scale = 2, nullable = true } = {}) {
  const column = table.decimal(name, precision, scale);
  return nullable ? column.nullable() : column.notNullable();
}

/** Optimistic concurrency column for records several users edit at once. */
function version(table) {
  table.integer('version').notNullable().defaultTo(1);
}

function orgFk(table, { column = 'organization_id', onDelete = 'CASCADE' } = {}) {
  table.foreign(column).references('id').inTable('organizations').onDelete(onDelete);
}

/** Drops tables in reverse dependency order, ignoring ones that never existed. */
async function dropAll(knex, tables) {
  for (const name of [...tables].reverse()) {
    await knex.schema.dropTableIfExists(name);
  }
}

module.exports = { pk, org, timestamps, actors, money, version, orgFk, dropAll };
