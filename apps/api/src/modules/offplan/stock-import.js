import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ValidationError, UNIT_STOCK_STATUSES } from '@govyzer/domain';
import { sha256 } from '../../core/crypto.js';
import { nextReference } from '../../core/references.js';
import { recordAudit } from '../../core/audit.js';

/** Columns accepted by the bulk stock template, in template order. */
export const STOCK_TEMPLATE_COLUMNS = Object.freeze([
  'unit_number',
  'unit_type_code',
  'building_code',
  'phase_code',
  'floor_label',
  'property_type',
  'bedrooms',
  'bathrooms',
  'built_up_area',
  'balcony_area',
  'plot_area',
  'size_unit',
  'parking_spaces',
  'view',
  'base_price',
  'current_price',
  'stock_status',
  'payment_plan_code',
  'handover_date',
]);

export function buildTemplateCsv() {
  const example = {
    unit_number: 'A-1203',
    unit_type_code: '2BR-A',
    building_code: 'TOWER-A',
    phase_code: 'PH1',
    floor_label: '12',
    property_type: 'apartment',
    bedrooms: '2',
    bathrooms: '2.5',
    built_up_area: '1250',
    balcony_area: '120',
    plot_area: '',
    size_unit: 'sqft',
    parking_spaces: '1',
    view: 'Marina',
    base_price: '2350000',
    current_price: '2350000',
    stock_status: 'available',
    payment_plan_code: '60-40',
    handover_date: '2027-06-30',
  };
  return `${STOCK_TEMPLATE_COLUMNS.join(',')}\n${STOCK_TEMPLATE_COLUMNS.map((column) => example[column] ?? '').join(',')}\n`;
}

function rowHash(projectId, row) {
  return sha256(`${projectId}|${JSON.stringify(row)}`);
}

/**
 * Validates and optionally commits a bulk unit import. Re-running the same batch with the
 * same idempotency key returns the original result instead of duplicating stock.
 */
export async function importStock({ organizationId, actor, payload }) {
  const db = getDb();

  if (payload.idempotency_key) {
    const existing = await db('stock_import_batches')
      .where({ organization_id: organizationId, idempotency_key: payload.idempotency_key })
      .first();
    if (existing && existing.status === 'completed') {
      const rows = await db('stock_import_rows').where({ organization_id: organizationId, batch_id: existing.id }).orderBy('row_number');
      return { batch: existing, rows, replayed: true };
    }
  }

  const project = await db('projects').where({ id: payload.project_id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!project) throw new NotFoundError('Project');

  const [unitTypes, buildings, phases, paymentPlans, existingUnits] = await Promise.all([
    db('unit_types').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').select('id', 'code', 'bedrooms', 'total_area', 'property_type'),
    db('project_buildings').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').select('id', 'code'),
    db('project_phases').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').select('id', 'code'),
    db('project_payment_plans').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').select('id', 'code'),
    db('units').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').select('id', 'unit_number', 'stock_status'),
  ]);

  const unitTypeMap = new Map(unitTypes.map((row) => [row.code.toLowerCase(), row]));
  const buildingMap = new Map(buildings.map((row) => [row.code.toLowerCase(), row]));
  const phaseMap = new Map(phases.map((row) => [row.code.toLowerCase(), row]));
  const planMap = new Map(paymentPlans.map((row) => [row.code.toLowerCase(), row]));
  const existingMap = new Map(existingUnits.map((row) => [String(row.unit_number).toLowerCase(), row]));

  const seen = new Set();
  const evaluated = payload.rows.map((row, index) => {
    const errors = [];
    const key = String(row.unit_number ?? '').trim().toLowerCase();
    if (!key) errors.push({ field: 'unit_number', message: 'Unit number is required' });
    if (seen.has(key)) errors.push({ field: 'unit_number', message: 'Duplicate unit number inside this file' });
    seen.add(key);

    const unitType = row.unit_type_code ? unitTypeMap.get(String(row.unit_type_code).toLowerCase()) : null;
    if (row.unit_type_code && !unitType) errors.push({ field: 'unit_type_code', message: `Unknown unit type ${row.unit_type_code}` });

    const building = row.building_code ? buildingMap.get(String(row.building_code).toLowerCase()) : null;
    if (row.building_code && !building) errors.push({ field: 'building_code', message: `Unknown building ${row.building_code}` });

    const phase = row.phase_code ? phaseMap.get(String(row.phase_code).toLowerCase()) : null;
    if (row.phase_code && !phase) errors.push({ field: 'phase_code', message: `Unknown phase ${row.phase_code}` });

    const plan = row.payment_plan_code ? planMap.get(String(row.payment_plan_code).toLowerCase()) : null;
    if (row.payment_plan_code && !plan) errors.push({ field: 'payment_plan_code', message: `Unknown payment plan ${row.payment_plan_code}` });

    if (row.current_price != null && Number(row.current_price) < 0) errors.push({ field: 'current_price', message: 'Price cannot be negative' });
    if (row.base_price != null && Number(row.base_price) < 0) errors.push({ field: 'base_price', message: 'Price cannot be negative' });
    if (row.bedrooms != null && (Number(row.bedrooms) < 0 || Number(row.bedrooms) > 20)) errors.push({ field: 'bedrooms', message: 'Bedrooms must be between 0 and 20' });
    if (row.built_up_area != null && Number(row.built_up_area) < 0) errors.push({ field: 'built_up_area', message: 'Area cannot be negative' });
    if (row.stock_status && !UNIT_STOCK_STATUSES.includes(row.stock_status)) errors.push({ field: 'stock_status', message: `Unknown stock status ${row.stock_status}` });

    const existing = existingMap.get(key) ?? null;
    if (existing && ['reserved', 'booked', 'sold'].includes(existing.stock_status) && row.stock_status && row.stock_status !== existing.stock_status) {
      errors.push({ field: 'stock_status', message: `Unit is ${existing.stock_status}; its status cannot be changed by import` });
    }

    return {
      row_number: index + 1,
      raw: row,
      normalized: {
        unit_number: row.unit_number,
        unit_type_id: unitType?.id ?? null,
        project_building_id: building?.id ?? null,
        phase_id: phase?.id ?? null,
        payment_plan_id: plan?.id ?? null,
        floor_label: row.floor_label ?? null,
        property_type: row.property_type ?? unitType?.property_type ?? 'apartment',
        bedrooms: row.bedrooms ?? unitType?.bedrooms ?? null,
        bathrooms: row.bathrooms ?? null,
        built_up_area: row.built_up_area ?? unitType?.total_area ?? null,
        balcony_area: row.balcony_area ?? null,
        plot_area: row.plot_area ?? null,
        size_unit: row.size_unit ?? 'sqft',
        parking_spaces: row.parking_spaces ?? null,
        view: row.view ?? null,
        base_price: row.base_price ?? row.current_price ?? null,
        current_price: row.current_price ?? row.base_price ?? null,
        stock_status: row.stock_status ?? 'available',
        handover_date: row.handover_date ?? null,
      },
      existing_unit_id: existing?.id ?? null,
      errors,
      status: errors.length > 0 ? 'error' : existing ? 'update' : 'create',
    };
  });

  const validRows = evaluated.filter((row) => row.errors.length === 0);
  const batchId = newId();

  await db('stock_import_batches').insert({
    id: batchId,
    organization_id: organizationId,
    project_id: project.id,
    status: payload.mode === 'commit' ? 'processing' : 'validated',
    mode: payload.mode,
    total_rows: evaluated.length,
    valid_rows: validRows.length,
    error_rows: evaluated.length - validRows.length,
    idempotency_key: payload.idempotency_key ?? null,
    created_by: actor.membershipId,
  });

  await db('stock_import_rows').insert(
    evaluated.map((row) => ({
      id: newId(),
      organization_id: organizationId,
      batch_id: batchId,
      row_number: row.row_number,
      raw_row: JSON.stringify(row.raw),
      normalized_row: JSON.stringify(row.normalized),
      status: row.status,
      unit_id: row.existing_unit_id,
      row_hash: rowHash(project.id, row.raw),
      errors: row.errors.length > 0 ? JSON.stringify(row.errors) : null,
    }))
  );

  if (payload.mode !== 'commit') {
    return {
      batch: await db('stock_import_batches').where('id', batchId).first(),
      rows: evaluated,
      preview: true,
    };
  }

  if (validRows.length === 0) {
    await db('stock_import_batches').where('id', batchId).update({ status: 'failed' });
    throw new ValidationError('No valid rows to import', evaluated.flatMap((row) => row.errors));
  }

  let created = 0;
  let updated = 0;

  await withTransaction(db, async (trx) => {
    for (const row of validRows) {
      if (row.existing_unit_id) {
        await trx('units')
          .where({ id: row.existing_unit_id, organization_id: organizationId })
          .update({ ...row.normalized, updated_at: trx.fn.now(), updated_by: actor.membershipId });
        updated += 1;
      } else {
        const reference = await nextReference({ trx, organizationId, entity: 'unit', prefix: actor?.referencePrefix ?? 'GVZ', periodic: false });
        const id = newId();
        await trx('units').insert({
          id,
          organization_id: organizationId,
          module: 'offplan',
          project_id: project.id,
          city_id: project.city_id,
          community_id: project.community_id,
          reference,
          currency: 'AED',
          ...row.normalized,
          created_by: actor.membershipId,
          updated_by: actor.membershipId,
        });
        await trx('unit_status_history').insert({
          id: newId(),
          organization_id: organizationId,
          unit_id: id,
          from_status: null,
          to_status: row.normalized.stock_status,
          reason: 'created by stock import',
          changed_by_membership_id: actor.membershipId,
          related_entity_type: 'stock_import_batch',
          related_entity_id: batchId,
        });
        await trx('stock_import_rows').where({ batch_id: batchId, row_number: row.row_number }).update({ unit_id: id, status: 'created' });
        created += 1;
      }
    }
    await trx('stock_import_batches').where('id', batchId).update({
      status: 'completed',
      created_units: created,
      updated_units: updated,
      skipped_units: evaluated.length - validRows.length,
      summary: JSON.stringify({ created, updated, errors: evaluated.length - validRows.length }),
    });
  });

  await recordAudit({
    organizationId,
    actor,
    action: 'units.imported',
    entityType: 'project',
    entityId: project.id,
    after: { batch_id: batchId, created, updated, errors: evaluated.length - validRows.length },
  });

  return {
    batch: await db('stock_import_batches').where('id', batchId).first(),
    rows: evaluated,
    preview: false,
  };
}
