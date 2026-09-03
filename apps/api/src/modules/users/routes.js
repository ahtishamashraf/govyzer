import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { NotFoundError, ValidationError } from '@govyzer/domain';
import { idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';

const membershipUpdateSchema = z.object({
  branch_id: idSchema.nullable().optional(),
  department_id: idSchema.nullable().optional(),
  team_id: idSchema.nullable().optional(),
  manager_membership_id: idSchema.nullable().optional(),
  employee_code: z.string().max(40).nullable().optional(),
  job_title: z.string().max(120).nullable().optional(),
  status: z.enum(['active', 'suspended', 'invited']).optional(),
  record_scope: z.enum(['own', 'assigned', 'team', 'branch', 'organization']).optional(),
  modules: z.array(z.enum(['ready', 'offplan', 'sales_screen', 'finance', 'admin'])).optional(),
  capacity_limit: z.coerce.number().int().min(0).max(1000).nullable().optional(),
  working_hours: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))).nullable().optional(),
  languages: z.array(z.string().max(10)).optional(),
  specialities: z.record(z.string(), z.unknown()).optional(),
  is_lead_pool_eligible: z.boolean().optional(),
  is_assignable: z.boolean().optional(),
  role_codes: z.array(z.string().max(60)).optional(),
  version: z.coerce.number().int().optional(),
});

const profileSchema = z.object({
  first_name: z.string().min(1).max(80).optional(),
  last_name: z.string().min(1).max(80).optional(),
  phone: z.string().max(40).nullable().optional(),
  avatar_url: z.string().url().max(512).nullable().optional(),
  locale: z.enum(['en', 'ar']).optional(),
  timezone: z.string().max(64).optional(),
});

function jsonColumn(value) {
  return value === undefined ? undefined : value === null ? null : JSON.stringify(value);
}

export function userRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth());

  router.patch(
    '/me',
    validate({ body: profileSchema }),
    handler(async (req, res) => {
      const db = getDb();
      await db('users').where('id', req.actor.userId).update({ ...req.validatedBody, updated_at: db.fn.now() });
      const user = await db('users').where('id', req.actor.userId).first('id', 'email', 'first_name', 'last_name', 'phone', 'avatar_url', 'locale', 'timezone');
      sendData(res, user);
    })
  );

  router.use(requireOrganization());

  router.get(
    '/',
    requirePermission('users.read'),
    validate({
      query: paginationSchema.extend({
        q: z.string().max(120).optional(),
        status: z.string().max(24).optional(),
        branch_id: idSchema.optional(),
        team_id: idSchema.optional(),
        module: z.string().max(24).optional(),
        assignable: z.coerce.boolean().optional(),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const { page, per_page: perPage, q, status, branch_id: branchId, team_id: teamId, assignable } = req.validatedQuery;

      const build = () => {
        let query = db('organization_memberships as m')
          .join('users as u', 'u.id', 'm.user_id')
          .where('m.organization_id', req.actor.organizationId)
          .whereNull('m.deleted_at');
        if (status) query = query.where('m.status', status);
        if (branchId) query = query.where('m.branch_id', branchId);
        if (teamId) query = query.where('m.team_id', teamId);
        if (assignable != null) query = query.where('m.is_assignable', assignable);
        if (q) {
          query = query.where((builder) =>
            builder
              .where('u.first_name', 'like', `%${q}%`)
              .orWhere('u.last_name', 'like', `%${q}%`)
              .orWhere('u.email', 'like', `%${q}%`)
              .orWhere('m.job_title', 'like', `%${q}%`)
          );
        }
        return query;
      };

      const [{ total }] = await build().clearOrder().count({ total: 'm.id' });
      const rows = await build()
        .select(
          'm.id',
          'm.status',
          'm.job_title',
          'm.employee_code',
          'm.branch_id',
          'm.department_id',
          'm.team_id',
          'm.manager_membership_id',
          'm.record_scope',
          'm.modules',
          'm.capacity_limit',
          'm.languages',
          'm.specialities',
          'm.is_lead_pool_eligible',
          'm.is_assignable',
          'm.version',
          'm.created_at',
          'u.id as user_id',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.phone',
          'u.avatar_url',
          'u.last_login_at'
        )
        .orderBy('u.first_name')
        .limit(perPage)
        .offset((page - 1) * perPage);

      const roleRows = rows.length
        ? await db('membership_roles')
            .join('roles', 'roles.id', 'membership_roles.role_id')
            .whereIn('membership_roles.membership_id', rows.map((row) => row.id))
            .select('membership_roles.membership_id', 'roles.code', 'roles.name')
        : [];

      const withRoles = rows.map((row) => ({
        ...row,
        roles: roleRows.filter((role) => role.membership_id === row.id).map((role) => ({ code: role.code, name: role.name })),
      }));
      sendList(res, withRoles, { page, perPage, total: Number(total) });
    })
  );

  router.get(
    '/:id',
    requirePermission('users.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const membership = await db('organization_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.id', req.validatedParams.id)
        .where('m.organization_id', req.actor.organizationId)
        .whereNull('m.deleted_at')
        .first('m.*', 'u.first_name', 'u.last_name', 'u.email', 'u.phone', 'u.avatar_url', 'u.last_login_at');
      if (!membership) throw new NotFoundError('Membership');
      const roles = await db('membership_roles')
        .join('roles', 'roles.id', 'membership_roles.role_id')
        .where('membership_roles.membership_id', membership.id)
        .select('roles.code', 'roles.name');
      sendData(res, { ...membership, roles });
    })
  );

  router.patch(
    '/:id',
    requirePermission('users.update'),
    validate({ params: z.object({ id: idSchema }), body: membershipUpdateSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const before = await db('organization_memberships')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .whereNull('deleted_at')
        .first();
      if (!before) throw new NotFoundError('Membership');

      const { role_codes: roleCodes, version, ...rest } = req.validatedBody;
      const payload = {
        ...rest,
        modules: jsonColumn(rest.modules),
        working_hours: jsonColumn(rest.working_hours),
        languages: jsonColumn(rest.languages),
        specialities: jsonColumn(rest.specialities),
        updated_at: db.fn.now(),
      };
      Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);

      let query = db('organization_memberships').where({ id: before.id, organization_id: req.actor.organizationId });
      if (version != null) query = query.where('version', version);
      const updated = await query.update({ ...payload, version: db.raw('`version` + 1') });
      if (updated === 0) throw new ValidationError('This membership was changed by someone else. Reload and try again.');

      if (roleCodes) {
        const roles = await db('roles')
          .whereIn('code', roleCodes)
          .where((builder) => builder.where('organization_id', req.actor.organizationId).orWhere('organization_id', ''))
          .select('id');
        if (roles.length === 0) throw new ValidationError('No valid roles supplied', [{ path: 'role_codes', message: 'Unknown role' }]);
        await db('membership_roles').where('membership_id', before.id).delete();
        await db('membership_roles').insert(roles.map((role) => ({ membership_id: before.id, role_id: role.id })));
      }

      const after = await db('organization_memberships').where('id', before.id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'membership.updated', entityType: 'organization_membership', entityId: before.id, before, after });
      sendData(res, after);
    })
  );

  router.post(
    '/:id/deactivate',
    requirePermission('users.deactivate'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ reason: z.string().max(300).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const membership = await db('organization_memberships')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .whereNull('deleted_at')
        .first();
      if (!membership) throw new NotFoundError('Membership');
      if (membership.id === req.actor.membershipId) throw new ValidationError('You cannot deactivate your own membership');

      await db('organization_memberships').where('id', membership.id).update({ status: 'suspended', is_assignable: false, updated_at: db.fn.now() });
      await db('sessions')
        .where('user_id', membership.user_id)
        .where('organization_id', req.actor.organizationId)
        .whereNull('revoked_at')
        .update({ revoked_at: db.fn.now(), revoked_reason: 'membership_deactivated' });

      await recordAudit({ ...auditFromRequest(req), action: 'membership.deactivated', entityType: 'organization_membership', entityId: membership.id, before: membership, after: { status: 'suspended', reason: req.validatedBody.reason ?? null } });
      sendData(res, { deactivated: true });
    })
  );

  router.get(
    '/:id/hierarchy',
    requirePermission('users.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const membership = await db('organization_memberships')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .first();
      if (!membership) throw new NotFoundError('Membership');
      const reports = await db('organization_memberships as m')
        .join('users as u', 'u.id', 'm.user_id')
        .where('m.manager_membership_id', membership.id)
        .whereNull('m.deleted_at')
        .select('m.id', 'm.job_title', 'u.first_name', 'u.last_name', 'u.email');
      const manager = membership.manager_membership_id
        ? await db('organization_memberships as m')
            .join('users as u', 'u.id', 'm.user_id')
            .where('m.id', membership.manager_membership_id)
            .first('m.id', 'm.job_title', 'u.first_name', 'u.last_name', 'u.email')
        : null;
      sendData(res, { membership_id: membership.id, manager, direct_reports: reports });
    })
  );

  return router;
}
