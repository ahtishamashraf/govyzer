import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, matchCandidates, unitStockMachine } from '@govyzer/domain';
import {
  developerSchema,
  projectSchema,
  phaseSchema,
  projectBuildingSchema,
  unitTypeSchema,
  unitSchema,
  unitStatusChangeSchema,
  unitSearchSchema,
  paymentPlanSchema,
  priceListSchema,
  stockImportSchema,
  holdSchema,
  reservationSchema,
  reservationExtendSchema,
  reservationCancelSchema,
  idSchema,
  paginationSchema,
} from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { nextReference } from '../../core/references.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import * as inventory from './inventory.js';
import { importStock, buildTemplateCsv } from './stock-import.js';

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 180);
}

export function offplanRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  // ---------- Developers ----------
  router.get(
    '/developers',
    requirePermission('developers.read'),
    validate({ query: paginationSchema.extend({ q: z.string().max(120).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('developers').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.q) query = query.where('name', 'like', `%${req.validatedQuery.q}%`);
      const rows = await query.orderBy('name').limit(req.validatedQuery.per_page).offset((req.validatedQuery.page - 1) * req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/developers',
    requirePermission('developers.manage'),
    validate({ body: developerSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('developers').insert({
        id,
        organization_id: req.actor.organizationId,
        slug: slugify(req.validatedBody.name),
        ...req.validatedBody,
        created_by: req.actor.membershipId,
        updated_by: req.actor.membershipId,
      });
      sendData(res, await db('developers').where('id', id).first(), { status: 201 });
    })
  );

  // ---------- Projects ----------
  router.get(
    '/projects',
    requirePermission('projects.read'),
    validate({ query: paginationSchema.extend({ q: z.string().max(120).optional(), developer_id: idSchema.optional(), status: z.string().max(30).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('projects').where('projects.organization_id', req.actor.organizationId).whereNull('projects.deleted_at');
        if (query.developer_id) builder = builder.where('projects.developer_id', query.developer_id);
        if (query.status) builder = builder.where('projects.status', query.status);
        if (query.q) builder = builder.where('projects.name', 'like', `%${query.q}%`);
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'projects.id' });
      const rows = await build()
        .leftJoin('developers as d', 'd.id', 'projects.developer_id')
        .select('projects.*', 'd.name as developer_name')
        .orderBy('projects.name')
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/projects',
    requirePermission('projects.manage'),
    validate({ body: projectSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { amenity_codes: amenityCodes, assignment_policy: policy, specialist_membership_ids: specialists, ...rest } = req.validatedBody;
      const id = newId();

      await withTransaction(db, async (trx) => {
        const reference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'project', prefix: req.actor.referencePrefix, periodic: false });
        await trx('projects').insert({
          id,
          organization_id: req.actor.organizationId,
          reference,
          slug: slugify(rest.name),
          ...rest,
          assignment_policy: policy ? JSON.stringify(policy) : null,
          specialist_membership_ids: specialists ? JSON.stringify(specialists) : null,
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
        });
        if (amenityCodes?.length) {
          const amenities = await trx('amenities')
            .whereIn('code', amenityCodes)
            .where((builder) => builder.where('organization_id', req.actor.organizationId).orWhere('organization_id', ''))
            .select('id');
          if (amenities.length > 0) {
            await trx('entity_amenities').insert(
              amenities.map((amenity) => ({ organization_id: req.actor.organizationId, entity_type: 'project', entity_id: id, amenity_id: amenity.id }))
            );
          }
        }
      });
      await recordAudit({ ...auditFromRequest(req), action: 'project.created', entityType: 'project', entityId: id, after: { name: rest.name } });
      sendData(res, await db('projects').where('id', id).first(), { status: 201 });
    })
  );

  router.get(
    '/projects/:id',
    requirePermission('projects.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const organizationId = req.actor.organizationId;
      const project = await db('projects').where({ id: req.validatedParams.id, organization_id: organizationId }).whereNull('deleted_at').first();
      if (!project) throw new NotFoundError('Project');

      const [developer, phases, buildings, unitTypes, paymentPlans, stockSummary, media] = await Promise.all([
        db('developers').where('id', project.developer_id).first(),
        db('project_phases').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').orderBy('position'),
        db('project_buildings').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').orderBy('code'),
        db('unit_types').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at').orderBy('code'),
        db('project_payment_plans').where({ organization_id: organizationId, project_id: project.id }).whereNull('deleted_at'),
        db('units')
          .where({ organization_id: organizationId, project_id: project.id })
          .whereNull('deleted_at')
          .groupBy('stock_status')
          .select('stock_status')
          .count({ total: 'id' })
          .sum({ value: 'current_price' }),
        db('media_assets').where({ organization_id: organizationId, entity_type: 'project', entity_id: project.id }).whereNull('deleted_at').orderBy('position'),
      ]);

      sendData(res, {
        ...project,
        assignment_policy: typeof project.assignment_policy === 'string' ? JSON.parse(project.assignment_policy ?? 'null') : project.assignment_policy,
        developer,
        phases,
        buildings,
        unit_types: unitTypes,
        payment_plans: paymentPlans,
        media,
        stock_summary: stockSummary.map((row) => ({ status: row.stock_status, count: Number(row.total), value: Number(row.value ?? 0) })),
      });
    })
  );

  router.patch(
    '/projects/:id',
    requirePermission('projects.manage'),
    validate({ params: z.object({ id: idSchema }), body: projectSchema.partial() }),
    handler(async (req, res) => {
      const db = getDb();
      const { amenity_codes: amenityCodes, assignment_policy: policy, specialist_membership_ids: specialists, ...rest } = req.validatedBody;
      const updates = { ...rest, updated_by: req.actor.membershipId, updated_at: db.fn.now() };
      if (policy) updates.assignment_policy = JSON.stringify(policy);
      if (specialists) updates.specialist_membership_ids = JSON.stringify(specialists);
      const updated = await db('projects').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).update(updates);
      if (updated === 0) throw new NotFoundError('Project');
      sendData(res, await db('projects').where('id', req.validatedParams.id).first());
    })
  );

  router.post(
    '/projects/:id/phases',
    requirePermission('projects.manage'),
    validate({ params: z.object({ id: idSchema }), body: phaseSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('project_phases').insert({ id, organization_id: req.actor.organizationId, project_id: req.validatedParams.id, ...req.validatedBody });
      sendData(res, await db('project_phases').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/projects/:id/buildings',
    requirePermission('projects.manage'),
    validate({ params: z.object({ id: idSchema }), body: projectBuildingSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('project_buildings').insert({ id, organization_id: req.actor.organizationId, project_id: req.validatedParams.id, ...req.validatedBody });
      sendData(res, await db('project_buildings').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/projects/:id/unit-types',
    requirePermission('projects.manage'),
    validate({ params: z.object({ id: idSchema }), body: unitTypeSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('unit_types').insert({ id, organization_id: req.actor.organizationId, ...req.validatedBody, project_id: req.validatedParams.id });
      sendData(res, await db('unit_types').where('id', id).first(), { status: 201 });
    })
  );

  // ---------- Payment plans ----------
  router.get(
    '/payment-plans',
    requirePermission('projects.read'),
    validate({ query: paginationSchema.extend({ project_id: idSchema.optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('project_payment_plans').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.project_id) query = query.where('project_id', req.validatedQuery.project_id);
      const plans = await query.orderBy('name');
      const installments = plans.length
        ? await db('payment_plan_installments')
            .where('organization_id', req.actor.organizationId)
            .whereIn('payment_plan_id', plans.map((plan) => plan.id))
            .orderBy('position')
        : [];
      sendData(
        res,
        plans.map((plan) => ({ ...plan, installments: installments.filter((installment) => installment.payment_plan_id === plan.id) }))
      );
    })
  );

  router.post(
    '/payment-plans',
    requirePermission('prices.manage'),
    validate({ body: paymentPlanSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { installments, ...plan } = req.validatedBody;
      const id = newId();
      await withTransaction(db, async (trx) => {
        await trx('project_payment_plans').insert({ id, organization_id: req.actor.organizationId, ...plan, created_by: req.actor.membershipId });
        if (installments.length > 0) {
          await trx('payment_plan_installments').insert(
            installments.map((installment) => ({ id: newId(), organization_id: req.actor.organizationId, payment_plan_id: id, ...installment }))
          );
        }
      });
      sendData(res, await db('project_payment_plans').where('id', id).first(), { status: 201 });
    })
  );

  router.get(
    '/units/:id/payment-schedule',
    requirePermission('units.read'),
    validate({ params: z.object({ id: idSchema }), query: z.object({ payment_plan_id: idSchema, price: z.coerce.number().min(0).optional() }) }),
    handler(async (req, res) => {
      sendData(
        res,
        await inventory.buildPaymentSchedule({
          organizationId: req.actor.organizationId,
          unitId: req.validatedParams.id,
          paymentPlanId: req.validatedQuery.payment_plan_id,
          price: req.validatedQuery.price ?? null,
        })
      );
    })
  );

  // ---------- Price lists ----------
  router.post(
    '/price-lists',
    requirePermission('prices.manage'),
    validate({ body: priceListSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { items, ...priceList } = req.validatedBody;
      const id = newId();
      await withTransaction(db, async (trx) => {
        await trx('price_lists').insert({ id, organization_id: req.actor.organizationId, ...priceList, status: 'active', created_by: req.actor.membershipId });
        if (items.length > 0) {
          await trx('price_list_items').insert(
            items.map((item) => ({ id: newId(), organization_id: req.actor.organizationId, price_list_id: id, ...item }))
          );
          for (const item of items.filter((entry) => entry.unit_id)) {
            const unit = await trx('units').where({ id: item.unit_id, organization_id: req.actor.organizationId }).first();
            if (!unit) continue;
            await trx('unit_price_history').insert({
              id: newId(),
              organization_id: req.actor.organizationId,
              unit_id: unit.id,
              old_price: unit.current_price,
              new_price: item.price,
              currency: priceList.currency,
              reason: `price list ${priceList.name}`,
              price_list_id: id,
              changed_by_membership_id: req.actor.membershipId,
            });
            await trx('units').where('id', unit.id).update({ current_price: item.price, updated_at: trx.fn.now() });
          }
        }
      });
      sendData(res, await db('price_lists').where('id', id).first(), { status: 201 });
    })
  );

  // ---------- Units / inventory matrix ----------
  router.get(
    '/units',
    requirePermission('units.read'),
    validate({ query: unitSearchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('units').where('units.organization_id', req.actor.organizationId).whereNull('units.deleted_at');
        if (query.project_id) builder = builder.where('units.project_id', query.project_id);
        if (query.phase_id) builder = builder.where('units.phase_id', query.phase_id);
        if (query.project_building_id) builder = builder.where('units.project_building_id', query.project_building_id);
        if (query.unit_type_id) builder = builder.where('units.unit_type_id', query.unit_type_id);
        if (query.developer_id) {
          builder = builder.whereIn('units.project_id', function subquery() {
            this.select('id').from('projects').where('organization_id', req.actor.organizationId).where('developer_id', query.developer_id);
          });
        }
        if (query.stock_status) {
          builder = Array.isArray(query.stock_status)
            ? builder.whereIn('units.stock_status', query.stock_status)
            : builder.where('units.stock_status', query.stock_status);
        }
        if (query.bedrooms != null) builder = builder.where('units.bedrooms', query.bedrooms);
        if (query.bedrooms_min != null) builder = builder.where('units.bedrooms', '>=', query.bedrooms_min);
        if (query.bedrooms_max != null) builder = builder.where('units.bedrooms', '<=', query.bedrooms_max);
        if (query.price_min != null) builder = builder.where('units.current_price', '>=', query.price_min);
        if (query.price_max != null) builder = builder.where('units.current_price', '<=', query.price_max);
        if (query.area_min != null) builder = builder.where('units.built_up_area', '>=', query.area_min);
        if (query.area_max != null) builder = builder.where('units.built_up_area', '<=', query.area_max);
        if (query.view) builder = builder.where('units.view', 'like', `%${query.view}%`);
        if (query.floor_label) builder = builder.where('units.floor_label', query.floor_label);
        if (query.unit_number) builder = builder.where('units.unit_number', 'like', `%${query.unit_number}%`);
        if (query.payment_plan_id) builder = builder.where('units.payment_plan_id', query.payment_plan_id);
        if (query.handover_from) builder = builder.where('units.handover_date', '>=', query.handover_from);
        if (query.handover_to) builder = builder.where('units.handover_date', '<=', query.handover_to);
        if (query.q) builder = builder.where((inner) => inner.where('units.unit_number', 'like', `%${query.q}%`).orWhere('units.reference', 'like', `%${query.q}%`));
        return builder;
      };

      const [{ total }] = await build().clearOrder().count({ total: 'units.id' });
      const rows = await build()
        .orderBy(['units.project_id', 'units.floor_label', 'units.unit_number'])
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.get(
    '/units/matrix',
    requirePermission('units.read'),
    validate({ query: z.object({ project_id: idSchema, phase_id: idSchema.optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('units')
        .where({ organization_id: req.actor.organizationId, project_id: req.validatedQuery.project_id })
        .whereNull('deleted_at');
      if (req.validatedQuery.phase_id) query = query.where('phase_id', req.validatedQuery.phase_id);
      const units = await query.select('id', 'unit_number', 'floor_label', 'project_building_id', 'unit_type_id', 'bedrooms', 'built_up_area', 'current_price', 'currency', 'view', 'stock_status', 'handover_date');

      const floors = [...new Set(units.map((unit) => unit.floor_label ?? '—'))].sort((a, b) => Number(b) - Number(a) || String(b).localeCompare(String(a)));
      const summary = units.reduce((accumulator, unit) => {
        accumulator[unit.stock_status] = (accumulator[unit.stock_status] ?? 0) + 1;
        return accumulator;
      }, {});

      sendData(res, {
        project_id: req.validatedQuery.project_id,
        total_units: units.length,
        summary,
        total_value: units.reduce((sum, unit) => sum + Number(unit.current_price ?? 0), 0),
        floors: floors.map((floor) => ({
          floor,
          units: units.filter((unit) => (unit.floor_label ?? '—') === floor).sort((a, b) => String(a.unit_number).localeCompare(String(b.unit_number))),
        })),
      });
    })
  );

  router.post(
    '/units',
    requirePermission('units.manage'),
    validate({ body: unitSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await withTransaction(db, async (trx) => {
        const reference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'unit', prefix: req.actor.referencePrefix, periodic: false });
        await trx('units').insert({
          id,
          organization_id: req.actor.organizationId,
          reference,
          ...req.validatedBody,
          attributes: req.validatedBody.attributes ? JSON.stringify(req.validatedBody.attributes) : null,
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
        });
        await trx('unit_status_history').insert({
          id: newId(),
          organization_id: req.actor.organizationId,
          unit_id: id,
          to_status: req.validatedBody.stock_status ?? 'draft',
          reason: 'unit created',
          changed_by_membership_id: req.actor.membershipId,
        });
      });
      sendData(res, await db('units').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/units/:id/status',
    requirePermission('units.manage'),
    validate({ params: z.object({ id: idSchema }), body: unitStatusChangeSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const unit = await db('units').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!unit) throw new NotFoundError('Unit');

      const isOverride = req.validatedBody.is_override;
      if (isOverride && !req.actor.permissions.has('units.override_status') && !req.actor.isPlatformAdmin) {
        const { ForbiddenError } = await import('@govyzer/domain');
        throw new ForbiddenError('Overriding a unit status requires units.override_status');
      }
      if (!isOverride) unitStockMachine.assert(unit.stock_status, req.validatedBody.stock_status);

      await withTransaction(db, async (trx) => {
        await trx('units').where('id', unit.id).update({ stock_status: req.validatedBody.stock_status, updated_at: trx.fn.now(), updated_by: req.actor.membershipId });
        await trx('unit_status_history').insert({
          id: newId(),
          organization_id: req.actor.organizationId,
          unit_id: unit.id,
          from_status: unit.stock_status,
          to_status: req.validatedBody.stock_status,
          reason: req.validatedBody.reason ?? null,
          changed_by_membership_id: req.actor.membershipId,
          is_override: isOverride,
        });
      });
      await recordAudit({ ...auditFromRequest(req), action: 'unit.status_changed', entityType: 'unit', entityId: unit.id, before: { stock_status: unit.stock_status }, after: req.validatedBody });
      sendData(res, await db('units').where('id', unit.id).first());
    })
  );

  router.get(
    '/units/:id',
    requirePermission('units.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const unit = await db('units').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!unit) throw new NotFoundError('Unit');
      const [history, holds, reservations, priceHistory, owners] = await Promise.all([
        db('unit_status_history').where({ organization_id: req.actor.organizationId, unit_id: unit.id }).orderBy('created_at', 'desc').limit(50),
        db('unit_holds').where({ organization_id: req.actor.organizationId, unit_id: unit.id }).orderBy('created_at', 'desc').limit(20),
        db('reservations').where({ organization_id: req.actor.organizationId, unit_id: unit.id }).whereNull('deleted_at').orderBy('created_at', 'desc').limit(20),
        db('unit_price_history').where({ organization_id: req.actor.organizationId, unit_id: unit.id }).orderBy('created_at', 'desc').limit(50),
        db('unit_owners').where({ organization_id: req.actor.organizationId, unit_id: unit.id }).whereNull('deleted_at'),
      ]);
      sendData(res, { ...unit, status_history: history, holds, reservations, price_history: priceHistory, owners });
    })
  );

  // ---------- Stock import ----------
  router.get(
    '/stock-import/template',
    requirePermission('units.import'),
    handler(async (req, res) => {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="govyzer-unit-stock-template.csv"');
      res.send(buildTemplateCsv());
    })
  );

  router.post(
    '/stock-import',
    requirePermission('units.import'),
    validate({ body: stockImportSchema }),
    handler(async (req, res) => {
      sendData(res, await importStock({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody }), { status: 201 });
    })
  );

  router.get(
    '/stock-import/:id',
    requirePermission('units.import'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const batch = await db('stock_import_batches').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!batch) throw new NotFoundError('Import batch');
      const rows = await db('stock_import_rows').where({ organization_id: req.actor.organizationId, batch_id: batch.id }).orderBy('row_number').limit(5000);
      sendData(res, { batch, rows });
    })
  );

  // ---------- Holds ----------
  router.post(
    '/holds',
    requirePermission('holds.create'),
    idempotency('offplan.hold'),
    validate({ body: holdSchema }),
    handler(async (req, res) => {
      sendData(res, await inventory.createHold({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody }), { status: 201 });
    })
  );

  router.post(
    '/holds/:id/release',
    requirePermission('holds.release'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ reason: z.string().max(300).optional(), is_override: z.boolean().default(false) }) }),
    handler(async (req, res) => {
      sendData(
        res,
        await inventory.releaseHold({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          holdId: req.validatedParams.id,
          reason: req.validatedBody.reason ?? 'released',
          isOverride: req.validatedBody.is_override,
        })
      );
    })
  );

  // ---------- Reservations ----------
  router.get(
    '/reservations',
    requirePermission('reservations.read'),
    validate({ query: paginationSchema.extend({ status: z.string().max(24).optional(), project_id: idSchema.optional(), expiring_hours: z.coerce.number().int().min(1).max(720).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('reservations as r')
          .leftJoin('units as u', 'u.id', 'r.unit_id')
          .leftJoin('contacts as c', 'c.id', 'r.contact_id')
          .where('r.organization_id', req.actor.organizationId)
          .whereNull('r.deleted_at');
        if (query.status) builder = builder.where('r.status', query.status);
        if (query.project_id) builder = builder.where('r.project_id', query.project_id);
        if (query.expiring_hours) {
          builder = builder
            .whereIn('r.status', ['pending', 'confirmed', 'extended'])
            .where('r.expires_at', '<=', new Date(Date.now() + query.expiring_hours * 60 * 60 * 1000));
        }
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'r.id' });
      const rows = await build()
        .select('r.*', 'u.unit_number', 'u.reference as unit_reference', 'c.display_name as contact_name')
        .orderBy('r.created_at', 'desc')
        .limit(query.per_page)
        .offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/reservations',
    requirePermission('reservations.create'),
    idempotency('offplan.reservation'),
    validate({ body: reservationSchema }),
    handler(async (req, res) => {
      const result = await inventory.createReservation({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        payload: req.validatedBody,
        idempotencyKey: req.get('idempotency-key') ?? null,
      });
      sendData(res, result.reservation, { status: result.replayed ? 200 : 201 });
    })
  );

  router.post(
    '/reservations/:id/extend',
    requirePermission('reservations.extend'),
    validate({ params: z.object({ id: idSchema }), body: reservationExtendSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await inventory.extendReservation({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          reservationId: req.validatedParams.id,
          additionalHours: req.validatedBody.additional_hours,
          reason: req.validatedBody.reason,
        })
      );
    })
  );

  router.post(
    '/reservations/:id/cancel',
    requirePermission('reservations.cancel'),
    validate({ params: z.object({ id: idSchema }), body: reservationCancelSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await inventory.cancelReservation({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          reservationId: req.validatedParams.id,
          reason: req.validatedBody.reason,
          releaseUnit: req.validatedBody.release_unit,
        })
      );
    })
  );

  router.post(
    '/reservations/:id/booking',
    requirePermission('bookings.manage'),
    validate({
      params: z.object({ id: idSchema }),
      body: z.object({ total_price: z.coerce.number().min(0).optional(), paid_amount: z.coerce.number().min(0).optional(), booking_date: z.coerce.date().optional() }),
    }),
    handler(async (req, res) => {
      sendData(
        res,
        await inventory.createBooking({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          reservationId: req.validatedParams.id,
          payload: req.validatedBody,
        }),
        { status: 201 }
      );
    })
  );

  // ---------- Matching ----------
  router.get(
    '/match',
    requirePermission('units.read'),
    validate({ query: z.object({ lead_id: idSchema, limit: z.coerce.number().int().min(1).max(50).default(20) }) }),
    handler(async (req, res) => {
      const db = getDb();
      const organizationId = req.actor.organizationId;
      const lead = await db('leads').where({ id: req.validatedQuery.lead_id, organization_id: organizationId }).whereNull('deleted_at').first();
      if (!lead) throw new NotFoundError('Lead');
      const requirement = await db('lead_requirements')
        .where({ organization_id: organizationId, lead_id: lead.id, is_active: true })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first();
      if (!requirement) return sendData(res, { matches: [], reason: 'no_active_requirement' });

      const parsed = {
        ...requirement,
        property_types: typeof requirement.property_types === 'string' ? JSON.parse(requirement.property_types ?? '[]') : requirement.property_types,
        community_ids: typeof requirement.community_ids === 'string' ? JSON.parse(requirement.community_ids ?? '[]') : requirement.community_ids,
        amenities: typeof requirement.amenities === 'string' ? JSON.parse(requirement.amenities ?? '[]') : requirement.amenities,
        views: typeof requirement.views === 'string' ? JSON.parse(requirement.views ?? '[]') : requirement.views,
      };

      const units = await db('units')
        .where('organization_id', organizationId)
        .whereNull('deleted_at')
        .whereIn('stock_status', ['available', 'on_hold'])
        .limit(1000)
        .select('id', 'reference', 'unit_number', 'project_id', 'property_type', 'bedrooms', 'built_up_area as size', 'current_price as price', 'community_id', 'view', 'handover_date', 'stock_status');

      const matches = matchCandidates(parsed, units, { limit: req.validatedQuery.limit });
      sendData(res, { lead_id: lead.id, requirement_id: requirement.id, matches });
    })
  );

  return router;
}
