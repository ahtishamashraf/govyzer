import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { contactCreateSchema, contactUpdateSchema, contactMergeSchema, idSchema, searchSchema } from '@govyzer/validation';
import { CONTACT_ROLES } from '@govyzer/domain';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { applyRecordScope } from '../../core/repository.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import * as service from './service.js';

const contactSearchSchema = searchSchema.extend({
  role: z.enum(CONTACT_ROLES).optional(),
  owner_membership_id: idSchema.optional(),
  status: z.string().max(24).optional(),
  identifier: z.string().max(190).optional(),
});

export function contactRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/',
    requirePermission('contacts.read'),
    validate({ query: contactSearchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { page, per_page: perPage, q, role, owner_membership_id: ownerId, status, identifier, sort, direction } = req.validatedQuery;

      const build = () => {
        let query = db('contacts')
          .where('contacts.organization_id', req.actor.organizationId)
          .whereNull('contacts.deleted_at');
        query = applyRecordScope(query, req.actor, { table: 'contacts', ownerColumn: 'owner_membership_id', assignedColumn: 'owner_membership_id' });
        if (status) query = query.where('contacts.status', status);
        if (ownerId) query = query.where('contacts.owner_membership_id', ownerId);
        if (q) {
          query = query.where((builder) =>
            builder
              .where('contacts.display_name', 'like', `%${q}%`)
              .orWhere('contacts.company_name', 'like', `%${q}%`)
              .orWhere('contacts.reference', 'like', `%${q}%`)
          );
        }
        if (identifier) {
          query = query.whereIn('contacts.id', function subquery() {
            this.select('contact_id')
              .from('contact_identifiers')
              .where('organization_id', req.actor.organizationId)
              .where('value_normalized', 'like', `%${identifier}%`);
          });
        }
        if (role) {
          query = query.whereIn('contacts.id', function subquery() {
            this.select('contact_id')
              .from('contact_roles')
              .where('organization_id', req.actor.organizationId)
              .where('role', role)
              .where('is_active', true);
          });
        }
        return query;
      };

      const [{ total }] = await build().clearOrder().count({ total: 'contacts.id' });
      const rows = await build()
        .orderBy(`contacts.${sort ?? 'created_at'}`, direction)
        .limit(perPage)
        .offset((page - 1) * perPage);
      sendList(res, rows, { page, perPage, total: Number(total) });
    })
  );

  router.post(
    '/',
    requirePermission('contacts.create'),
    idempotency('contacts.create'),
    validate({ body: contactCreateSchema }),
    handler(async (req, res) => {
      const result = await service.createContact({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        payload: req.validatedBody,
        request: { requestId: req.requestId },
      });
      sendData(res, { ...result.contact, deduplicated: !result.created, matched_on: result.matched_on }, { status: result.created ? 201 : 200 });
    })
  );

  router.get(
    '/:id',
    requirePermission('contacts.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.getContact({ organizationId: req.actor.organizationId, id: req.validatedParams.id, actor: req.actor }));
    })
  );

  router.patch(
    '/:id',
    requirePermission('contacts.update'),
    validate({ params: z.object({ id: idSchema }), body: contactUpdateSchema }),
    handler(async (req, res) => {
      sendData(
        res,
        await service.updateContact({
          organizationId: req.actor.organizationId,
          actor: req.actor,
          id: req.validatedParams.id,
          payload: req.validatedBody,
          request: { requestId: req.requestId },
        })
      );
    })
  );

  router.delete(
    '/:id',
    requirePermission('contacts.delete'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const before = await db('contacts').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!before) return sendNoContent(res);
      await db('contacts').where('id', before.id).update({ deleted_at: db.fn.now(), updated_by: req.actor.membershipId });
      await recordAudit({ ...auditFromRequest(req), action: 'contact.deleted', entityType: 'contact', entityId: before.id, before });
      sendNoContent(res);
    })
  );

  router.get(
    '/:id/duplicates',
    requirePermission('contacts.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      sendData(res, await service.findDuplicateCandidates({ organizationId: req.actor.organizationId, contactId: req.validatedParams.id }));
    })
  );

  router.post(
    '/merge',
    requirePermission('contacts.merge'),
    validate({ body: contactMergeSchema }),
    handler(async (req, res) => {
      const merged = await service.mergeContacts({
        organizationId: req.actor.organizationId,
        actor: req.actor,
        sourceContactId: req.validatedBody.source_contact_id,
        targetContactId: req.validatedBody.target_contact_id,
        fieldChoices: req.validatedBody.field_choices ?? {},
      });
      sendData(res, merged);
    })
  );

  router.post(
    '/:id/roles',
    requirePermission('contacts.update'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ roles: z.array(z.enum(CONTACT_ROLES)).min(1) }) }),
    handler(async (req, res) => {
      await service.ensureRoles({
        organizationId: req.actor.organizationId,
        contactId: req.validatedParams.id,
        roles: req.validatedBody.roles,
      });
      sendData(res, await service.getContact({ organizationId: req.actor.organizationId, id: req.validatedParams.id, actor: req.actor }));
    })
  );

  router.get(
    '/:id/timeline',
    requirePermission('communications.read'),
    validate({ params: z.object({ id: idSchema }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const organizationId = req.actor.organizationId;
      const contactId = req.validatedParams.id;
      const limit = req.validatedQuery.limit;

      const [messages, notes, meetings, calls, viewings] = await Promise.all([
        db('messages').where({ organization_id: organizationId, contact_id: contactId }).orderBy('created_at', 'desc').limit(limit),
        db('notes').where({ organization_id: organizationId, entity_type: 'contact', entity_id: contactId }).whereNull('deleted_at').orderBy('created_at', 'desc').limit(limit),
        db('meetings').where({ organization_id: organizationId, contact_id: contactId }).whereNull('deleted_at').orderBy('starts_at', 'desc').limit(limit),
        db('call_logs').where({ organization_id: organizationId, contact_id: contactId }).orderBy('started_at', 'desc').limit(limit),
        db('viewings').where({ organization_id: organizationId, contact_id: contactId }).whereNull('deleted_at').orderBy('scheduled_at', 'desc').limit(limit),
      ]);

      const timeline = [
        ...messages.map((row) => ({ type: 'message', at: row.created_at, data: row })),
        ...notes.map((row) => ({ type: 'note', at: row.created_at, data: row })),
        ...meetings.map((row) => ({ type: 'meeting', at: row.starts_at, data: row })),
        ...calls.map((row) => ({ type: 'call', at: row.started_at, data: row })),
        ...viewings.map((row) => ({ type: 'viewing', at: row.scheduled_at, data: row })),
      ]
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, limit);

      sendList(res, timeline, { perPage: limit, total: timeline.length, nextCursor: timeline.length === limit ? String(new Date(timeline.at(-1).at).getTime()) : null });
    })
  );

  return router;
}
