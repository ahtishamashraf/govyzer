import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { NotFoundError, validateCommissionRules } from '@govyzer/domain';
import { dealSchema, dealStageSchema, dealSearchSchema, offerSchema, commissionPlanSchema, commissionCalculateSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { applyRecordScope } from '../../core/repository.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { newId } from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import * as service from './service.js';
import * as commission from './commission.js';

export function dealRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/',
    requirePermission('deals.read'),
    validate({ query: dealSearchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('deals').where('deals.organization_id', req.actor.organizationId).whereNull('deals.deleted_at');
        builder = applyRecordScope(builder, req.actor, { table: 'deals', assignedColumn: 'agent_membership_id' });
        if (query.status) builder = builder.where('deals.status', query.status);
        if (query.stage) builder = builder.where('deals.stage', query.stage);
        if (query.deal_type) builder = builder.where('deals.deal_type', query.deal_type);
        if (query.module) builder = builder.where('deals.module', query.module);
        if (query.agent_membership_id) builder = builder.where('deals.agent_membership_id', query.agent_membership_id);
        if (query.won_from) builder = builder.where('deals.won_at', '>=', query.won_from);
        if (query.won_to) builder = builder.where('deals.won_at', '<=', query.won_to);
        if (query.q) builder = builder.where('deals.reference', 'like', `%${query.q}%`);
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'deals.id' });
      const rows = await build().orderBy(`deals.${query.sort ?? 'created_at'}`, query.direction).limit(query.per_page).offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/',
    requirePermission('deals.create'),
    idempotency('deals.create'),
    validate({ body: dealSchema }),
    handler(async (req, res) => {
      sendData(res, await service.createDeal({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody, request: { requestId: req.requestId } }), { status: 201 });
    })
  );

  router.get(
    '/:id',
    requirePermission('deals.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.getDeal({ organizationId: req.actor.organizationId, id: req.validatedParams.id }));
    })
  );

  router.patch(
    '/:id',
    requirePermission('deals.update'),
    validate({ params: z.object({ id: idSchema }), body: dealSchema.partial() }),
    handler(async (req, res) => {
      sendData(res, await service.updateDeal({ organizationId: req.actor.organizationId, actor: req.actor, id: req.validatedParams.id, payload: req.validatedBody }));
    })
  );

  router.post(
    '/:id/stage',
    requireAnyPermission(['deals.update', 'deals.win']),
    validate({ params: z.object({ id: idSchema }), body: dealStageSchema }),
    handler(async (req, res) => {
      if (req.validatedBody.stage === 'won' && !req.actor.permissions.has('deals.win') && !req.actor.isPlatformAdmin) {
        const { ForbiddenError } = await import('@govyzer/domain');
        throw new ForbiddenError('Missing permission: deals.win');
      }
      sendData(
        res,
        await service.changeStage({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          stage: req.validatedBody.stage,
          reason: req.validatedBody.reason,
        })
      );
    })
  );

  router.post(
    '/:id/commission/preview',
    requireAnyPermission(['commissions.read', 'commissions.read_own']),
    validate({ params: z.object({ id: idSchema }), body: commissionCalculateSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const deal = await db('deals').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!deal) throw new NotFoundError('Deal');
      const payload = { ...deal };
      if (req.validatedBody.gross_commission != null) payload.gross_commission = req.validatedBody.gross_commission;
      sendData(
        res,
        await commission.previewCommission({
          organizationId: req.actor.organizationId,
          deal: payload,
          actor: req.actor,
          planId: req.validatedBody.commission_plan_id ?? null,
          manualOverrides: req.validatedBody.manual_overrides,
        })
      );
    })
  );

  router.get(
    '/:id/commission',
    requireAnyPermission(['commissions.read', 'commissions.read_own']),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const snapshots = await db('commission_snapshots').where({ organization_id: req.actor.organizationId, deal_id: req.validatedParams.id }).orderBy('created_at', 'desc');
      const lines = snapshots.length
        ? await db('commission_lines').where('organization_id', req.actor.organizationId).whereIn('snapshot_id', snapshots.map((snapshot) => snapshot.id))
        : [];
      const visibleLines = req.actor.permissions.has('commissions.read')
        ? lines
        : lines.filter((line) => line.membership_id === req.actor.membershipId);
      sendData(
        res,
        snapshots.map((snapshot) => ({
          ...snapshot,
          rules_snapshot: typeof snapshot.rules_snapshot === 'string' ? JSON.parse(snapshot.rules_snapshot) : snapshot.rules_snapshot,
          inputs_snapshot: typeof snapshot.inputs_snapshot === 'string' ? JSON.parse(snapshot.inputs_snapshot) : snapshot.inputs_snapshot,
          lines: visibleLines.filter((line) => line.snapshot_id === snapshot.id),
        }))
      );
    })
  );

  router.post(
    '/commission-lines/:id/approve',
    requirePermission('commissions.approve'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(500).optional() }) }),
    handler(async (req, res) => {
      sendData(
        res,
        await commission.approveCommissionLine({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          lineId: req.validatedParams.id,
          decision: req.validatedBody.decision,
          reason: req.validatedBody.reason,
        })
      );
    })
  );

  // ---------- Commission plans ----------
  router.get(
    '/commission-plans/all',
    requirePermission('commissions.read'),
    handler(async (req, res) => {
      const db = getDb();
      const plans = await db('commission_plans').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('priority');
      const rules = plans.length
        ? await db('commission_rules').where('organization_id', req.actor.organizationId).whereIn('plan_id', plans.map((plan) => plan.id)).orderBy('position')
        : [];
      const assignments = plans.length
        ? await db('commission_plan_assignments').where('organization_id', req.actor.organizationId).whereIn('plan_id', plans.map((plan) => plan.id))
        : [];
      sendData(
        res,
        plans.map((plan) => ({
          ...plan,
          rules: rules.filter((rule) => rule.plan_id === plan.id),
          assignments: assignments.filter((assignment) => assignment.plan_id === plan.id),
        }))
      );
    })
  );

  router.post(
    '/commission-plans',
    requirePermission('commissions.manage'),
    validate({ body: commissionPlanSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { rules, assignments, ...plan } = req.validatedBody;
      const issues = validateCommissionRules(rules);
      if (issues.length > 0) {
        const { ValidationError } = await import('@govyzer/domain');
        throw new ValidationError('The commission plan is not valid', issues);
      }
      const id = newId();
      const { withTransaction } = await import('@govyzer/database');
      await withTransaction(db, async (trx) => {
        if (plan.is_default) {
          await trx('commission_plans').where('organization_id', req.actor.organizationId).update({ is_default: false });
        }
        await trx('commission_plans').insert({ id, organization_id: req.actor.organizationId, ...plan, created_by: req.actor.membershipId });
        await trx('commission_rules').insert(
          rules.map((rule) => ({
            id: newId(),
            organization_id: req.actor.organizationId,
            plan_id: id,
            ...rule,
            conditions: rule.conditions ? JSON.stringify(rule.conditions) : null,
            tiers: rule.tiers ? JSON.stringify(rule.tiers) : null,
          }))
        );
        if (assignments.length > 0) {
          await trx('commission_plan_assignments').insert(
            assignments.map((assignment) => ({ id: newId(), organization_id: req.actor.organizationId, plan_id: id, ...assignment }))
          );
        }
      });
      sendData(res, await db('commission_plans').where('id', id).first(), { status: 201 });
    })
  );

  // ---------- Offers ----------
  router.get(
    '/offers/all',
    requirePermission('deals.read'),
    validate({ query: paginationSchema.extend({ listing_id: idSchema.optional(), lead_id: idSchema.optional(), status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('offers').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.listing_id) query = query.where('listing_id', req.validatedQuery.listing_id);
      if (req.validatedQuery.lead_id) query = query.where('lead_id', req.validatedQuery.lead_id);
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      const rows = await query.orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/offers',
    requirePermission('deals.create'),
    validate({ body: offerSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      const { withTransaction } = await import('@govyzer/database');
      await withTransaction(db, async (trx) => {
        const reference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'offer', prefix: req.actor.referencePrefix });
        await trx('offers').insert({
          id,
          organization_id: req.actor.organizationId,
          reference,
          ...req.validatedBody,
          agent_membership_id: req.actor.membershipId,
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
        });
      });
      sendData(res, await db('offers').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/offers/:id/respond',
    requirePermission('deals.update'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ status: z.enum(['accepted', 'rejected', 'countered', 'withdrawn']), note: z.string().max(500).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const offer = await db('offers').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!offer) throw new NotFoundError('Offer');
      await db('offers').where('id', offer.id).update({
        status: req.validatedBody.status,
        responded_at: db.fn.now(),
        response_note: req.validatedBody.note ?? null,
        updated_at: db.fn.now(),
        updated_by: req.actor.membershipId,
      });
      sendData(res, await db('offers').where('id', offer.id).first());
    })
  );

  return router;
}
