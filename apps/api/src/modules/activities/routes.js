import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError } from '@govyzer/domain';
import { noteSchema, taskSchema, meetingSchema, meetingOutcomeSchema, viewingSchema, viewingFeedbackSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { applyRecordScope } from '../../core/repository.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';

async function touchLead(db, organizationId, leadId) {
  if (!leadId) return;
  await db('leads').where({ id: leadId, organization_id: organizationId }).update({ last_activity_at: db.fn.now() });
}

export function activityRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  // ----- Notes -----
  router.get(
    '/notes',
    requirePermission('activities.read'),
    validate({ query: paginationSchema.extend({ entity_type: z.string().max(40), entity_id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('notes')
        .where({
          organization_id: req.actor.organizationId,
          entity_type: req.validatedQuery.entity_type,
          entity_id: req.validatedQuery.entity_id,
        })
        .whereNull('deleted_at')
        .where((builder) =>
          builder.where('is_private', false).orWhere('created_by', req.actor.membershipId)
        )
        .orderBy('created_at', 'desc')
        .limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/notes',
    requirePermission('activities.manage'),
    validate({ body: noteSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('notes').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        mentions: null,
        created_by: req.actor.membershipId,
        updated_by: req.actor.membershipId,
      });
      if (req.validatedBody.entity_type === 'lead') await touchLead(db, req.actor.organizationId, req.validatedBody.entity_id);
      sendData(res, await db('notes').where('id', id).first(), { status: 201 });
    })
  );

  // ----- Tasks -----
  router.get(
    '/tasks',
    requirePermission('activities.read'),
    validate({
      query: paginationSchema.extend({
        status: z.string().max(24).optional(),
        assigned_membership_id: idSchema.optional(),
        entity_type: z.string().max(40).optional(),
        entity_id: idSchema.optional(),
        due_before: z.coerce.date().optional(),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('tasks').where('tasks.organization_id', req.actor.organizationId).whereNull('tasks.deleted_at');
        builder = applyRecordScope(builder, req.actor, { table: 'tasks', assignedColumn: 'assigned_membership_id' });
        if (query.status) builder = builder.where('tasks.status', query.status);
        if (query.assigned_membership_id) builder = builder.where('tasks.assigned_membership_id', query.assigned_membership_id);
        if (query.entity_type) builder = builder.where('tasks.entity_type', query.entity_type);
        if (query.entity_id) builder = builder.where('tasks.entity_id', query.entity_id);
        if (query.due_before) builder = builder.where('tasks.due_at', '<=', query.due_before);
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'tasks.id' });
      const rows = await build().orderBy('tasks.due_at', 'asc').limit(query.per_page).offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/tasks',
    requirePermission('activities.manage'),
    validate({ body: taskSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('tasks').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        assigned_membership_id: req.validatedBody.assigned_membership_id ?? req.actor.membershipId,
        created_by: req.actor.membershipId,
        updated_by: req.actor.membershipId,
      });
      const task = await db('tasks').where('id', id).first();
      if (task.due_at) {
        await enqueueJob({
          organizationId: req.actor.organizationId,
          jobType: JOB_TYPES.REMINDER_DISPATCH,
          payload: { entity_type: 'task', entity_id: id },
          runAfter: task.due_at,
          dedupeKey: `task-reminder:${id}`,
        });
      }
      sendData(res, task, { status: 201 });
    })
  );

  router.patch(
    '/tasks/:id',
    requirePermission('activities.manage'),
    validate({ params: z.object({ id: idSchema }), body: taskSchema.partial().extend({ status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const task = await db('tasks').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!task) throw new NotFoundError('Task');
      const updates = { ...req.validatedBody, updated_by: req.actor.membershipId, updated_at: db.fn.now() };
      if (updates.status === 'completed') {
        updates.completed_at = db.fn.now();
        updates.completed_by_membership_id = req.actor.membershipId;
      }
      await db('tasks').where('id', task.id).update(updates);
      sendData(res, await db('tasks').where('id', task.id).first());
    })
  );

  // ----- Meetings -----
  router.get(
    '/meetings',
    requirePermission('activities.read'),
    validate({
      query: paginationSchema.extend({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        module: z.enum(['ready', 'offplan']).optional(),
        status: z.string().max(24).optional(),
        lead_id: idSchema.optional(),
        project_id: idSchema.optional(),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      const build = () => {
        let builder = db('meetings').where('meetings.organization_id', req.actor.organizationId).whereNull('meetings.deleted_at');
        builder = applyRecordScope(builder, req.actor, { table: 'meetings', assignedColumn: 'organizer_membership_id' });
        if (query.from) builder = builder.where('meetings.starts_at', '>=', query.from);
        if (query.to) builder = builder.where('meetings.starts_at', '<=', query.to);
        if (query.module) builder = builder.where('meetings.module', query.module);
        if (query.status) builder = builder.where('meetings.status', query.status);
        if (query.lead_id) builder = builder.where('meetings.lead_id', query.lead_id);
        if (query.project_id) builder = builder.where('meetings.project_id', query.project_id);
        return builder;
      };
      const [{ total }] = await build().clearOrder().count({ total: 'meetings.id' });
      const rows = await build().orderBy('meetings.starts_at', 'asc').limit(query.per_page).offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: Number(total) });
    })
  );

  router.post(
    '/meetings',
    requirePermission('activities.manage'),
    validate({ body: meetingSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { attendee_membership_ids: memberships, attendee_emails: emails, ...payload } = req.validatedBody;
      const id = newId();

      await withTransaction(db, async (trx) => {
        await trx('meetings').insert({
          id,
          organization_id: req.actor.organizationId,
          ...payload,
          organizer_membership_id: req.actor.membershipId,
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
          reminder_at: new Date(new Date(payload.starts_at).getTime() - 30 * 60 * 1000),
        });
        const attendees = [
          ...memberships.map((membershipId) => ({ attendee_type: 'membership', membership_id: membershipId })),
          ...emails.map((email) => ({ attendee_type: 'external', email })),
        ];
        if (payload.contact_id) attendees.push({ attendee_type: 'contact', contact_id: payload.contact_id });
        if (attendees.length > 0) {
          await trx('meeting_attendees').insert(
            attendees.map((attendee) => ({
              id: newId(),
              organization_id: req.actor.organizationId,
              meeting_id: id,
              membership_id: attendee.membership_id ?? null,
              contact_id: attendee.contact_id ?? null,
              email: attendee.email ?? null,
              attendee_type: attendee.attendee_type,
            }))
          );
        }
        await emitEvent(trx, {
          organizationId: req.actor.organizationId,
          eventType: EVENT_TYPES.MEETING_CREATED,
          aggregateType: 'meeting',
          aggregateId: id,
          payload: { meeting_id: id, lead_id: payload.lead_id ?? null, starts_at: payload.starts_at },
        });
      });

      await touchLead(db, req.actor.organizationId, payload.lead_id);
      await enqueueJob({
        organizationId: req.actor.organizationId,
        jobType: JOB_TYPES.REMINDER_DISPATCH,
        payload: { entity_type: 'meeting', entity_id: id },
        runAfter: new Date(new Date(payload.starts_at).getTime() - 30 * 60 * 1000),
        dedupeKey: `meeting-reminder:${id}`,
      });
      sendData(res, await db('meetings').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/meetings/:id/outcome',
    requirePermission('activities.manage'),
    validate({ params: z.object({ id: idSchema }), body: meetingOutcomeSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const meeting = await db('meetings').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!meeting) throw new NotFoundError('Meeting');
      await db('meetings').where('id', meeting.id).update({
        status: req.validatedBody.status,
        outcome: req.validatedBody.outcome ?? null,
        notes: req.validatedBody.notes ?? meeting.notes,
        updated_by: req.actor.membershipId,
        updated_at: db.fn.now(),
      });
      await touchLead(db, req.actor.organizationId, meeting.lead_id);
      await recordAudit({ ...auditFromRequest(req), action: 'meeting.outcome_recorded', entityType: 'meeting', entityId: meeting.id, before: { status: meeting.status }, after: req.validatedBody });
      sendData(res, await db('meetings').where('id', meeting.id).first());
    })
  );

  // ----- Viewings -----
  router.get(
    '/viewings',
    requirePermission('activities.read'),
    validate({ query: paginationSchema.extend({ listing_id: idSchema.optional(), lead_id: idSchema.optional(), status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const query = req.validatedQuery;
      let builder = db('viewings').where('viewings.organization_id', req.actor.organizationId).whereNull('viewings.deleted_at');
      builder = applyRecordScope(builder, req.actor, { table: 'viewings', assignedColumn: 'agent_membership_id' });
      if (query.listing_id) builder = builder.where('viewings.listing_id', query.listing_id);
      if (query.lead_id) builder = builder.where('viewings.lead_id', query.lead_id);
      if (query.status) builder = builder.where('viewings.status', query.status);
      const rows = await builder.orderBy('viewings.scheduled_at', 'desc').limit(query.per_page).offset((query.page - 1) * query.per_page);
      sendList(res, rows, { page: query.page, perPage: query.per_page, total: rows.length });
    })
  );

  router.post(
    '/viewings',
    requirePermission('activities.manage'),
    validate({ body: viewingSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('viewings').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        agent_membership_id: req.validatedBody.agent_membership_id ?? req.actor.membershipId,
        created_by: req.actor.membershipId,
        updated_by: req.actor.membershipId,
      });
      await touchLead(db, req.actor.organizationId, req.validatedBody.lead_id);
      sendData(res, await db('viewings').where('id', id).first(), { status: 201 });
    })
  );

  router.post(
    '/viewings/:id/feedback',
    requirePermission('activities.manage'),
    validate({ params: z.object({ id: idSchema }), body: viewingFeedbackSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const viewing = await db('viewings').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!viewing) throw new NotFoundError('Viewing');

      await withTransaction(db, async (trx) => {
        await trx('viewings').where('id', viewing.id).update({
          status: req.validatedBody.status,
          feedback: req.validatedBody.feedback ?? null,
          interest_level: req.validatedBody.interest_level ?? null,
          outcome: req.validatedBody.outcome ?? null,
          completed_at: req.validatedBody.status === 'completed' ? trx.fn.now() : null,
          updated_by: req.actor.membershipId,
          updated_at: trx.fn.now(),
        });
        if (req.validatedBody.status === 'completed') {
          await emitEvent(trx, {
            organizationId: req.actor.organizationId,
            eventType: EVENT_TYPES.VIEWING_COMPLETED,
            aggregateType: 'viewing',
            aggregateId: viewing.id,
            payload: {
              viewing_id: viewing.id,
              lead_id: viewing.lead_id,
              listing_id: viewing.listing_id,
              agent_membership_id: viewing.agent_membership_id,
            },
          });
        }
      });
      await touchLead(db, req.actor.organizationId, viewing.lead_id);
      sendData(res, await db('viewings').where('id', viewing.id).first());
    })
  );

  // ----- Notifications -----
  router.get(
    '/notifications',
    validate({ query: paginationSchema.extend({ unread_only: z.coerce.boolean().default(false) }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('notifications').where({ organization_id: req.actor.organizationId, membership_id: req.actor.membershipId });
      if (req.validatedQuery.unread_only) query = query.whereNull('read_at');
      const rows = await query.orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: 1, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/notifications/:id/read',
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      await db('notifications')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId, membership_id: req.actor.membershipId })
        .update({ read_at: db.fn.now() });
      sendNoContent(res);
    })
  );

  return router;
}
